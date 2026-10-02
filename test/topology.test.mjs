import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTopology, normalizeTopology, nodeInterfaces, rdmaDevice, publicTopology, DEFAULT_TOPOLOGY_PATH } from "../lib/topology.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const example = (count) => loadTopology(path.join(ROOT, "examples", `topology.${count}-node.json`), { fallback: false });
const P1A = "enp1s0f1np1", P1B = "enP2p1s0f1np1", P0A = "enp1s0f0np0", P0B = "enP2p1s0f0np0";

test("the shipped topology.json is one node collected locally, with no links", () => {
  const topology = loadTopology(DEFAULT_TOPOLOGY_PATH, { fallback: false });
  assert.deepEqual(topology.nodes.map((node) => [node.id, node.name, node.host, node.local, node.collect]), [["1", "spark-1", "local", true, true]]);
  assert.deepEqual(topology.links, []);
  assert.deepEqual(nodeInterfaces(topology, "1"), []);
});

test("a missing default topology falls back to this machine; a missing explicit file is an error", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-topology-"));
  try {
    const missing = path.join(directory, "topology.json");
    const fallback = loadTopology(missing, { fallback: true });
    assert.equal(fallback.nodes.length, 1);
    assert.equal(fallback.nodes[0].local, true);
    assert.equal(fallback.links.length, 0);
    assert.match(fallback.source, /built-in/);
    assert.throws(() => loadTopology(missing, { fallback: false }), /cannot read/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the examples cover one to four nodes; three and four nodes form a ring", () => {
  for (const count of [1, 2, 3, 4]) assert.equal(example(count).nodes.length, count);
  for (const count of [3, 4]) {
    const topology = example(count);
    assert.equal(topology.links.length, count);
    for (const node of topology.nodes) {
      assert.equal(topology.links.filter((link) => link.nodes.includes(node.id)).length, 2, `node ${node.id} has two neighbours`);
      // Each node uses both of its ports, one per neighbour.
      assert.deepEqual(nodeInterfaces(topology, node.id).sort(), [P0A, P0B, P1A, P1B].sort());
    }
  }
  const ring = example(4);
  assert.deepEqual(nodeInterfaces(ring, "1"), [P0A, P0B, P1A, P1B]);
  assert.deepEqual(nodeInterfaces(ring, "2"), [P1A, P1B, P0A, P0B]);
  assert.deepEqual(nodeInterfaces(ring, "99"), []);
});

test("two cables between the same pair of nodes stay two distinct links", () => {
  const pair = example(2);
  assert.deepEqual(pair.links.map((link) => [link.id, link.label, link.nodes, link.pairIndex, link.pairCount]), [
    ["1-2a", "1–2 #1", ["1", "2"], 0, 2],
    ["1-2b", "1–2 #2", ["1", "2"], 1, 2],
  ]);
  assert.equal(pair.nodes[0].local, true);
  assert.equal(pair.nodes[1].local, false);
  assert.equal(pair.nodes[1].host, "spark-2");
  // Without ids, parallel links get numbered ids and labels instead of colliding.
  const ends = (port) => [{ node: "x", a: port }, { node: "y", a: port }];
  const generated = normalizeTopology({ nodes: [{ id: "x", host: "local" }, { id: "y", host: "y" }], links: [{ ends: ends(P0A) }, { ends: ends(P1A) }] });
  assert.deepEqual(generated.links.map((link) => [link.id, link.label, link.planes]), [["x-y-1", "x–y #1", ["a"]], ["x-y-2", "x–y #2", ["a"]]]);
  // A single cable keeps the plain label.
  const single = normalizeTopology({ nodes: [{ id: "x", host: "local" }, { id: "y", host: "y" }], links: [{ ends: ends(P0A) }] });
  assert.deepEqual(single.links.map((link) => [link.id, link.label]), [["x-y", "x–y"]]);
});

test("RoCE device names follow the netdev names", () => {
  assert.equal(rdmaDevice(P1A), "rocep1s0f1");
  assert.equal(rdmaDevice(P1B), "roceP2p1s0f1");
  assert.equal(rdmaDevice(P0A), "rocep1s0f0");
  assert.equal(rdmaDevice(P0B), "roceP2p1s0f0");
  assert.equal(rdmaDevice("wlan0"), null);
});

test("invalid configuration is rejected before anything reaches a shell", () => {
  const base = () => ({
    nodes: [{ id: "1", name: "a", host: "local" }, { id: "2", name: "b", host: "b" }],
    links: [{ id: "1-2", ends: [{ node: "1", a: P0A }, { node: "2", a: P1A }] }],
  });
  assert.doesNotThrow(() => normalizeTopology(base()));
  const injected = base();
  injected.links[0].ends[0].a = "enp1s0'; rm -rf ~; '";
  assert.throws(() => normalizeTopology(injected), /invalid interface name/);
  const unknownEnd = base();
  unknownEnd.links[0].ends[1].node = "7";
  assert.throws(() => normalizeTopology(unknownEnd), /unknown node/);
  const duplicate = base();
  duplicate.nodes[1].id = "1";
  assert.throws(() => normalizeTopology(duplicate), /duplicate node id/);
  const noHost = base();
  delete noHost.nodes[1].host;
  assert.throws(() => normalizeTopology(noHost), /needs an SSH "host"/);
  noHost.nodes[1].collect = false;
  assert.doesNotThrow(() => normalizeTopology(noHost));
  const option = base();
  option.nodes[1].host = "-oProxyCommand=touch";
  assert.throws(() => normalizeTopology(option), /needs an SSH "host"/);
  const twoLocal = base();
  twoLocal.nodes[1] = { id: "2", local: true };
  assert.throws(() => normalizeTopology(twoLocal), /only one node can be collected locally/);
  const selfLink = base();
  selfLink.links[0].ends[1].node = "1";
  assert.throws(() => normalizeTopology(selfLink), /connects a node to itself/);
  // One interface can carry only one plane of one cable.
  const reused = base();
  reused.nodes.push({ id: "3", name: "c", host: "c" });
  reused.links.push({ id: "1-3", ends: [{ node: "1", a: P0A }, { node: "3", a: P1A }] });
  assert.throws(() => normalizeTopology(reused), /interface enp1s0f0np0 on node 1 is used by link 1-2 plane A and by link 1-3 plane A/);
});

test("the browser gets names, roles and links but no interface names", () => {
  const shared = publicTopology(example(4));
  assert.equal(shared.nodes.length, 4);
  assert.deepEqual(shared.links[0], { id: "1-2", label: "1–2", nodes: ["1", "2"], planes: ["a", "b"], cabled: true });
  assert.ok(!JSON.stringify(shared).includes("enp1s0"));
  assert.equal(publicTopology(example(1)).nodes[0].local, true);
});

test("without SPARK_SCOPE_TOPOLOGY the user's own topology is preferred over the shipped one", async () => {
  const { defaultTopologyPath, userTopologyPath } = await import("../lib/topology.mjs");
  const { mkdirSync, writeFileSync, rmSync, mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const config = mkdtempSync(path.join(os.tmpdir(), "spark-scope-config-"));
  try {
    const env = { XDG_CONFIG_HOME: config, HOME: "/nonexistent" };
    assert.equal(userTopologyPath(env), path.join(config, "spark-scope", "topology.json"));
    assert.equal(defaultTopologyPath(env), DEFAULT_TOPOLOGY_PATH);
    mkdirSync(path.join(config, "spark-scope"));
    writeFileSync(path.join(config, "spark-scope", "topology.json"), "{}");
    assert.equal(defaultTopologyPath(env), path.join(config, "spark-scope", "topology.json"));
    assert.equal(defaultTopologyPath({ ...env, SPARK_SCOPE_TOPOLOGY: "/elsewhere/topology.json" }), "/elsewhere/topology.json");
    assert.equal(userTopologyPath({ HOME: "/home/someone" }), "/home/someone/.config/spark-scope/topology.json");
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});
