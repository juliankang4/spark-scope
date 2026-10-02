import {
  orderedNodes, nodeLinks, nodeView, reasonText, clusterView, seriesPoints, timePaths, valueRange, tempRangeLabel, f1, compact, freeLabel, panelWidth,
} from "./rack-view.js";

const POLL_MS = 2000;
const TEMP_POLL_MS = 30_000;
const FETCH_TIMEOUT_MS = 4000;
const RELOAD_MS = 12 * 60 * 60_000; // picks up page updates without touching the kiosk; only while the server answers
const BAND_WINDOW_MS = 5 * 60_000;
const BAND_GAP_MS = 15_000;
const TEMP_WINDOW_MS = 60 * 60_000;
const TEMP_GAP_MS = 120_000;
const TRACE_W = 178;
const TRACE_H = 150;
// The panel is laid out at BW x 480 logical pixels and scaled to the window. "?width=" changes BW (default 1920).
const BW = panelWidth(location.search);
const PANEL_H = 480;
const BH = 130;
const BAND_TOP = 18;
const BAND_BOTTOM = 122;

const screen = document.getElementById("screen");
screen.style.setProperty("--w", `${BW}px`);
const bays = document.getElementById("bays");
const bandPlot = document.getElementById("band-plot");
const bandSvg = document.getElementById("band-svg");
bandSvg.setAttribute("width", String(BW));
bandSvg.setAttribute("viewBox", `0 0 ${BW} ${BH}`);
const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let latest = null;
let lastReceivedAt = null;
let tempHistory = [];
let liveOut = [];
let bandAnchor = { serverMs: 0, clientMs: 0 };
const lastOkAt = {};
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function tempTrace(id, toMs) {
  const points = seriesPoints(tempHistory, (point) => point.nodes?.[id]?.temperature, toMs - TEMP_WINDOW_MS, toMs);
  const [min, max] = valueRange(points, 38, 64);
  const { line, area } = timePaths(points, { fromMs: toMs - TEMP_WINDOW_MS, toMs, width: TRACE_W, height: TRACE_H, min, max, gapMs: TEMP_GAP_MS });
  return {
    svg: `<svg width="${TRACE_W}" height="${TRACE_H}" viewBox="0 0 ${TRACE_W} ${TRACE_H}" aria-hidden="true"><path d="${area}" fill="var(--trace-fill)"/><path d="${line}" fill="none" stroke="var(--trace)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
    range: tempRangeLabel(points),
  };
}

// Keeps one bay element per node, in topology order, rebuilding only when the topology changes.
function syncBays(metas) {
  const ids = metas.map((meta) => meta.id).join(",");
  if (bays.dataset.ids === ids) return;
  bays.dataset.ids = ids;
  bays.dataset.count = metas.length <= 4 ? String(metas.length) : "many";
  bays.style.setProperty("--bays", String(metas.length));
  bays.innerHTML = metas.map((meta) => `<div class="bay" data-node="${escapeHtml(meta.id)}"></div>`).join("");
}

const meter = (label, value, pct, warn = false) => `<div class="meter"><div><span>${label}</span><b>${value}</b></div><div class="bar"><i class="${warn ? "warn" : ""}" style="width:${pct === null ? 0 : Math.max(0, Math.min(100, pct))}%"></i></div></div>`;

function renderBay(meta, toMs) {
  const links = nodeLinks(latest, meta.id);
  const view = nodeView(meta, latest.nodes?.[meta.id], { vllmOk: Boolean(latest?.vllm?.ok), lastOkAt: lastOkAt[meta.id], nowMs: toMs, links });
  const target = view.local ? "local" : view.host ? `SSH ${view.host}` : "no host";
  const el = bays.querySelector(`[data-node="${CSS.escape(meta.id)}"]`);
  el.className = `bay ${view.level}`;
  const head = `<span class="stripe"></span><header><div class="name">${escapeHtml(view.name)}<small>${escapeHtml(view.role)}</small></div><div class="reason" title="${escapeHtml(view.reasons.join(", "))}"><span class="lamp ${view.level}"></span><span>${escapeHtml(reasonText(view))}</span></div></header>`;
  const dots = view.links.length
    ? `<span class="lk">Links${view.links.map((link) => `<em><i class="${link.level}"></i>${escapeHtml(link.tag)}</em>`).join("")}</span>`
    : "";
  if (!view.ok) {
    const body = view.pending
      ? `<div class="down"><b class="num">—</b><span>${view.waiting ? "Waiting for the first poll" : `Not collected | ${escapeHtml(target)}`}</span></div>`
      : `<div class="down"><b class="num">—</b><span>${escapeHtml(target)} not responding${view.lastOk ? ` | last OK ${view.lastOk}` : ""}</span></div>`;
    const note = view.pending ? "No readings yet" : "Readings unavailable";
    el.innerHTML = `${head}${body}<div class="foot"><span>${note}</span>${dots}</div>`;
    return;
  }
  const trace = tempTrace(meta.id, toMs);
  el.innerHTML = `${head}
    <div class="main">
      <div class="temp">${trace.svg}<b class="num halo">${view.temp === null ? "—" : Math.round(view.temp)}<sup>°C</sup></b></div>
      <div class="meters">
        ${meter("GPU load", `${view.load ?? "—"}%`, view.load)}
        ${meter(`RAM (${freeLabel(view.memFreeGiB)} free)`, `${view.memUsedPct ?? "—"}%`, view.memUsedPct)}
        ${meter(`Disk (${freeLabel(view.diskFreeGiB)} free)`, `${view.diskPct ?? "—"}%`, view.diskPct, view.diskWarn)}
      </div>
      <div class="cap">GPU temp 60 min: ${trace.range}</div>
    </div>
    <div class="foot"><span>Power ${f1(view.power)} W</span>${view.tsoc === null ? "" : `<span>TSOC ${f1(view.tsoc)}°C</span>`}${dots}</div>`;
}

function drawBand() {
  const toMs = bandAnchor.serverMs;
  const fromMs = toMs - BAND_WINDOW_MS;
  const merged = new Map();
  for (const point of seriesPoints(latest?.history, "outputTokensPerSecond", fromMs - BAND_GAP_MS, toMs)) merged.set(point.at, point);
  for (const point of liveOut) if (point.at >= fromMs - BAND_GAP_MS) merged.set(point.at, point);
  const points = [...merged.values()].sort((a, b) => a.at - b.at);
  const peak = Math.max(0, ...points.map((point) => point.value ?? 0));
  const max = Math.max(40, Math.ceil(peak / 10) * 10);
  const { line, area } = timePaths(points, { fromMs, toMs, width: BW, height: BH, min: 0, max, gapMs: BAND_GAP_MS, top: BAND_TOP, bottom: BAND_BOTTOM });
  // Minute ticks and the baseline run one minute past the right edge so scrolling never uncovers a bare edge.
  let grid = "";
  for (let minute = Math.ceil(fromMs / 60_000) * 60_000; minute <= toMs + 60_000; minute += 60_000) {
    const x = ((minute - fromMs) / BAND_WINDOW_MS * BW).toFixed(1);
    grid += `<line x1="${x}" x2="${x}" y1="${BAND_BOTTOM - 10}" y2="${BAND_BOTTOM}" stroke="#3a3a3a" stroke-width="2"/>`;
  }
  bandPlot.innerHTML = `${grid}<line x1="0" x2="${BW * 1.2}" y1="${BAND_BOTTOM}" y2="${BAND_BOTTOM}" stroke="#262626" stroke-width="1"/><path d="${area}" fill="var(--data-fill)"/><path d="${line}" fill="none" stroke="var(--data)" stroke-opacity=".8" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
}

function renderCluster(fetchFailed) {
  const view = clusterView(latest, { fetchFailed, lastReceivedAt });
  screen.classList.toggle("stale", Boolean(view.stale));
  $("cl-lamp").className = `lamp ${view.level}`;
  $("cl-title").textContent = view.title;
  $("cl-line1").textContent = view.lines[0] ?? "";
  $("cl-line2").textContent = view.lines[1] ?? "";
  $("out-value").textContent = f1(view.out);
  $("tok-total").textContent = compact(view.todayTotal);
  $("tok-sub").textContent = view.todayRequests === null ? "Tokens today" : `Tokens today | ${view.todayRequests.toLocaleString("en-US")} requests`;
}

function render() {
  const toMs = Date.parse(latest.updatedAt) || Date.now();
  const metas = orderedNodes(latest);
  syncBays(metas);
  for (const meta of metas) renderBay(meta, toMs);
  drawBand();
  renderCluster(false);
}

async function poll() {
  try {
    const state = await getJson("/api/state?minutes=15");
    latest = state;
    lastReceivedAt = new Date();
    for (const [id, node] of Object.entries(state.nodes ?? {})) if (node?.ok) lastOkAt[id] = node.updatedAt ?? state.updatedAt;
    const at = Date.parse(state.vllm?.updatedAt ?? state.updatedAt);
    if (Number.isFinite(at) && at !== liveOut.at(-1)?.at) {
      liveOut.push({ at, value: state.vllm?.ok && Number.isFinite(state.vllm.outputTokensPerSecond) ? state.vllm.outputTokensPerSecond : null });
      liveOut = liveOut.filter((point) => point.at >= at - BAND_WINDOW_MS - BAND_GAP_MS);
    }
    bandAnchor = { serverMs: Date.parse(state.updatedAt) || Date.now(), clientMs: performance.now() };
    render();
  } catch {
    renderCluster(true);
  }
}

async function pollTemps() {
  try {
    const state = await getJson("/api/state?minutes=60");
    tempHistory = state.history ?? [];
    if (latest) render();
  } catch {
    // Keep the previous trace; the 2-second poll reports the disconnect.
  }
}

function scroll(now) {
  const offset = reduceMotion.matches || !latest ? 0 : -((now - bandAnchor.clientMs) / BAND_WINDOW_MS) * BW;
  bandPlot.setAttribute("transform", `translate(${offset.toFixed(2)} 0)`);
  requestAnimationFrame(scroll);
}

function fit() {
  const scale = Math.min(innerWidth / BW, innerHeight / PANEL_H);
  screen.style.transform = `scale(${scale})`;
}

addEventListener("resize", fit);
fit();
await pollTemps();
await poll();
setInterval(poll, POLL_MS);
setInterval(pollTemps, TEMP_POLL_MS);
setTimeout(function reloadWhenReachable() {
  if (lastReceivedAt && Date.now() - lastReceivedAt.getTime() < 10_000) location.reload();
  else setTimeout(reloadWhenReachable, 60_000);
}, RELOAD_MS);
requestAnimationFrame(scroll);
