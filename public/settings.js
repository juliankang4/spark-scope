// Display preferences for the web page, kept per browser in localStorage. Nothing here reaches the server: the engine
// address, poll intervals and topology stay in the server's environment and topology.json.
import { PALETTE } from './view-data.js';

export const SETTINGS_KEY = 'spark-scope-settings';
export const THEME_KEY = 'spark-scope-theme';

// What a node card can show in its four reading slots, and the bars and page panels that can be turned on or off.
export const READING_IDS = ['temp', 'power', 'mem', 'clock', 'disk', 'diskfree', 'cpu', 'nvme', 'nic', 'proc'];
export const BAR_IDS = ['unified', 'disk'];
export const PANEL_IDS = ['interconnect', 'engine', 'trends', 'ledger'];

// Each field: its default, a check that returns the clean value or undefined, and its form in a settings link.
const choice = (fallback, values) => ({ fallback, check: (value) => (values.includes(value) ? value : undefined), read: (raw) => (typeof fallback === 'number' ? Number(raw) : raw) });
const flag = (fallback) => ({ fallback, check: (value) => (typeof value === 'boolean' ? value : undefined), read: (raw) => (raw === '1' ? true : raw === '0' ? false : null), write: (value) => (value ? '1' : '0') });
// A whole number between min and max (the warning levels).
const level = (fallback, min, max) => ({ fallback, check: (value) => (Number.isInteger(value) && value >= min && value <= max ? value : undefined), read: Number });
// A list of known ids, each at most once; with size set it must have exactly that many (the reading slots).
const list = (fallback, ids, size) => ({
  fallback,
  check: (value) => (Array.isArray(value) && value.every((id) => ids.includes(id)) && new Set(value).size === value.length && (size === undefined || value.length === size) ? [...value] : undefined),
  read: (raw) => (raw ? raw.split(',') : []),
  write: (value) => value.join(','),
});
// Node colours by position in the topology: palette names or #rrggbb (stored in lower case, written without # in a
// link). An empty list keeps the default order; up to 32 nodes.
const colorList = {
  fallback: [],
  check: (value) => {
    if (!Array.isArray(value) || value.length > 32) return undefined;
    const clean = value.map((color) => (typeof color !== 'string' ? null : PALETTE.includes(color) ? color : /^#?[0-9a-f]{6}$/i.test(color) ? `#${color.replace('#', '').toLowerCase()}` : null));
    return clean.every(Boolean) ? clean : undefined;
  },
  read: (raw) => (raw ? raw.split(',') : []),
  write: (value) => value.map((color) => color.replace('#', '')).join(','),
};
const FIELDS = {
  temp: choice('c', ['c', 'f']),
  mem: choice('gib', ['gib', 'gb']),
  clock: choice('24', ['24', '12']),
  range: choice(60, [15, 60, 360]),
  refresh: choice(2, [2, 5, 10]),
  pause: flag(true),
  lang: choice('en', ['en', 'ko']),
  readings: list(['temp', 'power', 'mem', 'clock'], READING_IDS, 4),
  bars: list(['unified'], BAR_IDS),
  hide: list([], PANEL_IDS),
  labels: choice('auto', ['auto', 'full', 'short']),
  // Colour thresholds on the cards: GPU temperature in °C, disk use in percent, free memory in GiB.
  tempWarn: level(85, 40, 110),
  diskWarn: level(95, 50, 100),
  memWarn: level(2, 0, 64),
  colors: colorList,
};
export const DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(FIELDS).map(([key, field]) => [key, field.fallback])));
const same = (a, b) => (Array.isArray(a) ? Array.isArray(b) && a.join(',') === b.join(',') : a === b);

// Every field is checked on its own: an unknown or invalid value falls back to its default and the others are kept.
export function parseSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(FIELDS).map(([key, field]) => {
    const clean = field.check(source[key]);
    return [key, clean === undefined ? (Array.isArray(field.fallback) ? [...field.fallback] : field.fallback) : clean];
  }));
}

// The fields that differ from the defaults; only these are stored and put in a settings link.
export function changedSettings(settings) {
  const parsed = parseSettings(settings);
  return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => !same(value, DEFAULTS[key])));
}

// Storage can be missing or throw (private windows, blocked site data); the page then runs on the defaults.
export function loadSettings(storage) {
  try { return parseSettings(JSON.parse(storage?.getItem(SETTINGS_KEY) ?? 'null')); } catch { return parseSettings(null); }
}
export function saveSettings(storage, settings) {
  try {
    const changed = changedSettings(settings);
    if (Object.keys(changed).length) storage.setItem(SETTINGS_KEY, JSON.stringify(changed));
    else storage.removeItem(SETTINGS_KEY);
    return true;
  } catch {
    return false;
  }
}

// The theme keeps its own key, which theme.js reads before the page is drawn: 'light', 'dark' or null (the system's).
export function loadTheme(storage) {
  try { const saved = storage?.getItem(THEME_KEY); return saved === 'light' || saved === 'dark' ? saved : null; } catch { return null; }
}
export function saveTheme(storage, theme) {
  try { theme === 'light' || theme === 'dark' ? storage.setItem(THEME_KEY, theme) : storage.removeItem(THEME_KEY); return true; } catch { return false; }
}

// A settings link carries the whole display setup to another browser, for example
// "?temp=f&readings=temp,power,disk,clock&bars=unified,disk&lang=ko&theme=dark". Defaults are left out, so a link
// without a field means that field's default.
export function settingsQuery(settings, theme) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(changedSettings(settings))) params.set(key, FIELDS[key].write ? FIELDS[key].write(value) : String(value));
  if (theme === 'light' || theme === 'dark') params.set('theme', theme);
  return params.toString();
}
// null when the address has no settings; otherwise the full setup it describes (invalid values read as defaults).
export function settingsFromQuery(search) {
  const params = new URLSearchParams(search);
  if (![...Object.keys(FIELDS), 'theme'].some((key) => params.has(key))) return null;
  const found = {};
  for (const [key, field] of Object.entries(FIELDS)) if (params.has(key)) found[key] = field.read(params.get(key));
  const theme = params.get('theme');
  return { settings: parseSettings(found), theme: theme === 'light' || theme === 'dark' ? theme : null };
}
// The address without the settings fields, so a reload does not apply the link again.
export function withoutSettingsQuery(search) {
  const params = new URLSearchParams(search);
  for (const key of [...Object.keys(FIELDS), 'theme']) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}
