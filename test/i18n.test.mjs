import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS, LANGUAGES, LANGUAGE_NAMES, t, setLanguage, language, queryLanguage, serverText, hasOwnString, locale } from '../public/i18n.js';
import { monthLabel, monthName, dayLabel, weekLabel, clockTime, eventTime, linkText, compact, systemStateText, roleName } from '../public/view-data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const placeholders = (text) => new Set([...[text].flat().join(' ').matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
// Runs fn with the page language set, and always puts English back.
const inLanguage = (lang, fn) => { setLanguage(lang); try { return fn(); } finally { setLanguage('en'); } };

test('t() fills placeholders, picks the plural form by count and joins lists', () => {
  assert.equal(t('statusbar.nodes', { online: 3, count: 4 }), 'Nodes 3/4');
  assert.equal(t('settings.about.nodeCount', { count: 1 }), '1 node');
  assert.equal(t('settings.about.nodeCount', { count: 4 }), '4 nodes');
  assert.equal(t('settings.about.nodeCount', { count: 0 }), '0 nodes');
  assert.equal(t('status.gpuUnavailable', { nodes: ['spark-1', 'spark-2'] }), 'GPU readings unavailable on spark-1, spark-2');
  // A missing parameter stays visible instead of reading "undefined".
  assert.equal(t('statusbar.nodes', { online: 3 }), 'Nodes 3/{count}');
  assert.equal(t('statusbar.nodes', null), 'Nodes {online}/{count}');
  // Korean has one form for any count; the language can be given per call.
  assert.equal(t('settings.about.nodeCount', { count: 1 }, 'ko'), STRINGS.ko['settings.about.nodeCount'].replace('{count}', '1'));
  assert.equal(t('settings.about.nodeCount', { count: 4 }, 'ko'), STRINGS.ko['settings.about.nodeCount'].replace('{count}', '4'));
  // An unknown key reads as itself, so a typo shows on the page rather than an empty label.
  assert.equal(t('no.such.key'), 'no.such.key');
});

test('a key the Korean table lacks falls back to English, and the current language is the default', () => {
  STRINGS.en['test.onlyEnglish'] = 'Only in English {n}';
  try {
    assert.equal(t('test.onlyEnglish', { n: 1 }, 'ko'), 'Only in English 1');
    assert.equal(hasOwnString('test.onlyEnglish', 'ko'), false);
    assert.equal(inLanguage('ko', () => t('test.onlyEnglish', { n: 2 })), 'Only in English 2');
  } finally {
    delete STRINGS.en['test.onlyEnglish'];
  }
  assert.equal(inLanguage('ko', () => t('ledger.today')), STRINGS.ko['ledger.today']);
  assert.notEqual(STRINGS.ko['ledger.today'], STRINGS.en['ledger.today']);
  assert.equal(language(), 'en');
  // Anything but a known language is English.
  assert.equal(setLanguage('fr'), 'en');
  assert.equal(setLanguage(undefined), 'en');
  assert.deepEqual(LANGUAGES, ['en', 'ko']);
  assert.equal(LANGUAGE_NAMES.en, 'English');
  assert.equal(locale('ko'), 'ko-KR');
  assert.equal(locale('en'), 'en-US');
});

// Contributors only add English: a key the Korean table lacks falls back to English and is listed here, and fails the
// test only with STRICT_I18N=1, which is how the Korean is checked before a merge.
test('Korean has no key English lacks, missing Korean is listed, and each Korean text uses the same placeholders', (t) => {
  assert.deepEqual(Object.keys(STRINGS.ko).filter((key) => !Object.hasOwn(STRINGS.en, key)), []);
  const missing = Object.keys(STRINGS.en).filter((key) => !Object.hasOwn(STRINGS.ko, key));
  if (missing.length) t.diagnostic(`Korean text missing for: ${missing.join(', ')}`);
  if (process.env.STRICT_I18N === '1') assert.deepEqual(missing, []);
  // Calendar labels pick from the same date parts: English names the month, Korean numbers it.
  const dateParts = new Set(['year', 'month', 'day', 'monthName', 'monthShort']);
  for (const [key, text] of Object.entries(STRINGS.ko)) {
    assert.equal(typeof text, 'string', `${key}: Korean needs no plural forms`);
    assert.ok(text.trim() && text === text.trim(), `${key}: empty or padded text`);
    if (key.startsWith('format.')) assert.ok([...placeholders(text), ...placeholders(STRINGS.en[key])].every((name) => dateParts.has(name)), key);
    else assert.deepEqual(placeholders(text), placeholders(STRINGS.en[key]), `${key}: placeholders differ`);
  }
  for (const [key, text] of Object.entries(STRINGS.en)) {
    if (Array.isArray(text)) assert.deepEqual(placeholders(text[0]), placeholders(text[1]), `${key}: plural forms differ`);
  }
});

