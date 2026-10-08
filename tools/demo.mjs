// npm run demo: the dashboard, the rack panel and the mini window with made-up data (tools/fixtures.mjs), to try Spark
// Scope without a Spark. Nothing is collected, nothing is written to disk and no other machine is contacted.
//
//   npm run demo                                  # four nodes at http://127.0.0.1:8787
//   npm run demo -- --nodes 2 --mode fault        # two nodes with a fault; modes: serving, fault, idle
//   npm run demo -- --port 8788
//   npm run demo -- --discrete                    # four Sparks and one separate GPU workstation
//   npm run demo -- --servers 2 --off             # four nodes as two model servers (2 + 2), the second one off
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { fixtureState, usageMonth, MODES } from "./fixtures.mjs";
import { SECURITY_HEADERS } from "../lib/http-guard.mjs";

const PUBLIC = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };


// The engine moves through a 20-second cycle so the charts and the mini window have something to show: a prefill
// burst (2 s), decoding (12 s), then idle (6 s). GPU load and temperature follow it.
// servers and offGroup split the nodes into model servers (see fixtures.mjs); later servers run slower.
export function liveState(count, fixtureMode, now, { servers = 0, offGroup = false, discreteGpu = false } = {}) {
  const state = fixtureState(count, fixtureMode, now, { servers, offGroup, discreteGpu });
  const readings = state.servers.map((server) => server.inference);
  if (!readings.some((v) => v?.ok)) return state;
  const cycle = now % 20_000, prefill = cycle < 2000, decode = cycle >= 2000 && cycle < 14_000;
  readings.forEach((v, k) => {
    if (!v?.ok) return;
    const scale = 1 / (1 + k * 1.4);
    v.outputTokensPerSecond = decode ? Number(((58 + 6 * Math.sin(now / 3000)) * scale).toFixed(1)) : 0;
    v.promptComputeTokensPerSecond = Math.round((2100 + 400 * Math.sin(now / 7000)) * scale);
    v.promptTokensPerSecond = v.promptComputeTokensPerSecond + v.promptCacheTokensPerSecond;
    v.prefillUpdatedAt = new Date(prefill ? now : now - (cycle - 2000)).toISOString();
    v.runningRequests = prefill ? 1 : decode ? 2 : 0;
  });
  // inference (and its earlier name) are the first server's, as the server sends them.
  state.inference = state.vllm = readings[0];
  for (const node of Object.values(state.nodes)) {
    if (!node?.ok || !node.gpu) continue;
    if (!prefill && !decode) node.gpu.utilization = 3;
    if (Number.isFinite(node.gpu.temperature)) node.gpu.temperature += prefill ? 6 : decode ? 3 : 0;
  }
  return state;
}

// One demo server: count nodes in the given fixture mode, with the rack panel's last poll kept in memory.
export function demoServer(count, fixtureMode, options = {}) {
  let rackSeenAt = null;
  return createServer((request, response) => void handle(request, response, count, fixtureMode, (seen) => (seen ? (rackSeenAt = seen) : rackSeenAt), options).catch(() => response.writeHead(500).end()));
}

async function handle(request, response, nodes, mode, rack, options) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  const url = new URL(request.url, "http://localhost"), now = Date.now();
  const json = (status, body) => response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  if (url.pathname === "/api/state") {
    const minutes = [15, 60, 360].includes(Number(url.searchParams.get("minutes"))) ? Number(url.searchParams.get("minutes")) : 60;
    const state = liveState(nodes, mode, now, options);
    state.history = url.searchParams.get("history") === "0" ? undefined : state.history.filter((point) => point.at >= now - minutes * 60_000);
    if (url.searchParams.get("from") === "rack") rack(new Date(now).toISOString());
    return json(200, { ...state, rackSeenAt: rack() });
  }
  if (url.pathname === "/api/usage") return json(200, usageMonth(url.searchParams.get("month") || new Date(now).toISOString().slice(0, 7), now));
  if (url.pathname === "/api/health") return json(200, { status: "healthy", message: "demo", updatedAt: new Date(now).toISOString() });
  if (url.pathname === "/rack" || url.pathname === "/mini") return response.writeHead(302, { Location: `${url.pathname}/${url.search}` }).end();
  const file = path.resolve(PUBLIC, `.${path.normalize(decodeURIComponent(url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname))}`);
  try {
    if (!file.startsWith(PUBLIC + path.sep) || !(await stat(file)).isFile()) throw new Error("not found");
    response.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { nodes: { type: "string", default: "4" }, mode: { type: "string", default: "serving" }, port: { type: "string", default: "8787" }, servers: { type: "string", default: "1" }, off: { type: "boolean", default: false }, discrete: { type: "boolean", default: false } } });
  const nodes = Number(values.nodes), port = Number(values.port), mode = values.mode, servers = Number(values.servers);
  const fail = (message) => { console.error(`spark-scope demo: ${message}`); process.exit(2); };
  if (!Number.isInteger(nodes) || nodes < 1 || nodes > 8) fail("--nodes takes 1 to 8");
  if (values.discrete && nodes > 7) fail("--discrete requires --nodes 1 to 7 (8 total nodes maximum)");
  if (!MODES.includes(mode)) fail(`--mode takes ${MODES.join(", ")}`);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port takes 0 to 65535");
  if (!Number.isInteger(servers) || servers < 1 || servers > nodes) fail("--servers takes 1 to the number of nodes");
  const server = demoServer(nodes, mode, { servers, offGroup: values.off, discreteGpu: values.discrete });
  const totalNodes = nodes + Number(values.discrete), totalServers = servers + Number(values.discrete);
  server.listen(port, "127.0.0.1", () => {
    console.log(`Spark Scope demo: http://127.0.0.1:${server.address().port}/ (${totalNodes} node${totalNodes === 1 ? "" : "s"}${totalServers > 1 ? ` as ${totalServers} model servers${values.off ? ", the last one off" : ""}` : ""}, ${mode}; made-up data). Ctrl+C stops it.`);
  });
}
