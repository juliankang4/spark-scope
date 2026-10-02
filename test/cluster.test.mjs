import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRingLinks, clusterStatus, servingSummary } from '../lib/cluster.mjs';
import { applyNetworkRates } from '../lib/collectors.mjs';
import { normalizeTopology } from '../lib/topology.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawExample = (count) => JSON.parse(readFileSync(path.join(ROOT, 'examples', `topology.${count}-node.json`), 'utf8'));
const P1A = 'enp1s0f1np1', P1B = 'enP2p1s0f1np1', P0A = 'enp1s0f0np0', P0B = 'enP2p1s0f0np0';
const nic = (up = true, rateGbps = 0, speedGbps = 200) => ({ available: true, up, speedGbps: up ? speedGbps : -0.001, rateGbps: up ? rateGbps : null, errors: 0, dropped: 0 });
// Rates are distinct per node and port so the tests can see which interfaces a link pairs.
const node = (id, { p1 = true, p0 = true, base = 0, proc = true } = {}) => ({
  ok: true, collected: true, id, name: `spark-${id}`, systemState: 'running', failedUnits: 0,
  inferenceProcessUp: proc, inferenceProcessReady: proc, rank: null, expectedRank: null, inference: { engine: proc ? 'SGLang' : null },
  gpu: { thermalSlowdown: false },
  network: { [P1A]: nic(p1, base + 1), [P1B]: nic(p1, base + 2), [P0A]: nic(p0, base + 3), [P0B]: nic(p0, base + 4) },
});
const uncollected = (id) => ({ ok: false, collected: false, id, name: `spark-${id}`, error: null });
function ring({ collect1 = true, cabled12 = true } = {}) {
  const raw = rawExample(4);
  raw.nodes[0].collect = collect1;
  raw.links[0].cabled = cabled12;
  return normalizeTopology(raw);
}
const fourNodes = () => ({ 1: node('1', { base: 0 }), 2: node('2', { base: 10 }), 3: node('3', { base: 20 }), 4: node('4', { base: 30 }) });

test('ring links pair the configured interfaces and average both endpoints', () => {
  const links = buildRingLinks(fourNodes(), ring());
  // 1-2: spark-1 port 0 (3) with spark-2 port 1 (11).
  assert.equal(links['1-2'].a.rateGbps, 7);
  // 2-3: spark-2 port 0 (13) with spark-3 port 1 (21); B plane 14 and 22.
  assert.equal(links['2-3'].a.rateGbps, 17);
  assert.equal(links['2-3'].b.rateGbps, 18);
  // 3-4: spark-3 port 0 (23) with spark-4 port 1 (31). 4-1: spark-4 port 0 (33) with spark-1 port 1 (1).
  assert.equal(links['3-4'].a.rateGbps, 27);
  assert.equal(links['4-1'].a.rateGbps, 17);
  assert.ok(Object.values(links).every((link) => link.state === 'up' && link.a.observedEnds === 2));
});

test('a single node has no links and is judged on the node and the API alone', () => {
  const topology = normalizeTopology(rawExample(1));
  const nodes = { 1: { ...node('1'), network: {} } };
  const links = buildRingLinks(nodes, topology);
  assert.deepEqual(links, {});
  assert.deepEqual(clusterStatus(nodes, { ok: true }, links, topology), { status: 'healthy', inferenceState: 'serving', message: 'Node and inference API healthy' });
  // A machine without systemd reports no system state; that alone is not a fault.
  nodes['1'].systemState = null;
  assert.equal(clusterStatus(nodes, { ok: true }, links, topology).status, 'healthy');
  // One serving node is not labelled with a node count.
  assert.equal(servingSummary(nodes, { ok: true, engine: 'vLLM' }, topology).label, 'vLLM');
  nodes['1'].inferenceProcessUp = false; nodes['1'].inferenceProcessReady = false;
  assert.equal(clusterStatus(nodes, { ok: false }, links, topology).message, '1 node connected, no inference process');
  assert.equal(clusterStatus({ 1: { ok: false, collected: true, id: '1' } }, { ok: false }, links, topology).message, 'Cannot reach the node');
});

