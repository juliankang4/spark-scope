import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { collectNode, uncollectedNode, InferenceCollector, applyNetworkRates, applyGpuMemoryFallback } from "./lib/collectors.mjs";
import { buildRingLinks, clusterStatus, serverState, servingSummary, DEFAULT_LINK_MIN_GBPS, STARTING_MESSAGE } from "./lib/cluster.mjs";
import { downsampleHistory, summarizeHistory } from "./lib/history.mjs";
import { hostAllowed, hostRules, SECURITY_HEADERS } from "./lib/http-guard.mjs";
import { publicState } from "./lib/public-state.mjs";
import { loadTopology, nodeInterfaces, publicTopology, topologyServers } from "./lib/topology.mjs";

// node:sqlite (the token ledger) needs Node 22.13 or later; say so instead of failing on the import.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Spark Scope needs Node.js 22.13 or later; this is ${process.versions.node}. See "Requirements" in README.md.`);
  process.exit(1);
}
const { UsageStore } = await import("./lib/usage-store.mjs");

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, "public");
// Shown in the settings dialog's About section.
const VERSION = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")).version;
// When a rack panel last polled this server (see /api/state); null until one does.
let rackSeenAt = null;

// Whole numbers only: "2s" or "1e4" are rejected instead of being read as 2 or 1.
function positiveInteger(name, fallback, minimum = 1) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a whole number of at least ${minimum}, got "${raw}"`);
  return value;
}

function portNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`${name} must be a port number (0 picks a free one), got "${raw}"`);
  return value;
}

// Checked here because fetch would otherwise put a malformed URL, or one with a password, into its error messages,
// which reach the pages. The value itself is never printed.
function inferenceUrl(name, fallback) {
  const raw = process.env[name] || fallback;
  let url = null;
  try { url = new URL(raw); } catch { /* reported below */ }
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${name} must be an http:// or https:// URL without a user name or password, such as http://127.0.0.1:8000`);
  }
  return raw;
}

function validTimeZone(timeZone) {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    throw new Error(`SPARK_SCOPE_TIME_ZONE is not a valid IANA time zone: "${timeZone}"`);
  }
}

const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
const config = {
  host: process.env.SPARK_SCOPE_HOST || "127.0.0.1",
  port: portNumber("SPARK_SCOPE_PORT", 8787),
  apiUrl: inferenceUrl("SPARK_SCOPE_API_URL", "http://127.0.0.1:8000"),
  nodeIntervalMs: positiveInteger("SPARK_SCOPE_NODE_INTERVAL_MS", 5000, 1000),
  apiIntervalMs: positiveInteger("SPARK_SCOPE_API_INTERVAL_MS", 2000, 500),
  usageDbPath: process.env.SPARK_SCOPE_USAGE_DB || path.join(dataHome, "spark-scope", "usage.sqlite"),
  timeZone: validTimeZone(process.env.SPARK_SCOPE_TIME_ZONE),
  linkMinGbps: positiveInteger("SPARK_SCOPE_LINK_MIN_GBPS", DEFAULT_LINK_MIN_GBPS),
  allowedHosts: process.env.SPARK_SCOPE_ALLOWED_HOSTS || "",
};
const hosts = hostRules({ bindHost: config.host, allowed: config.allowedHosts });
const HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;
const HISTORY_LIMIT = Math.ceil(HISTORY_WINDOW_MS / Math.min(config.nodeIntervalMs, config.apiIntervalMs)) + 20;

// Nodes, SSH targets and links come from topology.json (or the file named by SPARK_SCOPE_TOPOLOGY).
const topology = loadTopology();
const nodeDefinitions = topology.nodes.map((node) => ({ ...node, interfaces: nodeInterfaces(topology, node.id) }));

