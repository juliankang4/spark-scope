// Pure view-model helpers for the Spark Scope rack panel (1920 x 480 by default). No DOM access, so node --test can import them.

export const BRAND = "SPARK SCOPE";
const ROLE_LABELS = { HEAD: "Head", WORKER: "Worker", NODE: "Node" };
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

export function compact(value) {
  if (!finite(value)) return "—";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e7) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(Math.round(value));
}

// Free space for a bar label: 2.5 TiB, 319 GiB, 7.7 GiB.
export function freeLabel(gib) {
  if (!finite(gib)) return "—";
  if (gib >= 1000) return `${(gib / 1024).toFixed(1)} TiB`;
  if (gib >= 10) return `${Math.round(gib)} GiB`;
  return `${gib.toFixed(1)} GiB`;
}

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
  if (link.state === "pending") return `Link ${label} not cabled`;
  if (link.state === "down") return `Link ${label} down`;
  if (link.state === "partial") {
    const dark = planes.filter((plane) => link[plane]?.up === false);
    if (dark.length) return `Link ${label} ${dark.map((plane) => PLANE_NAMES[plane]).join("/")} down`;
    const unseen = planes.filter((plane) => !link[plane]?.available);
    return `Link ${label} ${unseen.map((plane) => PLANE_NAMES[plane]).join("/")} not visible`;
  }
  if (link.state === "up" && link.slow) {
    const speeds = planes.map((plane) => link[plane]?.speedGbps).filter(finite);
    return `Link ${label} slow${speeds.length ? ` ${Math.round(Math.min(...speeds))}G` : ""}`;
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
  stuck: { level: "crit", text: "nvidia-smi stuck" },
  timeout: { level: "crit", text: "GPU query timed out" },
  error: { level: "crit", text: "GPU query failed" },
  missing: { level: "warn", text: "no nvidia-smi" },
};

