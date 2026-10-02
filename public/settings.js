// Display preferences for the web page, kept per browser in localStorage. Nothing here reaches the server: the engine
// address, poll intervals and topology stay in the server's environment and topology.json.
export const SETTINGS_KEY = 'spark-scope-settings';
export const THEME_KEY = 'spark-scope-theme';
export const DEFAULTS = Object.freeze({ temp: 'c', mem: 'gib', clock: '24', range: 60, refresh: 2, pause: true });
const CHOICES = { temp: ['c', 'f'], mem: ['gib', 'gb'], clock: ['24', '12'], range: [15, 60, 360], refresh: [2, 5, 10], pause: [true, false] };

// Every field is checked on its own: an unknown or invalid value falls back to its default and the others are kept.
export function parseSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key, CHOICES[key].includes(source[key]) ? source[key] : fallback]));
}

// The fields that differ from the defaults; only these are stored and put in a settings link.
export function changedSettings(settings) {
  const parsed = parseSettings(settings);
  return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => value !== DEFAULTS[key]));
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

// A settings link carries the whole display setup to another browser: "?temp=f&mem=gb&clock=12&range=15&refresh=5&pause=0&theme=dark".
// Defaults are left out, so a link without a field means that field's default.
export function settingsQuery(settings, theme) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(changedSettings(settings))) params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  if (theme === 'light' || theme === 'dark') params.set('theme', theme);
  return params.toString();
}
// null when the address has no settings; otherwise the full setup it describes (invalid values read as defaults).
export function settingsFromQuery(search) {
  const params = new URLSearchParams(search);
  if (![...Object.keys(DEFAULTS), 'theme'].some(key => params.has(key))) return null;
  const found = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (!params.has(key)) continue;
    const raw = params.get(key);
    found[key] = key === 'pause' ? (raw === '1' ? true : raw === '0' ? false : null) : typeof DEFAULTS[key] === 'number' ? Number(raw) : raw;
  }
  const theme = params.get('theme');
  return { settings: parseSettings(found), theme: theme === 'light' || theme === 'dark' ? theme : null };
}
// The address without the settings fields, so a reload does not apply the link again.
export function withoutSettingsQuery(search) {
  const params = new URLSearchParams(search);
  for (const key of [...Object.keys(DEFAULTS), 'theme']) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}