// One inference API per model server: those listed under "servers" in topology.json, or SPARK_SCOPE_API_URL for every
// node. The first server's sessions keep the ledger's plain keys; the others prefix their id (see usage-store.mjs).
for (const server of topology.servers ?? []) {
  if (server.apiKeyEnv && !process.env[server.apiKeyEnv]) console.warn(`Server ${server.id}: its apiKeyEnv variable is empty or unset`);
}
const servers = topologyServers(topology, config.apiUrl).map((server, index) => ({
  ...server,
  collector: new InferenceCollector(server.api, { apiKeyEnv: server.apiKeyEnv }),
  keyPrefix: index === 0 ? "" : `${server.id}:`,
  lastServedModel: null,
}));
const apiKeyEnvNames = servers.map(server => server.apiKeyEnv).filter(Boolean);
// A ledger that cannot be opened (corrupt file, wrong permissions) turns off token counting, not the dashboard.
let usageStore = null;
let usageOpenError = null;
try {
  usageStore = new UsageStore(config.usageDbPath, { timeZone: config.timeZone });
} catch (error) {
  usageOpenError = `Token ledger unavailable: ${error.message}`;
  console.error(`${usageOpenError} (${config.usageDbPath})`);
}
const unavailableUsage = () => ({ persistent: false, error: usageOpenError, updatedAt: new Date().toISOString() });
const state = {
  status: "starting",
  message: STARTING_MESSAGE,
  messageKey: "status.starting",
  messageParams: {},
  inference: null,
  // Per model server: its nodes, its API reading, which of its nodes serve and its inference state (no API URLs).
  servers: servers.map(({ id, name, nodes, implicit }) => ({ id, name, nodes, implicit: Boolean(implicit), inference: null, serving: null, inferenceState: "unknown" })),
  topology: publicTopology(topology),
  nodes: Object.fromEntries(topology.nodes.map((node) => [node.id, null])),
  ringLinks: {},
  serving: null,
  inferenceState: "unknown",
  history: [],
  usage: usageStore ? usageStore.summary() : unavailableUsage(),
  startedAt: new Date().toISOString(),
  updatedAt: null,
};

let collectingNodes = false;
// When the last chart point was added (one per poll interval, whichever server answers first).
let lastHistoryAt = 0;
// Ledger errors repeat every poll; log a message when it changes and at most every ten minutes otherwise.
let lastUsageError = { message: null, at: 0 };
// Full node collection errors go to the log when they change; the browser only gets a short reason.
const lastNodeErrors = new Map();
const lastGpuMemoryKinds = new Map();
const lastNodePlatforms = new Map();
const lastNodeBatteries = new Map();
// Refused Host names, logged once each so a missing SPARK_SCOPE_ALLOWED_HOSTS entry is easy to spot.
const refusedHosts = new Set();

function refreshClusterStatus() {
  state.ringLinks = buildRingLinks(state.nodes, topology, { minGbps: config.linkMinGbps });
  for (const server of state.servers) {
    const members = new Set(server.nodes);
    server.serving = servingSummary(state.nodes, server.inference, { nodes: topology.nodes.filter((meta) => members.has(meta.id)) });
    server.inferenceState = serverState(server, state.nodes, topology).inferenceState;
  }
  // inference and serving are the first server's, for pages and scripts written for one server.
  state.inference = state.servers[0].inference;
  state.serving = state.servers[0].serving;
  Object.assign(state, clusterStatus(state.nodes, state.servers, state.ringLinks, topology));
  state.updatedAt = new Date().toISOString();
}

// One server's chart fields, null while its API does not answer.
function historyFields(inference) {
  return {
    outputTokensPerSecond: inference?.ok ? inference.outputTokensPerSecond ?? null : null,
    promptTokensPerSecond: inference?.ok ? inference.promptTokensPerSecond ?? null : null,
    runningRequests: inference?.ok ? inference.runningRequests ?? null : null,
    queue: inference?.ok ? inference.waitingRequests ?? null : null,
  };
}

