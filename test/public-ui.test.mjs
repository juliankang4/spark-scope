import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readingValue, nodeColor, lowContrast, PALETTE, compact, duration, tokenRate, chartPath, clockTime, eventTime, memory, memoryUnit, temperature, temperatureUnit, validateMonth, monthOptions, monthLabel, dayLabel, localDay, nodeOrder, linkText, fabricLayout, nodeLabel, labelWidth, nextTheme, COLORS } from '../public/view-data.js';
import { loadTopology, publicTopology } from '../lib/topology.mjs';
import { rackQuery, DEFAULTS, SETTINGS_KEY, parseSettings, loadSettings, saveSettings, loadTheme, saveTheme, settingsQuery, settingsFromQuery, withoutSettingsQuery } from '../public/settings.js';

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
  assert.deepEqual(fabricLayout({ ...example(4), nodes: [...example(4).nodes, { id: '5' }] }), fabricLayout(example(4)));
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
    nodes: { 1: { ok: true, gpu: { temperature: 57, memory: { kind: 'unified', availableBytes: 9.5 * 2 ** 30 } }, memory: { availableBytes: 9.5 * 2 ** 30 } }, 2: { ok: false } },
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

test('settings fall back to the default field by field when stored values are missing or invalid', () => {
  assert.deepEqual(parseSettings(null), DEFAULTS);
  assert.deepEqual(parseSettings('{"temp":"f"}'), DEFAULTS);
  assert.deepEqual(parseSettings([1, 2]), DEFAULTS);
  assert.deepEqual(parseSettings({ temp: 'f', mem: 'tb', clock: 12, range: 60, refresh: 3, pause: 'no', lang: 'fr', extra: 1 }),
    { ...DEFAULTS, temp: 'f' });
  assert.deepEqual(parseSettings({ temp: 'f', mem: 'gb', clock: '12', range: 360, refresh: 10, pause: false, lang: 'ko' }),
    { ...DEFAULTS, temp: 'f', mem: 'gb', clock: '12', range: 360, refresh: 10, pause: false, lang: 'ko' });
  // English is the default language.
  assert.equal(DEFAULTS.lang, 'en');
});

test('settings storage keeps only changed fields and survives broken or missing storage', () => {
  const memoryStore = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), data }; };
  const store = memoryStore();
  assert.equal(saveSettings(store, { ...DEFAULTS, temp: 'f', range: 15, lang: 'ko' }), true);
  assert.equal(store.data.get(SETTINGS_KEY), '{"temp":"f","range":15,"lang":"ko"}');
  assert.deepEqual(loadSettings(store), { ...DEFAULTS, temp: 'f', range: 15, lang: 'ko' });
  saveSettings(store, DEFAULTS);
  assert.equal(store.data.has(SETTINGS_KEY), false);
  store.setItem(SETTINGS_KEY, '{not json');
  assert.deepEqual(loadSettings(store), DEFAULTS);
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadSettings(throwing), DEFAULTS);
  assert.equal(saveSettings(throwing, DEFAULTS), false);
  assert.deepEqual(loadSettings(null), DEFAULTS);
  assert.equal(loadTheme(throwing), null);
  saveTheme(store, 'dark');
  assert.equal(loadTheme(store), 'dark');
  saveTheme(store, null);
  assert.equal(loadTheme(store), null);
});

test('a settings link carries the whole setup and ignores what it does not know', () => {
  const settings = { ...DEFAULTS, temp: 'f', mem: 'gb', clock: '12', range: 15, refresh: 5, pause: false, lang: 'ko' };
  const query = settingsQuery(settings, 'dark');
  assert.equal(query, 'temp=f&mem=gb&clock=12&range=15&refresh=5&pause=0&lang=ko&theme=dark');
  assert.deepEqual(settingsFromQuery(`?${query}`), { settings, theme: 'dark' });
  assert.equal(settingsQuery(DEFAULTS, null), '');
  assert.equal(settingsFromQuery(''), null);
  assert.equal(settingsFromQuery('?view=tokens'), null);
  // A link names only what differs from the defaults, so a missing field resets to its default.
  assert.deepEqual(settingsFromQuery('?temp=f&range=7&pause=maybe&theme=blue'), { settings: { ...DEFAULTS, temp: 'f' }, theme: null });
  // A link with only the language switches only the language; an unknown language reads as English.
  assert.deepEqual(settingsFromQuery('?lang=ko'), { settings: { ...DEFAULTS, lang: 'ko' }, theme: null });
  assert.deepEqual(settingsFromQuery('?lang=fr'), { settings: DEFAULTS, theme: null });
  assert.equal(settingsQuery({ ...DEFAULTS, lang: 'ko' }, null), 'lang=ko');
  assert.equal(withoutSettingsQuery('?temp=f&mem=gb&view=tokens'), '?view=tokens');
  assert.equal(withoutSettingsQuery('?lang=ko&view=tokens'), '?view=tokens');
  assert.equal(withoutSettingsQuery('?temp=f&theme=dark'), '');
});

