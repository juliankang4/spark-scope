import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeView, clusterView, timePaths, compact, freeLabel, orderedNodes, nodeLinks, linkReason, reasonText, seriesPoints, panelWidth, bayLayout } from "../public/rack/rack-view.js";
import { compact as webCompact } from "../public/view-data.js";
import { loadTopology, publicTopology } from "../lib/topology.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
const GIB = 2 ** 30;
const example = (count) => publicTopology(loadTopology(path.join(ROOT, "examples", `topology.${count}-node.json`), { fallback: false }));
const TOPOLOGY = example(4);
const META = Object.fromEntries(TOPOLOGY.nodes.map((meta) => [meta.id, meta]));
// Fixed clock settings so time-of-day strings do not depend on the machine running the tests.
const clock = { timeZone: "UTC", locale: "en-GB" };

const healthy = (overrides = {}) => ({
  ok: true, collected: true, host: "spark-3", role: "WORKER", systemState: "running", failedUnits: 0,
  inferenceProcessUp: true, inferenceProcessReady: true,
  gpu: { utilization: 93, temperature: 56, powerWatts: 26.4, thermalSlowdown: false },
  thermals: { tsocCelsius: 57.9 },
  memory: { totalBytes: 121.6 * GIB, availableBytes: 7.7 * GIB },
  disk: { usedPercent: 86, availableBytes: 127 * GIB },
  container: { restarts: 0 },
  kernelEvents: { total: 0, capped: false, lastAt: null },
  ...overrides,
});
const link = (id, state, extra = {}) => ({ id, label: id.replace("-", "–"), nodes: id.split("-").slice(0, 2), cabled: state !== "pending", state, a: { available: state !== "unknown", up: state === "up" }, b: { available: state !== "unknown", up: state === "up" }, ...extra });
const linkStates = (topology, states = {}) => Object.fromEntries(topology.links.map((l) => [l.id, { ...link(l.id, states[l.id] ?? "up"), label: l.label, nodes: l.nodes }]));
const ringState = (states = {}) => ({ topology: TOPOLOGY, ringLinks: linkStates(TOPOLOGY, states) });

test("bays follow the topology order and show display names, not SSH targets", () => {
  const metas = orderedNodes({ topology: TOPOLOGY, nodes: {} });
  assert.deepEqual(metas.map((meta) => meta.name), ["spark-1", "spark-2", "spark-3", "spark-4"]);
  const view = nodeView({ ...META["2"], host: "gpu-box-b" }, healthy({ host: "gpu-box-b" }));
  assert.equal(view.name, "spark-2");
  assert.equal(view.host, "gpu-box-b");
  assert.equal(view.role, "Worker");
  assert.equal(nodeView(META["1"], undefined).role, "Head");
  // A payload without topology still renders its nodes.
  assert.deepEqual(orderedNodes({ nodes: { a: { host: "box-a" } } }).map((meta) => meta.name), ["box-a"]);
});

test("in a ring each bay's link dots show the previous neighbour first, then the next", () => {
  const state = ringState();
  assert.deepEqual(nodeLinks(state, "1").map((l) => l.peer), ["4", "2"]);
  assert.deepEqual(nodeLinks(state, "2").map((l) => l.peer), ["1", "3"]);
  assert.deepEqual(nodeLinks(state, "4").map((l) => l.tag), ["3", "1"]);
  // A link the server has not reported yet is unknown, not up and not a crash.
  assert.equal(nodeLinks({ topology: TOPOLOGY }, "3")[0].state, "unknown");
});

test("a single node has no link dots and the band counts only the node", () => {
  const topology = example(1);
  const state = { topology, ringLinks: {} };
  assert.deepEqual(nodeLinks(state, "1"), []);
  const view = nodeView(topology.nodes[0], healthy(), { links: nodeLinks(state, "1") });
  assert.deepEqual(view.links, []);
  assert.deepEqual(view.reasons, ["OK"]);
  const serving = {
    ...state, status: "healthy", inferenceState: "serving", nodes: { 1: { ok: true } },
    inference: { ok: true, engine: "vLLM", modelName: "example-model", outputTokensPerSecond: 41.2, runningRequests: 1, waitingRequests: 0 },
    serving: { label: "vLLM" }, usage: { today: { total: 1000, requests: 3 } },
  };
  assert.deepEqual(clusterView(serving).lines, ["example-model | vLLM", "Node up | running 1 | waiting 0"]);
  const down = { ...serving, status: "offline", message: "Cannot reach the node", nodes: { 1: { ok: false, collected: true } }, inference: { ok: false } };
  assert.deepEqual(clusterView(down).lines, ["Cannot reach the node", "Node down | spark-1 not responding"]);
});