function addHistoryPoint() {
  if (state.servers.every((server) => !server.inference)) return;
  const each = state.servers.map((server) => historyFields(server.inference));
  // The chart fields are the sum over the servers that answered (with one server, its own values).
  const sum = (field) => {
    const values = each.map((fields) => fields[field]).filter(Number.isFinite);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const point = {
    at: Date.now(),
    outputTokensPerSecond: sum("outputTokensPerSecond"),
    promptTokensPerSecond: sum("promptTokensPerSecond"),
    runningRequests: sum("runningRequests"),
    queue: sum("queue"),
    // With several servers, each one's own fields by server id.
    ...(state.servers.length > 1 ? { servers: Object.fromEntries(state.servers.map((server, index) => [server.id, each[index]])) } : {}),
    // Per node id: { temperature, memoryAvailableBytes }. Unreachable or uncollected nodes stay null.
    nodes: Object.fromEntries(topology.nodes.map(({ id }) => {
      const node = state.nodes[id];
      return [id, {
        temperature: node?.ok ? node.gpu?.temperature ?? null : null,
        memoryAvailableBytes: node?.ok ? node.gpu?.memory?.availableBytes ?? null : null,
      }];
    })),
  };
  state.history.push(point);
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  while (state.history.length > HISTORY_LIMIT || (state.history[0] && state.history[0].at < cutoff)) {
    state.history.shift();
  }
}

async function collectNodes() {
  if (collectingNodes) return;
  collectingNodes = true;
  try {
    const snapshots = await Promise.all(nodeDefinitions.map((definition) => (
      definition.collect ? collectNode(definition, { apiKeyEnvNames }) : uncollectedNode(definition))));
    for (let index = 0; index < nodeDefinitions.length; index += 1) {
      const definition = nodeDefinitions[index];
      const previous = state.nodes[definition.id];
      const next = snapshots[index];
      if (next.platform) lastNodePlatforms.set(definition.id, next.platform);
      else if (next.ok) { lastNodePlatforms.delete(definition.id); lastNodeBatteries.delete(definition.id); }
      else if (lastNodePlatforms.has(definition.id)) next.platform = lastNodePlatforms.get(definition.id);
      if (typeof next.power?.hasBattery === "boolean") lastNodeBatteries.set(definition.id, next.power.hasBattery);
      if (next.platform === "darwin") {
        next.power = { systemWatts: null, batteryPercent: null, onAC: null, ...next.power, hasBattery: next.power?.hasBattery ?? lastNodeBatteries.get(definition.id) ?? null };
        if (!next.ok) next.gpu = { memory: { kind: lastGpuMemoryKinds.get(definition.id) ?? null, totalBytes: null, usedBytes: null, availableBytes: null } };
      }
      const kind = next.gpu?.memory?.kind;
      if (kind) lastGpuMemoryKinds.set(definition.id, kind);
      else applyGpuMemoryFallback(next, lastGpuMemoryKinds.get(definition.id));
      state.nodes[definition.id] = applyNetworkRates(next, previous);
      const error = snapshots[index]?.error ?? null;
      if (error !== (lastNodeErrors.get(definition.id) ?? null)) {
        console.error(error ? `Node ${definition.name}: ${error}` : `Node ${definition.name}: collecting again`);
        lastNodeErrors.set(definition.id, error);
      }
    }
    refreshClusterStatus();
  } finally {
    collectingNodes = false;
  }
}

// A model switch starts that server's chart again: with one server the whole chart (as the averages mix models
// otherwise), with several only the switched server's own series.
function restartChart(index) {
  if (servers.length === 1) {
    state.history = [];
    return;
  }
  const id = servers[index].id;
  for (const point of state.history) if (point.servers?.[id]) point.servers[id] = historyFields(null);
}

// Books one server's reading in the ledger. Today's totals and the reported counters cover every server; session,
// modelName and processStartedAt describe the first server's run, like inference.
function bookUsage(index, next) {
  if (!usageStore) {
    state.usage = unavailableUsage();
    return;
  }
  try {
    const result = next.ok ? usageStore.record(next, Date.now(), { keyPrefix: servers[index].keyPrefix }) : null;
    const own = index === 0 && result ? result : state.usage;
    state.usage = { ...(result ?? usageStore.summary()), session: own.session, modelName: own.modelName, processStartedAt: own.processStartedAt };
  } catch (error) {
    state.usage = { ...state.usage, error: error.message, updatedAt: new Date().toISOString() };
    const now = Date.now();
    if (error.message !== lastUsageError.message || now - lastUsageError.at > 10 * 60_000) {
      console.error(`Token usage store: ${error.message}`);
      lastUsageError = { message: error.message, at: now };
    }
  }
}

// Each server is polled on its own, so one that does not answer (up to the 4 s request timeout) does not hold up the
// others.
async function collectServer(index) {
  const server = servers[index];
  if (server.collecting) return;
  server.collecting = true;
  try {
    const next = await server.collector.collect();
    // The model of the server's last successful poll: a restart in between (failed polls) does not hide a switch.
    if (next.ok && next.modelName) {
      if (server.lastServedModel && server.lastServedModel !== next.modelName) restartChart(index);
      server.lastServedModel = next.modelName;
    }
    state.servers[index].inference = next;
    bookUsage(index, next);
    refreshClusterStatus();
    // One chart point per poll interval, with the latest reading of every server.
    if (servers.length === 1 || Date.now() - lastHistoryAt >= config.apiIntervalMs * 0.8) {
      addHistoryPoint();
      lastHistoryAt = Date.now();
    }
  } finally {
    server.collecting = false;
  }
}

function collectInference() {
  return Promise.all(servers.map((server, index) => collectServer(index)));
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
]);

