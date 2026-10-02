// One colour per node in topology order (cards, cable diagram, trend lines); a ninth node starts over.
export const COLORS = ['var(--blue)', 'var(--orange)', 'var(--green)', 'var(--ink)', 'var(--purple)', 'var(--gold)', 'var(--magenta)', 'var(--umber)'];
// Shown wherever a value was not observed; never replaced by a made-up zero.
export const UNKNOWN = 'unknown';
// Nodes in the order of the server's topology (topology.json); a payload without topology falls back to its node keys.
export function nodeOrder(state) {
  const metas = state?.topology?.nodes;
  if (Array.isArray(metas) && metas.length) return metas;
  return Object.keys(state?.nodes ?? {}).map(id => ({ id, name: state.nodes[id]?.name ?? state.nodes[id]?.host ?? id, host: state.nodes[id]?.host ?? null, role: state.nodes[id]?.role ?? '', collect: true }));
}
export const LINK_TEXT = { up: 'A/B up', partial: 'one plane down', pending: 'not cabled yet', down: 'down', unknown: UNKNOWN };
export function linkText(link) {
  if (!link) return UNKNOWN;
  const planes = Array.isArray(link.planes) && link.planes.length ? link.planes : ['a', 'b'];
  const upText = planes.map(plane => plane.toUpperCase()).join('/') + ' up';
  if (link.state === 'partial') return planes.map(plane => `${plane.toUpperCase()} ${link[plane]?.up === true ? 'up' : link[plane]?.up === false ? 'down' : UNKNOWN}`).join(', ');
  if (link.state === 'up') return link.slow ? `${upText} (slow)` : upText;
  return LINK_TEXT[link.state] ?? UNKNOWN;
}
export const finite = value => Number.isFinite(value);
// Numbers use one fixed format (1,234.5) so the K/M/B suffixes and the columns read the same everywhere.
export function fixed(value, digits = 1, suffix = '') {
  return finite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + suffix : UNKNOWN;
}
// Token counts with three significant digits (1.5K, 9.55M, 1.06B), shared by the web page and the rack panel.
// The unit is chosen after rounding, so 999,950 reads 1M rather than 1000.0K.
const UNITS = ['K', 'M', 'B', 'T'];
export function compact(value, missing = UNKNOWN) {
  if (!finite(value)) return missing;
  if (Math.abs(Math.round(value)) < 1000) return String(Math.round(value) || 0);
  let scaled = value;
  for (const [index, unit] of UNITS.entries()) {
    scaled /= 1000;
    const size = Math.abs(scaled);
    const text = scaled.toFixed(size < 10 ? 2 : size < 100 ? 1 : 0);
    if (Math.abs(Number(text)) < 1000 || index === UNITS.length - 1) return (text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text) + unit;
  }
}
// Below a second in milliseconds, otherwise seconds; 0.9996 s reads 1.00 s, not 1,000 ms.
export function duration(seconds) {
  if (!finite(seconds)) return UNKNOWN;
  return Math.round(seconds * 1000) < 1000 ? fixed(seconds * 1000, 0, ' ms') : fixed(seconds, 2, ' s');
}
// Token rates: one decimal below 100 tok/s, none from there (99.96 reads 100 tok/s, not 100.0).
export function tokenRate(value) {
  return finite(value) ? fixed(value, Math.abs(value) >= 99.95 ? 0 : 1, ' tok/s') : UNKNOWN;
}
export const gib = (bytes, digits = 1) => fixed(finite(bytes) ? bytes / 2 ** 30 : null, digits);
// Display units chosen in the settings: memory and disk in GiB (2^30 bytes) or GB (10^9), temperatures in °C or °F.
export const memoryUnit = unit => (unit === 'gb' ? 'GB' : 'GiB');
export const memory = (bytes, unit, digits = 1) => fixed(finite(bytes) ? bytes / (unit === 'gb' ? 1e9 : 2 ** 30) : null, digits);
export const temperatureUnit = unit => (unit === 'f' ? '°F' : '°C');
export const temperature = (celsius, unit, digits = 0) => fixed(finite(celsius) ? (unit === 'f' ? celsius * 9 / 5 + 32 : celsius) : null, digits);
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
// Wall-clock times follow the viewer's own time zone, on a 24-hour clock in the viewer's locale; the 12-hour clock
// uses the page's language for AM and PM.
export function clockTime(value, { seconds = true, timeZone, hour12 = false } = {}) {
  const date = new Date(value);
  if (value == null || !finite(date.getTime())) return UNKNOWN;
  const options = { hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hourCycle: hour12 ? 'h12' : 'h23', ...(seconds ? { second: '2-digit' } : {}) };
  const locale = hour12 ? 'en-US' : undefined;
  try { return date.toLocaleTimeString(locale, { ...options, timeZone }); } catch { return date.toLocaleTimeString(locale, options); }
}
// A past event's time, with its date when it was not today ("Oct 1 23:12:04").
export function eventTime(value, nowMs = Date.now(), { hour12 = false } = {}) {
  const at = new Date(value).getTime();
  if (value == null || !finite(at)) return UNKNOWN;
  if (localDay(at) === localDay(nowMs)) return clockTime(value, { hour12 });
  return `${new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${clockTime(value, { hour12 })}`;
}
// YYYY-MM-DD in the given IANA time zone; without one (or with an invalid one), the viewer's time zone.
export function localDay(at = Date.now(), timeZone) {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' };
  let parts;
  try { parts = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: timeZone || undefined }).formatToParts(new Date(at)); }
  catch { parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(new Date(at)); }
  const p = Object.fromEntries(parts.map(({type, value}) => [type, value]));
  return `${p.year}-${p.month}-${p.day}`;
}
// Calendar labels for ledger keys ("2026-09" -> "September 2026", "2026-09-17" -> "Sep 17"); the keys are plain dates, so UTC avoids shifting them.
export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long' });
}
export function dayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}
export function monthOptions(first, current) {
  if (!/^\d{4}-\d{2}$/.test(first || '')) first = current;
  const options = [];
  let cursor = current;
  while (cursor >= first && options.length < 1200) {
    options.push(cursor);
    const [y,m] = cursor.split('-').map(Number);
    const previous = new Date(Date.UTC(y,m-2,1));
    cursor = previous.toISOString().slice(0,7);
  }
  return options.length ? options : [current];
}
// key is a field name or a function that picks the value from a point, so values never share a key with the time.
export function chartPath(points, key, { start, end, width = 800, height = 140, min = 0, max = 1, top = 4, bottom = 4 }) {
  const pick = typeof key === 'function' ? key : point => point[key];
  let connected = false;
  const commands = [];
  for (const point of points) {
    const value = pick(point);
    if (!finite(value) || !finite(point.at)) { connected = false; continue; }
    const x = Math.min(width, Math.max(0, (point.at - start) / Math.max(1, end - start) * width));
    const y = top + (1 - Math.min(1, Math.max(0, (value - min) / Math.max(.001, max - min)))) * (height - top - bottom);
    commands.push(`${connected ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`);
    connected = true;
  }
  return commands.join(' ');
}
export function validateMonth(payload, requestedMonth) {
  if (!payload || payload.error || payload.month !== requestedMonth || !Array.isArray(payload.days)) throw new Error('invalid monthly ledger response');
  for (const field of ['input', 'compute', 'cache', 'output', 'requests', 'total']) {
    if (!finite(payload.totals?.[field]) || payload.totals[field] < 0) throw new Error('invalid monthly total');
    const sum = payload.days.reduce((total, day) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.day) || !day.day.startsWith(requestedMonth + '-') || !finite(day[field]) || day[field] < 0) throw new Error('invalid daily record');
      return total + day[field];
    }, 0);
    if (sum !== payload.totals[field]) throw new Error('monthly total does not match the daily records');
  }
  if (payload.totals.total !== payload.totals.input + payload.totals.output) throw new Error('invalid token total');
  return payload;
}
// Geometry of the interconnect diagram, or null when there is nothing to draw (one node, or no links configured).
// Nodes sit on an ellipse in topology order: two side by side, three as a triangle, four as a square.
// Parallel cables between the same pair are spread apart so each one stays visible.
export function fabricLayout(topology, { width = 380, height = 190, rx = 120, ry = 62 } = {}) {
  const nodes = topology?.nodes ?? [];
  const ids = new Set(nodes.map(node => node.id));
  const links = (topology?.links ?? []).filter(link => link.nodes?.length === 2 && link.nodes.every(id => ids.has(id)));
  if (nodes.length < 2 || !links.length) return null;
  const cx = width / 2, cy = height / 2, count = nodes.length;
  const startAngle = count % 2 === 0 ? -90 - 180 / count : -90;
  const at = Object.fromEntries(nodes.map((node, i) => {
    const angle = (startAngle + i * 360 / count) * Math.PI / 180;
    return [node.id, [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]];
  }));
  const groups = new Map();
  for (const link of links) {
    const key = [...link.nodes].sort().join('\n');
    groups.set(key, [...(groups.get(key) ?? []), link]);
  }
  const lines = links.map(link => {
    const key = [...link.nodes].sort().join('\n'), group = groups.get(key), index = group.indexOf(link);
    const spacing = group.length > 1 ? Math.min(12, 28 / (group.length - 1)) : 0;
    const offset = (index - (group.length - 1) / 2) * spacing;
    // One normal per pair (from its sorted ids), so parallel lines shift apart whatever their end order.
    const [p, q] = key.split('\n').map(id => at[id]);
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const nx = -(q[1] - p[1]) / length * offset, ny = (q[0] - p[0]) / length * offset;
    const [a, b] = link.nodes.map(id => at[id]);
    return { id: link.id, x1: a[0] + nx, y1: a[1] + ny, x2: b[0] + nx, y2: b[1] + ny };
  });
  return {
    nodes: nodes.map((node, i) => ({ id: node.id, label: nodeLabel(node.id), x: at[node.id][0], y: at[node.id][1], color: COLORS[i % COLORS.length] })),
    links: lines,
    // Two nodes leave the centre on the cable, so the caption moves below them.
    caption: { x: cx, y: count === 2 ? cy + 50 : cy + 4 },
  };
}