test('every key the pages name exists in the English table', () => {
  const html = ['public/index.html', 'public/rack/index.html'].map(read).join('\n');
  const htmlKeys = [...html.matchAll(/data-i18n(?:-title|-aria-label)?="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(htmlKeys.length > 50);
  const scripts = ['public/app.js', 'public/view-data.js', 'public/ledger.js', 'public/rack/rack.js', 'public/rack/rack-view.js'].map(read).join('\n');
  const scriptKeys = [...scripts.matchAll(/\bt\(\s*['"]([\w.]+)['"]/g)].map((match) => match[1]);
  assert.ok(scriptKeys.length > 100);
  for (const key of [...htmlKeys, ...scriptKeys]) assert.ok(Object.hasOwn(STRINGS.en, key), `missing key ${key}`);
});

test('Korean text lives only in the string table', () => {
  const files = (dir) => readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : /\.(m?js|html|css)$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
  const offenders = [...files('public'), ...files('lib'), ...files('tools'), 'server.mjs']
    .filter((file) => file !== path.join('public', 'i18n.js') && /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(read(file)));
  assert.deepEqual(offenders, []);
});

test('ledger months and days read in the chosen language; Korean matches the platform calendar format', () => {
  assert.equal(monthLabel('2026-09'), 'September 2026');
  assert.equal(monthName('2026-09'), 'September');
  assert.equal(dayLabel('2026-09-17'), 'Sep 17');
  const korean = (date, options) => new Date(date).toLocaleDateString('ko-KR', { timeZone: 'UTC', ...options });
  assert.equal(monthLabel('2026-09', 'ko'), korean(Date.UTC(2026, 8, 1), { year: 'numeric', month: 'long' }));
  assert.equal(monthLabel('2026-12', 'ko'), korean(Date.UTC(2026, 11, 1), { year: 'numeric', month: 'long' }));
  assert.equal(dayLabel('2026-09-17', 'ko'), korean(Date.UTC(2026, 8, 17), { month: 'long', day: 'numeric' }));
  assert.equal(dayLabel('2026-01-01', 'ko'), korean(Date.UTC(2026, 0, 1), { month: 'long', day: 'numeric' }));
  // The month alone, for "{month} total": not the first word of the full label, which in Korean is the year.
  assert.equal(monthName('2026-09', 'ko'), korean(Date.UTC(2026, 8, 1), { month: 'long' }));
  assert.ok(!monthName('2026-09', 'ko').includes('2026'));
  assert.equal(t('ledger.monthTotal', { month: monthName('2026-09') }), 'September total');
  // Statement weeks: May 2027 starts on a Saturday, so the 1st opens the first week and Monday the 31st the sixth.
  assert.equal(weekLabel('2027-05-03'), 'Week of May 3');
  for (const [day, n] of [['2027-05-01', 1], ['2027-05-03', 2], ['2027-05-31', 6], ['2026-06-08', 2]]) {
    assert.equal(weekLabel(day, 'ko'), STRINGS.ko[`format.week${n}`].replace('{month}', String(Number(day.slice(5, 7)))), day);
  }
  // The page language is the default.
  assert.equal(inLanguage('ko', () => monthLabel('2026-09')), monthLabel('2026-09', 'ko'));
});

test('the 12-hour clock uses the Korean day periods in Korean; the 24-hour clock and numbers stay the same', () => {
  const evening = new Date(2026, 9, 3, 18, 4, 5).getTime(), morning = new Date(2026, 9, 3, 6, 4, 5).getTime();
  assert.equal(clockTime(evening, { hour12: true }), '6:04:05 PM');
  const pm = clockTime(evening, { hour12: true, lang: 'ko' }), am = clockTime(morning, { hour12: true, lang: 'ko' });
  assert.equal(pm, new Date(evening).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: 'h12' }));
  // The period comes first ("<period> 6:04:05") and is not AM or PM.
  assert.match(pm, /^\S+ 6:04:05$/);
  assert.match(am, /^\S+ 6:04:05$/);
  assert.notEqual(pm.split(' ')[0], am.split(' ')[0]);
  assert.ok(!/AM|PM/.test(pm + am));
  assert.equal(clockTime(evening, { lang: 'ko' }), clockTime(evening));
  assert.equal(inLanguage('ko', () => clockTime(evening, { hour12: true, seconds: false })), pm.replace(':05', ''));
  // An earlier day's event carries the Korean date.
  const now = Date.parse('2026-10-02T12:00:00');
  assert.equal(eventTime('2026-10-01T23:12:04', now, { lang: 'ko' }), `${t('format.dayLabel', { month: 10, day: 1 }, 'ko')} ${clockTime('2026-10-01T23:12:04')}`);
  // Token counts keep one format in both languages.
  assert.equal(inLanguage('ko', () => compact(1_061_000_000)), '1.06B');
});

test('values that were not observed, link states, roles and system states follow the language', () => {
  inLanguage('ko', () => {
    assert.equal(compact(null), STRINGS.ko['common.unknown']);
    assert.equal(linkText(undefined), STRINGS.ko['common.unknown']);
    assert.equal(linkText({ state: 'pending' }), STRINGS.ko['link.pending']);
    assert.equal(linkText({ state: 'partial', a: { up: true }, b: { up: false } }), `${t('link.plane.up', { plane: 'A' })}, ${t('link.plane.down', { plane: 'B' })}`);
    assert.equal(linkText({ state: 'up', planes: ['a'] }), t('link.up', { planes: 'A' }));
    assert.equal(roleName('HEAD'), STRINGS.ko['role.head']);
    assert.equal(systemStateText('degraded'), STRINGS.ko['systemState.degraded']);
  });
  // Roles and system states the table does not know are shown as reported.
  assert.equal(roleName('GATEWAY', 'ko'), 'GATEWAY');
  assert.equal(roleName(undefined), '');
  assert.equal(systemStateText('weird-state', 'ko'), 'weird-state');
  assert.equal(systemStateText('degraded'), 'degraded');
});

test("the server's status message shows in Korean by its key and falls back to the English message", () => {
  const message = 'Node connection needs attention (3/4 reachable)';
  const params = { connected: 3, count: 4 };
  assert.equal(serverText('status.nodeConnection', params, message, 'en'), message);
  assert.equal(serverText('status.nodeConnection', params, message, 'ko'), t('status.nodeConnection', params, 'ko'));
  assert.ok(serverText('status.nodeConnection', params, message, 'ko').includes('3/4'));
  // A key from a newer server, or no key from an older one: the English message.
  assert.equal(serverText('status.somethingNew', {}, 'Something new', 'ko'), 'Something new');
  assert.equal(serverText(undefined, undefined, 'Old server', 'ko'), 'Old server');
  assert.equal(serverText('status.healthy', undefined, 'Nodes and inference API healthy', 'ko'), STRINGS.ko['status.healthy']);
});

test('the rack panel takes its language from ?lang=', () => {
  assert.equal(queryLanguage('?lang=ko'), 'ko');
  assert.equal(queryLanguage('?width=819&lang=ko'), 'ko');
  assert.equal(queryLanguage('?lang=en'), 'en');
  assert.equal(queryLanguage('?lang=KO'), 'en');
  assert.equal(queryLanguage('?lang=fr'), 'en');
  assert.equal(queryLanguage(''), 'en');
});
