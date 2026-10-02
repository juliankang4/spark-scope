import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectNode, uncollectedNode, VllmCollector, applyNetworkRates } from "./lib/collectors.mjs";
import { buildRingLinks, clusterStatus, servingSummary, DEFAULT_LINK_MIN_GBPS } from "./lib/cluster.mjs";
import { loadTopology, nodeInterfaces, publicTopology } from "./lib/topology.mjs";
import { UsageStore } from "./lib/usage-store.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, "public");

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
  apiUrl: process.env.SPARK_SCOPE_API_URL || "http://127.0.0.1:8000",
  nodeIntervalMs: positiveInteger("SPARK_SCOPE_NODE_INTERVAL_MS", 5000, 1000),
  apiIntervalMs: positiveInteger("SPARK_SCOPE_API_INTERVAL_MS", 2000, 500),
  usageDbPath: process.env.SPARK_SCOPE_USAGE_DB || path.join(dataHome, "spark-scope", "usage.sqlite"),
  timeZone: validTimeZone(process.env.SPARK_SCOPE_TIME_ZONE),
  linkMinGbps: positiveInteger("SPARK_SCOPE_LINK_MIN_GBPS", DEFAULT_LINK_MIN_GBPS),
};
const HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;
const HISTORY_LIMIT = Math.ceil(HISTORY_WINDOW_MS / Math.min(config.nodeIntervalMs, config.apiIntervalMs)) + 20;

// Nodes, SSH targets and links come from topology.json (or the file named by SPARK_SCOPE_TOPOLOGY).
const topology = loadTopology();
const nodeDefinitions = topology.nodes.map((node) => ({ ...node, interfaces: nodeInterfaces(topology, node.id) }));

const vllmCollector = new VllmCollector(config.apiUrl);
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
  message: "Waiting for the first measurements",
  vllm: null,
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
let collectingVllm = false;
// The model of the last successful poll: a restart in between (failed polls) does not hide a model switch.
let lastServedModel = null;
// Ledger errors repeat every poll; log a message when it changes and at most every ten minutes otherwise.
let lastUsageError = { message: null, at: 0 };

function refreshClusterStatus() {
  state.ringLinks = buildRingLinks(state.nodes, topology, { minGbps: config.linkMinGbps });
  state.serving = servingSummary(state.nodes, state.vllm, topology);
  Object.assign(state, clusterStatus(state.nodes, state.vllm, state.ringLinks, topology));
  state.updatedAt = new Date().toISOString();
}

const HISTORY_FIELDS = ["outputTokensPerSecond", "promptTokensPerSecond", "runningRequests", "queue"];
const HISTORY_NODE_FIELDS = ["temperature", "memoryAvailableBytes"];

