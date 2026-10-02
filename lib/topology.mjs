// Node and link configuration. Display names are decoupled from SSH targets, so topology.json is the
// single place that maps a card on the dashboard to a machine and a cable to its network interfaces.
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_TOPOLOGY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "topology.json");

// Where a topology is looked for when SPARK_SCOPE_TOPOLOGY is not set: the user's own file in
// $XDG_CONFIG_HOME/spark-scope (default ~/.config/spark-scope), so editing it never touches the git checkout,
// then the shipped single-node topology.json.
export function userTopologyPath(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), ".config"), "spark-scope", "topology.json");
}

export function defaultTopologyPath(env = process.env) {
  if (env.SPARK_SCOPE_TOPOLOGY) return env.SPARK_SCOPE_TOPOLOGY;
  const user = userTopologyPath(env);
  return existsSync(user) ? user : DEFAULT_TOPOLOGY_PATH;
}

// "host": "local" (or "local": true) collects the machine the dashboard runs on, without SSH.
export const LOCAL_HOST = "local";

const ID_PATTERN = /^[0-9A-Za-z_-]{1,16}$/;
// Linux interface names: at most 15 characters. The pattern also keeps them safe inside the collector shell script.
const INTERFACE_PATTERN = /^[A-Za-z0-9_.-]{1,15}$/;
// An SSH destination: a ~/.ssh/config alias, a hostname, an address or user@host. No spaces, no shell
// syntax and no leading "-", so it can never be read as an ssh option.
const HOST_PATTERN = /^[A-Za-z0-9_.@][A-Za-z0-9_.@:-]{0,252}$/;
const PLANES = ["a", "b"];

function fail(message) {
  throw new Error(`topology: ${message}`);
}

export function normalizeTopology(raw) {
  if (!raw || !Array.isArray(raw.nodes) || !raw.nodes.length) fail("nodes must be a non-empty array");
  const nodes = raw.nodes.map((node, index) => {
    const id = String(node?.id ?? "");
    if (!ID_PATTERN.test(id)) fail(`node ${index} has an invalid id "${id}" (letters, digits, _ or -, at most 16)`);
    const collect = node.collect !== false;
    const rawHost = node.host == null ? "" : String(node.host).trim();
    const local = node.local === true || rawHost.toLowerCase() === LOCAL_HOST;
    if (collect && !local && !HOST_PATTERN.test(rawHost)) fail(`node ${id} needs an SSH "host" (or "host": "local") to be collected`);
    const expectedRank = Number.isInteger(node.expectedRank) ? node.expectedRank : null;
    return {
      id,
      name: String(node.name || id),
      host: local ? LOCAL_HOST : rawHost || null,
      local,
      role: String(node.role || "NODE").toUpperCase(),
      hardware: node.hardware ? String(node.hardware) : null,
      collect,
      // Whether this node must run an inference process while the API serves.
      inference: node.inference !== false,
      expectedRank,
    };
  });
  const ids = new Set();
  for (const node of nodes) {
    if (ids.has(node.id)) fail(`duplicate node id ${node.id}`);
    ids.add(node.id);
  }
  if (nodes.filter((node) => node.local && node.collect).length > 1) fail("only one node can be collected locally");

  const parsed = (raw.links ?? []).map((link, index) => {
    const ends = Array.isArray(link?.ends) ? link.ends : [];
    if (ends.length !== 2) fail(`link ${index} must have exactly two ends`);
    const normalizedEnds = ends.map((end) => {
      const node = String(end?.node ?? "");
      if (!ids.has(node)) fail(`link ${index} refers to unknown node "${node}"`);
      const planes = {};
      for (const plane of PLANES) {
        const nic = end[plane];
        if (nic == null || nic === "") { planes[plane] = null; continue; }
        if (!INTERFACE_PATTERN.test(String(nic))) fail(`link ${index} has an invalid interface name "${nic}"`);
        planes[plane] = String(nic);
      }
      return { node, ...planes };
    });
    if (normalizedEnds[0].node === normalizedEnds[1].node) fail(`link ${index} connects a node to itself`);
    return { raw: link, ends: normalizedEnds, pair: normalizedEnds.map((end) => end.node).sort().join("|") };
  });

  // Two Sparks are often joined by two cables. Parallel links between the same pair get a numbered
  // default id and label ("1-2-1", "1–2 #1") so they stay distinct everywhere.
  const pairCounts = new Map();
  for (const link of parsed) pairCounts.set(link.pair, (pairCounts.get(link.pair) ?? 0) + 1);
  const pairSeen = new Map();
  const links = parsed.map(({ raw: link, ends, pair }) => {
    const pairCount = pairCounts.get(pair);
    const pairIndex = pairSeen.get(pair) ?? 0;
    pairSeen.set(pair, pairIndex + 1);
    const suffix = pairCount > 1 ? pairIndex + 1 : null;
    const id = String(link.id || `${ends[0].node}-${ends[1].node}${suffix ? `-${suffix}` : ""}`);
    const label = String(link.label || `${ends[0].node}–${ends[1].node}${suffix ? ` #${suffix}` : ""}`);
    return {
      id,
      label,
      nodes: ends.map((end) => end.node),
      // Planes with an interface named on at least one end. A link with none is never observed.
      planes: PLANES.filter((plane) => ends.some((end) => end[plane])),
      // false while the cable is not installed yet: a dark port then reads "not cabled", not "down".
      cabled: link.cabled !== false,
      pairIndex,
      pairCount,
      ends,
    };
  });
  const linkIds = new Set();
  for (const link of links) {
    if (linkIds.has(link.id)) fail(`duplicate link id ${link.id}`);
    linkIds.add(link.id);
  }
  return { nodes, links };
}

// Used when no topology file exists at the default location: one card for this machine, collected locally.
export function builtInTopology() {
  const name = hostname().split(".")[0] || "this-node";
  return normalizeTopology({ nodes: [{ id: "1", name, host: LOCAL_HOST }], links: [] });
}

export function loadTopology(filePath = defaultTopologyPath(), { fallback = !process.env.SPARK_SCOPE_TOPOLOGY } = {}) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (fallback && error.code === "ENOENT") return { ...builtInTopology(), source: "built-in (single local node)" };
    fail(`cannot read ${filePath}: ${error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    fail(`${filePath} is not valid JSON: ${error.message}`);
  }
  return { ...normalizeTopology(raw), source: filePath };
}

// The RoCE device that shares a port with a netdev: enp1s0f1np1 -> rocep1s0f1, enP2p1s0f1np1 -> roceP2p1s0f1.
export function rdmaDevice(nic) {
  const match = /^en(.+?)(?:np\d+)?$/.exec(nic);
  return match ? `roce${match[1]}` : null;
}

// Interfaces a node must report: every link end that names this node, deduplicated in link order.
export function nodeInterfaces(topology, nodeId) {
  const seen = new Set();
  for (const link of topology.links) {
    for (const end of link.ends) {
      if (end.node !== nodeId) continue;
      for (const plane of PLANES) if (end[plane]) seen.add(end[plane]);
    }
  }
  return [...seen];
}

// The part of the topology the browser needs (no interface names).
export function publicTopology(topology) {
  return {
    nodes: topology.nodes.map(({ id, name, host, local, role, hardware, collect, inference }) => ({ id, name, host, local, role, hardware, collect, inference })),
    links: topology.links.map(({ id, label, nodes, planes, cabled }) => ({ id, label, nodes, planes, cabled })),
  };
}
