// The mini window: a small view for watching a model test (decode, prefill, temperatures and resources) next to
// other windows. mountMini() draws it into a document: the always-on-top picture-in-picture window that the web
// page opens in Chrome and Edge, or the plain /mini/ page that other browsers open as a small window. Timers and
// requests run on the mini window's own `win`, so they keep their pace while the main tab is hidden.
import { t, setLanguage } from '../i18n.js';
import { loadSettings, loadTheme } from '../settings.js';
import { nodeOrder, nodeColor, finite, fixed, memory, memoryUnit, temperature, temperatureUnit, duration, clockTime, escapeHtml as esc, unknown } from '../view-data.js';

export const TABS = ['glance', 'scope', 'runs'];
const TAB_KEY = 'spark-scope-mini-tab';
const RUNS_KEY = 'spark-scope-runs';
const SPARK_MS = 5 * 60_000;
const SCOPE_MS = 2 * 60_000;
const HOT_CELSIUS = 80;
const MAX_RUNS = 20;

const store = (win) => { try { return win.localStorage; } catch { return null; } };
const read = (win, key, fallback) => { try { return JSON.parse(store(win)?.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; } };
const write = (win, key, value) => { try { store(win)?.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch {} };

// Prefill as the dashboard counts it (new prompt tokens computed), falling back to all prompt tokens.
const prefillRate = (v) => (finite(v?.promptComputeTokensPerSecond) ? v.promptComputeTokensPerSecond : finite(v?.promptTokensPerSecond) ? v.promptTokensPerSecond : 0);
// The phase of one sample: prefill while prompt tokens are being computed, decode while output tokens are produced.
export function phaseOf(sample) {
  if (!sample) return 'idle';
  if (sample.prefill > 0) return 'prefill';
  if (sample.decode > 0) return 'decode';
  return 'idle';
}
// A sample from one /api/state response. The server holds the prefill rate between prefills, so a sample counts as
// prefill only when new prefills completed since the previous sample (prefillUpdatedAt moved on).
export function sampleOf(state, at = Date.now(), previousAt = null) {
  const v = state?.inference?.ok ? state.inference : null;
  const prefillAt = Date.parse(v?.prefillUpdatedAt ?? '');
  const fresh = Number.isFinite(prefillAt) && (previousAt === null ? at - prefillAt < 3000 : prefillAt > previousAt);
  const nodes = Object.fromEntries(Object.entries(state?.nodes ?? {}).map(([id, node]) => [id, {
    temp: node?.ok && finite(node.gpu?.temperature) ? node.gpu.temperature : null,
    power: node?.ok && finite(node.gpu?.powerWatts) ? node.gpu.powerWatts : null,
  }]));
  return { at, decode: v && finite(v.outputTokensPerSecond) ? v.outputTokensPerSecond : 0, prefill: v && fresh ? prefillRate(v) : 0, nodes };
}

// A recorded run, folded from samples: averages and peaks, the slowest TTFT, the hottest GPU, GPU energy and tokens.
export function startRun(state, at) {
  const today = state?.usage?.today ?? {};
  return { startedAt: at, last: at, day: state?.usage?.day ?? null, startOutput: today.output ?? null, startInput: today.input ?? null,
    decodeSum: 0, decodeTime: 0, peakDecode: 0, peakPrefill: 0, slowestTtft: null, hottest: null, hottestNode: null, energyWh: 0, outputTokens: 0, promptTokens: 0 };
}
export function addToRun(run, state, sample) {
  const dt = Math.max(0, (sample.at - run.last) / 1000);
  run.last = sample.at;
  if (sample.decode > 0) { run.decodeSum += sample.decode * dt; run.decodeTime += dt; }
  run.peakDecode = Math.max(run.peakDecode, sample.decode);
  run.peakPrefill = Math.max(run.peakPrefill, sample.prefill);
  run.outputTokens += sample.decode * dt;
  run.promptTokens += sample.prefill * dt;
  const ttft = state?.inference?.ttftP95RecentSeconds;
  if (finite(ttft)) run.slowestTtft = Math.max(run.slowestTtft ?? 0, ttft);
  let watts = 0;
  for (const [id, node] of Object.entries(sample.nodes)) {
    if (finite(node.power)) watts += node.power;
    if (finite(node.temp) && (run.hottest === null || node.temp > run.hottest)) { run.hottest = node.temp; run.hottestNode = id; }
  }
  run.energyWh += watts * dt / 3600;
  return run;
}
// The finished run. Token counts come from today's ledger when the run stayed within one day, otherwise from rates.
export function finishRun(run, state, number) {
  const today = state?.usage?.today ?? {};
  const sameDay = run.day !== null && state?.usage?.day === run.day;
  const fromLedger = (end, start) => (sameDay && finite(end) && finite(start) && end >= start ? end - start : null);
  return {
    number, startedAt: run.startedAt, seconds: Math.round((run.last - run.startedAt) / 1000),
    avgDecode: run.decodeTime > 0 ? run.decodeSum / run.decodeTime : null, peakDecode: run.peakDecode, peakPrefill: run.peakPrefill,
    slowestTtft: run.slowestTtft, hottest: run.hottest, hottestNode: run.hottestNode, energyWh: run.energyWh,
    outputTokens: fromLedger(today.output, run.startOutput) ?? Math.round(run.outputTokens),
    promptTokens: fromLedger(today.input, run.startInput) ?? Math.round(run.promptTokens),
  };
}
// One row per run for a spreadsheet.
export function runsCsv(runs) {
  const header = ['run', 'started', 'seconds', 'avg_decode_tok_s', 'peak_decode_tok_s', 'peak_prefill_tok_s', 'slowest_ttft_p95_s', 'hottest_gpu_c', 'hottest_node', 'gpu_energy_wh', 'output_tokens', 'prompt_tokens'];
  const cell = (value) => (value === null || value === undefined ? '' : /[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
  const round = (value, digits) => (finite(value) ? Number(value.toFixed(digits)) : null);
  return [header, ...runs.map((r) => [r.number, new Date(r.startedAt).toISOString(), r.seconds, round(r.avgDecode, 1), round(r.peakDecode, 1), round(r.peakPrefill, 0), round(r.slowestTtft, 3), round(r.hottest, 1), r.hottestNode, round(r.energyWh, 3), r.outputTokens, r.promptTokens])]
    .map((row) => row.map(cell).join(',')).join('\n') + '\n';
}

export function mountMini(doc, win, { onOpenDashboard } = {}) {
  const html = doc.documentElement;
  const origin = win.location.origin !== 'null' ? win.location.origin : '';
  let settings = loadSettings(store(win)), latest = null, metas = [], samples = [], failed = false;
  let tab = TABS.includes(read(win, TAB_KEY, null)) ? read(win, TAB_KEY, null) : 'glance';
  let run = null, runs = read(win, RUNS_KEY, []).filter((r) => r && finite(r.number)).slice(0, MAX_RUNS);
  const root = doc.createElement('div');
  root.className = 'm-root';
  doc.body.replaceChildren(root);

  // Settings are read again on every poll, so a change on the main page reaches the mini window within one poll.
  function applySettings() {
    settings = loadSettings(store(win));
    setLanguage(settings.lang);
    html.lang = settings.lang;
    const theme = loadTheme(store(win)) ?? (win.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    html.dataset.theme = theme;
    if (settings.design === 'default') delete html.dataset.design; else html.dataset.design = settings.design;
    doc.title = t('mini.title');
  }

  const hour12 = () => settings.clock === '12';
  const tempText = (celsius) => (finite(celsius) ? `${temperature(celsius, settings.temp)}${temperatureUnit(settings.temp)}` : unknown());
  const hotClass = (celsius) => (finite(celsius) && celsius >= HOT_CELSIUS ? 'hot' : finite(celsius) && celsius >= HOT_CELSIUS - 8 ? 'warm' : '');
  const rate = (value) => (finite(value) ? fixed(value, value >= 100 ? 0 : 1) : unknown());
  const color = (id) => nodeColor(settings.colors, Math.max(0, metas.findIndex((meta) => meta.id === id)));

  function spark(key, stroke, now) {
    const points = samples.filter((sample) => sample.at >= now - SPARK_MS);
    if (points.length < 2) return '<svg class="m-spark" viewBox="0 0 300 30" aria-hidden="true"></svg>';
    const max = Math.max(1, ...points.map((p) => p[key])), from = now - SPARK_MS;
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${((p.at - from) / SPARK_MS * 300).toFixed(1)} ${(28 - 26 * p[key] / max).toFixed(1)}`).join('');
    return `<svg class="m-spark" viewBox="0 0 300 30" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function header() {
    const v = latest?.inference, nodes = latest?.nodes ?? {}, online = metas.filter((meta) => nodes[meta.id]?.ok).length;
    const level = failed ? 'crit' : latest?.status === 'healthy' ? 'ok' : 'warn';
    return `<div class="m-head"><b title="${esc(v?.modelName ?? '')}">${esc(v?.modelName ?? t('header.modelUnknown'))}</b><span class="m-${level}"><span class="m-dot"></span>${failed ? esc(t('mini.offline')) : esc(t('mini.nodesUp', { online, count: metas.length }))}</span></div>`;
  }
  const tabs = () => `<nav class="m-tabs" role="tablist">${TABS.map((name) => `<button type="button" role="tab" data-tab="${name}" aria-selected="${name === tab}">${esc(t(`mini.tab.${name}`))}</button>`).join('')}</nav>`;
  const metric = (label, value, unit, extra = '') => `<div class="m-metric"><small>${esc(label)}</small><b class="num">${value}<em>${unit}</em></b>${extra}</div>`;
  function chips() {
    const v = latest?.inference?.ok ? latest.inference : null;
    return `<div class="m-chips"><span>${esc(t('mini.running'))} <b>${v ? fixed(v.runningRequests, 0) : unknown()}</b></span><span>${esc(t('mini.queue'))} <b>${v ? fixed(v.waitingRequests, 0) : unknown()}</b></span><span>KV <b>${v ? fixed(v.kvCachePercent, 0, '%') : unknown()}</b></span><span>TTFT <b>${v ? duration(v.ttftP95RecentSeconds) : unknown()}</b></span><span>TPOT <b>${v ? duration(v.tpotP95RecentSeconds) : unknown()}</b></span></div>`;
  }
  function nodeRows() {
    const nodes = latest?.nodes ?? {};
    return `<div class="m-nodes">${metas.map((meta) => {
      const node = nodes[meta.id], ok = Boolean(node?.ok), gpu = ok ? node.gpu ?? {} : {};
      const load = finite(gpu.utilization) ? Math.max(0, Math.min(100, gpu.utilization)) : 0;
      const used = ok ? node.memory?.usedBytes : null, total = ok ? node.memory?.totalBytes : null, memPct = finite(used) && finite(total) && total > 0 ? 100 * used / total : 0;
      return `<div class="m-node" style="--node:${color(meta.id)}"><div class="m-l1"><span class="m-name"><i></i>${esc(meta.name)}</span><span class="${hotClass(gpu.temperature)}">${tempText(gpu.temperature)}</span><span>${finite(gpu.powerWatts) ? `${fixed(gpu.powerWatts)} W` : unknown()}</span></div><div class="m-l2"><span>GPU</span><span class="m-bar" title="${esc(t('node.gpuLoad'))} ${fixed(gpu.utilization, 0, '%')}"><i style="width:${load.toFixed(0)}%"></i></span><span>${esc(t('mini.mem'))}</span><span class="m-bar m-mem" title="${finite(used) && finite(total) ? `${memory(used, settings.mem)} / ${memory(total, settings.mem, 0)} ${memoryUnit(settings.mem)}` : ''}"><i style="width:${memPct.toFixed(0)}%"></i></span></div></div>`;
    }).join('')}</div>`;
  }
  function footer(note) {
    return `<div class="m-foot"><span>${esc(note)}</span><button type="button" class="m-link" data-open-dashboard>${esc(t('mini.openDashboard'))}</button></div>`;
  }

  function glance(now) {
    const v = latest?.inference?.ok ? latest.inference : null, nodes = latest?.nodes ?? {};
    const watts = metas.map((meta) => nodes[meta.id]).filter((node) => node?.ok && finite(node.gpu?.powerWatts)).reduce((sum, node) => sum + node.gpu.powerWatts, 0);
    const fullest = metas.map((meta) => nodes[meta.id]).filter((node) => node?.ok && finite(node.memory?.usedBytes) && finite(node.memory?.totalBytes)).sort((a, b) => b.memory.usedBytes / b.memory.totalBytes - a.memory.usedBytes / a.memory.totalBytes)[0];
    return `<div class="m-pair">${metric(t('mini.decode'), rate(v?.outputTokensPerSecond), 'tok/s', spark('decode', 'var(--blue)', now))}${metric(t('mini.prefill'), rate(v ? prefillRate(v) : null), 'tok/s', spark('prefill', 'var(--orange)', now))}</div>
      ${chips()}<div class="m-rule"></div>${nodeRows()}
      <div class="m-chips m-spread"><span>${esc(t('mini.gpuPower'))} <b>${fixed(watts)} W</b></span><span>${esc(t('mini.mostMemory'))} <b>${fullest ? `${memory(fullest.memory.usedBytes, settings.mem)} / ${memory(fullest.memory.totalBytes, settings.mem, 0)} ${memoryUnit(settings.mem)}` : unknown()}</b></span></div>
      ${footer(t('mini.updated', { time: clockTime(latest?.updatedAt, { hour12: hour12() }) }))}
      <div class="m-wide">${metric(t('mini.decode'), rate(v?.outputTokensPerSecond), 'tok/s')}${metric(t('mini.prefill'), rate(v ? prefillRate(v) : null), 'tok/s')}<div class="m-wide-nodes">${metas.map((meta) => { const gpu = nodes[meta.id]?.ok ? nodes[meta.id].gpu ?? {} : {}; return `<div style="--node:${color(meta.id)}"><span>${esc(meta.name)}</span><span class="m-bar"><i style="width:${finite(gpu.utilization) ? Math.max(0, Math.min(100, gpu.utilization)).toFixed(0) : 0}%"></i></span><span class="${hotClass(gpu.temperature)}">${finite(gpu.temperature) ? `${temperature(gpu.temperature, settings.temp)}°` : '—'}</span></div>`; }).join('')}</div></div>`;
  }

  function scope(now) {
    const W = 312, H = 150, TH = 90, from = now - SCOPE_MS, points = samples.filter((s) => s.at >= from - 4000);
    const x = (at) => Math.max(0, Math.min(W, (at - from) / SCOPE_MS * W));
    const maxDecode = Math.max(40, ...points.map((p) => p.decode)) * 1.15, maxPrefill = Math.max(1000, ...points.map((p) => p.prefill)) * 1.1;
    let bands = '';
    points.forEach((p, i) => {
      const phase = phaseOf(p), next = points[i + 1]?.at ?? now;
      if (phase !== 'idle') bands += `<rect x="${x(p.at).toFixed(1)}" y="0" width="${Math.max(1, x(next) - x(p.at)).toFixed(1)}" height="${H}" fill="${phase === 'prefill' ? 'var(--orange)' : 'var(--blue)'}" opacity=".1"/>`;
    });
    const bars = points.filter((p) => p.prefill > 0).map((p) => `<rect x="${x(p.at).toFixed(1)}" y="${(H - H * p.prefill / maxPrefill).toFixed(1)}" width="2" height="${(H * p.prefill / maxPrefill).toFixed(1)}" fill="var(--orange)"/>`).join('');
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)} ${(H - 4 - (H - 10) * p.decode / maxDecode).toFixed(1)}`).join('');
    const temps = points.flatMap((p) => Object.values(p.nodes).map((n) => n.temp)).filter(finite);
    const low = Math.min(40, ...temps) - 2, high = Math.max(HOT_CELSIUS + 4, ...temps) + 2, ty = (c) => TH - 4 - (TH - 8) * (c - low) / (high - low);
    const tempLines = metas.map((meta) => { const d = points.filter((p) => finite(p.nodes[meta.id]?.temp)).map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)} ${ty(p.nodes[meta.id].temp).toFixed(1)}`).join(''); return d ? `<path d="${d}" fill="none" stroke="${color(meta.id)}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>` : ''; }).join('');
    const current = phaseOf(samples.at(-1)), last = samples.at(-1) ?? { decode: 0, prefill: 0, nodes: {} };
    const hottest = metas.map((meta) => ({ meta, temp: latest?.nodes?.[meta.id]?.ok ? latest.nodes[meta.id].gpu?.temperature : null })).filter((h) => finite(h.temp)).sort((a, b) => b.temp - a.temp)[0];
    const phases = ['idle', 'prefill', 'decode'].map((phase) => `<span class="${phase === current ? `m-on m-${phase}` : ''}">${esc(t(`mini.phase.${phase}`))}</span>`).join('');
    return `<div class="m-head"><div class="m-phase">${phases}</div><span class="num">${esc(t('mini.twoMinutes'))}</span></div>
      <div class="m-scope"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="${esc(t('mini.scopeLabel'))}" role="img">${bands}<line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="var(--grid)"/>${bars}${line ? `<path d="${line}" fill="none" stroke="var(--blue)" stroke-width="2" vector-effect="non-scaling-stroke"/>` : ''}</svg><span class="m-lbl m-left">${esc(t('mini.decode'))} ${rate(last.decode)} tok/s</span><span class="m-lbl m-right">${esc(t('mini.prefill'))} ${rate(latest?.inference?.ok ? prefillRate(latest.inference) : null)}</span></div>
      ${chips()}
      <div class="m-head"><span>${esc(t('node.reading.temp'))}</span><span class="num ${hotClass(hottest?.temp)}">${hottest ? esc(t('mini.hottest', { temp: tempText(hottest.temp), node: hottest.meta.name })) : unknown()}</span></div>
      <div class="m-scope m-temps"><svg viewBox="0 0 ${W} ${TH}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="${W}" y1="${ty(HOT_CELSIUS).toFixed(1)}" y2="${ty(HOT_CELSIUS).toFixed(1)}" stroke="var(--red)" stroke-dasharray="3 4" opacity=".6" vector-effect="non-scaling-stroke"/>${tempLines}</svg><span class="m-lbl m-right m-hot" style="top:${Math.max(0, ty(HOT_CELSIUS) - 15).toFixed(0)}px">${tempText(HOT_CELSIUS)}</span></div>
      ${footer(t('mini.shading'))}`;
  }

  const mmss = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  // The change against the previous run, marked good or bad by which way is better for that figure.
  function change(now, before, better) {
    if (!finite(now) || !finite(before) || before === 0) return '';
    const pct = (now - before) / before * 100, good = better === 'up' ? pct >= 0 : pct <= 0;
    return `<em class="${good ? 'm-good' : 'm-bad'}">${pct >= 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(0)}%</em>`;
  }
  function runStats(r, previous) {
    const node = (id) => metas.find((meta) => meta.id === id)?.name ?? id ?? '';
    return `<div class="m-stats"><div><small>${esc(t('mini.run.avgDecode'))}</small><b>${rate(r.avgDecode)}</b>${change(r.avgDecode, previous?.avgDecode, 'up')}</div><div><small>${esc(t('mini.run.peakDecode'))}</small><b>${rate(r.peakDecode)}</b>${change(r.peakDecode, previous?.peakDecode, 'up')}</div>
      <div><small>${esc(t('mini.run.peakPrefill'))}</small><b>${rate(r.peakPrefill)}</b>${change(r.peakPrefill, previous?.peakPrefill, 'up')}</div><div><small>${esc(t('mini.run.slowestTtft'))}</small><b>${duration(r.slowestTtft)}</b>${change(r.slowestTtft, previous?.slowestTtft, 'down')}</div>
      <div><small>${esc(t('mini.run.hottest'))}</small><b class="${hotClass(r.hottest)}">${tempText(r.hottest)}</b> <em class="m-muted">${esc(node(r.hottestNode))}</em></div><div><small>${esc(t('mini.run.energy'))}</small><b>${fixed(r.energyWh, 2)} Wh</b></div>
      <div><small>${esc(t('mini.run.output'))}</small><b>${fixed(r.outputTokens, 0)}</b></div><div><small>${esc(t('mini.run.prompt'))}</small><b>${fixed(r.promptTokens, 0)}</b></div></div>`;
  }
  function runsView(now) {
    const v = latest?.inference?.ok ? latest.inference : null, previous = runs[0];
    const live = run ? finishRun({ ...run }, latest, (previous?.number ?? 0) + 1) : null;
    const control = run
      ? `<div class="m-rec"><span class="m-state m-recording"><span class="m-dot"></span>${esc(t('mini.run.recording'))} ${mmss((now - run.startedAt) / 1000)}</span><button type="button" class="m-stop" data-run="stop">${esc(t('mini.run.stop'))}</button></div>`
      : `<div class="m-rec"><span class="m-state m-muted">${esc(t('mini.run.ready'))}</span><button type="button" data-run="start">${esc(t('mini.run.start'))}</button></div>`;
    const shown = live ?? previous;
    const list = runs.slice(0, 4).map((r) => `<div><span><b>${esc(t('mini.run.name', { n: r.number }))}</b> ${esc(clockTime(r.startedAt, { seconds: false, hour12: hour12() }))} | ${mmss(r.seconds)}</span><span>${rate(r.avgDecode)}</span><span>${duration(r.slowestTtft)} | ${finite(r.hottest) ? `${temperature(r.hottest, settings.temp)}°` : '—'}</span></div>`).join('');
    return `${control}<div class="m-pair">${metric(t('mini.decodeNow'), rate(v?.outputTokensPerSecond), 'tok/s')}${metric(t('mini.prefillNow'), rate(v ? prefillRate(v) : null), 'tok/s')}</div>
      ${shown ? `<div class="m-head"><span>${esc(live ? t('mini.run.thisRun') : t('mini.run.lastRun', { n: shown.number }))}</span><span class="num">${mmss(shown.seconds)}</span></div>${runStats(shown, live ? previous : runs[1])}` : `<p class="m-empty">${esc(t('mini.run.none'))}</p>`}
      ${runs.length ? `<div class="m-rule"></div><div class="m-head"><span>${esc(t('mini.run.list'))}</span><span>${esc(t('mini.run.columns'))}</span></div><div class="m-runs">${list}</div>` : ''}
      <div class="m-foot"><span>${esc(t('mini.run.kept'))}</span>${runs.length ? `<button type="button" class="m-link" data-run="csv">${esc(t('mini.run.csv'))}</button>` : ''}</div>`;
  }

  function render() {
    const now = Date.now(), views = { glance, scope, runs: runsView };
    root.innerHTML = `${header()}${tabs()}<div class="m-body m-tab-${tab}">${latest ? views[tab](now) : `<p class="m-empty">${esc(failed ? t('mini.offline') : t('mini.waiting'))}</p>`}</div>`;
  }

  async function poll(first = false) {
    applySettings();
    try {
      const response = await win.fetch(`${origin}/api/state?minutes=15${first ? '' : '&history=0'}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const state = await response.json();
      latest = state;
      metas = nodeOrder(state);
      failed = false;
      const now = Date.parse(state.updatedAt) || Date.now();
      // The first poll fills the sparklines and the scope from the server's recent history.
      if (first && Array.isArray(state.history)) {
        // The history keeps no prefill timing, so earlier samples carry decode only; prefill bursts start from now on.
        samples = state.history.filter((p) => p.at >= now - SPARK_MS).map((p) => ({ at: p.at, decode: finite(p.outputTokensPerSecond) ? p.outputTokensPerSecond : 0, prefill: 0, nodes: Object.fromEntries(Object.entries(p.nodes ?? {}).map(([id, n]) => [id, { temp: finite(n?.temperature) ? n.temperature : null, power: null }])) }));
      }
      const sample = sampleOf(state, now, samples.at(-1)?.at ?? null);
      if (!samples.length || sample.at > samples.at(-1).at) samples.push(sample);
      samples = samples.filter((s) => s.at >= now - SPARK_MS);
      if (run) addToRun(run, state, sample);
    } catch {
      failed = true;
    }
    render();
  }

  root.addEventListener('click', (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.tab) { tab = target.dataset.tab; write(win, TAB_KEY, JSON.stringify(tab)); render(); return; }
    if (target.hasAttribute('data-open-dashboard')) { onOpenDashboard ? onOpenDashboard() : win.open(`${origin}/`, '_blank'); return; }
    if (target.dataset.run === 'start' && latest) { run = startRun(latest, Date.parse(latest.updatedAt) || Date.now()); render(); return; }
    if (target.dataset.run === 'stop' && run) {
      runs = [finishRun(run, latest, (runs[0]?.number ?? 0) + 1), ...runs].slice(0, MAX_RUNS);
      write(win, RUNS_KEY, runs);
      run = null;
      render();
      return;
    }
    if (target.dataset.run === 'csv') {
      const link = doc.createElement('a');
      link.href = win.URL.createObjectURL(new win.Blob([runsCsv(runs)], { type: 'text/csv' }));
      link.download = 'spark-scope-runs.csv';
      doc.body.append(link);
      link.click();
      link.remove();
    }
  });

  applySettings();
  render();
  void poll(true);
  let timer = win.setInterval(() => void poll(), settings.refresh * 1000);
  return {
    close() { win.clearInterval(timer); timer = null; },
  };
}
