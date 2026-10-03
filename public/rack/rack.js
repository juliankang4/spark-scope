import {
  orderedNodes, nodeLinks, nodeView, reasonText, clusterView, seriesPoints, timePaths, valueRange, tempRangeLabel, f1, compact, freeLabel, panelWidth, bayLayout, BRAND, degrees, degreeUnit, bayColor, bayColorStyle, rackFocus,
} from "./rack-view.js";
import { modelServers, serverOfNode, serverName } from "../view-data.js";
import { t, setLanguage, queryLanguage, translatePage } from "../i18n.js";
import { settingsFromQuery, DEFAULTS } from "../settings.js";

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
// "?lang=ko" shows the panel in Korean; the kiosk has no keyboard, so the address is the only setting. The same
// address takes the web page's temp, mem, colors and motion settings (the settings dialog builds the kiosk URL).
const options = settingsFromQuery(location.search)?.settings ?? DEFAULTS;
setLanguage(queryLanguage(location.search));
translatePage();
document.getElementById("cl-line1").textContent = t("rack.cluster.waitingBrand", { brand: BRAND });
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
// The band's right edge follows this browser's clock, set to the server's time. The server's updatedAt moves in uneven
// steps (the engine poll and the node poll both set it), and drawing to it made the band jump back and forth.
// updatedAt is never ahead of the server's clock, so the largest offset seen is the closest; a much smaller one means
// a clock was set back.
let clockOffsetMs = null;
let bandAnchor = { serverMs: 0 };
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
    range: tempRangeLabel(points, options.temp),
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

function renderBay(meta, toMs, index) {
  const links = nodeLinks(latest, meta.id);
  // A node needs an inference process only while its own server's API answers; with several servers the bay names it.
  const servers = modelServers(latest), server = serverOfNode(servers, meta.id);
  const view = nodeView(meta, latest.nodes?.[meta.id], { inferenceOk: Boolean(server?.inference?.ok), lastOkAt: lastOkAt[meta.id], nowMs: toMs, links, mem: options.mem });
  if (servers.length > 1 && server) view.role = `${serverName(server)} | ${view.role}`;
  const target = view.local ? t("node.target.local") : view.host ? `SSH ${view.host}` : t("node.target.noHost");
  const el = bays.querySelector(`[data-node="${CSS.escape(meta.id)}"]`);
  el.className = `bay ${view.level}`;
  // With "?colors=", the bay's bars and temperature trace take the node's colour; the stripe keeps its state colour.
  el.style.cssText = bayColorStyle(bayColor(options.colors, index));
  const head = `<span class="stripe"></span><header><div class="name">${escapeHtml(view.name)} <small>${escapeHtml(view.role)}</small></div><div class="reason" title="${escapeHtml(view.reasons.join(", "))}"><span class="lamp ${view.level}"></span><span>${escapeHtml(reasonText(view))}</span></div></header>`;
  // Peer names next to the dots only while the ids are short; long ids leave just the coloured dots.
  const named = view.links.every((link) => link.peer.length <= 6);
  const dots = view.links.length
    ? `<span class="lk${named ? "" : " dots"}"><span class="lk-label">${t("rack.bay.links")}</span>${view.links.map((link) => `<em><i class="${link.level}"></i>${escapeHtml(link.tag)}</em>`).join("")}</span>`
    : "";
  if (!view.ok) {
    const body = view.pending
      ? `<div class="down"><b class="num">—</b><span>${view.waiting ? t("rack.bay.waitingFirstPoll") : escapeHtml(t("rack.bay.notCollected", { target }))}</span></div>`
      : `<div class="down"><b class="num">—</b><span>${escapeHtml(t("rack.bay.notResponding", { target }))}${view.lastOk ? ` | ${t("rack.bay.lastOk", { time: view.lastOk })}` : ""}</span></div>`;
    const note = t(view.pending ? "rack.bay.noReadingsYet" : "rack.bay.readingsUnavailable");
    el.innerHTML = `${head}${body}<div class="foot"><span>${note}</span>${dots}</div>`;
    fitFoot(el);
    return;
  }
  const trace = tempTrace(meta.id, toMs);
  el.innerHTML = `${head}
    <div class="main">
      <div class="temp">${trace.svg}<b class="num halo${view.temp !== null && Math.round(degrees(view.temp, options.temp)) >= 100 ? " triple" : ""}">${view.temp === null ? "—" : Math.round(degrees(view.temp, options.temp))}<sup>${degreeUnit(options.temp)}</sup></b></div>
      <div class="meters">
        ${meter(t("rack.meter.gpuLoad"), `${view.load ?? "—"}%`, view.load)}
        ${meter("RAM", `${view.memUsedPct ?? "—"}%`, view.memUsedPct, false, t("rack.meter.free", { free: freeLabel(view.memFreeGiB, options.mem) }))}
        ${meter(t("rack.meter.disk"), `${view.diskPct ?? "—"}%`, view.diskPct, view.diskWarn, t("rack.meter.free", { free: freeLabel(view.diskFreeGiB, options.mem) }))}
      </div>
      <div class="cap"><span class="cap-label">${t("rack.caption.gpuTemp")} </span>${t("rack.caption.range", { range: trace.range })}</div>
    </div>
    <div class="foot"><span>${t("rack.power", { watts: f1(view.power) })}</span>${view.tsoc === null ? "" : `<span class="tsoc">TSOC ${f1(degrees(view.tsoc, options.temp))}${degreeUnit(options.temp)}</span>`}${dots}</div>`;
  fitFoot(el);
}