test("two cables to the one peer get numbered dots, reasons and band notes", () => {
  const topology = example(2);
  const state = { topology, ringLinks: linkStates(topology, { "1-2b": "down" }) };
  assert.deepEqual(nodeLinks(state, "1").map((l) => [l.peer, l.tag]), [["2", "2 #1"], ["2", "2 #2"]]);
  assert.deepEqual(nodeLinks(state, "2").map((l) => l.tag), ["1 #1", "1 #2"]);
  const view = nodeView(topology.nodes[1], healthy(), { links: nodeLinks(state, "2") });
  assert.deepEqual(view.reasons, ["Link 1–2 #2 down"]);
  assert.deepEqual(view.links.map((l) => [l.tag, l.level]), [["1 #1", "good"], ["1 #2", "crit"]]);
  const band = clusterView({
    ...state, status: "degraded", inferenceState: "serving", message: "QSFP link needs attention", nodes: { 1: { ok: true }, 2: { ok: true } },
    inference: { ok: true, modelName: "example-model", runningRequests: 0, waitingRequests: 0 }, serving: { label: "vLLM | 2 nodes" },
  });
  assert.equal(band.level, "warn");
  assert.deepEqual(band.lines, ["example-model | vLLM | 2 nodes", "Nodes 2/2 | Links 1/2 | link 1–2 #2 down | running 0 | waiting 0"]);
});

test("a cable that is not installed yet reads 'not cabled' on both ends; a dark cable reads 'down'", () => {
  const state = ringState({ "1-2": "pending" });
  const spark2 = nodeView(META["2"], healthy(), { links: nodeLinks(state, "2") });
  assert.equal(spark2.level, "warn");
  assert.deepEqual(spark2.reasons, ["Link 1–2 not cabled"]);
  assert.deepEqual(spark2.links, [{ peer: "1", tag: "1", level: "warn" }, { peer: "3", tag: "3", level: "good" }]);
  const broken = ringState({ "2-3": "down" });
  assert.equal(reasonText(nodeView(META["2"], healthy({ inferenceProcessUp: false }), { inferenceOk: true, links: nodeLinks(broken, "2") })), "Link 2–3 down +1");
  assert.deepEqual(nodeView(META["2"], healthy(), { links: nodeLinks(broken, "2") }).links[1], { peer: "3", tag: "3", level: "crit" });
  assert.equal(linkReason(link("2-3", "partial", { a: { available: true, up: true }, b: { available: true, up: false } })), "Link 2–3 B down");
  // A plane nobody can see next to one that is up is a setup question (unknown), not a fault to report.
  assert.equal(linkReason(link("2-3", "unknown", { a: { available: true, up: true }, b: { available: false, up: null } })), null);
  assert.equal(linkReason(link("2-3", "up", { slow: true, a: { available: true, up: true, speedGbps: 100 }, b: { available: true, up: true, speedGbps: 200 } })), "Link 2–3 slow 100G");
  assert.equal(linkReason(link("2-3", "unknown")), null);
});

test("a node that is not collected shows 'not collected' instead of a fault or invented values", () => {
  const state = ringState({ "1-2": "pending" });
  const view = nodeView(META["1"], { ok: false, collected: false, id: "1" }, { links: nodeLinks(state, "1") });
  assert.equal(view.ok, false);
  assert.equal(view.pending, true);
  assert.equal(view.level, "warn");
  assert.deepEqual(view.reasons, ["Link 1–2 not cabled"]);
  assert.equal(view.temp, undefined);
  const quiet = nodeView(META["1"], { ok: false, collected: false }, { links: nodeLinks(ringState(), "1") });
  assert.equal(quiet.level, "idle");
  assert.deepEqual(quiet.reasons, ["not collected"]);
  // A configured node with no sample yet waits; it is not reported as unreachable.
  assert.deepEqual(nodeView(META["3"], undefined).reasons, ["waiting for data"]);
});