async function serveStatic(urlPath, response, root = PUBLIC_ROOT) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.endsWith("/") ? `${urlPath}index.html` : urlPath);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.resolve(root, `.${normalized}`);
  if (!filePath.startsWith(root + path.sep)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("not a file");
    const data = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes.get(path.extname(filePath)) ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(data);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

// JSON, gzip-compressed when the client accepts it (the state payload shrinks to a fraction).
function sendJson(request, response, status, body) {
  const text = JSON.stringify(body);
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept-Encoding" };
  if (text.length > 1024 && /\bgzip\b/.test(request.headers["accept-encoding"] ?? "")) {
    response.writeHead(status, { ...headers, "Content-Encoding": "gzip" });
    response.end(gzipSync(text));
    return;
  }
  response.writeHead(status, headers);
  response.end(text);
}

async function handle(request, response) {
  if (!hostAllowed(request.headers.host, hosts)) {
    const name = String(request.headers.host).slice(0, 100);
    if (!refusedHosts.has(name) && refusedHosts.size < 50) {
      refusedHosts.add(name);
      console.error(`Refused a request for host "${name}". If this is how you reach the dashboard, add it to SPARK_SCOPE_ALLOWED_HOSTS.`);
    }
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Host not allowed. Add it to SPARK_SCOPE_ALLOWED_HOSTS on the dashboard server.");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }
  let url;
  try {
    url = new URL(request.url, "http://localhost");
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Bad request");
    return;
  }
  if (url.pathname === "/api/state") {
    // The rack panel marks its polls, so the web page can offer rack settings only where a rack panel is in use.
    // Only the time is kept (in memory), not who asked.
    if (url.searchParams.get("from") === "rack") rackSeenAt = new Date().toISOString();
    const requestedMinutes = Number(url.searchParams.get("minutes") || 60);
    const minutes = [15, 60, 360].includes(requestedMinutes) ? requestedMinutes : 60;
    const history = state.history.filter(point => point.at >= Date.now() - minutes * 60_000);
    // history=0 leaves out the samples: pages poll every two seconds and fetch the full history only now and then.
    const withHistory = url.searchParams.get("history") !== "0";
    sendJson(request, response, 200, publicState(state, {
      history: withHistory ? downsampleHistory(history) : undefined,
      historyStats: summarizeHistory(history, minutes),
      pollIntervals: { nodeMs: config.nodeIntervalMs, apiMs: config.apiIntervalMs },
      version: VERSION,
      rackSeenAt,
    }));
    return;
  }
  if (url.pathname === "/api/health") {
    sendJson(request, response, state.status === "offline" ? 503 : 200, { status: state.status, message: state.message, updatedAt: state.updatedAt });
    return;
  }
  if (url.pathname === "/api/usage") {
    const month = url.searchParams.get("month") ?? "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      sendJson(request, response, 400, { error: "month must use YYYY-MM format" });
      return;
    }
    if (!usageStore) {
      sendJson(request, response, 503, { error: usageOpenError });
      return;
    }
    try {
      sendJson(request, response, 200, usageStore.month(month));
    } catch (error) {
      sendJson(request, response, 500, { error: error.message });
    }
    return;
  }
  // The rack panel (public/rack/) for a bar display or kiosk.
  if (url.pathname === "/rack" || url.pathname === "/mini") {
    response.writeHead(302, { Location: `${url.pathname}/${url.search}` }).end();
    return;
  }
  await serveStatic(url.pathname, response);
}

const server = createServer((request, response) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  handle(request, response).catch((error) => {
    console.error(`Request ${request.url}: ${error.message}`);
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Internal error");
  });
});

await Promise.all([collectNodes(), collectInference()]);
const nodeTimer = setInterval(collectNodes, config.nodeIntervalMs);
const inferenceTimer = setInterval(collectInference, config.apiIntervalMs);
nodeTimer.unref();
inferenceTimer.unref();

server.on("error", (error) => {
  console.error(`Spark Scope cannot listen on ${config.host}:${config.port}: ${error.message}`);
  usageStore?.close();
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const shown = config.host.includes(":") ? `[${config.host}]` : config.host;
  console.log(`Spark Scope: http://${shown}:${server.address().port}/ (rack panel: /rack/)`);
  if (!["127.0.0.1", "::1", "localhost"].includes(config.host)) {
    console.log("Warning: listening beyond localhost. Spark Scope has no authentication; expose it only on a network you trust.");
    console.log(`Accepted host names: localhost, IP addresses, ${hosts.short}, ${hosts.short}.local, ${hosts.short}.<tailnet>.ts.net${config.allowedHosts ? `, ${config.allowedHosts}` : ""} (SPARK_SCOPE_ALLOWED_HOSTS adds more).`);
  }
  console.log(servers.length === 1 && servers[0].implicit
    ? `Inference API: ${servers[0].api}`
    : `Model servers: ${servers.map((server) => `${server.id}=${server.api} (${server.nodes.join(", ")})`).join("; ")}`);
  console.log(usageStore ? `Token ledger: ${config.usageDbPath} (days in ${usageStore.timeZone})` : usageOpenError);
  console.log(`Topology: ${topology.source} (${topology.nodes.map((node) => `${node.name}=${!node.collect ? "not collected" : node.local ? "local" : `ssh ${node.host}`}`).join(", ")})`);
});

function shutdown() {
  clearInterval(nodeTimer);
  clearInterval(inferenceTimer);
  server.close(() => {
    usageStore?.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