// The footer keeps its first reading (the power) whole: when the line does not fit, the link dots drop their peer
// names, then the TSOC reading and the "Links" label go, and only then is the power cut short.
function fitFoot(bay) {
  const foot = bay.querySelector(".foot");
  const steps = ["fit-dots", "fit-tsoc", "fit-label", "fit-first"];
  foot.classList.remove(...steps);
  for (const step of steps) {
    if (foot.scrollWidth <= foot.clientWidth) return;
    foot.classList.add(step);
  }
}

// The band moves left between polls with one CSS transition per poll (composited), instead of a script that moves
// it every frame. It covers about 13 px per poll, so it moves in steps of about one pixel: a smooth glide would make
// Chromium and the compositor draw a new frame at the display rate all day for sub-pixel moves.
// Each redraw puts it back at the start; with reduced motion or while disconnected it stays still.
const BAND_SHIFT = (POLL_MS / BAND_WINDOW_MS) * BW;
function glideBand() {
  bandSvg.style.transition = "none";
  bandSvg.style.transform = "translateX(0px)";
  if (reduceMotion.matches || options.motion === "still" || screen.classList.contains("stale")) return;
  void bandSvg.getBoundingClientRect();
  bandSvg.style.transition = `transform ${POLL_MS}ms ${options.motion === "smooth" ? "linear" : `steps(${Math.max(1, Math.round(BAND_SHIFT))}, end)`}`;
  bandSvg.style.transform = `translateX(${(-BAND_SHIFT).toFixed(2)}px)`;
}

function drawBand() {
  const toMs = bandAnchor.serverMs;
  const fromMs = toMs - BAND_WINDOW_MS;
  const merged = new Map();
  // Earlier samples come from the 60-minute history (refreshed every 30 s), up to the first 2-second poll: the history
  // holds 10-second averages, and mixing them with the polls' raw values drew dips and spikes that never happened.
  const historyEnd = Math.min(toMs, (liveOut[0]?.at ?? Infinity) - 1);
  const focus = latest?.focusServer, output = focus ? (point) => point.servers?.[focus]?.outputTokensPerSecond : "outputTokensPerSecond";
  for (const point of seriesPoints(tempHistory, output, fromMs - BAND_GAP_MS, historyEnd)) merged.set(point.at, point);
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
  // With several servers the first line is a chip per server: its state lamp, its name and its output.
  // Each chip keeps its lamp and figure; only the names get shorter when the chips do not fit.
  $("cl-line1").classList.toggle("chips", Boolean(view.chips));
  if (view.chips) {
    const line = $("cl-line1");
    line.innerHTML = view.chips.map((chip) => `<span class="chip"><span class="lamp ${chip.level}"></span><span class="chip-name">${escapeHtml(chip.name)}</span><b>${escapeHtml(chip.value)}${chip.unit ? `<span class="unit"> ${escapeHtml(chip.unit)}</span>` : ""}</b></span>`).join("");
    fitChips(line);
    // Text is measured with the fonts at hand; a font that loads after this draw (wider than its fallback) refits.
    document.fonts?.ready.then(() => fitChips(line));
  } else $("cl-line1").textContent = view.lines[0] ?? "";
  $("cl-line2").textContent = view.lines[1] ?? "";
  $("out-value").textContent = f1(view.out);
  $("tok-total").textContent = compact(view.todayTotal);
  $("tok-sub").textContent = view.todayRequests === null ? t("rack.tokensToday") : t("rack.tokensTodayRequests", { count: view.todayRequests.toLocaleString("en-US") });
}

// Where even a lamp and a figure do not fit, the figures drop their unit, then the figures go and each chip keeps its
// lamp and name (the big figure has the total; the band's job here is which server serves).
function fitChips(line) {
  line.classList.remove("tight", "tighter");
  const cut = () => [...line.children].some((chip) => chip.scrollWidth > chip.clientWidth + 1);
  if (cut()) line.classList.add("tight");
  if (cut()) line.classList.add("tighter");
}

function renderBays() {
  const toMs = Date.parse(latest.updatedAt) || Date.now();
  const metas = orderedNodes(latest);
  syncBays(metas);
  metas.forEach((meta, index) => renderBay(meta, toMs, index));
  // The footers were fitted with the fonts at hand; a font that loads after this draw refits them.
  document.fonts?.ready.then(() => bays.querySelectorAll(".bay").forEach((bay) => { if (bay.querySelector(".foot")) fitFoot(bay); }));
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
    state = await getJson("/api/state?minutes=15&history=0&from=rack");
  } catch {
    renderCluster(true);
  }
  try {
    if (state) {
      // The band follows every model server together, or the one named by "?server=".
      latest = rackFocus(state, options.server);
      lastReceivedAt = new Date();
      for (const [id, node] of Object.entries(state.nodes ?? {})) if (node?.ok) lastOkAt[id] = node.updatedAt ?? state.updatedAt;
      const live = latest.inference, at = Date.parse(live?.updatedAt ?? state.updatedAt);
      if (Number.isFinite(at) && at !== liveOut[liveOut.length - 1]?.at) {
        liveOut.push({ at, value: live?.ok && Number.isFinite(live.outputTokensPerSecond) ? live.outputTokensPerSecond : null });
        liveOut = liveOut.filter((point) => point.at >= at - BAND_WINDOW_MS - BAND_GAP_MS);
      }
      const serverMs = Date.parse(state.updatedAt);
      if (Number.isFinite(serverMs)) {
        const offset = serverMs - Date.now();
        if (clockOffsetMs === null || offset > clockOffsetMs || offset < clockOffsetMs - 30_000) clockOffsetMs = offset;
      }
      bandAnchor = { serverMs: Date.now() + (clockOffsetMs ?? 0) };
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
    const state = await getJson("/api/state?minutes=60&from=rack");
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
