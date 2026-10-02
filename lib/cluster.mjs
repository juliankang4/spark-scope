// Link states and cluster status for the nodes and links named in topology.json.
// On DGX Spark-class machines each QSFP cable carries two logical planes, A (PCIe domain 0) and B (domain 2).

const PLANES = ["a", "b"];
export const DEFAULT_LINK_MIN_GBPS = 200;

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

// up: every configured plane up. partial: some up. down: nothing up and a dark port was seen.
// pending: the cable is not installed yet (topology "cabled": false) and nothing is up. unknown: no end observed.
export function linkState(link, planes) {
  const values = configuredPlanes(link).map((plane) => planes[plane]);
  if (!values.some((plane) => plane?.available)) return "unknown";
  const upCount = values.filter((plane) => plane.up === true).length;
  if (upCount === values.length) return "up";
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
export function servingSummary(nodes, vllm, topology) {
  const list = topology.nodes.map((meta) => nodes[meta.id]);
  const running = list.filter((node) => node?.ok && node.inferenceProcessUp);
  const engines = running.map((node) => node.inference?.engine).filter(Boolean);
  const counts = new Map();
  for (const engine of engines) counts.set(engine, (counts.get(engine) ?? 0) + 1);
  const nodeEngine = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const engine = (vllm?.ok ? vllm.engine : null) ?? nodeEngine;
  // The process count only equals the number of serving nodes when every node was observed.
  const complete = list.every((node) => node?.ok);
  const ranks = running.length;
  const parallel = complete && ranks > 0 ? ranks : null;
  const label = [engine, parallel > 1 ? `${parallel} nodes` : null].filter(Boolean).join(" | ") || null;
  return { engine, ranks, parallel, complete, label };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function clusterStatus(nodes, vllm, ringLinks, topology) {
  const metas = topology.nodes.filter((meta) => meta.collect);
  const list = metas.map((meta) => nodes[meta.id]);
  const total = topology.nodes.length;
  const connected = list.filter((node) => node?.ok).length;
  const allPresent = list.every(Boolean);
  const inferenceState = list.length && list.every((node) => node?.ok) && list.every((node) => !node.inferenceProcessUp) && vllm && !vllm.ok
    ? "stopped" : vllm?.ok ? "serving" : "unknown";
  const disconnected = list.filter((node) => !node?.ok);
  // Reachable, but nvidia-smi gave nothing (hung, missing or failing): often a GPU fault, never "healthy".
  const withoutGpu = list.filter((node) => node?.ok && node.gpu?.available === false);
  const failedServices = list.filter((node) => node?.ok && node.failedUnits > 0);
  const abnormalSystems = list.filter((node) => node?.ok && ((node.systemState != null && node.systemState !== "running") || node.failedUnits !== 0));
  // A cable that is not installed yet and a link nobody can observe are not reported as broken.
  const linksHealthy = Object.values(ringLinks).every((link) => ["pending", "unknown"].includes(link.state) || (link.state === "up" && !link.slow));
  const thermal = list.some((node) => node?.gpu?.thermalSlowdown);
  const required = metas.filter((meta) => meta.inference).map((meta) => nodes[meta.id]);
  const processesReady = required.every((node) => node?.inferenceProcessReady && (!node.container?.detected || node.container.running)
    && (node.expectedRank == null || node.rank === null || node.rank === node.expectedRank));
  const subject = total === 1 ? "Node" : "Nodes";
  if (!allPresent || !vllm) return { status: "starting", inferenceState, message: "Waiting for the first measurements" };
  if (!connected && !vllm.ok) return { status: "offline", inferenceState, message: total === 1 ? "Cannot reach the node" : "Cannot reach any node" };
  if (disconnected.length) return { status: "degraded", inferenceState, message: `Node connection needs attention (${connected}/${list.length} reachable)` };
  if (withoutGpu.length) return { status: "degraded", inferenceState, message: `GPU readings unavailable on ${withoutGpu.map((node) => node.name ?? node.id).join(", ")}` };
  if (failedServices.length) {
    const failed = failedServices.reduce((sum, node) => sum + node.failedUnits, 0);
    return { status: "degraded", inferenceState, message: `${plural(failed, "failed system service")} ${failed === 1 ? "needs" : "need"} attention` };
  }
  if (abnormalSystems.length) return { status: "degraded", inferenceState, message: "Node system state needs attention" };
  if (!linksHealthy) return { status: "degraded", inferenceState, message: "QSFP link needs attention" };
  if (thermal) return { status: "degraded", inferenceState, message: "GPU thermal slowdown detected" };
  if (inferenceState === "stopped") return { status: "degraded", inferenceState, message: `${plural(connected, "node")} connected, no inference process` };
  if (!vllm.ok || !processesReady) return { status: "degraded", inferenceState, message: "Inference API or process needs attention" };
  const uncollected = total - metas.length;
  return { status: "healthy", inferenceState, message: uncollected ? `${subject} and inference API healthy (${uncollected} not collected)` : `${subject} and inference API healthy` };
}
