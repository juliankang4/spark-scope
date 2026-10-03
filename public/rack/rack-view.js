// Pure view-model helpers for the Spark Scope rack panel (1920 x 480 by default). No DOM access, so node --test can import them.
import { compact as compactCount, roleName, systemStateText, modelServers, combinedInference, serverName } from "../view-data.js";
import { t, serverText } from "../i18n.js";

export const BRAND = "SPARK SCOPE";
const GIB = 2 ** 30;

export const DISK_WARN_PERCENT = 95;
export const MEMORY_WARN_GIB = 2;
// Past events (a kernel warning, a container restart) clear after this window; ongoing conditions stay.
export const EVENT_WINDOW_MS = 10 * 60_000;

const LINK_LEVELS = { up: "good", partial: "warn", pending: "warn", down: "crit", unknown: "idle" };
const PLANE_NAMES = { a: "A", b: "B" };

const finite = (value) => typeof value === "number" && Number.isFinite(value);

export function f1(value) {
  return finite(value) ? value.toFixed(1) : "—";
}

// Token counts in the web page's format (1.5K, 9.55M, 1.06B); a dash when unknown.
export const compact = (value) => compactCount(value, "—");

// Free space for a bar label: 2.5 TiB, 319 GiB, 7.7 GiB, or in decimal units with "?mem=gb" (2.7 TB, 343 GB, 8.3 GB).
// The unit is chosen after rounding (999.6 GiB reads 1.0 TiB).
export function freeLabel(gib, unit = "gib") {
  if (!finite(gib)) return "—";
  const decimal = unit === "gb", value = decimal ? gib * 2 ** 30 / 1e9 : gib, step = decimal ? 1000 : 1024;
  const [small, large] = decimal ? ["GB", "TB"] : ["GiB", "TiB"];
  if (Math.round(value) >= 1000) return `${(value / step).toFixed(1)} ${large}`;
  if (Number(value.toFixed(1)) >= 10) return `${Math.round(value)} ${small}`;
  return `${value.toFixed(1)} ${small}`;
}