test("a healthy node reads OK with usage-based memory and disk figures", () => {
  const view = nodeView(META["3"], healthy());
  assert.equal(view.level, "good");
  assert.deepEqual(view.reasons, ["OK"]);
  assert.equal(view.memUsedPct, 94);
  assert.equal(Math.round(view.diskFreeGiB), 127);
  assert.equal(view.diskWarn, false);
  assert.equal(freeLabel(3610), "3.5 TiB");
  assert.equal(freeLabel(319.3), "319 GiB");
  assert.equal(freeLabel(7.74), "7.7 GiB");
  assert.equal(freeLabel(999.6), "1.0 TiB");
  assert.equal(freeLabel(9.97), "10 GiB");
});

test("the bay header names the actual reasons, most severe first", () => {
  const view = nodeView(META["1"], healthy({
    disk: { usedPercent: 97, availableBytes: 31.4 * GIB },
    kernelEvents: { total: 1, capped: false, lastAt: "2026-09-26T06:12:17.345Z" },
  }), { nowMs: Date.parse("2026-09-26T06:20:00Z"), clock });
  assert.equal(view.level, "warn");
  assert.deepEqual(view.reasons, ["disk 97%", "kernel 1 (06:12)"]);
  const hot = nodeView(META["1"], healthy({ gpu: { utilization: 99, temperature: 91, powerWatts: 30, thermalSlowdown: true }, disk: { usedPercent: 97, availableBytes: GIB } }), { links: nodeLinks(ringState({ "4-1": "down" }), "1") });
  assert.equal(hot.level, "crit");
  assert.deepEqual(hot.reasons.slice(0, 2), ["thermal slowdown", "Link 4–1 down"]);
});

test("past kernel warnings and restarts clear after ten minutes, ongoing conditions stay", () => {
  const node = healthy({
    kernelEvents: { total: 1, capped: false, lastAt: "2026-09-26T06:12:17Z" },
    container: { restarts: 2, startedAt: "2026-09-26T06:10:00Z" },
    disk: { usedPercent: 97, availableBytes: 31 * GIB },
  });
  const soon = nodeView(META["2"], node, { nowMs: Date.parse("2026-09-26T06:19:00Z"), clock });
  assert.deepEqual(soon.reasons, ["restarted ×2", "disk 97%", "kernel 1 (06:12)"]);
  const later = nodeView(META["2"], node, { nowMs: Date.parse("2026-09-26T06:30:00Z"), clock });
  assert.deepEqual(later.reasons, ["disk 97%"]);
  assert.equal(nodeView(META["2"], healthy({ kernelEvents: { total: 3, capped: false, lastAt: null } })).level, "good");
});

test("an unreachable node is critical and never shows zeros for unknown values", () => {
  const view = nodeView(META["3"], { ok: false, collected: true, host: "spark-3", error: "timeout" }, { lastOkAt: "2026-09-26T06:44:00Z", clock });
  assert.equal(view.level, "crit");
  assert.deepEqual(view.reasons, ["no response"]);
  assert.equal(view.lastOk, "06:44");
  assert.equal(view.temp, undefined);
});

test("a missing inference process warns while the API serves, unless the node may idle", () => {
  assert.ok(nodeView(META["4"], healthy({ inferenceProcessUp: false }), { inferenceOk: true }).reasons.includes("no inference process"));
  assert.equal(nodeView({ ...META["4"], inference: false }, healthy({ inferenceProcessUp: false }), { inferenceOk: true }).level, "good");
  assert.equal(nodeView(META["4"], healthy({ inferenceProcessUp: false }), { inferenceOk: false }).level, "good");
});

const nodesAll = (fn = () => ({ ok: true })) => Object.fromEntries(TOPOLOGY.nodes.map((meta) => [meta.id, fn(meta)]));

test("the band says what is serving from data, with node and link counts", () => {
  const serving = {
    ...ringState(), status: "healthy", inferenceState: "serving", message: "Nodes and inference API healthy",
    nodes: nodesAll(),
    inference: { ok: true, engine: "SGLang", modelName: "example-model", outputTokensPerSecond: 75.4, runningRequests: 2, waitingRequests: 0 },
    serving: { label: "SGLang | 4 nodes" },
    usage: { today: { total: 3418250, requests: 412 } },
  };
  const view = clusterView(serving);
  assert.equal(view.title, "Serving");
  assert.equal(view.level, "good");
  assert.deepEqual(view.lines, ["example-model | SGLang | 4 nodes", "Nodes 4/4 | Links 4/4 | running 2 | waiting 0"]);
  assert.equal(view.out, 75.4);
  // No engine information: no engine label, and nothing names an engine by default.
  const bare = clusterView({ ...serving, serving: null, inference: { ...serving.inference, engine: null, runningRequests: 0 } });
  assert.equal(bare.title, "Ready");
  assert.equal(bare.lines[0], "example-model");
  assert.ok(!/vLLM|SGLang/.test(JSON.stringify(bare)));
});