test('temperatures and memory read in the chosen units', () => {
  assert.equal(temperature(63, 'c'), '63');
  assert.equal(temperature(63, 'f'), '145');
  assert.equal(temperature(47.5, 'f', 1), '117.5');
  assert.equal(temperature(null, 'f'), 'unknown');
  assert.equal(temperatureUnit('f'), '°F');
  assert.equal(memory(122 * 2 ** 30, 'gib', 0), '122');
  assert.equal(memory(122 * 2 ** 30, 'gb', 0), '131');
  assert.equal(memory(10.5 * 2 ** 30, 'gb'), '11.3');
  assert.equal(memoryUnit('gb'), 'GB');
  assert.equal(memoryUnit('anything'), 'GiB');
});

test('the 12-hour clock names AM and PM and drops the leading zero', () => {
  const at = new Date(2026, 9, 3, 18, 4, 5).getTime();
  assert.equal(clockTime(at, { hour12: true }), '6:04:05 PM');
  assert.equal(clockTime(at, { hour12: true, seconds: false }), '6:04 PM');
  assert.match(clockTime(at), /^18.04.05$/);
  assert.match(eventTime(at, at, { hour12: true }), /^6:04:05 PM$/);
});

test('node card settings: four distinct known readings, known bars and panels, whole-number warning levels', () => {
  assert.deepEqual(DEFAULTS.readings, ['temp', 'power', 'mem', 'clock']);
  assert.deepEqual(DEFAULTS.bars, ['unified']);
  assert.deepEqual(DEFAULTS.hide, []);
  assert.equal(DEFAULTS.labels, 'auto');
  const good = { readings: ['temp', 'power', 'disk', 'clock'], bars: ['unified', 'disk'], hide: ['engine', 'trends'], labels: 'short', tempWarn: 80, diskWarn: 90, memWarn: 4 };
  assert.deepEqual(parseSettings(good), { ...DEFAULTS, ...good });
  // Three readings, a repeated one, an unknown one: the slots fall back to the default four.
  for (const readings of [['temp', 'power', 'mem'], ['temp', 'temp', 'mem', 'clock'], ['temp', 'power', 'fan', 'clock'], 'temp,power,mem,clock'])
    assert.deepEqual(parseSettings({ readings }).readings, DEFAULTS.readings, String(readings));
  assert.deepEqual(parseSettings({ bars: [] }).bars, [], 'no bars at all is a valid choice');
  assert.deepEqual(parseSettings({ bars: ['gpu'] }).bars, DEFAULTS.bars);
  assert.deepEqual(parseSettings({ hide: ['ledger', 'ledger'] }).hide, DEFAULTS.hide);
  for (const [key, value] of [['tempWarn', 39], ['tempWarn', 85.5], ['diskWarn', 101], ['memWarn', -1], ['memWarn', '2'], ['labels', 'tiny']])
    assert.equal(parseSettings({ [key]: value })[key], DEFAULTS[key], `${key}=${value}`);
  // A stored list is a copy: changing the parsed settings never changes the defaults.
  const parsed = parseSettings(null);
  parsed.readings[0] = 'cpu';
  assert.equal(DEFAULTS.readings[0], 'temp');
  // In a link the lists are comma-separated.
  const query = settingsQuery({ ...DEFAULTS, temp: 'f', readings: ['temp', 'power', 'disk', 'clock'], bars: ['unified', 'disk'], hide: ['engine'] }, null);
  assert.equal(query, 'temp=f&readings=temp,power,disk,clock&bars=unified,disk&hide=engine');
  assert.deepEqual(settingsFromQuery(`?${query}`).settings, { ...DEFAULTS, temp: 'f', readings: ['temp', 'power', 'disk', 'clock'], bars: ['unified', 'disk'], hide: ['engine'] });
  assert.deepEqual(settingsFromQuery('?bars=').settings.bars, []);
  assert.deepEqual(settingsFromQuery('?readings=temp,power').settings.readings, DEFAULTS.readings);
});

