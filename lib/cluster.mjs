// Link states and cluster status for the nodes and links named in topology.json.
// On DGX Spark-class machines each QSFP cable carries two logical planes, A (PCIe domain 0) and B (domain 2).
import { DEFAULT_SERVER_ID } from "./topology.mjs";

const PLANES = ["a", "b"];
export const DEFAULT_LINK_MIN_GBPS = 200;
// The message before the first poll has finished (also the server's initial state).
export const STARTING_MESSAGE = "Waiting for the first measurements";

function observedEnd(node, nic) {
  if (!nic || !node?.ok) return null;
  const sample = node.network?.[nic];
  return sample && sample.available !== false ? sample : null;
}

// Combines what either end reports about one plane. One end is enough: a DAC port only has carrier
// while its peer is up, so a collected neighbour can vouch for a node that is not collected.
export function combinePlane(samples) {
  const seen = samples.filter(Boolean);
  if (!seen.length) {
    return { available: false, up: null, observedEnds: 0, speedGbps: null, rateGbps: null, errors: null, dropped: null };
  }
  const up = seen.every((sample) => sample.up);
  const rates = seen.map((sample) => sample.rateGbps);
  return {
    available: true,
    up,
    observedEnds: seen.length,
    speedGbps: up ? Math.min(...seen.map((sample) => sample.speedGbps)) : null,
    // Average of the endpoints' receive-plus-transmit rates, so traffic is not counted twice.
    rateGbps: up && rates.every(Number.isFinite) ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : null,
    errors: seen.reduce((sum, sample) => sum + (sample.errors ?? 0), 0),
    dropped: seen.reduce((sum, sample) => sum + (sample.dropped ?? 0), 0),
  };
}

function configuredPlanes(link) {
  return Array.isArray(link.planes) ? link.planes : PLANES;
}

// up: every configured plane seen up. partial: a dark plane next to one that is up. down: nothing up and a dark
// port was seen. pending: the cable is not installed yet (topology "cabled": false) and nothing is up. unknown: a
// plane neither end can see (a wrong interface name, both ends uncollected) and nothing seen dark, so a setup
// mistake is not reported as a broken cable.
export function linkState(link, planes) {
  const values = configuredPlanes(link).map((plane) => planes[plane]);
  const seen = values.filter((plane) => plane?.available);
  const upCount = seen.filter((plane) => plane.up === true).length;
  const dark = seen.length - upCount;
  if (!dark) return seen.length === values.length && seen.length ? "up" : "unknown";
  if (upCount > 0) return "partial";
  return link.cabled === false ? "pending" : "down";
}

export function buildRingLinks(nodes, topology, { minGbps = DEFAULT_LINK_MIN_GBPS } = {}) {
  return Object.fromEntries(topology.links.map((link) => {
    const planeNames = configuredPlanes(link);
    const planes = Object.fromEntries(PLANES.map((plane) => [plane,
      combinePlane(link.ends.map((end) => observedEnd(nodes[end.node], end[plane])))]));
    const state = linkState(link, planes);
    const slow = state === "up" && planeNames.some((plane) => !(planes[plane].speedGbps >= minGbps));
    return [link.id, { id: link.id, label: link.label, nodes: link.nodes, planes: planeNames, cabled: link.cabled, state, slow, ...planes }];
  }));
}