test("idle: stopped inference, a pending cable and a node that is not collected", () => {
  const nodes = nodesAll((meta) => (meta.id === "1" ? { ok: false, collected: false } : { ok: true }));
  const topology = { ...TOPOLOGY, nodes: TOPOLOGY.nodes.map((meta) => ({ ...meta, collect: meta.id !== "1" })) };
  const idle = { ...ringState({ "1-2": "pending" }), topology, status: "degraded", inferenceState: "stopped", message: "3 nodes connected, no inference process", nodes, inference: { ok: false }, usage: { today: { total: 194495, requests: 97 } } };
  const view = clusterView(idle);
  assert.equal(view.title, "Inference stopped");
  assert.equal(view.level, "idle");
  assert.deepEqual(view.lines, ["No model serving", "Nodes 3/4 | Links 3/4 | link 1–2 not cabled | spark-1 not collected"]);
  assert.equal(view.out, null);
});

test("a fault names the unreachable node and keeps the last model while the API is down", () => {
  const nodes = nodesAll((meta) => (meta.id === "3" ? { ok: false, collected: true } : { ok: true }));
  const fault = {
    ...ringState({ "2-3": "down", "3-4": "down" }),
    status: "degraded", inferenceState: "unknown", message: "Node connection needs attention (3/4 reachable)", nodes,
    inference: { ok: false, outputTokensPerSecond: 12 }, usage: { modelName: "example-model", today: { total: 1, requests: 1 } },
  };
  const view = clusterView(fault);
  assert.equal(view.level, "crit");
  assert.equal(view.title, "Inference down");
  assert.deepEqual(view.lines, ["example-model | API not responding", "Nodes 3/4 | Links 2/4 | spark-3 not responding | link 2–3 down"]);
  assert.equal(view.out, null);
  const lost = clusterView(fault, { fetchFailed: true, lastReceivedAt: new Date("2026-09-26T06:46:32Z"), clock });
  assert.equal(lost.level, "crit");
  assert.equal(lost.stale, true);
  assert.equal(lost.title, "SPARK SCOPE disconnected");
  assert.match(lost.lines[1], /06:46:32/);
});

test("temperature traces read the per-node history and break at gaps and missing samples", () => {
  const history = [{ at: 0, nodes: { 2: { temperature: 41 } } }, { at: 2000, nodes: { 2: { temperature: null } } }, { at: 4000, nodes: {} }];
  assert.deepEqual(seriesPoints(history, (p) => p.nodes?.["2"]?.temperature, 0, 5000).map((p) => p.value), [41, null, null]);
  const points = [
    { at: 0, value: 10 }, { at: 2000, value: 12 },
    { at: 60000, value: 30 }, { at: 62000, value: 31 },
    { at: 64000, value: null }, { at: 66000, value: 5 }, { at: 68000, value: 6 },
  ];
  const { line } = timePaths(points, { fromMs: 0, toMs: 70000, width: 700, height: 100, min: 0, max: 40, gapMs: 15000 });
  assert.equal(line.match(/M/g).length, 3);
});

test("token totals use compact units, the same as the web page", () => {
  assert.equal(compact(15943405), "15.9M");
  assert.equal(compact(155347), "155K");
  assert.equal(compact(1061000000), "1.06B");
  assert.equal(compact(null), "—");
  for (const value of [1500, 999_950, 9_552_810, 42, 3.2e9]) assert.equal(compact(value), webCompact(value));
});

test("the panel width defaults to 1920 and can be set from the URL within limits", () => {
  assert.equal(panelWidth(""), 1920);
  assert.equal(panelWidth("?width=2560"), 2560);
  assert.equal(panelWidth("?width=819"), 819);
  assert.equal(panelWidth("?width=100"), 800);
  assert.equal(panelWidth("?width=99999"), 3840);
  assert.equal(panelWidth("?width=wide"), 1920);
});