test('card readings give text, unit and warning in the chosen units', async () => {
  const GIB = 2 ** 30;
  const settings = { ...DEFAULTS, temp: 'f' };
  const node = { ok: true, gpu: { temperature: 86, powerWatts: 31.52, clockMHz: 2405, memory: { kind: 'unified', totalBytes: 128 * GIB, availableBytes: 1.5 * GIB, usedBytes: 126.5 * GIB } }, memory: { availableBytes: 1.5 * GIB },
    disk: { totalBytes: 1000 * GIB, availableBytes: 40 * GIB, usedPercent: 96 }, cpu: { load1: 1.834, cores: 20 }, nvmeCelsius: 48, processMemoryBytes: 98.2 * GIB };
  const read = (id) => readingValue(id, node, settings);
  assert.deepEqual(read('temp'), { text: '187', unit: '°F', warn: true });
  assert.deepEqual(read('power'), { text: '31.5', unit: 'W', warn: false });
  assert.deepEqual(read('mem'), { text: '1.5', unit: 'GiB', warn: true });
  assert.deepEqual(read('disk'), { text: '960', unit: 'GiB', warn: true });
  assert.deepEqual(read('diskfree'), { text: '40', unit: 'GiB', warn: true });
  assert.deepEqual(read('cpu'), { text: '1.83', unit: '/ 20', warn: false });
  assert.deepEqual(read('nvme'), { text: '118', unit: '°F', warn: false });
  assert.equal(read('nic').text, 'unknown');
  assert.equal(readingValue('temp', { ok: false }, settings).text, 'unknown');
  assert.equal(readingValue('temp', node, { ...settings, tempWarn: 90 }).warn, false);
  assert.equal(readingValue('mem', node, { ...settings, mem: 'gb' }).unit, 'GB');
  const { gpuMemory, memoryWording, readingLabel, livePoint } = await import('../public/view-data.js');
  const discrete = { ...node, gpu: { ...node.gpu, memory: { kind: 'discrete', totalBytes: 32 * GIB, availableBytes: 12 * GIB, usedBytes: 20 * GIB } }, memory: { availableBytes: 40 * GIB } };
  const unknown = { ...discrete, gpu: { ...node.gpu, memory: { kind: null, totalBytes: null, usedBytes: null, availableBytes: null } } };
  for (const [sample, wording, text, free] of [[node, 'unified', '1.5', 1.5 * GIB], [discrete, 'gpu', '12.0', 12 * GIB], [unknown, 'gpu', 'unknown', null]]) {
    assert.equal(memoryWording([gpuMemory(sample).kind]), wording);
    assert.equal(readingLabel('mem', { wording }), wording === 'unified' ? 'node.reading.mem' : 'node.reading.gpuMem');
    assert.equal(readingValue('mem', sample, settings).text, text);
    assert.equal(livePoint({ updatedAt: '2026-10-02T03:00:02Z', nodes: { 1: sample } }).nodes[1].memoryAvailableBytes, free);
  }
  assert.equal(gpuMemory({ ...discrete, ok: false }).availableBytes, null);
  assert.equal(readingValue('mem', { ...discrete, gpu: {} }, settings).text, 'unknown');
  assert.equal(readingValue('mem', unknown, settings).unit, '');
  assert.equal(memoryWording(['unified', 'discrete']), 'gpu');
});