test('two cables between two nodes are judged separately', () => {
  const topology = normalizeTopology(rawExample(2));
  const nodes = { 1: node('1', { base: 0 }), 2: node('2', { base: 10 }) };
  const links = buildRingLinks(nodes, topology);
  assert.deepEqual(Object.keys(links), ['1-2a', '1-2b']);
  // Cable a joins port 0 on both nodes (3 and 13), cable b port 1 (1 and 11).
  assert.equal(links['1-2a'].a.rateGbps, 8);
  assert.equal(links['1-2b'].a.rateGbps, 6);
  assert.equal(clusterStatus(nodes, { ok: true }, links, topology).status, 'healthy');
  // Pull the second cable: its ports go dark on both ends while the first cable stays up.
  nodes['1'].network[P1A] = nic(false); nodes['1'].network[P1B] = nic(false);
  nodes['2'].network[P1A] = nic(false); nodes['2'].network[P1B] = nic(false);
  const pulled = buildRingLinks(nodes, topology);
  assert.equal(pulled['1-2a'].state, 'up');
  assert.equal(pulled['1-2b'].state, 'down');
  assert.equal(clusterStatus(nodes, { ok: true }, pulled, topology).message, 'QSFP link needs attention');
  // With only one cable configured, the unused ports are not reported at all.
  const oneCable = normalizeTopology({ ...rawExample(2), links: [rawExample(2).links[0]] });
  assert.equal(clusterStatus(nodes, { ok: true }, buildRingLinks(nodes, oneCable), oneCable).status, 'healthy');
});

test('a link with only one plane configured is judged on that plane', () => {
  const raw = rawExample(2);
  raw.links = [{ id: '1-2', ends: [{ node: '1', a: P0A }, { node: '2', a: P0A }] }];
  const topology = normalizeTopology(raw);
  const nodes = { 1: node('1'), 2: node('2') };
  const links = buildRingLinks(nodes, topology);
  assert.equal(links['1-2'].state, 'up');
  assert.deepEqual(links['1-2'].planes, ['a']);
  assert.equal(links['1-2'].b.available, false);
});

test('the minimum healthy link speed is configurable', () => {
  const topology = normalizeTopology(rawExample(2));
  const nodes = { 1: node('1'), 2: node('2') };
  for (const n of Object.values(nodes)) for (const nicName of Object.keys(n.network)) n.network[nicName] = nic(true, 1, 100);
  assert.equal(buildRingLinks(nodes, topology)['1-2a'].slow, true);
  assert.equal(buildRingLinks(nodes, topology, { minGbps: 100 })['1-2a'].slow, false);
});

test('a cable that is not installed yet reads as pending, not as a broken link', () => {
  const nodes = { ...fourNodes(), 1: uncollected('1') };
  nodes['2'].network[P1A] = nic(false);
  nodes['2'].network[P1B] = nic(false);
  for (const n of Object.values(nodes)) { n.inferenceProcessUp = false; n.inferenceProcessReady = false; }
  const pending = buildRingLinks(nodes, ring({ collect1: false, cabled12: false }));
  assert.equal(pending['1-2'].state, 'pending');
  assert.equal(pending['1-2'].a.rateGbps, null);
  const status = clusterStatus(nodes, { ok: false }, pending, ring({ collect1: false, cabled12: false }));
  assert.equal(status.inferenceState, 'stopped');
  assert.equal(status.message, '3 nodes connected, no inference process');
  // Once the cable is expected, the same dark port is a broken link.
  const expected = buildRingLinks(nodes, ring({ collect1: false, cabled12: true }));
  assert.equal(expected['1-2'].state, 'down');
  assert.equal(clusterStatus(nodes, { ok: false }, expected, ring({ collect1: false })).message, 'QSFP link needs attention');
});