// A node id as drawn in the cable diagram: up to ten characters, longer ids shortened with an ellipsis.
export function nodeLabel(id) {
  const text = String(id ?? '');
  return text.length > 10 ? `${text.slice(0, 9)}…` : text;
}
// The diagram draws short labels in a circle and longer ones in a pill sized to the text (12 px semibold).
export function labelWidth(label) {
  return label.length <= 3 ? 38 : Math.max(38, Math.ceil(label.length * 7.6 + 18));
}

// The theme button cycles from the system look to the other look, then the system's look picked by hand, then back
// to following the system. choice is the saved 'light' or 'dark' (null follows the system); system is the current one.
export function nextTheme(choice, system) {
  const other = system === 'dark' ? 'light' : 'dark';
  if (choice !== 'light' && choice !== 'dark') return other;
  return choice === other ? system : null;
}

// Everything the cards show from topology.json; a change rebuilds them (the ids alone can stay the same).
export function topologyKey(metas) {
  return JSON.stringify((metas ?? []).map(({ id, name, host, local, role, hardware, collect, inference }) => [id, name, host, local, role, hardware, collect, inference]));
}

// Data is stale after three of the slower poll intervals the server reports, and never sooner than 20 s.
export function staleAfterMs(state) {
  const slowest = Math.max(state?.pollIntervals?.nodeMs ?? 0, state?.pollIntervals?.apiMs ?? 0);
  return Math.max(20_000, finite(slowest) ? slowest * 3 : 0);
}

