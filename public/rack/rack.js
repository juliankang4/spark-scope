import {
  orderedNodes, nodeLinks, nodeView, reasonText, clusterView, seriesPoints, timePaths, valueRange, tempRangeLabel, f1, compact, freeLabel, panelWidth, bayLayout,
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
// Below 1440 logical pixels (small 16:9 or 16:10 screens) the bottom band uses smaller type.
screen.classList.toggle("narrow", BW < 1440);
const bays = document.getElementById("bays");
const bandPlot = document.getElementById("band-plot");
const bandSvg = document.getElementById("band-svg");
bandSvg.setAttribute("width", String(BW));
bandSvg.setAttribute("viewBox", `0 0 ${BW} ${BH}`);
const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let latest = null;
let lastReceivedAt = null;
let polling = false;
let tempHistory = [];
let liveOut = [];
let bandAnchor = { serverMs: 0, clientMs: 0 };
const lastOkAt = {};
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const onMotionChange = (listener) => (reduceMotion.addEventListener ? reduceMotion.addEventListener("change", listener) : reduceMotion.addListener?.(listener));

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
    svg: `<svg width="${TRACE_W}" height="${TRACE_H}" viewBox="0 0 ${TRACE_W} ${TRACE_H}" preserveAspectRatio="none" aria-hidden="true"><path d="${area}" fill="var(--trace-fill)"/><path d="${line}" fill="none" stroke="var(--trace)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
    range: tempRangeLabel(points),
  };
}

// Keeps one bay element per node, in topology order, rebuilding only when the topology changes.
function syncBays(metas) {
  const ids = metas.map((meta) => meta.id).join(",");
  if (bays.dataset.ids === ids) return;
  bays.dataset.ids = ids;
  bays.dataset.count = metas.length <= 4 ? String(metas.length) : "many";
  bays.dataset.layout = bayLayout(metas.length, BW);
  bays.style.setProperty("--bays", String(metas.length));
  bays.innerHTML = metas.map((meta) => `<div class="bay" data-node="${escapeHtml(meta.id)}"></div>`).join("");
}

// detail is the part of the label that may be cut short with an ellipsis in a very narrow bay.
const meter = (label, value, pct, warn = false, detail = "") => `<div class="meter"><div><span>${label}${detail ? `<em> ${detail}</em>` : ""}</span><b>${value}</b></div><div class="bar"><i class="${warn ? "warn" : ""}" style="width:${pct === null ? 0 : Math.max(0, Math.min(100, pct))}%"></i></div></div>`;

function renderBay(meta, toMs) {
  const links = nodeLinks(latest, meta.id);
  const view = nodeView(meta, latest.nodes?.[meta.id], { inferenceOk: Boolean(latest?.inference?.ok), lastOkAt: lastOkAt[meta.id], nowMs: toMs, links });
  const target = view.local ? "local" : view.host ? `SSH ${view.host}` : "no host";
  const el = bays.querySelector(`[data-node="${CSS.escape(meta.id)}"]`);
  el.className = `bay ${view.level}`;
  const head = `<span class="stripe"></span><header><div class="name">${escapeHtml(view.name)}<small>${escapeHtml(view.role)}</small></div><div class="reason" title="${escapeHtml(view.reasons.join(", "))}"><span class="lamp ${view.level}"></span><span>${escapeHtml(reasonText(view))}</span></div></header>`;
  // Peer names next to the dots only while they are short; long ids leave just the coloured dots.
  const named = view.links.every((link) => link.tag.length <= 6);
  const dots = view.links.length
    ? `<span class="lk${named ? "" : " dots"}">Links${view.links.map((link) => `<em><i class="${link.level}"></i>${escapeHtml(link.tag)}</em>`).join("")}</span>`
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
        ${meter("RAM", `${view.memUsedPct ?? "—"}%`, view.memUsedPct, false, `(${freeLabel(view.memFreeGiB)} free)`)}
        ${meter("Disk", `${view.diskPct ?? "—"}%`, view.diskPct, view.diskWarn, `(${freeLabel(view.diskFreeGiB)} free)`)}
      </div>
      <div class="cap"><span class="cap-label">GPU temp </span>60 min: ${trace.range}</div>
    </div>
    <div class="foot"><span>Power ${f1(view.power)} W</span>${view.tsoc === null ? "" : `<span class="tsoc">TSOC ${f1(view.tsoc)}°C</span>`}${dots}</div>`;
}

