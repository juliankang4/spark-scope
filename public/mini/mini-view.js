// The mini window: a small view for watching a model test (decode, prefill, temperatures and resources) next to
// other windows. mountMini() draws it into a document: the always-on-top picture-in-picture window that the web
// page opens in Chrome and Edge, the dashboard page itself where that is missing (Safari, phones), or the plain
// /mini/ page. Timers and requests run on the mini window's own `win`, so they keep their pace while the main tab is
// hidden.
import { t, setLanguage } from '../i18n.js';
import { loadSettings, loadTheme } from '../settings.js';
import { nodeOrder, nodeColor, finite, fixed, memory, memoryUnit, gpuMemory, memoryWording, temperature, temperatureUnit, duration, clockTime, escapeHtml as esc, unknown, severalServers, modelServers, pickedServer, viewInference, combinedInference, serverName, serverStateKey, serverColorIndex, PHONE_QUERY, onMediaChange, offMediaChange, engineMetric, hasNodeTemperature, gpuPowerWatts, outputCoverage, rateCoverage, engineNeedsKey } from '../view-data.js';

export const TABS = ['glance', 'scope', 'runs'];
const TAB_KEY = 'spark-scope-mini-tab';
const RUNS_KEY = 'spark-scope-runs';
const SPARK_MS = 5 * 60_000;
const SCOPE_MS = 2 * 60_000;
const HOT_CELSIUS = 80;
const MAX_RUNS = 20;
// From this window height up, Glance and Scope fit one above the other without scrolling, so the tabs give way and
// Runs follows below.
const STACK_HEIGHT = 720;