test('node colours: palette names or hex by position, written without # in a link', () => {
  assert.deepEqual(DEFAULTS.colors, []);
  assert.deepEqual(parseSettings({ colors: ['purple', '#FF8800', 'ff0000'] }).colors, ['purple', '#ff8800', '#ff0000']);
  for (const colors of [['purple', 'pink'], ['#ff88'], 'purple', Array(33).fill('blue')]) assert.deepEqual(parseSettings({ colors }).colors, [], String(colors));
  const query = settingsQuery({ ...DEFAULTS, colors: ['purple', '#ff8800'] }, null);
  assert.equal(query, 'colors=purple,ff8800');
  assert.deepEqual(settingsFromQuery(`?${query}`).settings.colors, ['purple', '#ff8800']);
  // The colour a node gets: its pick, otherwise the default order (which never uses red).
  assert.equal(nodeColor([], 0), 'var(--blue)');
  assert.equal(nodeColor(['purple'], 0), 'var(--purple)');
  assert.equal(nodeColor(['purple', '#ff8800'], 1), '#ff8800');
  assert.equal(nodeColor(['purple'], 3), 'var(--ink)');
  assert.equal(nodeColor([], 8), 'var(--blue)');
  assert.ok(!COLORS.includes('var(--red)'));
  assert.ok(PALETTE.includes('red'));
  // Custom colours that would be hard to see get a warning for the theme in question.
  assert.equal(lowContrast('#ffff00'), 'light');
  assert.equal(lowContrast('#111111'), 'dark');
  assert.equal(lowContrast('#c0392b'), 'dark');
  assert.equal(lowContrast('#7a7a7a'), null);
  assert.equal(lowContrast('purple'), null);
});

test('the kiosk URL carries only what a rack panel reads, with readable lists', () => {
  assert.equal(rackQuery(DEFAULTS), '');
  assert.equal(rackQuery({ ...DEFAULTS, temp: 'f', mem: 'gb', lang: 'ko', range: 15, readings: ['temp', 'power', 'disk', 'clock'], colors: ['purple', '#ff8800'], motion: 'still' }),
    'temp=f&mem=gb&lang=ko&colors=purple,ff8800&motion=still');
  assert.deepEqual(parseSettings({ motion: 'bounce' }).motion, 'step');
  assert.deepEqual(settingsFromQuery('?motion=smooth').settings.motion, 'smooth');
});

test('with several model servers the pages add up their output, or follow the picked one', async () => {
  const { modelServers, severalServers, serverName, serverOfNode, pickedServer, combinedInference, viewInference, livePoint } = await import('../public/view-data.js');
  const at = '2026-10-03T01:00:00.000Z', later = '2026-10-03T01:00:01.000Z';
  const a = { id: 'a', name: null, nodes: ['1', '2'], inference: { ok: true, engine: 'vLLM', modelName: 'big-model', outputTokensPerSecond: 40, promptTokensPerSecond: 1000, runningRequests: 2, waitingRequests: 1, kvCachePercent: 20, ttftP95RecentSeconds: 0.4, prefixCacheHitPercent: 50, updatedAt: at }, inferenceState: 'serving' };
  const b = { id: 'b', name: 'Small', nodes: ['3'], inference: { ok: true, engine: 'SGLang', modelName: 'small-model', outputTokensPerSecond: 20, promptTokensPerSecond: 500, runningRequests: 1, waitingRequests: 0, kvCachePercent: 35, ttftP95RecentSeconds: 0.9, updatedAt: later }, inferenceState: 'serving' };
  const state = { servers: [a, b], inference: a.inference, nodes: { 1: { ok: true, gpu: { temperature: 50 } } }, topology: { nodes: [{ id: '1' }, { id: '2' }, { id: '3' }] } };
  assert.equal(severalServers(state), true);
  assert.deepEqual([serverName(a), serverName(b), serverName({ id: 'c', inference: { ok: false } })], ['big-model', 'Small', 'c']);
  assert.equal(serverOfNode(state.servers, '3').id, 'b');
  assert.equal(serverOfNode(state.servers, '9'), null);
  assert.equal(pickedServer(state.servers, 'b').id, 'b');
  assert.equal(pickedServer(state.servers, 'gone').id, 'a');
  const all = combinedInference(state.servers);
  assert.deepEqual([all.ok, all.modelName, all.engine, all.outputTokensPerSecond, all.runningRequests, all.waitingRequests, all.kvCachePercent, all.ttftP95RecentSeconds, all.prefixCacheHitPercent, all.updatedAt],
    [true, 'big-model | Small', 'vLLM + SGLang', 60, 3, 1, 35, 0.9, null, later]);
  // A server that does not answer adds nothing; with none answering the reading is not ok.
  assert.equal(combinedInference([a, { ...b, inference: { ok: false, error: 'fetch failed' } }]).outputTokensPerSecond, 40);
  assert.equal(combinedInference([{ ...a, inference: { ok: false, error: 'fetch failed' } }]).ok, false);
  assert.equal(viewInference(state, { servers: 'all' }).outputTokensPerSecond, 60);
  assert.equal(viewInference(state, { servers: 'one', server: 'b' }).outputTokensPerSecond, 20);
  // One server, or a payload from an older server without servers[]: the state's own reading.
  assert.equal(viewInference({ inference: a.inference }, { servers: 'one', server: 'b' }), a.inference);
  assert.deepEqual(modelServers({ inference: a.inference, topology: { nodes: [{ id: '1' }] } }).map((server) => [server.id, server.nodes, server.implicit]), [['default', ['1'], true]]);
  // The live chart sample: totals, each server's own, and the newest server time.
  const point = livePoint(state);
  assert.deepEqual([point.at, point.outputTokensPerSecond, point.queue, point.servers.b.outputTokensPerSecond], [Date.parse(later), 60, 1, 20]);
  assert.equal(livePoint({ inference: a.inference, nodes: {} }).servers, undefined);
});