test('one collected end vouches for a link to a node that is not collected', () => {
  const nodes = { ...fourNodes(), 1: uncollected('1') };
  const links = buildRingLinks(nodes, ring({ collect1: false }));
  assert.equal(links['4-1'].state, 'up');
  assert.equal(links['4-1'].a.observedEnds, 1);
  assert.equal(links['4-1'].a.rateGbps, 33);
});

test('links nobody can observe stay unknown; dark ports facing a powered-off node are down', () => {
  const nodes = fourNodes();
  nodes['3'] = { ok: false, collected: true, id: '3', name: 'spark-3', error: 'timeout' };
  nodes['2'].network[P0A] = nic(false); nodes['2'].network[P0B] = nic(false);
  nodes['4'].network[P1A] = nic(false); nodes['4'].network[P1B] = nic(false);
  const links = buildRingLinks(nodes, ring());
  assert.equal(links['2-3'].state, 'down');
  assert.equal(links['3-4'].state, 'down');
  assert.equal(links['2-3'].a.rateGbps, null);
  const status = clusterStatus(nodes, { ok: false }, links, ring());
  assert.equal(status.status, 'degraded');
  assert.equal(status.message, 'Node connection needs attention (3/4 reachable)');

  const blind = { ...fourNodes(), 1: uncollected('1'), 2: { ok: false, collected: true, id: '2', name: 'spark-2' } };
  const unknown = buildRingLinks(blind, ring({ collect1: false }));
  assert.equal(unknown['1-2'].state, 'unknown');
  assert.equal(unknown['1-2'].a.available, false);
});

test('one dark plane is a partial link and degrades the cluster', () => {
  const nodes = fourNodes();
  nodes['2'].network[P0B] = nic(false);
  const links = buildRingLinks(nodes, ring());
  assert.equal(links['2-3'].state, 'partial');
  assert.equal(links['2-3'].a.up, true);
  assert.equal(links['2-3'].b.up, false);
  assert.equal(clusterStatus(nodes, { ok: true }, links, ring()).message, 'QSFP link needs attention');
});

test('an uncollected node is left out of the counts and the process check', () => {
  const t = ring({ collect1: false });
  const nodes = { ...fourNodes(), 1: uncollected('1') };
  const links = buildRingLinks(nodes, t);
  assert.equal(clusterStatus(nodes, { ok: true }, links, t).status, 'healthy');
  assert.equal(clusterStatus(nodes, { ok: true }, links, t).message, 'Nodes and inference API healthy (1 not collected)');
  nodes['3'] = { ok: false, collected: true, id: '3', name: 'spark-3' };
  assert.equal(clusterStatus(nodes, { ok: true }, links, t).message, 'Node connection needs attention (2/3 reachable)');
});

test('every node marked for inference must be ready while the API serves', () => {
  const t = ring();
  const nodes = fourNodes();
  const links = buildRingLinks(nodes, t);
  assert.equal(clusterStatus(nodes, { ok: true }, links, t).status, 'healthy');
  nodes['4'].inferenceProcessUp = false; nodes['4'].inferenceProcessReady = false;
  assert.equal(clusterStatus(nodes, { ok: true }, links, t).message, 'Inference API or process needs attention');
  // "inference": false in topology.json lets a node idle.
  const relaxed = normalizeTopology({ ...rawExample(4), nodes: rawExample(4).nodes.map((n) => ({ ...n, inference: n.id !== '4' })) });
  assert.equal(clusterStatus(nodes, { ok: true }, links, relaxed).status, 'healthy');
  // A configured rank must match the observed one.
  nodes['4'].inferenceProcessUp = true; nodes['4'].inferenceProcessReady = true; nodes['4'].rank = 1; nodes['4'].expectedRank = 3;
  assert.equal(clusterStatus(nodes, { ok: true }, links, t).status, 'degraded');
});

