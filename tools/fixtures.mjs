// Synthetic /api/state payloads for the render check, built with the server's own topology and status code
// from the example topologies. All values are made up; nothing is collected.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTopology, publicTopology, nodeInterfaces } from "../lib/topology.mjs";
import { buildRingLinks, clusterStatus, servingSummary } from "../lib/cluster.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GIB = 2 ** 30;
export const MODES = ["serving", "fault", "idle"];

// One to four nodes use the shipped examples; more nodes get a ring of the same shape.
function rawTopology(count) {
  if (count <= 4) return JSON.parse(readFileSync(path.join(ROOT, "examples", `topology.${count}-node.json`), "utf8"));
  const ids = Array.from({ length: count }, (_, i) => String(i + 1));
  return {
    nodes: ids.map((id, i) => ({ id, name: `spark-${id}`, host: `spark-${id}`, role: i ? "WORKER" : "HEAD", hardware: "DGX Spark" })),
    links: ids.map((id, i) => {
      const next = ids[(i + 1) % count];
      return { id: `${id}-${next}`, ends: [{ node: id, a: "enp1s0f0np0", b: "enP2p1s0f0np0" }, { node: next, a: "enp1s0f1np1", b: "enP2p1s0f1np1" }] };
    }),
  };
}

// longNames: the longest ids (16 characters) and long display names, to check truncation in every view.
const longId = (id) => `gb10-rack-node-${id}`.slice(0, 16);
function topologyFor(count, { longNames = false } = {}) {
  const raw = rawTopology(count);
  if (longNames) {
    for (const node of raw.nodes) Object.assign(node, { id: longId(node.id), name: `spark-cluster-node-${node.id}-tokyo` });
    for (const link of raw.links) for (const end of link.ends) end.node = longId(end.node);
  }
  return normalizeTopology(raw);
}

// What goes wrong in "fault" for each node count.
const FAULTS = {
  1: { hot: ["1"], apiDown: true },
  2: { darkLinks: ["1-2b"] },
  3: { unreachable: ["3"], darkLinks: ["2-3", "3-1"], apiDown: true },
  4: { unreachable: ["3"], darkLinks: ["2-3", "3-4"], apiDown: true },
  5: { unreachable: ["4"], darkLinks: ["3-4", "4-5"], apiDown: true },
  6: { unreachable: ["4"], darkLinks: ["3-4", "4-5"], apiDown: true },
};

function nodeSample(topology, meta, index, { nowMs, ok, proc, darkNics, hot }) {
  const updatedAt = new Date(nowMs).toISOString();
  const base = { id: meta.id, name: meta.name, host: meta.host, local: meta.local, role: meta.role, expectedRank: null, updatedAt };
  if (!ok) return { ...base, ok: false, collected: true, hostname: meta.host, latencyMs: 4500, error: `${meta.host}: timed out after 4500 ms` };
  const network = Object.fromEntries(nodeInterfaces(topology, meta.id).map((nic, k) => {
    const up = !darkNics.has(`${meta.id}:${nic}`);
    return [nic, { available: true, up, speedGbps: up ? 200 : -0.001, rxBytes: 1e12, txBytes: 1e12, errors: 0, dropped: 0, rateGbps: up ? (proc ? 2.4 + index * 0.9 + k * 0.3 : 0.01) : null }];
  }));
  const total = 121.7 * GIB;
  const available = (proc ? 9.5 : 101) * GIB + index * 1.3 * GIB;
  return {
    ...base, ok: true, collected: true, hostname: meta.local ? "spark-1" : meta.host,
    rank: proc && topology.nodes.length > 1 ? index : null,
    inferenceProcessUp: proc, inferenceProcessReady: proc, processMemoryBytes: proc ? 98 * GIB : 0,
    inference: { up: proc, engine: proc ? "vLLM" : null, processName: proc ? `VLLM::Worker_TP${index}` : null },
    latencyMs: meta.local ? 38 : 22 + index * 3, uptimeSeconds: 86400 * 3, systemState: "running", failedUnits: 0,
    container: proc ? { detected: true, name: "vllm-node", image: "vllm/vllm-openai:latest", running: true, restarts: 0, startedAt: new Date(nowMs - 86400_000).toISOString() } : { detected: false, name: null, image: null, running: false, restarts: 0, startedAt: null },
    gpu: { utilization: proc ? Math.min(100, 88 + index * 3) : 0, temperature: hot ? 91 : (proc ? 57 : 41) + index * 2, powerWatts: proc ? 31.5 + index : 11.2, clockMHz: proc ? 2405 : 208, performanceState: "P0", thermalSlowdown: Boolean(hot) },
    thermals: {
      tsocCelsius: (proc ? 58.4 : 44.1) + index,
      ts1pCelsius: (proc ? 57.6 : 43.5) + index,
      zones: Object.fromEntries(["TSOC", "TS0E", "TS0P", "TS1E", "TS1P", "TGPU", "TUNC"].map((zone, z) => [zone, (proc ? 56.8 : 43.2) + index + z * 0.4])),
    },
    nvmeCelsius: (proc ? 46.9 : 39.5) + index,
    nicCelsius: (proc ? 61 : 52) + index,
    cpu: { load1: proc ? 1.42 + index * 0.1 : 0.21, load5: proc ? 1.31 : 0.18, load15: proc ? 1.12 : 0.16, cores: 20 },
    kernelEvents: { available: true, status: "ok", windowHours: 24, total: 0, noMemory: 0, xid: 0, capped: false, lastAt: null, lastMessage: null },
    memory: { totalBytes: total, availableBytes: available, usedBytes: total - available, swapUsedBytes: 0 },
    disk: { totalBytes: 3700 * GIB, availableBytes: hot ? 110 * GIB : (2400 - index * 300) * GIB, usedPercent: hot ? 97 : 35 + index * 8 },
    network,
  };
}