test('the model servers view is a setting that a settings link carries', () => {
  assert.equal(DEFAULTS.servers, 'all');
  assert.deepEqual(parseSettings({ servers: 'one', server: 'b' }), { ...DEFAULTS, servers: 'one', server: 'b' });
  assert.equal(parseSettings({ servers: 'some', server: 'not an id!' }).servers, 'all');
  assert.equal(parseSettings({ server: 'not an id!' }).server, '');
  assert.equal(settingsQuery({ ...DEFAULTS, servers: 'one', server: 'b' }, null), 'servers=one&server=b');
  assert.deepEqual(settingsFromQuery('?servers=one&server=b').settings, { ...DEFAULTS, servers: 'one', server: 'b' });
});

test('keyboard shortcuts go by physical key, so they also work with a Korean layout, and never while typing or with a modifier', async () => {
  const { shortcutAction } = await import('../public/view-data.js');
  const key = (code, key, extra = {}) => ({ code, key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, repeat: false, ...extra });
  assert.equal(shortcutAction(key('KeyS', 's')), 'scope');
  assert.equal(shortcutAction(key('KeyL', 'l')), 'tokens');
  assert.equal(shortcutAction(key('KeyM', 'm')), 'mini');
  assert.equal(shortcutAction(key('Comma', ',')), 'settings');
  assert.equal(shortcutAction(key('Slash', '?', { shiftKey: true })), 'keys');
  // With the Korean layout on, the same keys type ㄴ, ㅣ and ㅡ.
  assert.equal(shortcutAction(key('KeyS', 'ㄴ')), 'scope');
  assert.equal(shortcutAction(key('KeyL', 'ㅣ')), 'tokens');
  assert.equal(shortcutAction(key('KeyM', 'ㅡ')), 'mini');
  // On AZERTY "," sits where QWERTY has M, and M where QWERTY has ";": the character typed decides.
  assert.equal(shortcutAction(key('KeyM', ',')), 'settings');
  assert.equal(shortcutAction(key('Semicolon', 'm')), 'mini');
  // The browser's own shortcuts (Cmd+L, Ctrl+S), typing in a field, a held key and Shift+letters do nothing.
  assert.equal(shortcutAction(key('KeyL', 'l', { metaKey: true })), null);
  assert.equal(shortcutAction(key('KeyS', 's', { ctrlKey: true })), null);
  assert.equal(shortcutAction(key('KeyM', 'm', { altKey: true })), null);
  assert.equal(shortcutAction(key('KeyS', 's'), true), null);
  assert.equal(shortcutAction(key('KeyS', 's', { repeat: true })), null);
  assert.equal(shortcutAction(key('KeyS', 'S', { shiftKey: true })), null);
  assert.equal(shortcutAction(key('KeyX', 'x')), null);
});