test('engine and serving node count come from the API and the nodes, never assumed', () => {
  const t = ring();
  const nodes = fourNodes();
  assert.deepEqual(servingSummary(nodes, { ok: true, engine: 'SGLang' }, t), { engine: 'SGLang', ranks: 4, parallel: 4, complete: true, label: 'SGLang | 4 nodes' });
  // The API's own metrics win over process names; with the API down, the nodes still tell the engine.
  assert.equal(servingSummary(nodes, { ok: true, engine: 'vLLM' }, t).label, 'vLLM | 4 nodes');
  assert.equal(servingSummary(nodes, { ok: false }, t).label, 'SGLang | 4 nodes');
  // With a node not observed, the process count is not the serving node count.
  const partial = { ...nodes, 1: uncollected('1') };
  assert.deepEqual(servingSummary(partial, { ok: true, engine: 'SGLang' }, ring({ collect1: false })), { engine: 'SGLang', ranks: 3, parallel: null, complete: false, label: 'SGLang' });
  for (const n of Object.values(nodes)) { n.inferenceProcessUp = false; n.inference.engine = null; }
  assert.equal(servingSummary(nodes, { ok: false }, t).label, null);
});

test('interface counters compute rates and suppress counter resets and unavailable samples', () => {
  const previous = { ok: true, updatedAt: '2026-09-17T00:00:00Z', network: { [P0A]: { ...nic(true, null), rxBytes: 10, txBytes: 10 }, [P0B]: { ...nic(true, null), rxBytes: 10, txBytes: 10 } } };
  const current = { ok: true, updatedAt: '2026-09-17T00:00:02Z', network: { [P0A]: { ...nic(true, null), rxBytes: 1_000_000_010, txBytes: 1_000_000_010 }, [P0B]: { ...nic(true, null), rxBytes: 0, txBytes: 0 } } };
  applyNetworkRates(current, previous);
  assert.equal(current.network[P0A].rateGbps, 8);
  assert.equal(current.network[P0B].rateGbps, null);
  current.network[P0A].available = false;
  applyNetworkRates(current, previous);
  assert.equal(current.network[P0A].rateGbps, null);
});

test('resolved service failures recover on the next sample without hiding new failures', () => {
  const t = ring();
  const n = fourNodes();
  const links = () => buildRingLinks(n, t);
  n['2'].systemState = 'degraded'; n['2'].failedUnits = 42;
  n['3'].systemState = 'degraded'; n['3'].failedUnits = 4;
  n['4'].systemState = 'degraded'; n['4'].failedUnits = 3;
  assert.equal(clusterStatus(n, { ok: true }, links(), t).message, '49 failed system services need attention');
  for (const v of Object.values(n)) { v.systemState = 'running'; v.failedUnits = 0; }
  assert.equal(clusterStatus(n, { ok: true }, links(), t).status, 'healthy');
  n['4'].systemState = 'degraded'; n['4'].failedUnits = 1;
  assert.equal(clusterStatus(n, { ok: true }, links(), t).message, '1 failed system service needs attention');
  n['4'].failedUnits = 0;
  assert.equal(clusterStatus(n, { ok: true }, links(), t).status, 'degraded');
});

test('a reachable node without GPU readings degrades the cluster instead of reading healthy', () => {
  const t = normalizeTopology(rawExample(1));
  const nodes = { 1: { ...node('1'), gpu: { thermalSlowdown: false, available: false, status: 'timeout' } } };
  assert.deepEqual(clusterStatus(nodes, { ok: true }, buildRingLinks(nodes, t), t), {
    status: 'degraded', inferenceState: 'serving', message: 'GPU readings unavailable on spark-1',
  });
  // Older payloads without the flag are judged as before.
  const legacy = { 1: node('1') };
  assert.equal(clusterStatus(legacy, { ok: true }, buildRingLinks(legacy, t), t).status, 'healthy');
});