function history(topology, nowMs, { serving, unreachable }) {
  const points = [];
  for (let at = nowMs - 60 * 60_000; at <= nowMs; at += 10_000) {
    const t = (at - nowMs) / 60_000;
    const wave = Math.sin(t / 3) * 0.5 + Math.sin(t / 7.3) * 0.5;
    const busy = serving && t > -48;
    points.push({
      at,
      outputTokensPerSecond: serving ? (busy ? 52 + 14 * wave : 0) : null,
      promptTokensPerSecond: serving ? 2800 : null,
      runningRequests: serving ? (busy ? 2 : 0) : null,
      queue: serving ? (wave > 0.6 ? 1 : 0) : null,
      nodes: Object.fromEntries(topology.nodes.map((meta, index) => [meta.id, unreachable.has(meta.id) && t > -6
        ? { temperature: null, memoryAvailableBytes: null }
        : { temperature: (busy ? 56 : 42) + index * 2 + 3 * wave, memoryAvailableBytes: (busy ? 10 : 100) * GIB + index * GIB }])),
    });
  }
  return points;
}

export function usageMonth(month, nowMs) {
  const days = [];
  const today = new Date(nowMs).toISOString().slice(0, 10);
  for (let d = 1; d <= 28; d++) {
    const day = `${month}-${String(d).padStart(2, "0")}`;
    if (day > today) break;
    if (d % 6 === 0) continue; // a few days without use stay empty rather than zero
    const cache = 400_000 + d * 31_000, compute = 900_000 + d * 52_000, output = 160_000 + d * 9_500, requests = 120 + d * 7;
    days.push({ day, input: cache + compute, compute, cache, output, requests, total: cache + compute + output });
  }
  const totals = days.reduce((sum, day) => Object.fromEntries(Object.keys(sum).map((key) => [key, sum[key] + day[key]])), { input: 0, compute: 0, cache: 0, output: 0, requests: 0, total: 0 });
  return { persistent: true, timeZone: "UTC", month, day: today, days, totals, firstMonth: month, lastMonth: month, updatedAt: new Date(nowMs).toISOString(), error: null };
}

export function fixtureState(count, mode, nowMs = Date.now(), { longNames = false } = {}) {
  const topology = topologyFor(count, { longNames });
  const fault = mode === "fault" ? FAULTS[count] : {};
  const nodeId = (id) => (longNames ? longId(id) : id);
  const unreachable = new Set((fault.unreachable ?? []).map(nodeId));
  const darkNics = new Set();
  for (const id of fault.darkLinks ?? []) {
    for (const end of topology.links.find((link) => link.id === id).ends) for (const plane of ["a", "b"]) if (end[plane]) darkNics.add(`${end.node}:${end[plane]}`);
  }
  const proc = mode !== "idle";
  const nodes = Object.fromEntries(topology.nodes.map((meta, index) => [meta.id,
    nodeSample(topology, meta, index, { nowMs, ok: !unreachable.has(meta.id), proc, darkNics, hot: (fault.hot ?? []).map(nodeId).includes(meta.id) })]));
  const apiUp = proc && !fault.apiDown;
  const vllm = apiUp
    ? {
      ok: true, engine: "vLLM", modelName: longNames ? "example-org/Example-Reasoning-Model-70B-Instruct-FP8-Dynamic" : "example-model", baseUrl: "http://127.0.0.1:8000", latencyMs: 3,
      outputTokensPerSecond: 61.3, promptTokensPerSecond: 2950, promptComputeTokensPerSecond: 2104, promptCacheTokensPerSecond: 846,
      prefixCacheHitPercent: 41.2, speculativeAcceptancePercent: 0, kvCachePercent: 12.5, tpotP95Seconds: 0.028, ttftP95Seconds: 0.42,
      runningRequests: 2, waitingRequests: 0, updatedAt: new Date(nowMs).toISOString(), error: null,
    }
    : { ok: false, readiness: { ready: false, api: false, metrics: false }, baseUrl: "http://127.0.0.1:8000", updatedAt: new Date(nowMs).toISOString(), error: "fetch failed" };
  const ringLinks = buildRingLinks(nodes, topology);
  const month = usageMonth(new Date(nowMs).toISOString().slice(0, 7), nowMs);
  const today = month.days.find((day) => day.day === month.day) ?? { input: 0, compute: 0, cache: 0, output: 0, requests: 0, total: 0 };
  return {
    ...clusterStatus(nodes, vllm, ringLinks, topology),
    vllm,
    topology: publicTopology(topology),
    nodes,
    ringLinks,
    serving: servingSummary(nodes, vllm, topology),
    history: history(topology, nowMs, { serving: apiUp, unreachable }),
    historyStats: { activeOutputTokensPerSecond: apiUp ? 54.8 : null, activeSamples: apiUp ? 280 : 0, windowMinutes: 60 },
    usage: { persistent: true, timeZone: "UTC", day: month.day, modelName: "example-model", today, error: null },
    startedAt: new Date(nowMs - 3 * 3600_000).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
  };
}