const store = (win) => { try { return win.localStorage; } catch { return null; } };
const read = (win, key, fallback) => { try { return JSON.parse(store(win)?.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; } };
const write = (win, key, value) => { try { store(win)?.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch {} };

// With several model servers the mini window follows all of them together, or the server picked in "one at a time"
// (its own history too); with one server the state is used as it is.
export function focusState(state, settings) {
  if (!severalServers(state)) return state;
  const id = settings?.servers === 'one' ? pickedServer(modelServers(state), settings.server).id : null;
  const history = id && Array.isArray(state.history) ? state.history.map((point) => ({ ...point, outputTokensPerSecond: point.servers?.[id]?.outputTokensPerSecond ?? null })) : state.history;
  return { ...state, inference: viewInference(state, settings), history };
}

// Prefill as the dashboard counts it (new prompt tokens computed), falling back to all prompt tokens.
const prefillRate = (v) => (finite(v?.promptComputeTokensPerSecond) ? v.promptComputeTokensPerSecond : finite(v?.promptTokensPerSecond) ? v.promptTokensPerSecond : null);
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
  return { at, decode: v && v.reported?.outputTokensPerSecond !== false && finite(v.outputTokensPerSecond) ? v.outputTokensPerSecond : 0,
    prefill: v && fresh ? prefillRate(v) : 0, nodes };
}

// A recorded run, folded from samples: averages and peaks, the slowest TTFT, the hottest GPU, GPU energy and tokens.
export function startRun(state, at) {
  const today = state?.usage?.today ?? {};
  return { startedAt: at, last: at, day: state?.usage?.day ?? null, startOutput: today.output ?? null, startInput: today.input ?? null,
    reported: { ...state?.inference?.reported }, metricKinds: { ...state?.inference?.metricKinds },
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
  const inference = state?.inference;
  for (const key of Object.keys(inference?.reported ?? {})) {
    if (inference.reported[key] === false || inference.metricKinds?.[key] !== run.metricKinds[key]) run.reported[key] = false;
  }
  const ttft = inference?.ttftP95RecentSeconds;
  if (run.reported.ttftP95RecentSeconds === false) run.slowestTtft = null;
  else if (finite(ttft)) run.slowestTtft = Math.max(run.slowestTtft ?? 0, ttft);
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
    reported: { ...run.reported }, metricKinds: { ...run.metricKinds },
    avgDecode: run.reported?.outputTokensPerSecond !== false && run.decodeTime > 0 ? run.decodeSum / run.decodeTime : null,
    peakDecode: run.reported?.outputTokensPerSecond === false ? null : run.peakDecode,
    peakPrefill: engineMetric(run, 'promptComputeTokensPerSecond', { averages: false }).shown ? run.peakPrefill : null,
    slowestTtft: run.slowestTtft, hottest: run.hottest, hottestNode: run.hottestNode, energyWh: run.energyWh,
    outputTokens: fromLedger(today.output, run.startOutput) ?? (run.reported?.outputTokensPerSecond === false ? null : Math.round(run.outputTokens)),
    promptTokens: fromLedger(today.input, run.startInput) ?? (engineMetric(run, 'promptComputeTokensPerSecond', { averages: false }).shown ? Math.round(run.promptTokens) : null),
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

// In a container other than the body (the dashboard page), the page keeps its own title, language and theme, and
// getSettings hands over its settings.
export function mountMini(doc, win, { onBack, container = doc.body, getSettings = null } = {}) {
  const html = doc.documentElement, ownPage = container === doc.body;
  const origin = win.location.origin !== 'null' ? win.location.origin : '';
  const readSettings = getSettings ?? (() => loadSettings(store(win)));
  let settings = readSettings(), latest = null, metas = [], samples = [], failed = false;
  let tab = TABS.includes(read(win, TAB_KEY, null)) ? read(win, TAB_KEY, null) : 'glance';
  let run = null, runs = read(win, RUNS_KEY, []).filter((r) => r && finite(r.number)).slice(0, MAX_RUNS);
  // On a phone or in a tall window the three parts follow one another down the page instead of sitting behind tabs.
  // A window 260 px tall or less shows only the one-line Glance (mini.css hides the tabs there).
  const stackQuery = win.matchMedia(`${PHONE_QUERY}, (min-height: ${STACK_HEIGHT}px)`), shortQuery = win.matchMedia('(max-height: 260px)');
  // The header row (back arrow, model, nodes) stays in place and only its text changes, so the arrow keeps keyboard
  // focus without being rebuilt on every poll; the rest is redrawn into `content` (display: contents).
  const root = doc.createElement('div'), head = doc.createElement('div'), content = doc.createElement('div');
  root.className = 'm-root';
  head.className = 'm-head';
  head.innerHTML = '<span class="m-title"><button type="button" class="m-back" data-back><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5m6-6-6 6 6 6"/></svg></button><b></b></span><span><span class="m-dot"></span><span></span></span>';
  content.className = 'm-content';
  root.append(head, content);
  container.replaceChildren(root);

  // Settings are read again on every poll, so a change on the main page reaches the mini window within one poll.
  function applySettings() {
    settings = readSettings();
    if (!ownPage) return;
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
    const back = head.querySelector('[data-back]'), name = head.querySelector('b'), status = head.lastElementChild;
    const set = (el, key, value) => { if (el[key] !== value) el[key] = value; };
    set(back, 'title', t('mini.back'));
    if (back.getAttribute('aria-label') !== back.title) back.setAttribute('aria-label', back.title);
    set(name, 'textContent', v?.modelName ?? t('header.modelUnknown'));
    set(name, 'title', v?.modelName ?? '');
    set(status, 'className', `m-${failed ? 'crit' : latest?.status === 'healthy' ? 'ok' : 'warn'}`);
    set(status.lastElementChild, 'textContent', failed ? t('mini.offline') : t('mini.nodesUp', { online, count: metas.length }));
  }
  const tabs = () => `<nav class="m-tabs" role="tablist">${TABS.map((name) => `<button type="button" role="tab" data-tab="${name}" aria-selected="${name === tab}">${esc(t(`mini.tab.${name}`))}</button>`).join('')}</nav>`;
  const metric = (label, value, unit, extra = '') => `<div class="m-metric"><small>${esc(label)}</small><b class="num">${value}<em>${unit}</em></b>${extra}</div>`;
  function chips() {
    const v = latest?.inference?.ok ? latest.inference : null;
    const chip = field => {
      const { key, label, help, shown, idle } = engineMetric(latest?.inference, field);
      if (!shown) return '';
      const value = idle ? t('engine.noRequests') : v ? (key.endsWith('Seconds') ? duration(v[key]) : fixed(v[key], 0, '%')) : unknown();
      const caption = { 'engine.kvCache': 'KV', 'engine.ttft': 'TTFT', 'engine.tpot': 'TPOT' }[label] ?? t(label);
      return `<span${help ? ` title="${esc(t(help))}"` : ''}>${esc(caption)} <b>${value}</b></span>`;
    };
    return `<div class="m-chips"><span>${esc(t('mini.running'))} <b>${v ? fixed(v.runningRequests, 0) : unknown()}</b></span><span>${esc(t('mini.queue'))} <b>${v ? fixed(v.waitingRequests, 0) : unknown()}</b></span>${['kvCachePercent', 'ttftP95RecentSeconds', 'tpotP95RecentSeconds', 'prefixCacheHitPercent'].map(chip).join('')}</div>`;
  }
  function serverRows() {
    const list = modelServers(latest);
    if (list.length < 2) return '';
    const rows = list.map((server) => {
      const v = server.inference?.ok ? server.inference : null, key = serverStateKey(server);
      return `<div style="--node:${nodeColor(settings.colors, serverColorIndex(server, metas))}"><span class="m-name" title="${esc(serverName(server))}"><i></i><span>${esc(serverName(server))}</span></span><span class="num">${server.inference?.reported?.outputTokensPerSecond === false ? '' : `${rate(v?.outputTokensPerSecond)} tok/s`}</span><span class="m-${key}">${esc(t(engineNeedsKey(server.inference) ? 'engine.apiKeyRequired' : `servers.state.${key}`))}</span></div>`;
    }).join('');
    const total = combinedInference(list);
    return `<div class="m-servers">${rows}<div class="m-total"><span>${esc(t('chart.legend.total'))} ${esc(outputCoverage(list))}</span><span class="num">${total?.reported?.outputTokensPerSecond === false ? '' : `${rate(total?.outputTokensPerSecond)} tok/s`}</span><span></span></div></div>`;
  }
  function nodeRows() {
    const nodes = latest?.nodes ?? {};
    return `<div class="m-nodes${metas.length > 4 ? ' m-two' : ''}">${metas.map((meta) => {
      const node = nodes[meta.id], ok = Boolean(node?.ok), gpu = ok ? node.gpu ?? {} : {};
      const load = finite(gpu.utilization) ? Math.max(0, Math.min(100, gpu.utilization)) : 0;
      const { kind, usedBytes: used, totalBytes: total } = gpuMemory(node), memPct = finite(used) && finite(total) && total > 0 ? 100 * used / total : 0;
      return `<div class="m-node" style="--node:${color(meta.id)}"><div class="m-l1"><span class="m-name"><i></i>${esc(meta.name)}</span>${hasNodeTemperature(node) ? `<span class="${hotClass(gpu.temperature)}">${tempText(gpu.temperature)}</span><span>${finite(gpu.powerWatts) ? `${fixed(gpu.powerWatts)} W` : unknown()}</span>` : ''}</div><div class="m-l2"><span>GPU</span><span class="m-bar" title="${esc(t('node.gpuLoad'))} ${fixed(gpu.utilization, 0, '%')}"><i style="width:${load.toFixed(0)}%"></i></span><span>${esc(t(kind === 'discrete' ? 'mini.gpuMem' : 'mini.mem'))}</span><span class="m-bar m-mem" title="${finite(used) && finite(total) ? `${memory(used, settings.mem)} / ${memory(total, settings.mem, 0)} ${memoryUnit(settings.mem)}` : ''}"><i style="width:${memPct.toFixed(0)}%"></i></span></div></div>`;
    }).join('')}</div>`;
  }
  function footer(note) {
    return `<div class="m-foot"><span>${esc(note)}</span></div>`;
  }

  function focusedRateCoverage(field) {
    const list = modelServers(latest);
    return rateCoverage(settings.servers === 'one' ? [pickedServer(list, settings.server)] : list, field);
  }
  const rateCaption = (label, field) => { const coverage = focusedRateCoverage(field); return t(label) + (coverage ? ` ${coverage}` : ''); };

  function glance(now) {
    const v = latest?.inference?.ok ? latest.inference : null, nodes = latest?.nodes ?? {};
    const watts = gpuPowerWatts(metas.map((meta) => nodes[meta.id]));
    const reporting = metas.filter(meta => nodes[meta.id]?.ok && finite(nodes[meta.id].gpu?.powerWatts)).length;
    const gpuMems = metas.map((meta) => gpuMemory(nodes[meta.id])), wording = memoryWording(gpuMems.map((item) => item.kind));
    const fullest = gpuMems.filter((item) => finite(item.usedBytes) && finite(item.totalBytes) && item.totalBytes > 0).sort((a, b) => b.usedBytes / b.totalBytes - a.usedBytes / a.totalBytes)[0];
    const decode = engineMetric(latest?.inference, 'outputTokensPerSecond');
    const decodeLabel = decode.key === 'averageOutputTokensPerSecond' ? t(decode.label) : rateCaption(decode.label, decode.key);
    const prefill = engineMetric(latest?.inference, 'promptComputeTokensPerSecond');
    const prefillLabel = prefill.key === 'averagePromptTokensPerSecond' ? t(prefill.label) : rateCaption(prefill.label, prefill.key);
    return `${engineNeedsKey(latest?.inference) ? `<p class="m-empty">${esc(t('engine.apiKeyRequired'))}</p>` : ''}<div class="m-pair">${decode.shown ? metric(decodeLabel, rate(v?.[decode.key]), 'tok/s', decode.key === 'averageOutputTokensPerSecond' ? '' : spark('decode', 'var(--blue)', now)) : ''}${prefill.shown ? metric(prefillLabel, rate(v?.[prefill.key]), 'tok/s', prefill.key === 'averagePromptTokensPerSecond' ? '' : spark('prefill', 'var(--orange)', now)) : ''}</div>
      ${chips()}${serverRows()}<div class="m-rule"></div>${nodeRows()}
      <div class="m-chips m-spread">${watts === null ? '' : `<span data-gpu-power>${esc(t('mini.gpuPower'))} <b>${fixed(watts)} W</b>${reporting < metas.length ? ` ${esc(t('statusbar.gpuPowerPartial', { reporting, count: metas.length }))}` : ''}</span>`}<span>${esc(t(wording === 'unified' ? 'mini.mostMemory' : 'mini.mostGpuMemory'))} <b>${fullest ? `${memory(fullest.usedBytes, settings.mem)} / ${memory(fullest.totalBytes, settings.mem, 0)} ${memoryUnit(settings.mem)}` : unknown()}</b></span></div>
      ${footer(t('mini.updated', { time: clockTime(latest?.updatedAt, { hour12: hour12() }) }))}
      <div class="m-wide">${decode.shown ? metric(decodeLabel, rate(v?.[decode.key]), 'tok/s') : ''}${prefill.shown ? metric(prefillLabel, rate(v?.[prefill.key]), 'tok/s') : ''}<div class="m-wide-nodes">${metas.map((meta) => { const gpu = nodes[meta.id]?.ok ? nodes[meta.id].gpu ?? {} : {}; return `<div style="--node:${color(meta.id)}"><span>${esc(meta.name)}</span><span class="m-bar"><i style="width:${finite(gpu.utilization) ? Math.max(0, Math.min(100, gpu.utilization)).toFixed(0) : 0}%"></i></span>${hasNodeTemperature(nodes[meta.id]) ? `<span class="${hotClass(gpu.temperature)}">${finite(gpu.temperature) ? `${temperature(gpu.temperature, settings.temp)}°` : '—'}</span>` : ''}</div>`; }).join('')}</div></div>`;
  }

  function scope(now, stacked = false) {
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
    const showTemps = metas.some(meta => hasNodeTemperature(latest?.nodes?.[meta.id]));
    const phases = ['idle', 'prefill', 'decode'].map((phase) => `<span class="${phase === current ? `m-on m-${phase}` : ''}">${esc(t(`mini.phase.${phase}`))}</span>`).join('');
    const showRates = latest?.inference?.reported?.outputTokensPerSecond !== false;
    const decodeCoverage = focusedRateCoverage('outputTokensPerSecond');
    const prefillCoverage = focusedRateCoverage(engineMetric(latest?.inference, 'promptComputeTokensPerSecond', { averages: false }).key);
    return `${showRates ? `<div class="m-head"><div class="m-phase">${phases}</div><span class="num">${esc(t('mini.twoMinutes'))}</span></div>
      <div class="m-scope"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="${esc(t('mini.scopeLabel'))}" role="img">${bands}<line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="var(--grid)"/>${bars}${line ? `<path d="${line}" fill="none" stroke="var(--blue)" stroke-width="2" vector-effect="non-scaling-stroke"/>` : ''}</svg><span class="m-lbl m-left">${esc(t('mini.decode'))} ${rate(last.decode)} tok/s${decodeCoverage ? `<br>${esc(decodeCoverage)}` : ''}</span><span class="m-lbl m-right">${esc(t('mini.prefill'))} ${rate(latest?.inference?.ok ? prefillRate(latest.inference) : null)}${prefillCoverage ? `<br>${esc(prefillCoverage)}` : ''}</span></div>` : ''}
      ${stacked ? '' : chips()}
      ${!showRates && !showTemps ? `<p class="m-empty">${esc(t(engineNeedsKey(latest?.inference) ? 'engine.apiKeyRequired' : 'mini.scopeUnavailable'))}</p>` : ''}
      ${showTemps ? `<div class="m-head"><span>${esc(t('node.reading.temp'))}</span><span class="num ${hotClass(hottest?.temp)}">${hottest ? esc(t('mini.hottest', { temp: tempText(hottest.temp), node: hottest.meta.name })) : unknown()}</span></div>
      <div class="m-scope m-temps"><svg viewBox="0 0 ${W} ${TH}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="${W}" y1="${ty(HOT_CELSIUS).toFixed(1)}" y2="${ty(HOT_CELSIUS).toFixed(1)}" stroke="var(--red)" stroke-dasharray="3 4" opacity=".6" vector-effect="non-scaling-stroke"/>${tempLines}</svg><span class="m-lbl m-right m-hot" style="top:${Math.max(0, ty(HOT_CELSIUS) - 15).toFixed(0)}px">${tempText(HOT_CELSIUS)}</span></div>` : ''}
      ${showRates ? footer(t('mini.shading')) : ''}`;
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
    const showTemps = finite(r.hottest) || metas.some(meta => hasNodeTemperature(latest?.nodes?.[meta.id]));
    const showPower = r.energyWh > 0 || gpuPowerWatts(Object.values(latest?.nodes ?? {})) !== null;
    return `<div class="m-stats">${r.reported?.outputTokensPerSecond !== false ? `<div><small>${esc(t('mini.run.avgDecode'))}</small><b>${rate(r.avgDecode)}</b>${change(r.avgDecode, previous?.avgDecode, 'up')}</div><div><small>${esc(t('mini.run.peakDecode'))}</small><b>${rate(r.peakDecode)}</b>${change(r.peakDecode, previous?.peakDecode, 'up')}</div>` : ''}
      ${engineMetric(r, 'promptComputeTokensPerSecond', { averages: false }).shown ? `<div><small>${esc(t('mini.run.peakPrefill'))}</small><b>${rate(r.peakPrefill)}</b>${change(r.peakPrefill, previous?.peakPrefill, 'up')}</div>` : ''}${engineMetric(r, 'ttftP95RecentSeconds').shown ? `<div><small>${esc(t('mini.run.slowestTtft'))}</small><b>${duration(r.slowestTtft)}</b>${change(r.slowestTtft, previous?.slowestTtft, 'down')}</div>` : ''}
      ${showTemps ? `<div><small>${esc(t('mini.run.hottest'))}</small><b class="${hotClass(r.hottest)}">${tempText(r.hottest)}</b> <em class="m-muted">${esc(node(r.hottestNode))}</em></div>` : ''}${showPower ? `<div><small>${esc(t('mini.run.energy'))}</small><b>${fixed(r.energyWh, 2)} Wh</b></div>` : ''}
      <div><small>${esc(t('mini.run.output'))}</small><b>${fixed(r.outputTokens, 0)}</b></div><div><small>${esc(t('mini.run.prompt'))}</small><b>${fixed(r.promptTokens, 0)}</b></div></div>`;
  }
  function runsView(now, stacked = false) {
    const v = latest?.inference?.ok ? latest.inference : null, previous = runs[0];
    const live = run ? finishRun({ ...run }, latest, (previous?.number ?? 0) + 1) : null;
    const control = run
      ? `<div class="m-rec"><span class="m-state m-recording"><span class="m-dot"></span>${esc(t('mini.run.recording'))} ${mmss((now - run.startedAt) / 1000)}</span><button type="button" class="m-stop" data-run="stop">${esc(t('mini.run.stop'))}</button></div>`
      : `<div class="m-rec"><span class="m-state m-muted">${esc(t('mini.run.ready'))}</span><button type="button" data-run="start">${esc(t('mini.run.start'))}</button></div>`;
    const shown = live ?? previous;
    const recent = runs.slice(0, 4), showTtft = recent.some(r => engineMetric(r, 'ttftP95RecentSeconds').shown);
    const showDecode = recent.some(r => r.reported?.outputTokensPerSecond !== false), showTemps = recent.some(r => finite(r.hottest));
    const columns = [showDecode ? t('mini.decode') : '', showTtft ? 'TTFT' : '', showTemps ? t('mini.run.max') : ''].filter(Boolean).join(' | ');
    const list = recent.map((r) => `<div><span><b>${esc(t('mini.run.name', { n: r.number }))}</b> ${esc(clockTime(r.startedAt, { seconds: false, hour12: hour12() }))} | ${mmss(r.seconds)}</span><span>${r.reported?.outputTokensPerSecond === false ? '' : rate(r.avgDecode)}</span><span>${showTtft && engineMetric(r, 'ttftP95RecentSeconds').shown ? `${duration(r.slowestTtft)}${showTemps ? ' | ' : ''}` : ''}${showTemps && finite(r.hottest) ? `${temperature(r.hottest, settings.temp)}°` : ''}</span></div>`).join('');
    return `${control}${stacked ? '' : `<div class="m-pair">${latest?.inference?.reported?.outputTokensPerSecond !== false ? metric(rateCaption('mini.decodeNow', 'outputTokensPerSecond'), rate(v?.outputTokensPerSecond), 'tok/s') : ''}${engineMetric(latest?.inference, 'promptComputeTokensPerSecond', { averages: false }).shown ? metric(rateCaption('mini.prefillNow', engineMetric(latest?.inference, 'promptComputeTokensPerSecond', { averages: false }).key), rate(v ? prefillRate(v) : null), 'tok/s') : ''}</div>`}
      ${shown ? `<div class="m-head"><span>${esc(live ? t('mini.run.thisRun') : t('mini.run.lastRun', { n: shown.number }))}</span><span class="num">${mmss(shown.seconds)}</span></div>${runStats(shown, live ? previous : runs[1])}` : `<p class="m-empty">${esc(t('mini.run.none'))}</p>`}
      ${runs.length ? `<div class="m-rule"></div><div class="m-head"><span>${esc(t('mini.run.list'))}</span><span>${esc(columns)}</span></div><div class="m-runs">${list}</div>` : ''}
      <div class="m-foot"><span>${esc(t('mini.run.kept'))}</span>${runs.length ? `<button type="button" class="m-link" data-run="csv">${esc(t('mini.run.csv'))}</button>` : ''}</div>`;
  }

  // The redrawn control that had keyboard focus, found again after a redraw; Start and Stop take each other's place.
  function focusedControl() {
    const el = doc.activeElement;
    if (!el || !content.contains(el)) return null;
    if (el.dataset.tab) return `[data-tab="${el.dataset.tab}"]`;
    if (el.dataset.run === 'start' || el.dataset.run === 'stop') return '[data-run="start"],[data-run="stop"]';
    if (el.dataset.run) return `[data-run="${el.dataset.run}"]`;
    return null;
  }

  function render() {
    const now = Date.now(), views = { glance, scope, runs: runsView }, focused = focusedControl();
    const empty = `<p class="m-empty">${esc(failed ? t('mini.offline') : t('mini.waiting'))}</p>`;
    const stacked = stackQuery.matches && !shortQuery.matches;
    root.classList.toggle('m-stacked', stacked);
    header();
    if (stacked) {
      // Scope and Runs leave out the request counts and current rates that Glance already shows above them.
      content.innerHTML = `${latest ? TABS.map((name) => `<section class="m-body m-tab-${name}"${name === 'glance' ? '' : ` aria-label="${esc(t(`mini.tab.${name}`))}"`}>${name === 'glance' ? '' : `<h2 class="m-part">${esc(t(`mini.tab.${name}`))}</h2>`}${views[name](now, true)}</section>`).join('') : empty}`;
    } else {
      const shown = shortQuery.matches ? 'glance' : tab;
      content.innerHTML = `${tabs()}<div class="m-body m-tab-${shown}">${latest ? views[shown](now) : empty}</div>`;
    }
    if (focused) content.querySelector(focused)?.focus({ preventScroll: true });
  }

  // A hidden tab stops asking with "pause while hidden" on, as the dashboard does, unless a run is being recorded.
  async function poll(first = false) {
    applySettings();
    if (!first && settings.pause && doc.hidden && !run) return;
    try {
      const response = await win.fetch(`${origin}/api/state?minutes=15${first ? '' : '&history=0'}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const state = focusState(await response.json(), settings);
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
    if (target.hasAttribute('data-back')) { if (onBack) onBack(); else win.location.assign(`${origin}/`); return; }
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

  const shown = () => { if (!doc.hidden) void poll(); };
  applySettings();
  render();
  onMediaChange(stackQuery, render);
  onMediaChange(shortQuery, render);
  doc.addEventListener('visibilitychange', shown);
  void poll(true);
  let timer = win.setInterval(() => void poll(), settings.refresh * 1000);
  return {
    close() {
      win.clearInterval(timer);
      timer = null;
      offMediaChange(stackQuery, render);
      offMediaChange(shortQuery, render);
      doc.removeEventListener('visibilitychange', shown);
    },
    recording: () => run !== null,
  };
}
