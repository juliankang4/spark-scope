import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compact, duration, tokenRate, chartPath, eventTime, validateMonth, monthOptions, monthLabel, dayLabel, localDay, nodeOrder, linkText, fabricLayout, nodeLabel, labelWidth, nextTheme, COLORS } from '../public/view-data.js';
import { loadTopology, publicTopology } from '../lib/topology.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = (count) => publicTopology(loadTopology(path.join(ROOT, 'examples', `topology.${count}-node.json`), { fallback: false }));

test('token units promote to billions without hiding meaningful precision', () => {
  assert.equal(compact(1_061_000_000), '1.06B');
  assert.equal(compact(1_000_000_000), '1B');
  assert.equal(compact(999_000_000), '999M');
  assert.equal(compact(9_552_810), '9.55M');
  assert.equal(compact(1_500), '1.5K');
  assert.equal(compact(0), '0');
  assert.equal(compact(null), 'unknown');
});

test('numbers pick their unit after rounding, so a boundary never reads 1000 of the smaller unit', () => {
  assert.equal(compact(999_950), '1M');
  assert.equal(compact(999.6), '1K');
  assert.equal(compact(999_499), '999K');
  assert.equal(duration(0.9996), '1.00 s');
  assert.equal(duration(0.9994), '999 ms');
  assert.equal(tokenRate(99.96), '100 tok/s');
  assert.equal(tokenRate(99.94), '99.9 tok/s');
  assert.equal(tokenRate(null), 'unknown');
});

test('a kernel event from an earlier day carries its date', () => {
  const now = Date.parse('2026-10-02T12:00:00');
  assert.match(eventTime('2026-10-02T09:15:00', now), /^\d\d:\d\d:\d\d$/);
  assert.match(eventTime('2026-10-01T23:12:04', now), /^Oct 1 \d\d:\d\d:\d\d$/);
  assert.equal(eventTime(null, now), 'unknown');
});