// Node colours on the always-dark rack panel: the palette's dark values (as in styles.css), or a custom #rrggbb.
// null without a choice, so the panel keeps its single data colour.
export const RACK_PALETTE = { blue: "#7cbbeb", orange: "#f5ac7c", green: "#75cbae", ink: "#eeeeee", purple: "#c3a6ef", gold: "#dcc06a", magenta: "#f093c8", umber: "#c4b5a7", red: "#f29791" };
export function bayColor(colors, index) {
  const choice = colors?.[index];
  return RACK_PALETTE[choice] ?? (/^#[0-9a-f]{6}$/i.test(choice ?? "") ? choice : null);
}
// The bar and temperature-trace colours of one bay, from its node colour.
export function bayColorStyle(hex) {
  if (!hex) return "";
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `--data:${hex};--trace:rgba(${r},${g},${b},.55);--trace-fill:rgba(${r},${g},${b},.10)`;
}

// A temperature in the rack's unit ("?temp=f"), as a number; null stays null.
export const degrees = (celsius, unit = "c") => (finite(celsius) ? (unit === "f" ? celsius * 9 / 5 + 32 : celsius) : null);
export const degreeUnit = (unit = "c") => (unit === "f" ? "°F" : "°C");

// A 24-hour wall-clock time in the viewer's locale and time zone (both overridable, for tests).
export function clockTime(value, { seconds = false, timeZone, locale } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (value == null || Number.isNaN(date.getTime())) return "—";
  const options = { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(seconds ? { second: "2-digit" } : {}) };
  try {
    return date.toLocaleTimeString(locale, { ...options, timeZone });
  } catch {
    return date.toLocaleTimeString(undefined, options);
  }
}

// Bays follow the node order in topology.json. Without a topology, fall back to the node keys.
export function orderedNodes(state) {
  const metas = state?.topology?.nodes;
  if (Array.isArray(metas) && metas.length) return metas;
  return Object.keys(state?.nodes ?? {}).map((id) => ({ id, name: state.nodes[id]?.name ?? state.nodes[id]?.host ?? id, role: state.nodes[id]?.role, collect: true, inference: true }));
}

export function linkLevel(link) {
  if (!link) return "idle";
  if (link.state === "up" && link.slow) return "warn";
  return LINK_LEVELS[link.state] ?? "idle";
}

// The bay-header wording for a link problem; null when there is nothing to say (up or not observable).
export function linkReason(link) {
  if (!link) return null;
  const label = link.label ?? String(link.id ?? "").replace("-", "–");
  const planes = Array.isArray(link.planes) && link.planes.length ? link.planes : Object.keys(PLANE_NAMES);
  if (link.state === "pending") return t("rack.link.notCabled", { label });
  if (link.state === "down") return t("rack.link.down", { label });
  if (link.state === "partial") {
    // Partial always has a dark plane next to one that is up; a plane nobody can see makes the link unknown instead.
    const dark = planes.filter((plane) => link[plane]?.up === false);
    return t("rack.link.planesDown", { label, planes: dark.map((plane) => PLANE_NAMES[plane]).join("/") });
  }
  if (link.state === "up" && link.slow) {
    const speeds = planes.map((plane) => link[plane]?.speedGbps).filter(finite);
    return speeds.length ? t("rack.link.slow", { label, speed: Math.round(Math.min(...speeds)) }) : t("rack.link.slowNoSpeed", { label });
  }
  return null;
}

// The links touching one node, for its bay's dots. In a ring the link arriving from the previous node comes
// first, then the one to the next. Several cables to the same peer (two nodes, two cables) get "#1", "#2".
export function nodeLinks(state, id) {
  const links = state?.topology?.links ?? [];
  const touching = links.filter((link) => link.nodes?.includes(id));
  const incoming = touching.filter((link) => link.nodes[1] === id);
  const outgoing = touching.filter((link) => link.nodes[1] !== id);
  const ordered = [...incoming, ...outgoing];
  const perPeer = new Map();
  for (const link of ordered) {
    const peer = link.nodes.find((nodeId) => nodeId !== id);
    perPeer.set(peer, (perPeer.get(peer) ?? 0) + 1);
  }
  const seen = new Map();
  return ordered.map((link) => {
    const live = state?.ringLinks?.[link.id] ?? { ...link, state: "unknown" };
    const peer = link.nodes.find((nodeId) => nodeId !== id);
    const index = (seen.get(peer) ?? 0) + 1;
    seen.set(peer, index);
    const tag = perPeer.get(peer) > 1 ? `${peer} #${index}` : peer;
    return { ...link, ...live, label: link.label ?? live.label, peer, tag };
  });
}

const GPU_PROBLEMS = {
  stuck: { level: "crit", key: "rack.gpu.stuck" },
  timeout: { level: "crit", key: "rack.gpu.timeout" },
  error: { level: "crit", key: "rack.gpu.error" },
  missing: { level: "warn", key: "rack.gpu.missing" },
};

// Reasons are ordered by severity so the bay header can show the most important one.
export function nodeView(meta, node, { inferenceOk = false, lastOkAt = null, nowMs = Date.now(), links = [], clock = {}, mem = "gib" } = {}) {
  const id = meta?.id ?? node?.id ?? "?";
  const base = {
    id,
    name: meta?.name ?? node?.name ?? node?.host ?? id,
    host: meta?.host ?? node?.host ?? null,
    local: Boolean(meta?.local ?? node?.local),
    role: roleName(meta?.role ?? node?.role),
    links: links.map((link) => ({ peer: link.peer, tag: link.tag ?? link.peer, level: linkLevel(link) })),
  };
  const linkReasons = links.map(linkReason).filter(Boolean);
  if (meta?.collect === false || node?.collected === false) {
    // Not collected: neighbours can still vouch for its links, but its own figures are unknown (the body says so).
    return { ...base, ok: false, pending: true, level: linkReasons.length ? "warn" : "idle", reasons: linkReasons.length ? linkReasons : [t("rack.reason.notCollected")] };
  }
  if (!node) return { ...base, ok: false, pending: true, waiting: true, level: "idle", reasons: [t("rack.reason.waitingData")] };
  if (!node.ok) {
    return {
      ...base, ok: false, pending: false, level: "crit", reasons: [t("rack.reason.noResponse")],
      error: node.error ?? null,
      lastOk: lastOkAt ? clockTime(lastOkAt, clock) : null,
    };
  }
  const total = node.memory?.totalBytes;
  const available = node.memory?.availableBytes;
  const memFreeGiB = finite(available) ? available / GIB : null;
  const memUsedPct = finite(total) && finite(available) && total > 0 ? Math.round((total - available) / total * 100) : null;
  const diskPct = finite(node.disk?.usedPercent) ? node.disk.usedPercent : null;
  const diskFreeGiB = finite(node.disk?.availableBytes) ? node.disk.availableBytes / GIB : null;
  const restarts = finite(node.container?.restarts) ? node.container.restarts : null;
  const kernel = node.kernelEvents;
  const recent = (at) => {
    const ms = Date.parse(at ?? "");
    return Number.isFinite(ms) && nowMs - ms <= EVENT_WINDOW_MS;
  };

  const crit = [];
  const warn = [...linkReasons];
  if (node.gpu?.thermalSlowdown) crit.push(t("rack.reason.thermalSlowdown"));
  // No GPU readings: a hung or failing nvidia-smi is a likely GPU fault; a missing one is a setup issue.
  const gpuProblem = node.gpu?.available === false ? GPU_PROBLEMS[node.gpu.status] ?? GPU_PROBLEMS.error : null;
  if (gpuProblem) (gpuProblem.level === "crit" ? crit : warn).push(t(gpuProblem.key));
  if (node.systemState && node.systemState !== "running") warn.push(t("rack.reason.system", { state: systemStateText(node.systemState) }));
  if (node.failedUnits > 0) warn.push(t("rack.reason.failedUnits", { count: node.failedUnits }));
  // Nodes marked "inference": false in topology.json may idle while the API serves.
  if (inferenceOk && meta?.inference !== false && !node.inferenceProcessUp) warn.push(t("rack.reason.noInferenceProcess"));
  if (restarts > 0 && recent(node.container?.startedAt)) warn.push(t("rack.reason.restarted", { count: restarts }));
  if (diskPct !== null && diskPct >= DISK_WARN_PERCENT) warn.push(t("rack.reason.disk", { percent: diskPct }));
  if (memFreeGiB !== null && memFreeGiB < MEMORY_WARN_GIB) warn.push(t("rack.reason.memoryFree", { free: freeLabel(memFreeGiB, mem) }));
  if (kernel?.total > 0 && recent(kernel.lastAt)) {
    const count = `${kernel.capped ? "≥" : ""}${kernel.total}`;
    warn.push(kernel.lastAt ? t("rack.reason.kernel", { count, time: clockTime(kernel.lastAt, clock) }) : t("rack.reason.kernelNoTime", { count }));
  }

  const reasons = [...crit, ...warn];
  return {
    ...base, ok: true, pending: false,
    level: crit.length ? "crit" : warn.length ? "warn" : "good",
    reasons: reasons.length ? reasons : [t("rack.reason.ok")],
    temp: finite(node.gpu?.temperature) ? node.gpu.temperature : null,
    load: finite(node.gpu?.utilization) ? node.gpu.utilization : null,
    power: finite(node.gpu?.powerWatts) ? node.gpu.powerWatts : null,
    tsoc: finite(node.thermals?.tsocCelsius) ? node.thermals.tsocCelsius : null,
    memFreeGiB, memUsedPct, diskPct, diskFreeGiB, restarts,
    diskWarn: diskPct !== null && diskPct >= DISK_WARN_PERCENT,
  };
}

export function reasonText(view) {
  return `${view.reasons[0]}${view.reasons.length > 1 ? ` +${view.reasons.length - 1}` : ""}`;
}

// The engine with the number of serving nodes ("SGLang | 4 nodes"), rebuilt from serving.engine and serving.parallel
// so the count reads in the panel's language; a payload without them keeps the server's English label.
function servingLabel(serving) {
  if (!serving) return null;
  if (!("engine" in serving)) return serving.label ?? null;
  return [serving.engine, serving.parallel > 1 ? t("serving.nodes", { count: serving.parallel }) : null].filter(Boolean).join(" | ") || null;
}

// Model and engine as reported by the API and the nodes; nothing is assumed about the engine or the node count.
function servingLine(state) {
  const inference = state?.inference;
  const model = inference?.modelName ?? state?.usage?.modelName ?? null;
  const engine = servingLabel(state?.serving) ?? (inference?.ok ? inference.engine : null) ?? null;
  return [model ?? t("rack.modelUnknown"), engine].filter(Boolean).join(" | ");
}

// Second band line: counts first, then at most two things worth reading.
function countLine(state, extras, { power = true } = {}) {
  const metas = orderedNodes(state);
  const nodesUp = metas.filter((meta) => state?.nodes?.[meta.id]?.ok).length;
  const links = state?.topology?.links ?? [];
  const linksUp = links.filter((link) => state?.ringLinks?.[link.id]?.state === "up").length;
  const parts = [metas.length === 1 ? t(nodesUp ? "rack.count.nodeUp" : "rack.count.nodeDown") : t("rack.count.nodes", { up: nodesUp, count: metas.length })];
  if (links.length) parts.push(t("rack.count.links", { up: linksUp, count: links.length }));
  // GPU power summed over the nodes that report it (nvidia-smi power draw; the whole box draws more).
  const watts = metas.map((meta) => state?.nodes?.[meta.id]).filter((node) => node?.ok && finite(node.gpu?.powerWatts)).map((node) => node.gpu.powerWatts);
  if (power && watts.length) parts.push(`GPU ${Math.round(watts.reduce((sum, value) => sum + value, 0))} W`);
  return [...parts, ...extras.filter(Boolean).slice(0, 2)].join(" | ");
}

// Things worth a mention on the band: urgent ones before the queue counts, standing notes after them.
function bandNotes(state) {
  const metas = orderedNodes(state);
  const urgent = [];
  const standing = [];
  const down = metas.filter((meta) => meta.collect !== false && state?.nodes?.[meta.id]?.ok === false && state.nodes[meta.id].collected !== false);
  if (down.length) urgent.push(t("rack.note.notResponding", { node: `${down[0].name}${down.length > 1 ? ` +${down.length - 1}` : ""}` }));
  for (const link of state?.topology?.links ?? []) {
    const live = state?.ringLinks?.[link.id];
    if (live?.state === "down") urgent.push(t("rack.note.linkDown", { label: link.label }));
    else if (live?.state === "pending") standing.push(t("rack.note.linkNotCabled", { label: link.label }));
  }
  const uncollected = metas.filter((meta) => meta.collect === false);
  if (uncollected.length) standing.push(t("rack.note.notCollected", { names: uncollected.map((meta) => meta.name) }));
  return { urgent, standing };
}

// With several model servers the band follows all of them together (their output added up, a chip per server), or
// the one named by "?server=" as if it were the only one. The bays keep every node.
export function rackFocus(state, serverId = "") {
  const servers = modelServers(state);
  if (servers.length < 2) return state;
  const picked = servers.find((server) => server.id === serverId);
  if (picked) return { ...state, inference: picked.inference, serving: picked.serving, inferenceState: picked.inferenceState, focusServer: picked.id };
  return { ...state, inference: combinedInference(servers), servingServers: servers };
}

// One chip per server for the band: a lamp for its state, its name, and its output or why there is none.
export function serverChips(servers) {
  return servers.map((server) => {
    const v = server.inference;
    if (v?.ok) return { name: serverName(server), level: "good", text: `${f1(v.outputTokensPerSecond)} tok/s` };
    if (server.inferenceState === "stopped") return { name: serverName(server), level: "idle", text: t("rack.server.idle") };
    return { name: serverName(server), level: v ? "crit" : "idle", text: t(v ? "rack.server.down" : "rack.server.checking") };
  });
}

export function clusterView(state, { fetchFailed = false, lastReceivedAt = null, clock = {} } = {}) {
  const inference = state?.inference;
  const running = finite(inference?.runningRequests) ? inference.runningRequests : null;
  const waiting = finite(inference?.waitingRequests) ? inference.waitingRequests : null;
  const base = {
    running,
    waiting,
    out: inference?.ok && finite(inference.outputTokensPerSecond) ? inference.outputTokensPerSecond : null,
    todayTotal: state?.usage?.today?.total ?? null,
    todayRequests: state?.usage?.today?.requests ?? null,
  };
  if (fetchFailed) {
    const time = lastReceivedAt ? clockTime(lastReceivedAt, { ...clock, seconds: true }) : t("rack.cluster.never");
    return { ...base, out: null, level: "crit", title: t("rack.cluster.disconnected", { brand: BRAND }), lines: [t("rack.cluster.serverDown", { brand: BRAND }), t("rack.cluster.lastUpdate", { time })], stale: true };
  }
  // The server's status message in the panel's language (its English message when the key is unknown).
  const message = serverText(state?.messageKey, state?.messageParams, state?.message);
  if (!state || state.status === "starting") return { ...base, level: "idle", title: t("rack.cluster.waitingData"), lines: [t("rack.cluster.waitingBrand", { brand: BRAND }), message ?? ""].filter(Boolean) };
  const { urgent, standing } = bandNotes(state);
  // An urgent note (a node down, a broken link) matters more than the power total, so it takes its place.
  const counts = (...middle) => countLine(state, [...urgent, ...middle, ...standing], { power: !urgent.length });
  if (state.status === "offline") return { ...base, level: "crit", title: t("rack.cluster.unreachable"), lines: [message, counts()] };
  const chips = state.servingServers ? serverChips(state.servingServers) : null;
  if (state.inferenceState === "stopped") return { ...base, level: "idle", title: t("rack.cluster.inferenceStopped"), lines: [t("rack.cluster.noModelServing"), counts()], chips };
  if (!inference?.ok) return { ...base, level: "crit", title: t("rack.cluster.inferenceDown"), lines: [chips ? "" : `${servingLine(state)} | ${t("rack.cluster.apiNoResponse")}`, counts()], chips };
  const title = t(running > 0 ? "rack.cluster.serving" : "rack.cluster.ready");
  const queue = running === null ? null : t("rack.cluster.queue", { running, waiting: waiting ?? 0 });
  if (state.status !== "healthy") {
    // A degradation the notes do not already explain (heat, failed services, a half-dark link) shows the server message.
    const note = urgent.length ? null : message;
    return { ...base, level: "warn", title, lines: [chips ? "" : servingLine(state), counts(note, queue)], chips };
  }
  return { ...base, level: "good", title, lines: [chips ? "" : servingLine(state), counts(queue)], chips };
}

// Returns [{at, value}] for samples in [fromMs, toMs]; missing values stay null so the line breaks.
// field is a history key or a function that picks the value from a history point.
export function seriesPoints(history, field, fromMs, toMs) {
  const pick = typeof field === "function" ? field : (point) => point[field];
  return (history ?? [])
    .filter((point) => point.at >= fromMs && point.at <= toMs)
    .map((point) => {
      const value = pick(point);
      return { at: point.at, value: finite(value) ? value : null };
    });
}

// SVG line/area paths on a time axis. A gap longer than gapMs or a missing value breaks the line.
export function timePaths(points, { fromMs, toMs, width, height, min, max, gapMs, top = 0, bottom = height }) {
  const span = toMs - fromMs;
  const x = (at) => ((at - fromMs) / span * width).toFixed(1);
  const y = (value) => (bottom - (Math.min(Math.max(value, min), max) - min) / (max - min) * (bottom - top)).toFixed(1);
  let line = "";
  let area = "";
  let segment = [];
  let previousAt = null;
  const flush = () => {
    if (segment.length > 1) {
      line += `M${segment.join("L")}`;
      area += `M${segment[0].split(" ")[0]} ${bottom}L${segment.join("L")}L${segment[segment.length - 1].split(" ")[0]} ${bottom}Z`;
    }
    segment = [];
  };
  for (const point of points) {
    if (point.value === null || (previousAt !== null && point.at - previousAt > gapMs)) flush();
    if (point.value !== null) segment.push(`${x(point.at)} ${y(point.value)}`);
    previousAt = point.at;
  }
  flush();
  return { line, area };
}

export function valueRange(points, floorMin, floorMax, pad = 2) {
  const values = points.map((point) => point.value).filter(finite);
  if (!values.length) return [floorMin, floorMax];
  return [Math.min(floorMin, Math.floor(Math.min(...values) - pad)), Math.max(floorMax, Math.ceil(Math.max(...values) + pad))];
}

export function tempRangeLabel(points, unit = "c") {
  const values = points.map((point) => point.value).filter(finite).map((value) => degrees(value, unit));
  if (!values.length) return t("rack.tempRange.noData");
  const low = Math.round(Math.min(...values));
  const high = Math.round(Math.max(...values));
  return low === high ? `${low}${degreeUnit(unit)}` : `${low}–${high}${degreeUnit(unit)}`;
}

// Logical panel width from "?width=" (800 to 3840, default 1920). The panel is laid out 480 px tall and
// scaled to the window, so width = 480 x the display's aspect ratio fills a display edge to edge.
export const DEFAULT_PANEL_WIDTH = 1920;
export function panelWidth(search = "") {
  const value = Number.parseInt(new URLSearchParams(search).get("width") ?? "", 10);
  return Number.isFinite(value) ? Math.min(3840, Math.max(800, value)) : DEFAULT_PANEL_WIDTH;
}

// Bays narrower than this switch to the compact layout (temperature above the meters, smaller type); four nodes at
// 1920 (480 each) keep the regular one.
export const COMPACT_BAY_PX = 460;
// "wide" for one node with room for its meters side by side, "compact" when bays get narrow, otherwise "regular".
export function bayLayout(count, width = DEFAULT_PANEL_WIDTH) {
  if (count <= 1) return width >= 1400 ? "wide" : "regular";
  return width / count >= COMPACT_BAY_PX ? "regular" : "compact";
}