// The latest sample of a state polled without history, shaped like one point of state.history.
export function livePoint(state) {
  const at = Date.parse(state?.inference?.updatedAt ?? state?.updatedAt ?? '');
  if (!finite(at)) return null;
  const inference = state?.inference?.ok ? state.inference : null;
  const value = (key) => (inference && finite(inference[key]) ? inference[key] : null);
  return {
    at,
    outputTokensPerSecond: value('outputTokensPerSecond'),
    promptTokensPerSecond: value('promptTokensPerSecond'),
    runningRequests: value('runningRequests'),
    queue: value('waitingRequests'),
    nodes: Object.fromEntries(Object.entries(state?.nodes ?? {}).map(([id, node]) => [id, {
      temperature: node?.ok && finite(node.gpu?.temperature) ? node.gpu.temperature : null,
      memoryAvailableBytes: node?.ok && finite(node.memory?.availableBytes) ? node.memory.availableBytes : null,
    }])),
  };
}

// Appends a newer point and drops what fell out of the window; the input array is not changed.
export function mergeLivePoint(history, point, windowMs) {
  const list = Array.isArray(history) ? history : [];
  if (!point || (list.length && point.at <= list[list.length - 1].at)) return list;
  return [...list, point].filter((item) => item.at >= point.at - windowMs);
}

// AbortSignal.timeout() needs Safari 16; this works on older iPhones and iPads too.
export function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

// matchMedia().addEventListener needs Safari 14; older Safari only has addListener.
export function onMediaChange(query, listener) {
  if (typeof query.addEventListener === 'function') query.addEventListener('change', listener);
  else if (typeof query.addListener === 'function') query.addListener(listener);
}