// The band moves left between polls with one CSS transition per poll (composited), instead of a script that moves
// it every frame. It covers about 13 px per poll, so it moves in steps of about one pixel: a smooth glide would make
// Chromium and the compositor draw a new frame at the display rate all day for sub-pixel moves.
// Each redraw puts it back at the start; with reduced motion or while disconnected it stays still.
const BAND_SHIFT = (POLL_MS / BAND_WINDOW_MS) * BW;
function glideBand() {
  bandSvg.style.transition = "none";
  bandSvg.style.transform = "translateX(0px)";
  if (reduceMotion.matches || screen.classList.contains("stale")) return;
  void bandSvg.getBoundingClientRect();
  bandSvg.style.transition = `transform ${POLL_MS}ms steps(${Math.max(1, Math.round(BAND_SHIFT))}, end)`;
  bandSvg.style.transform = `translateX(${(-BAND_SHIFT).toFixed(2)}px)`;
}

function drawBand() {
  const toMs = bandAnchor.serverMs;
  const fromMs = toMs - BAND_WINDOW_MS;
  const merged = new Map();
  // Earlier samples come from the 60-minute history (refreshed every 30 s); the 2-second polls add their own.
  for (const point of seriesPoints(tempHistory, "outputTokensPerSecond", fromMs - BAND_GAP_MS, toMs)) merged.set(point.at, point);
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
  glideBand();
}

function renderCluster(fetchFailed) {
  const view = clusterView(latest, { fetchFailed, lastReceivedAt });
  const wasStale = screen.classList.contains("stale");
  screen.classList.toggle("stale", Boolean(view.stale));
  if (view.stale && !wasStale) glideBand();
  $("cl-lamp").className = `lamp ${view.level}`;
  $("cl-title").textContent = view.title;
  $("cl-line1").textContent = view.lines[0] ?? "";
  $("cl-line2").textContent = view.lines[1] ?? "";
  $("out-value").textContent = f1(view.out);
  $("tok-total").textContent = compact(view.todayTotal);
  $("tok-sub").textContent = view.todayRequests === null ? "Tokens today" : `Tokens today | ${view.todayRequests.toLocaleString("en-US")} requests`;
}

function renderBays() {
  const toMs = Date.parse(latest.updatedAt) || Date.now();
  const metas = orderedNodes(latest);
  syncBays(metas);
  for (const meta of metas) renderBay(meta, toMs);
}

function render() {
  renderBays();
  drawBand();
  renderCluster(false);
}

// Every two seconds, without history (small and cheap); one poll at a time, so answers never arrive out of order.
async function poll() {
  if (polling) return;
  polling = true;
  let state = null;
  try {
    state = await getJson("/api/state?minutes=15&history=0");
  } catch {
    renderCluster(true);
  }
  try {
    if (state) {
      latest = state;
      lastReceivedAt = new Date();
      for (const [id, node] of Object.entries(state.nodes ?? {})) if (node?.ok) lastOkAt[id] = node.updatedAt ?? state.updatedAt;
      const at = Date.parse(state.inference?.updatedAt ?? state.updatedAt);
      if (Number.isFinite(at) && at !== liveOut[liveOut.length - 1]?.at) {
        liveOut.push({ at, value: state.inference?.ok && Number.isFinite(state.inference.outputTokensPerSecond) ? state.inference.outputTokensPerSecond : null });
        liveOut = liveOut.filter((point) => point.at >= at - BAND_WINDOW_MS - BAND_GAP_MS);
      }
      bandAnchor = { serverMs: Date.parse(state.updatedAt) || Date.now(), clientMs: performance.now() };
      render();
    }
  } catch (error) {
    // A drawing problem is not a lost connection: keep the last good panel and say what broke.
    console.error("Spark Scope rack could not draw the latest state:", error);
  } finally {
    polling = false;
  }
}

// Every 30 s: the 60-minute history for the temperature traces and the band's earlier samples.
async function pollTemps() {
  try {
    const state = await getJson("/api/state?minutes=60");
    tempHistory = state.history ?? [];
    if (latest) renderBays();
  } catch {
    // Keep the previous trace; the 2-second poll reports the disconnect.
  }
}

// Scales the panel to the window and centres it, so a display of another shape gets even borders.
function fit() {
  const scale = Math.min(innerWidth / BW, innerHeight / PANEL_H);
  const left = Math.max(0, (innerWidth - BW * scale) / 2);
  const top = Math.max(0, (innerHeight - PANEL_H * scale) / 2);
  screen.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px) scale(${scale})`;
}

addEventListener("resize", fit);
fit();
await pollTemps();
await poll();
setInterval(poll, POLL_MS);
setInterval(pollTemps, TEMP_POLL_MS);
// Reloads only right after the server answered a health check, so the kiosk never lands on an error page.
setTimeout(async function reloadWhenReachable() {
  try {
    await getJson("/api/health").catch((error) => { if (!/HTTP 503/.test(error.message)) throw error; });
    location.reload();
  } catch {
    setTimeout(reloadWhenReachable, 60_000);
  }
}, RELOAD_MS);
onMotionChange(() => glideBand());