function addHistoryPoint() {
  if (!state.vllm) return;
  const point = {
    at: Date.now(),
    outputTokensPerSecond: state.vllm.ok ? state.vllm.outputTokensPerSecond : null,
    promptTokensPerSecond: state.vllm.ok ? state.vllm.promptTokensPerSecond : null,
    runningRequests: state.vllm.ok ? state.vllm.runningRequests : null,
    queue: state.vllm.ok ? state.vllm.waitingRequests : null,
    // Per node id: { temperature, memoryAvailableBytes }. Unreachable or uncollected nodes stay null.
    nodes: Object.fromEntries(topology.nodes.map(({ id }) => {
      const node = state.nodes[id];
      return [id, {
        temperature: node?.ok ? node.gpu?.temperature ?? null : null,
        memoryAvailableBytes: node?.ok ? node.memory?.availableBytes ?? null : null,
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
      definition.collect ? collectNode(definition) : uncollectedNode(definition))));
    for (let index = 0; index < nodeDefinitions.length; index += 1) {
      const definition = nodeDefinitions[index];
      const previous = state.nodes[definition.id];
      state.nodes[definition.id] = applyNetworkRates(snapshots[index], previous);
    }
    refreshClusterStatus();
  } finally {
    collectingNodes = false;
  }
}

async function collectVllm() {
  if (collectingVllm) return;
  collectingVllm = true;
  try {
    const nextVllm = await vllmCollector.collect();
    if (nextVllm.ok && nextVllm.modelName) {
      if (lastServedModel && lastServedModel !== nextVllm.modelName) state.history = [];
      lastServedModel = nextVllm.modelName;
    }
    state.vllm = nextVllm;
    try {
      if (!usageStore) {
        state.usage = unavailableUsage();
      } else if (nextVllm.ok) {
        state.usage = usageStore.record(nextVllm);
      } else {
        const { session, modelName, processStartedAt } = state.usage;
        state.usage = { ...usageStore.summary(), session, modelName, processStartedAt };
      }
    } catch (error) {
      state.usage = { ...state.usage, error: error.message, updatedAt: new Date().toISOString() };
      const now = Date.now();
      if (error.message !== lastUsageError.message || now - lastUsageError.at > 10 * 60_000) {
        console.error(`Token usage store: ${error.message}`);
        lastUsageError = { message: error.message, at: now };
      }
    }
    refreshClusterStatus();
    addHistoryPoint();
  } finally {
    collectingVllm = false;
  }
}

function downsampleHistory(points, targetCount = 360) {
  if (points.length <= targetCount) return points;
  const bucketSize = Math.ceil(points.length / targetCount);
  const output = [];
  for (let index = 0; index < points.length; index += bucketSize) {
    const bucket = points.slice(index, index + bucketSize);
    const last = bucket.at(-1);
    const averaged = { ...last };
    const mean = (values) => {
      const finite = values.filter(Number.isFinite);
      return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
    };
    for (const key of HISTORY_FIELDS) averaged[key] = mean(bucket.map((point) => point[key]));
    averaged.nodes = Object.fromEntries(Object.keys(last.nodes ?? {}).map((id) => [id,
      Object.fromEntries(HISTORY_NODE_FIELDS.map((field) => [field, mean(bucket.map((point) => point.nodes?.[id]?.[field]))]))]));
    output.push(averaged);
  }
  return output;
}

function summarizeHistory(points, minutes = 60) {
  const activeOutputRates = points
    .filter((point) => point.runningRequests > 0 && Number.isFinite(point.outputTokensPerSecond))
    .map((point) => point.outputTokensPerSecond);
  return {
    activeOutputTokensPerSecond: activeOutputRates.length
      ? activeOutputRates.reduce((sum, value) => sum + value, 0) / activeOutputRates.length
      : null,
    activeSamples: activeOutputRates.length,
    windowMinutes: minutes,
  };
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

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function handle(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/api/state") {
    const requestedMinutes = Number(url.searchParams.get("minutes") || 60);
    const minutes = [15, 60, 360].includes(requestedMinutes) ? requestedMinutes : 60;
    const history = state.history.filter(point => point.at >= Date.now() - minutes * 60_000);
    sendJson(response, 200, {
      ...state,
      history: downsampleHistory(history),
      historyStats: summarizeHistory(history, minutes),
    });
    return;
  }
  if (url.pathname === "/api/health") {
    sendJson(response, state.status === "offline" ? 503 : 200, { status: state.status, message: state.message, updatedAt: state.updatedAt });
    return;
  }
  if (url.pathname === "/api/usage") {
    const month = url.searchParams.get("month") ?? "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      sendJson(response, 400, { error: "month must use YYYY-MM format" });
      return;
    }
    if (!usageStore) {
      sendJson(response, 503, { error: usageOpenError });
      return;
    }
    try {
      sendJson(response, 200, usageStore.month(month));
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }
  // The rack panel (public/rack/) for a bar display or kiosk.
  if (url.pathname === "/rack") {
    response.writeHead(302, { Location: `/rack/${url.search}` }).end();
    return;
  }
  await serveStatic(url.pathname, response);
}

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error(`Request ${request.url}: ${error.message}`);
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Internal error");
  });
});

await Promise.all([collectNodes(), collectVllm()]);
const nodeTimer = setInterval(collectNodes, config.nodeIntervalMs);
const vllmTimer = setInterval(collectVllm, config.apiIntervalMs);
nodeTimer.unref();
vllmTimer.unref();

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
  }
  console.log(`Inference API: ${config.apiUrl}`);
  console.log(usageStore ? `Token ledger: ${config.usageDbPath} (days in ${usageStore.timeZone})` : usageOpenError);
  console.log(`Topology: ${topology.source} (${topology.nodes.map((node) => `${node.name}=${!node.collect ? "not collected" : node.local ? "local" : `ssh ${node.host}`}`).join(", ")})`);
});

function shutdown() {
  clearInterval(nodeTimer);
  clearInterval(vllmTimer);
  server.close(() => {
    usageStore?.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