test("bays switch to the compact layout below 460 logical pixels each; one node spreads out when there is room", () => {
  assert.equal(bayLayout(1, 1920), "wide");
  assert.equal(bayLayout(1, 819), "regular");
  assert.equal(bayLayout(4, 1920), "regular");
  assert.equal(bayLayout(5, 1920), "compact");
  assert.equal(bayLayout(4, 819), "compact");
  assert.equal(bayLayout(2, 819), "compact");
  assert.equal(bayLayout(3, 1440), "regular");
  assert.equal(bayLayout(4, 1800), "compact");
  const css = read("public/rack/rack.css");
  for (const layout of ["wide", "compact"]) assert.match(css, new RegExp(`\\.bays\\[data-layout="${layout}"\\]`));
});

test("the rack page uses only local files, and every font it names is bundled with its license", () => {
  for (const file of ["public/rack/index.html", "public/rack/rack.css", "public/rack/rack.js", "public/rack/rack-view.js"]) {
    const text = read(file);
    assert.ok(!/Bench Scope|GX10/i.test(text), `${file} carries an old name`);
    assert.ok(!/\bTP\d\b/.test(text), `${file} assumes a parallel size`);
  }
  assert.match(read("public/rack/index.html"), /<script type="module" src="rack\.js">/);
  for (const css of ["public/rack/rack.css", "public/styles.css"]) {
    const urls = [...read(css).matchAll(/url\('([^']+)'\)/g)].map((match) => match[1]);
    assert.ok(urls.length > 0);
    for (const url of urls) assert.ok(existsSync(path.resolve(ROOT, path.dirname(css), url)), `${css} names a missing file ${url}`);
  }
  assert.ok(existsSync(path.join(ROOT, "public/fonts/OFL-Archivo.txt")));
  assert.ok(existsSync(path.join(ROOT, "public/fonts/OFL-BebasNeue.txt")));
});

test("a node without GPU readings says why: a hung or failing query is critical, a missing nvidia-smi a warning", () => {
  const noGpu = (status) => healthy({ gpu: { utilization: null, temperature: null, powerWatts: null, thermalSlowdown: false, available: false, status } });
  assert.deepEqual([nodeView(META["2"], noGpu("stuck")).level, nodeView(META["2"], noGpu("stuck")).reasons[0]], ["crit", "nvidia-smi stuck"]);
  assert.deepEqual([nodeView(META["2"], noGpu("timeout")).level, nodeView(META["2"], noGpu("timeout")).reasons[0]], ["crit", "GPU query timed out"]);
  assert.deepEqual([nodeView(META["2"], noGpu("error")).level, nodeView(META["2"], noGpu("error")).reasons[0]], ["crit", "GPU query failed"]);
  assert.deepEqual([nodeView(META["2"], noGpu("missing")).level, nodeView(META["2"], noGpu("missing")).reasons[0]], ["warn", "no nvidia-smi"]);
  assert.equal(nodeView(META["2"], noGpu("timeout")).temp, null);
});

test("the band adds up GPU power over the nodes that report it, and gives way to urgent notes", () => {
  const state = (nodes, status, message) => ({
    ...ringState(), status, inferenceState: "serving", message, nodes,
    inference: { ok: true, engine: "SGLang", modelName: "example-model", outputTokensPerSecond: 0, runningRequests: 0, waitingRequests: 0 },
    serving: { label: "SGLang" }, usage: { today: { total: 0, requests: 0 } },
  });
  const reporting = { 1: healthy({ gpu: { powerWatts: 9.2 } }), 2: healthy({ gpu: { powerWatts: 8.4 } }), 3: healthy({ gpu: { powerWatts: null } }), 4: healthy({ gpu: {} }) };
  assert.equal(clusterView(state(reporting, "healthy", "Nodes and inference API healthy")).lines[1], "Nodes 4/4 | Links 4/4 | GPU 18 W | running 0 | waiting 0");
  // With a node down the note is what matters; the line has no room for both.
  const oneDown = { ...reporting, 4: { ok: false, collected: true } };
  assert.equal(clusterView(state(oneDown, "degraded", "Node connection needs attention (3/4 reachable)")).lines[1], "Nodes 3/4 | Links 4/4 | spark-4 not responding | running 0 | waiting 0");
});