// Reasons are ordered by severity so the bay header can show the most important one.
export function nodeView(meta, node, { vllmOk = false, lastOkAt = null, nowMs = Date.now(), links = [], clock = {} } = {}) {
  const id = meta?.id ?? node?.id ?? "?";
  const base = {
    id,
    name: meta?.name ?? node?.name ?? node?.host ?? id,
    host: meta?.host ?? node?.host ?? null,
    local: Boolean(meta?.local ?? node?.local),
    role: ROLE_LABELS[meta?.role ?? node?.role] ?? meta?.role ?? node?.role ?? "",
    links: links.map((link) => ({ peer: link.peer, tag: link.tag ?? link.peer, level: linkLevel(link) })),
  };
  const linkReasons = links.map(linkReason).filter(Boolean);
  if (meta?.collect === false || node?.collected === false) {
    // Not collected: neighbours can still vouch for its links, but its own figures are unknown (the body says so).
    return { ...base, ok: false, pending: true, level: linkReasons.length ? "warn" : "idle", reasons: linkReasons.length ? linkReasons : ["not collected"] };
  }
  if (!node) return { ...base, ok: false, pending: true, waiting: true, level: "idle", reasons: ["waiting for data"] };
  if (!node.ok) {
    return {
      ...base, ok: false, pending: false, level: "crit", reasons: ["no response"],
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
  if (node.gpu?.thermalSlowdown) crit.push("thermal slowdown");
  // No GPU readings: a hung or failing nvidia-smi is a likely GPU fault; a missing one is a setup issue.
  const gpuProblem = node.gpu?.available === false ? GPU_PROBLEMS[node.gpu.status] ?? GPU_PROBLEMS.error : null;
  if (gpuProblem) (gpuProblem.level === "crit" ? crit : warn).push(gpuProblem.text);
  if (node.systemState && node.systemState !== "running") warn.push(`system ${node.systemState}`);
  if (node.failedUnits > 0) warn.push(`${node.failedUnits} failed ${node.failedUnits === 1 ? "unit" : "units"}`);
  // Nodes marked "inference": false in topology.json may idle while the API serves.
  if (vllmOk && meta?.inference !== false && !node.inferenceProcessUp) warn.push("no inference process");
  if (restarts > 0 && recent(node.container?.startedAt)) warn.push(`restarted ×${restarts}`);
  if (diskPct !== null && diskPct >= DISK_WARN_PERCENT) warn.push(`disk ${diskPct}%`);
  if (memFreeGiB !== null && memFreeGiB < MEMORY_WARN_GIB) warn.push(`${memFreeGiB.toFixed(1)} GiB memory free`);
  if (kernel?.total > 0 && recent(kernel.lastAt)) warn.push(`kernel ${kernel.capped ? "≥" : ""}${kernel.total}${kernel.lastAt ? ` (${clockTime(kernel.lastAt, clock)})` : ""}`);

  const reasons = [...crit, ...warn];
  return {
    ...base, ok: true, pending: false,
    level: crit.length ? "crit" : warn.length ? "warn" : "good",
    reasons: reasons.length ? reasons : ["OK"],
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

// Model and engine as reported by the API and the nodes; nothing is assumed about the engine or the node count.
function servingLine(state) {
  const vllm = state?.vllm;
  const model = vllm?.modelName ?? state?.usage?.modelName ?? null;
  const engine = state?.serving?.label ?? (vllm?.ok ? vllm.engine : null) ?? null;
  return [model ?? "model unknown", engine].filter(Boolean).join(" | ");
}

// Second band line: counts first, then at most two things worth reading.
function countLine(state, extras, { power = true } = {}) {
  const metas = orderedNodes(state);
  const nodesUp = metas.filter((meta) => state?.nodes?.[meta.id]?.ok).length;
  const links = state?.topology?.links ?? [];
  const linksUp = links.filter((link) => state?.ringLinks?.[link.id]?.state === "up").length;
  const parts = [metas.length === 1 ? (nodesUp ? "Node up" : "Node down") : `Nodes ${nodesUp}/${metas.length}`];
  if (links.length) parts.push(`Links ${linksUp}/${links.length}`);
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
  if (down.length) urgent.push(`${down[0].name}${down.length > 1 ? ` +${down.length - 1}` : ""} not responding`);
  for (const link of state?.topology?.links ?? []) {
    const live = state?.ringLinks?.[link.id];
    if (live?.state === "down") urgent.push(`link ${link.label} down`);
    else if (live?.state === "pending") standing.push(`link ${link.label} not cabled`);
  }
  const uncollected = metas.filter((meta) => meta.collect === false);
  if (uncollected.length) standing.push(`${uncollected.map((meta) => meta.name).join(", ")} not collected`);
  return { urgent, standing };
}

export function clusterView(state, { fetchFailed = false, lastReceivedAt = null, clock = {} } = {}) {
  const vllm = state?.vllm;
  const running = finite(vllm?.runningRequests) ? vllm.runningRequests : null;
  const waiting = finite(vllm?.waitingRequests) ? vllm.waitingRequests : null;
  const base = {
    running,
    waiting,
    out: vllm?.ok && finite(vllm.outputTokensPerSecond) ? vllm.outputTokensPerSecond : null,
    todayTotal: state?.usage?.today?.total ?? null,
    todayRequests: state?.usage?.today?.requests ?? null,
  };
  if (fetchFailed) {
    return { ...base, out: null, level: "crit", title: `${BRAND} disconnected`, lines: [`${BRAND} server not responding`, `Last update ${lastReceivedAt ? clockTime(lastReceivedAt, { ...clock, seconds: true }) : "never"}`], stale: true };
  }
  if (!state || state.status === "starting") return { ...base, level: "idle", title: "Waiting for data", lines: [`Waiting for ${BRAND}`, state?.message ?? ""].filter(Boolean) };
  const { urgent, standing } = bandNotes(state);
  // An urgent note (a node down, a broken link) matters more than the power total, so it takes its place.
  const counts = (...middle) => countLine(state, [...urgent, ...middle, ...standing], { power: !urgent.length });
  if (state.status === "offline") return { ...base, level: "crit", title: "Nodes unreachable", lines: [state.message, counts()] };
  if (state.inferenceState === "stopped") return { ...base, level: "idle", title: "Inference stopped", lines: ["No model serving", counts()] };
  if (!vllm?.ok) return { ...base, level: "crit", title: "Inference down", lines: [`${servingLine(state)} | API not responding`, counts()] };
  const title = running > 0 ? "Serving" : "Ready";
  const queue = running === null ? null : `running ${running} | waiting ${waiting ?? 0}`;
  if (state.status !== "healthy") {
    // A degradation the notes do not already explain (heat, failed services, a half-dark link) shows the server message.
    const message = urgent.length ? null : state.message;
    return { ...base, level: "warn", title, lines: [servingLine(state), counts(message, queue)] };
  }
  return { ...base, level: "good", title, lines: [servingLine(state), counts(queue)] };
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

export function tempRangeLabel(points) {
  const values = points.map((point) => point.value).filter(finite);
  if (!values.length) return "no data";
  const low = Math.round(Math.min(...values));
  const high = Math.round(Math.max(...values));
  return low === high ? `${low}°C` : `${low}–${high}°C`;
}

// Logical panel width from "?width=" (1440 to 3840, default 1920). The panel is laid out 480 px tall and
// scaled to the window, so width = 480 x the display's aspect ratio fills a display edge to edge.
export const DEFAULT_PANEL_WIDTH = 1920;
export function panelWidth(search = "") {
  const value = Number.parseInt(new URLSearchParams(search).get("width") ?? "", 10);
  return Number.isFinite(value) ? Math.min(3840, Math.max(1440, value)) : DEFAULT_PANEL_WIDTH;
}