// Engine and the number of nodes serving, from what the nodes and the API actually report.
export function servingSummary(nodes, inference, topology) {
  const list = topology.nodes.map((meta) => nodes[meta.id]);
  const running = list.filter((node) => node?.ok && node.inferenceProcessUp);
  const engines = running.map((node) => node.inference?.engine).filter(Boolean);
  const counts = new Map();
  for (const engine of engines) counts.set(engine, (counts.get(engine) ?? 0) + 1);
  const nodeEngine = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const engine = (inference?.ok ? inference.engine : null) ?? nodeEngine;
  // The process count only equals the number of serving nodes when every node was observed.
  const complete = list.every((node) => node?.ok);
  const ranks = running.length;
  const parallel = complete && ranks > 0 ? ranks : null;
  const label = [engine, parallel > 1 ? `${parallel} nodes` : null].filter(Boolean).join(" | ") || null;
  return { engine, ranks, parallel, complete, label };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// The status message is English text for people and scripts; messageKey and messageParams name the same message, so
// the pages can show it in another language (public/i18n.js has the text for each key). Keys stay stable when the
// English wording changes.
const result = (status, inferenceState, message, messageKey, messageParams = {}) => ({ status, inferenceState, message, messageKey, messageParams });

// The model servers to judge: a list of { id, name, nodes, inference }, or one inference reading for every node (the
// usual single server, also how the tests and fixtures call it).
export function serverGroups(servers, topology) {
  if (Array.isArray(servers)) return servers;
  return [{ id: DEFAULT_SERVER_ID, name: null, nodes: topology.nodes.map((meta) => meta.id), inference: servers, implicit: true }];
}

// A name for a server in messages: its configured name, else the model it serves, else its id.
export const serverLabel = (server) => server.name || (server.inference?.ok && server.inference.modelName) || server.id;

// One server's inference state over its own collected nodes. stopped: every node answered, none runs an inference
// process and the API does not answer. ready: the API answers and every node that must serve has a ready process.
export function serverState(server, nodes, topology) {
  const members = new Set(server.nodes);
  const metas = topology.nodes.filter((meta) => meta.collect && members.has(meta.id));
  const list = metas.map((meta) => nodes[meta.id]);
  const inference = server.inference;
  const inferenceState = list.length && list.every((node) => node?.ok) && list.every((node) => !node.inferenceProcessUp) && inference && !inference.ok
    ? "stopped" : inference?.ok ? "serving" : "unknown";
  const required = metas.filter((meta) => meta.inference).map((meta) => nodes[meta.id]);
  const processesReady = required.every((node) => node?.inferenceProcessReady && (!node.container?.detected || node.container.running)
    && (node.expectedRank == null || node.rank === null || node.rank === node.expectedRank));
  return { inferenceState, ready: Boolean(inference?.ok) && processesReady };
}

export function clusterStatus(nodes, servers, ringLinks, topology) {
  const groups = serverGroups(servers, topology);
  const metas = topology.nodes.filter((meta) => meta.collect);
  const list = metas.map((meta) => nodes[meta.id]);
  const total = topology.nodes.length;
  const connected = list.filter((node) => node?.ok).length;
  const allPresent = list.every(Boolean);
  const states = groups.map((server) => ({ server, ...serverState(server, nodes, topology) }));
  // The cluster serves while any server serves; it is stopped only when every server is.
  const inferenceState = states.some((entry) => entry.inferenceState === "serving") ? "serving"
    : states.every((entry) => entry.inferenceState === "stopped") ? "stopped" : "unknown";
  const disconnected = list.filter((node) => !node?.ok);
  // Reachable, but nvidia-smi gave nothing (hung, missing or failing): often a GPU fault, never "healthy".
  const withoutGpu = list.filter((node) => node?.ok && node.gpu?.available === false);
  const failedServices = list.filter((node) => node?.ok && node.failedUnits > 0);
  const abnormalSystems = list.filter((node) => node?.ok && ((node.systemState != null && node.systemState !== "running") || node.failedUnits !== 0));
  // A cable that is not installed yet and a link nobody can observe are not reported as broken.
  const linksHealthy = Object.values(ringLinks).every((link) => ["pending", "unknown"].includes(link.state) || (link.state === "up" && !link.slow));
  const thermal = list.some((node) => node?.gpu?.thermalSlowdown);
  const subject = total === 1 ? "Node" : "Nodes";
  if (!allPresent || groups.some((server) => !server.inference)) return result("starting", inferenceState, STARTING_MESSAGE, "status.starting");
  if (!connected && !groups.some((server) => server.inference.ok)) {
    return total === 1
      ? result("offline", inferenceState, "Cannot reach the node", "status.cannotReachNode")
      : result("offline", inferenceState, "Cannot reach any node", "status.cannotReachAny");
  }
  if (disconnected.length) {
    return result("degraded", inferenceState, `Node connection needs attention (${connected}/${list.length} reachable)`, "status.nodeConnection", { connected, count: list.length });
  }
  if (withoutGpu.length) {
    const names = withoutGpu.map((node) => node.name ?? node.id);
    return result("degraded", inferenceState, `GPU readings unavailable on ${names.join(", ")}`, "status.gpuUnavailable", { nodes: names });
  }
  if (failedServices.length) {
    const failed = failedServices.reduce((sum, node) => sum + node.failedUnits, 0);
    return result("degraded", inferenceState, `${plural(failed, "failed system service")} ${failed === 1 ? "needs" : "need"} attention`, "status.failedServices", { count: failed });
  }
  if (abnormalSystems.length) return result("degraded", inferenceState, "Node system state needs attention", "status.systemState");
  if (!linksHealthy) return result("degraded", inferenceState, "QSFP link needs attention", "status.qsfpLink");
  if (thermal) return result("degraded", inferenceState, "GPU thermal slowdown detected", "status.thermal");
  if (inferenceState === "stopped") {
    return result("degraded", inferenceState, `${plural(connected, "node")} connected, no inference process`, "status.noInferenceProcess", { count: connected });
  }
  const uncollected = total - metas.length;
  if (groups.length > 1) return serversStatus(states, inferenceState, uncollected);
  if (!states[0].ready) return result("degraded", inferenceState, "Inference API or process needs attention", "status.inferenceAttention");
  return uncollected
    ? result("healthy", inferenceState, `${subject} and inference API healthy (${uncollected} not collected)`, "status.healthyUncollected", { count: total, uncollected })
    : result("healthy", inferenceState, `${subject} and inference API healthy`, "status.healthy", { count: total });
}

// Several servers: one that needs attention degrades the status; one that is stopped while another serves is idle by
// choice (a group that is switched off), not a fault.
function serversStatus(states, inferenceState, uncollected) {
  const attention = states.filter((entry) => entry.inferenceState !== "stopped" && !entry.ready).map((entry) => serverLabel(entry.server));
  if (attention.length) {
    const many = attention.length > 1;
    return result("degraded", inferenceState, `Model server${many ? "s" : ""} ${attention.join(", ")} need${many ? "" : "s"} attention`, "status.serverAttention", { servers: attention, count: attention.length });
  }
  const idle = states.filter((entry) => entry.inferenceState === "stopped").map((entry) => serverLabel(entry.server));
  if (idle.length) {
    const many = idle.length > 1;
    return result("healthy", inferenceState, `Nodes healthy, model server${many ? "s" : ""} ${idle.join(", ")} idle`, "status.serversIdle", { idle, count: idle.length });
  }
  const count = states.length;
  return uncollected
    ? result("healthy", inferenceState, `Nodes and ${count} model servers healthy (${uncollected} not collected)`, "status.healthyServersUncollected", { count, uncollected })
    : result("healthy", inferenceState, `Nodes and ${count} model servers healthy`, "status.healthyServers", { count });
}
