// Synthetic /api/state payloads for the render check, built with the server's own topology and status code
// from the example topologies. All values are made up; nothing is collected.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTopology, publicTopology, nodeInterfaces } from "../lib/topology.mjs";
import { buildRingLinks, clusterStatus, serverState, servingSummary } from "../lib/cluster.mjs";
import { publicState } from "../lib/public-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GIB = 2 ** 30;
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
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
function topologyFor(count, { longNames = false, servers = 0, gpuWorkstations = 0, macNodes = 0 } = {}) {
  const raw = rawTopology(count);
  if (longNames) {
    for (const node of raw.nodes) Object.assign(node, { id: longId(node.id), name: `spark-cluster-node-${node.id}-tokyo` });
    for (const link of raw.links) for (const end of link.ends) end.node = longId(end.node);
  }
  if (servers > 1 && count >= servers) {
    const ids = raw.nodes.map((node) => node.id);
    raw.servers = Array.from({ length: servers }, (_, k) => {
      const from = Math.round((k * count) / servers), to = Math.round(((k + 1) * count) / servers);
      return { id: String.fromCharCode(97 + k), api: `http://spark-${k + 1}:8000`, nodes: ids.slice(from, to) };
    });
  }
  if (gpuWorkstations) raw.servers ??= [{ id: "a", api: "http://example-engine:8000", nodes: raw.nodes.map(node => node.id) }];
  for (let k = 1; k <= gpuWorkstations; k++) {
    const id = String(count + k);
    raw.nodes.push({ id, name: `gpu-${id}`, host: `gpu-${id}`, role: "NODE", hardware: "GPU workstation" });
    raw.servers.push({ id: `gpu-${id}`, api: `http://gpu-${id}:8000`, nodes: [id] });
  }
  const macIds = new Set(raw.nodes.slice(0, macNodes).map(node => node.id));
  for (const node of raw.nodes) if (macIds.has(node.id)) Object.assign(node, { name: `mac-${node.id}`, host: `mac-${node.id}`, hardware: "Apple Silicon", role: "NODE" });
  raw.links = raw.links.filter(link => !link.ends.some(end => macIds.has(end.node)));
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
  7: { unreachable: ["5"], darkLinks: ["4-5", "5-6"], apiDown: true },
  8: { unreachable: ["5"], darkLinks: ["4-5", "5-6"], apiDown: true },
};

