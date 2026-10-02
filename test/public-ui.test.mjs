import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compact, chartPath, validateMonth, monthOptions, monthLabel, dayLabel, localDay, nodeOrder, linkText, fabricLayout } from '../public/view-data.js';
import { loadTopology, publicTopology } from '../lib/topology.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = (count) => publicTopology(loadTopology(path.join(ROOT, 'examples', `topology.${count}-node.json`), { fallback: false }));

test('token units promote to billions without hiding meaningful precision', () => {
  assert.equal(compact(1_061_000_000), '1.06B');
  assert.equal(compact(1_000_000_000), '1B');
  assert.equal(compact(999_000_000), '999.0M');
  assert.equal(compact(0), '0');
  assert.equal(compact(null), 'unknown');
});

test('monthly totals count cached input once and reject inconsistent responses', () => {
  const totals = {input:1000, compute:200, cache:800, output:100, requests:2, total:1100};
  const payload = {month:'2026-09', day:'2026-09-17', totals, days:[{day:'2026-09-17', ...totals}]};
  assert.equal(validateMonth(payload,'2026-09').totals.total,1100);
  assert.throws(()=>validateMonth(payload,'2026-08'));
  assert.throws(()=>validateMonth({...payload,totals:{...totals,output:101}},'2026-09'));
  const double = {...totals,total:1900};
  assert.throws(()=>validateMonth({...payload,totals:double,days:[{day:'2026-09-17',...double}]},'2026-09'));
  assert.throws(()=>validateMonth({...payload,error:'database unavailable'},'2026-09'));
});

test('charts leave missing observations as gaps and use elapsed time on the x axis', () => {
  const d = chartPath([{at:0,v:0},{at:1000,v:1},{at:2000,v:null},{at:4000,v:2}], 'v', {start:0,end:4000,width:100,height:100,max:2,top:0,bottom:0});
  assert.equal(d,'M0.00 100.00 L25.00 50.00 M100.00 0.00');
});

test('month selection crosses years; calendar days follow the given time zone', () => {
  assert.deepEqual(monthOptions('2025-11','2026-02'),['2026-02','2026-01','2025-12','2025-11']);
  const at = Date.parse('2026-09-30T15:00:00Z');
  assert.equal(localDay(at, 'UTC'), '2026-09-30');
  assert.equal(localDay(at, 'Asia/Tokyo'), '2026-10-01');
  // An unknown zone falls back to the viewer's own instead of breaking the page.
  assert.match(localDay(at, 'Not/AZone'), /^2026-(09-30|10-01)$/);
  assert.equal(monthLabel('2026-09'), 'September 2026');
  assert.equal(dayLabel('2026-09-01'), 'Sep 1');
});

test('cards follow the server topology and links are described without guessing', () => {
  const topology = { nodes: [{ id: '1', name: 'spark-1', collect: false }, { id: '2', name: 'spark-2' }, { id: '3', name: 'spark-3' }] };
  assert.deepEqual(nodeOrder({ topology, nodes: {} }).map(node => node.name), ['spark-1', 'spark-2', 'spark-3']);
  assert.deepEqual(nodeOrder({ nodes: { a: { host: 'box-a' } } }).map(node => node.name), ['box-a']);
  assert.equal(linkText({ state: 'pending' }), 'not cabled yet');
  assert.equal(linkText({ state: 'partial', a: { up: true }, b: { up: false } }), 'A up, B down');
  assert.equal(linkText({ state: 'up', slow: true }), 'A/B up (slow)');
  assert.equal(linkText({ state: 'up', planes: ['a'] }), 'A up');
  assert.equal(linkText(undefined), 'unknown');
});

test('one node, or nodes without links, draw no interconnect diagram', () => {
  assert.equal(fabricLayout(example(1)), null);
  assert.equal(fabricLayout({ ...example(2), links: [] }), null);
  assert.equal(fabricLayout(null), null);
  // A link to a node the topology does not list is skipped rather than drawn to nowhere.
  assert.equal(fabricLayout({ nodes: example(2).nodes, links: [{ id: 'x', nodes: ['1', '9'] }] }), null);
});

test('two cables between two nodes are drawn as two visibly separate lines', () => {
  const layout = fabricLayout(example(2));
  assert.equal(layout.nodes.length, 2);
  // The pair sits side by side, so both cables run horizontally.
  assert.equal(layout.nodes[0].y.toFixed(1), layout.nodes[1].y.toFixed(1));
  assert.ok(layout.nodes[0].x < layout.nodes[1].x);
  const [first, second] = layout.links;
  assert.deepEqual(layout.links.map(line => line.id), ['1-2a', '1-2b']);
  assert.ok(Math.abs(first.y1 - second.y1) >= 10, 'parallel cables are spread apart');
  assert.ok(Math.abs(first.y1 - first.y2) < 0.01 && Math.abs(second.y1 - second.y2) < 0.01, 'each cable stays parallel to the pair');
  // Both stay within the node circles (radius 19), so they still visibly connect the two nodes.
  for (const line of layout.links) assert.ok(Math.abs(line.y1 - layout.nodes[0].y) < 19);
  // The caption moves off the cables.
  assert.ok(layout.caption.y > layout.nodes[0].y + 19);
  // A single cable is drawn straight between the centres.
  const single = fabricLayout({ ...example(2), links: [example(2).links[0]] });
  assert.equal(single.links[0].y1.toFixed(1), single.nodes[0].y.toFixed(1));
});

test('three and four nodes are drawn as a ring with one line per cable', () => {
  for (const count of [3, 4]) {
    const layout = fabricLayout(example(count));
    assert.equal(layout.links.length, count);
    const points = new Set(layout.nodes.map(node => `${node.x.toFixed(0)},${node.y.toFixed(0)}`));
    assert.equal(points.size, count, 'every node has its own position');
    for (const line of layout.links) {
      const ends = [[line.x1, line.y1], [line.x2, line.y2]];
      for (const [x, y] of ends) assert.ok(layout.nodes.some(node => Math.hypot(node.x - x, node.y - y) < 0.01), 'ring cables run centre to centre');
    }
  }
});

test('the web page and the rack panel load nothing from other hosts', () => {
  const files = readdirSync(path.join(ROOT, 'public'), { recursive: true }).filter(file => /\.(html|css|js)$/.test(file));
  assert.ok(files.includes('index.html') && files.some(file => file.endsWith('rack.js')));
  for (const file of files) {
    const content = readFileSync(path.join(ROOT, 'public', file), 'utf8');
    assert.ok(!/https?:\/\//.test(content), `${file} references a remote URL`);
  }
});

test("shipped pages and server strings separate items with bars, not middle dots", async () => {
  const { readdirSync } = await import('node:fs');
  const files = (dir) => readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : /\.(m?js|html|css)$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
  const offenders = [...files('public'), ...files('lib'), 'server.mjs'].filter((file) => readFileSync(path.join(ROOT, file), 'utf8').includes('·'));
  assert.deepEqual(offenders, []);
});

test("both pages link the favicon files that ship with them", async () => {
  const { existsSync } = await import('node:fs');
  for (const page of ['public/index.html', 'public/rack/index.html']) {
    const html = readFileSync(path.join(ROOT, page), 'utf8');
    for (const href of ['/favicon.svg', '/favicon-32.png', '/apple-touch-icon.png']) {
      assert.match(html, new RegExp(`href="${href}"`), `${page} links ${href}`);
      assert.ok(existsSync(path.join(ROOT, 'public', href)), `${href} exists`);
    }
  }
  assert.ok(existsSync(path.join(ROOT, 'public', 'favicon.ico')));
});