test('the theme button cycles from the system look to the other one, the system one picked by hand, then system', () => {
  assert.equal(nextTheme(null, 'light'), 'dark');
  assert.equal(nextTheme('dark', 'light'), 'light');
  assert.equal(nextTheme('light', 'light'), null);
  assert.equal(nextTheme(null, 'dark'), 'light');
  assert.equal(nextTheme('light', 'dark'), 'dark');
  assert.equal(nextTheme('dark', 'dark'), null);
  assert.equal(nextTheme('purple', 'dark'), 'light');
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

test('a node whose id is "at" still gets its own trend line, because values are picked per node', () => {
  const history = [{ at: 0, nodes: { at: { temperature: 40 } } }, { at: 1000, nodes: { at: { temperature: 60 } } }];
  const d = chartPath(history, (point) => point.nodes.at.temperature, { start: 0, end: 1000, width: 100, height: 100, min: 40, max: 60, top: 0, bottom: 0 });
  assert.equal(d, 'M0.00 100.00 L100.00 0.00');
});

test('long node ids are shortened in the cable diagram and get a pill wide enough for the label', () => {
  assert.equal(nodeLabel('00'), '00');
  assert.equal(nodeLabel('gb10-rack-node-1'), 'gb10-rack…');
  assert.equal(labelWidth('00'), 38);
  assert.ok(labelWidth('gb10-rack…') >= 10 * 7.2 + 12);
  const layout = fabricLayout(example(4));
  assert.deepEqual(layout.nodes.map((node) => node.label), ['1', '2', '3', '4']);
});

test('eight nodes get eight different colours, and every colour is defined for both themes', () => {
  assert.equal(new Set(COLORS).size, 8);
  const css = readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const light = css.match(/:root\{[^}]*\}/)[0], dark = css.match(/html\[data-theme="dark"\]\{[^}]*\}/)[0];
  for (const color of COLORS) {
    const token = color.match(/var\((--[a-z]+)\)/)[1];
    assert.ok(light.includes(token + ':'), `${token} missing from the light theme`);
    if (token !== '--ink') assert.ok(dark.includes(token + ':'), `${token} missing from the dark theme`);
  }
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

// The server's Content-Security-Policy enforces this at run time (tools/render.mjs fails on a violation); this
// catches it in the source: every src, href, url(), import and fetch target is a path on this server.
test('the web page and the rack panel load nothing from other hosts', () => {
  const files = readdirSync(path.join(ROOT, 'public'), { recursive: true }).filter(file => /\.(html|css|js)$/.test(file));
  assert.ok(files.includes('index.html') && files.some(file => file.endsWith('rack.js')));
  const local = (target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('//');
  for (const file of files) {
    const content = readFileSync(path.join(ROOT, 'public', file), 'utf8');
    assert.ok(!/https?:\/\//.test(content), `${file} references a remote URL`);
    assert.ok(!/@import/.test(content), `${file} imports a stylesheet`);
    const targets = [
      ...content.matchAll(/\b(?:src|href)="([^"]*)"/g),
      ...content.matchAll(/url\(\s*['"]?([^'")]+)/g),
      ...content.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...content.matchAll(/\b(?:fetch|getJson)\(\s*[`'"]([^`'"]+)/g),
    ].map((match) => match[1].trim());
    for (const target of targets) assert.ok(local(target), `${file} loads ${target} from another host`);
  }
  // The checks themselves catch the forms a plain "http" search would miss.
  assert.equal(local('//cdn.example/x.js'), false);
  assert.equal(local('data:text/css,x'), false);
  assert.equal(local('/api/state'), true);
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

test("a change to any card field of the topology rebuilds the cards, not only a change of ids", async () => {
  const { topologyKey } = await import('../public/view-data.js');
  const before = [{ id: '1', name: 'spark-1', host: 'spark-1', role: 'HEAD', collect: false }];
  assert.equal(topologyKey(before), topologyKey([{ ...before[0] }]));
  assert.notEqual(topologyKey(before), topologyKey([{ ...before[0], name: 'renamed' }]));
  assert.notEqual(topologyKey(before), topologyKey([{ ...before[0], collect: true }]));
});

test("data counts as stale after three of the server's slower poll intervals, never sooner than 20 s", async () => {
  const { staleAfterMs } = await import('../public/view-data.js');
  assert.equal(staleAfterMs({}), 20_000);
  assert.equal(staleAfterMs({ pollIntervals: { nodeMs: 5000, apiMs: 2000 } }), 20_000);
  assert.equal(staleAfterMs({ pollIntervals: { nodeMs: 30_000, apiMs: 30_000 } }), 90_000);
});

test("a poll without history adds its own sample to the history the page already has", async () => {
  const { livePoint, mergeLivePoint } = await import('../public/view-data.js');
  const state = {
    updatedAt: '2026-10-02T03:00:02Z',
    inference: { ok: true, updatedAt: '2026-10-02T03:00:02Z', outputTokensPerSecond: 61.3, promptTokensPerSecond: 2104, runningRequests: 2, waitingRequests: 0 },
    nodes: { 1: { ok: true, gpu: { temperature: 57 }, memory: { availableBytes: 9.5 * 2 ** 30 } }, 2: { ok: false } },
  };
  const point = livePoint(state);
  assert.deepEqual(point, {
    at: Date.parse('2026-10-02T03:00:02Z'), outputTokensPerSecond: 61.3, promptTokensPerSecond: 2104, runningRequests: 2, queue: 0,
    nodes: { 1: { temperature: 57, memoryAvailableBytes: 9.5 * 2 ** 30 }, 2: { temperature: null, memoryAvailableBytes: null } },
  });
  const old = { at: point.at - 61 * 60_000 }, recent = { at: point.at - 2000 };
  assert.deepEqual(mergeLivePoint([old, recent], point, 60 * 60_000), [recent, point]);
  // The same sample twice, or an older one, changes nothing.
  assert.deepEqual(mergeLivePoint([recent, point], point, 60 * 60_000), [recent, point]);
  assert.equal(livePoint({ inference: { ok: false }, updatedAt: '2026-10-02T03:00:02Z' }).outputTokensPerSecond, null);
});

test("timeouts and media-query listeners also work where Safari lacks the newer APIs", async () => {
  const { timeoutSignal, onMediaChange } = await import('../public/view-data.js');
  const timed = timeoutSignal(10);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timed.signal.aborted, true);
  const cancelled = timeoutSignal(10);
  cancelled.done();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cancelled.signal.aborted, false);
  const calls = [];
  onMediaChange({ addListener: (fn) => calls.push(['legacy', fn]) }, () => {});
  onMediaChange({ addEventListener: (type, fn) => calls.push([type, fn]) }, () => {});
  assert.deepEqual(calls.map(([kind]) => kind), ['legacy', 'change']);
});