function nodeSample(topology, meta, index, { nowMs, ok, proc, darkNics, hot, sparkCount, macThermal }) {
  const updatedAt = new Date(nowMs).toISOString();
  const base = { id: meta.id, name: meta.name, host: meta.host, local: meta.local, role: meta.role, expectedRank: null, updatedAt };
  if (!ok) return { ...base, ok: false, collected: true, hostname: meta.host, latencyMs: 4500, error: `${meta.host}: timed out after 4500 ms` };
  const network = Object.fromEntries(nodeInterfaces(topology, meta.id).map((nic, k) => {
    const up = !darkNics.has(`${meta.id}:${nic}`);
    return [nic, { available: true, up, speedGbps: up ? 200 : -0.001, rxBytes: 1e12, txBytes: 1e12, errors: 0, dropped: 0, rateGbps: up ? (proc ? 2.4 + index * 0.9 + k * 0.3 : 0.01) : null }];
  }));
  const discrete = index >= sparkCount;
  const total = (discrete ? 64 : 121.7) * GIB;
  const available = discrete ? 40 * GIB : (proc ? 9.5 : 101) * GIB + index * 1.3 * GIB;
  const gpuTotal = discrete ? 32 * GIB : total;
  const gpuAvailable = discrete ? (proc ? 12 : 30) * GIB : available;
  if (meta.hardware === "Apple Silicon") {
    const totalBytes = 32 * GIB, availableBytes = (proc ? 16 : 22) * GIB;
    const thermalPressure = macThermal?.[index] ?? (hot ? 2 : 0);
    return {
      ...base, ok: true, collected: true, platform: "darwin", hostname: meta.host, rank: null,
      inferenceProcessUp: proc, inferenceProcessReady: proc, processMemoryBytes: proc ? 1.3 * GIB : null,
      inference: { up: proc, engine: proc ? "llama.cpp" : null, processName: proc ? "llama-server" : null },
      latencyMs: 120, uptimeSeconds: 86400 * 3, systemState: null, failedUnits: 0,
      thermalPressure,
      power: { hasBattery: index % 2 === 0, systemWatts: index % 2 ? null : proc ? 17.7 : 4.2, batteryPercent: index % 2 ? null : 80, onAC: index % 2 ? null : true },
      container: { detected: false, running: false, restarts: 0 },
      gpu: { utilization: proc ? 99 : 0, temperature: null, powerWatts: null, clockMHz: null, performanceState: "N/A", thermalSlowdown: thermalPressure >= 2, available: true, status: "ok", cores: 10,
        memory: { kind: "unified", totalBytes, availableBytes, usedBytes: totalBytes - availableBytes, inUseBytes: (proc ? 2.2 : 0.12) * GIB, allocatedBytes: (proc ? 3 : 0.7) * GIB } },
      memory: { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes, swapUsedBytes: 0.3 * GIB, compressedBytes: 0.88 * GIB, pressureLevel: 1, freePercent: 70 },
      disk: { totalBytes: 926 * GIB, availableBytes: 687 * GIB, usedPercent: 24 },
      thermals: { tsocCelsius: null, ts1pCelsius: null, zones: {} }, nvmeCelsius: null, nicCelsius: null,
      cpu: { load1: 1.4, load5: 1.75, load15: 1.95, cores: 10 }, kernelEvents: { available: false, status: "unavailable", total: 0 }, network: {},
    };
  }
  return {
    ...base, ok: true, collected: true, hostname: meta.local ? "spark-1" : meta.host,
    rank: proc && !discrete && sparkCount > 1 ? index : null,
    inferenceProcessUp: proc, inferenceProcessReady: proc, processMemoryBytes: proc ? (discrete ? 20 : 98) * GIB : 0,
    inference: { up: proc, engine: proc ? "vLLM" : null, processName: proc ? discrete ? "VLLM::EngineCore" : `VLLM::Worker_TP${index}` : null },
    latencyMs: meta.local ? 38 : 22 + index * 3, uptimeSeconds: 86400 * 3, systemState: "running", failedUnits: 0,
    container: proc ? { detected: true, name: "vllm-node", image: "vllm/vllm-openai:latest", running: true, restarts: 0, startedAt: new Date(nowMs - 86400_000).toISOString() } : { detected: false, name: null, image: null, running: false, restarts: 0, startedAt: null },
    gpu: { utilization: proc ? Math.min(100, 88 + index * 3) : 0, temperature: hot ? 91 : (proc ? 57 : 41) + index * 2, powerWatts: proc ? 31.5 + index : 11.2, clockMHz: proc ? 2405 : 208, performanceState: "P0", thermalSlowdown: Boolean(hot), memory: { kind: discrete ? "discrete" : "unified", totalBytes: gpuTotal, availableBytes: gpuAvailable, usedBytes: gpuTotal - gpuAvailable } },
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

// One server's chart fields at a moment; later servers run a smaller, slower model.
function serverHistory(t, wave, serving, k) {
  const busy = serving && t > -48 + k * 9;
  const scale = 1 / (1 + k * 1.4);
  return {
    outputTokensPerSecond: serving ? (busy ? (52 + 14 * (k ? -wave : wave)) * scale : 0) : null,
    promptTokensPerSecond: serving ? 2800 * scale : null,
    runningRequests: serving ? (busy ? 2 : 0) : null,
    queue: serving ? (wave > 0.6 && !k ? 1 : 0) : null,
  };
}

// serving: per model server, whether its API serves (one value for a single server).
function history(topology, nowMs, { serving, unreachable, sparkCount }) {
  const points = [];
  const servers = topology.servers ?? [{ id: "default" }];
  const servingOf = Array.isArray(serving) ? serving : [serving];
  for (let at = nowMs - 60 * 60_000; at <= nowMs; at += 10_000) {
    const t = (at - nowMs) / 60_000;
    const wave = Math.sin(t / 3) * 0.5 + Math.sin(t / 7.3) * 0.5;
    const busy = servingOf[0] && t > -48;
    const each = servers.map((server, k) => serverHistory(t, wave, servingOf[k], k));
    const sum = (field) => { const values = each.map((fields) => fields[field]).filter((value) => value !== null); return values.length ? values.reduce((a, b) => a + b, 0) : null; };
    points.push({
      at,
      outputTokensPerSecond: sum("outputTokensPerSecond"),
      promptTokensPerSecond: sum("promptTokensPerSecond"),
      runningRequests: sum("runningRequests"),
      queue: sum("queue"),
      ...(topology.servers ? { servers: Object.fromEntries(servers.map((server, k) => [server.id, each[k]])) } : {}),
      nodes: Object.fromEntries(topology.nodes.map((meta, index) => [meta.id, unreachable.has(meta.id) && t > -6
        ? { temperature: null, memoryAvailableBytes: null }
        : { temperature: meta.hardware === "Apple Silicon" ? null : (busy ? 56 : 42) + index * 2 + 3 * wave, memoryAvailableBytes: meta.hardware === "Apple Silicon" ? (busy ? 16 : 22) * GIB : index >= sparkCount ? (busy ? 12 : 30) * GIB : (busy ? 10 : 100) * GIB + index * GIB }])),
    });
  }
  return points;
}

// Synthetic model names for the token ledger (the render check accepts them on the Korean pages as data).
export const LEDGER_MODELS = ["example-model", "example-model-fp8", "example-vision-12b", "example-coder-32b", "example-reasoner-70b"];
// The ledger the render check walks through: records start on the 23rd of the first month, the second month is
// complete with all five models, and the third is the current month, three days in.
export const LEDGER_SCENARIO = { start: "2027-04-23", now: Date.parse("2027-06-03T12:00:00Z"), months: ["2027-04", "2027-05", "2027-06"] };

// The models that served on a day of the month, the larger one first on the days with a switch.
function modelsOn(dayOfMonth) {
  if (dayOfMonth <= 6) return [0];
  if (dayOfMonth === 7) return [0, 1];
  if (dayOfMonth <= 14) return [1];
  if (dayOfMonth <= 20) return [2];
  if (dayOfMonth === 21) return [2, 3];
  if (dayOfMonth <= 27) return [0];
  return [4];
}

// One day of made-up use: logical input is 60 to 100 times the output and mostly cache reads, like a chat or agent load.
function usageDay(day) {
  const n = Date.parse(`${day}T00:00:00Z`) / 86_400_000;
  const wave = 0.55 + 0.45 * Math.sin(n * 1.7) * Math.cos(n * 0.37);
  const output = Math.round(180_000 + 2_400_000 * wave * wave);
  const input = Math.round(output * (60 + 40 * Math.abs(Math.sin(n * 0.9))));
  const cache = Math.round(input * (0.88 + 0.1 * Math.abs(Math.cos(n * 1.3))));
  const requests = Math.round(output / (700 + 600 * Math.abs(Math.sin(n * 0.5))));
  return { input, compute: input - cache, cache, output, requests };
}

const FIELDS = ["input", "compute", "cache", "output", "requests"];
const withTotal = (row) => ({ ...row, total: row.input + row.output });

// /api/usage for one month. start is the ledger's first day (by default the first of the month nine months back);
// days before it, after today and a few idle days have no record; today and the month's last day always have one.
export function usageMonth(month, nowMs, { start } = {}) {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const back = new Date(nowMs);
  const firstDay = start ?? new Date(Date.UTC(back.getUTCFullYear(), back.getUTCMonth() - 9, 1)).toISOString().slice(0, 10);
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const days = [];
  const models = new Map();
  for (let d = 1; d <= lastDay; d++) {
    const day = `${month}-${String(d).padStart(2, "0")}`;
    if (day > today) break;
    if (day < firstDay || (d % 9 === 4 && day !== today && d !== lastDay)) continue;
    const whole = usageDay(day), picks = modelsOn(d);
    // On a switch day the second model gets a small share.
    const parts = picks.map((index, k) => {
      const share = picks.length === 1 ? 1 : k === 0 ? 0.85 : 0.15;
      return { modelName: LEDGER_MODELS[index], ...withTotal(Object.fromEntries(FIELDS.map((key) => [key, Math.round(whole[key] * share)]))) };
    });
    const totals = Object.fromEntries(FIELDS.map((key) => [key, parts.reduce((sum, part) => sum + part[key], 0)]));
    days.push({ day, ...withTotal(totals), models: parts });
    for (const part of parts) {
      const model = models.get(part.modelName) ?? { modelName: part.modelName, days: 0, ...Object.fromEntries(FIELDS.map((key) => [key, 0])) };
      model.days += 1;
      for (const key of FIELDS) model[key] += part[key];
      models.set(part.modelName, model);
    }
  }
  const totals = withTotal(Object.fromEntries(FIELDS.map((key) => [key, days.reduce((sum, day) => sum + day[key], 0)])));
  const modelRows = [...models.values()].map(withTotal).sort((a, b) => b.total - a.total);
  return { persistent: true, timeZone: "UTC", month, day: today, days, totals, models: modelRows, firstDay, firstMonth: firstDay.slice(0, 7), lastMonth: today.slice(0, 7), updatedAt: new Date(nowMs).toISOString(), error: null };
}

// servers: split the nodes into that many model servers; offGroup: the last one is switched off (no process, no API).
export function fixtureState(count, mode, nowMs = Date.now(), { longNames = false, servers = 0, offGroup = false, gpuWorkstations = 0, macNodes = 0, macThermal = null, macUnavailable = false, macPending = false, macPowerMissing = false } = {}) {
  const topology = topologyFor(count, { longNames, servers, gpuWorkstations, macNodes });
  const fault = mode === "fault" ? FAULTS[count] : {};
  const nodeId = (id) => (longNames ? longId(id) : id);
  const unreachable = new Set((fault.unreachable ?? []).map(nodeId));
  const darkNics = new Set();
  for (const id of fault.darkLinks ?? []) {
    for (const end of topology.links.find((link) => link.id === id)?.ends ?? []) for (const plane of ["a", "b"]) if (end[plane]) darkNics.add(`${end.node}:${end[plane]}`);
  }
  const proc = mode !== "idle";
  const groups = topology.servers ?? [{ id: "default", name: null, nodes: topology.nodes.map((meta) => meta.id), implicit: true }];
  const offIds = new Set(offGroup && topology.servers ? groups.at(-1).nodes : []);
  const nodes = Object.fromEntries(topology.nodes.map((meta, index) => [meta.id,
    nodeSample(topology, meta, index, { nowMs, ok: !unreachable.has(meta.id), proc: proc && !offIds.has(meta.id), darkNics, hot: (fault.hot ?? []).map(nodeId).includes(meta.id), sparkCount: count, macThermal })]));
  for (const meta of topology.nodes.slice(0, macNodes)) {
    const node = nodes[meta.id];
    if (macPowerMissing && node.power) node.power.systemWatts = null;
    if (macUnavailable || macPending) nodes[meta.id] = { id: node.id, name: node.name, host: node.host, local: node.local, role: node.role, updatedAt: node.updatedAt, platform: "darwin", ok: false, collected: !macPending, power: { hasBattery: node.power?.hasBattery, systemWatts: null }, gpu: { memory: { kind: "unified", totalBytes: null, usedBytes: null, availableBytes: null } } };
  }
  const apiUp = proc && !fault.apiDown;
  const inference = apiUp
    ? {
      ok: true, engine: macNodes === count && !gpuWorkstations ? "llama.cpp" : "vLLM", modelName: longNames ? "example-org/Example-Reasoning-Model-70B-Instruct-FP8-Dynamic" : "example-model", latencyMs: 3,
      outputTokensPerSecond: 61.3, promptTokensPerSecond: 2950, promptComputeTokensPerSecond: 2104, promptCacheTokensPerSecond: 846,
      prefixCacheHitPercent: 41.2, speculativeAcceptancePercent: 0, kvCachePercent: 12.5, tpotP95Seconds: 0.028, ttftP95Seconds: 0.42, tpotP95RecentSeconds: 0.031, ttftP95RecentSeconds: 0.51, latencyWindowSeconds: 300,
      runningRequests: 2, waitingRequests: 0, updatedAt: new Date(nowMs).toISOString(), error: null,
      // New prefills complete in one poll out of six, so the mini window shows prefill bursts between decoding.
      prefillUpdatedAt: new Date(Math.floor(nowMs / 12_000) * 12_000).toISOString(),
    }
    : { ok: false, updatedAt: new Date(nowMs).toISOString(), error: "fetch failed" };
  // Later servers run a smaller model at lower rates; in "fault" the second server's API does not answer either.
  const down = { ok: false, updatedAt: new Date(nowMs).toISOString(), error: "fetch failed" };
  const readings = groups.map((group, k) => {
    if (!k) return inference;
    if (!proc || (offGroup && k === groups.length - 1) || (mode === "fault" && k === 1)) return down;
    const scale = 1 / (1 + k * 1.4);
    return { ...inference, ok: true, modelName: k === 1 ? "example-coder-32b" : `example-model-${k}`, outputTokensPerSecond: 61.3 * scale, promptTokensPerSecond: 2950 * scale, promptComputeTokensPerSecond: 2104 * scale, promptCacheTokensPerSecond: 846 * scale, kvCachePercent: 31.2, prefixCacheHitPercent: 63.4, runningRequests: 1, waitingRequests: 1, error: null };
  });
  const serverList = groups.map((group, k) => ({ id: group.id, name: group.name ?? null, nodes: group.nodes, implicit: Boolean(group.implicit), inference: readings[k] }));
  for (const server of serverList) {
    const members = new Set(server.nodes);
    server.serving = servingSummary(nodes, server.inference, { nodes: topology.nodes.filter((meta) => members.has(meta.id)) });
    server.inferenceState = serverState(server, nodes, topology).inferenceState;
  }
  const ringLinks = buildRingLinks(nodes, topology);
  const month = usageMonth(new Date(nowMs).toISOString().slice(0, 7), nowMs);
  const today = month.days.find((day) => day.day === month.day) ?? { input: 0, compute: 0, cache: 0, output: 0, requests: 0, total: 0 };
  // Shaped by the server's own publicState(), so the pages see exactly what /api/state would send.
  return publicState({
    ...clusterStatus(nodes, serverList, ringLinks, topology),
    inference,
    servers: serverList,
    topology: publicTopology(topology),
    nodes,
    ringLinks,
    serving: serverList[0].serving,
    history: history(topology, nowMs, { serving: readings.map((reading) => reading.ok), unreachable, sparkCount: count }),
    historyStats: { activeOutputTokensPerSecond: apiUp ? 54.8 : null, activeSamples: apiUp ? 280 : 0, windowMinutes: 60 },
    usage: { persistent: true, timeZone: "UTC", day: month.day, modelName: "example-model", today, error: null },
    startedAt: new Date(nowMs - 3 * 3600_000).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
  }, { pollIntervals: { nodeMs: 5000, apiMs: 2000 }, version: VERSION, rackSeenAt: null });
}
