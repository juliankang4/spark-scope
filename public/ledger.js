// The token ledger tab: the figures over the month, the Statement, Calendar and Charts views, the table by model and
// the CSV export. Everything here works on one /api/usage month (and the month before it, for the comparison) and
// returns markup or plain values; app.js fetches the months, keeps the chosen view and day, and handles the clicks.
import { t, locale } from './i18n.js';
import { finite, fixed, compact, unknown, escapeHtml as esc, dayLabel, monthName } from './view-data.js';
import { helpButton } from './help.js';

// Model colours in the order of the month's table (largest first). Orange is left out: it is the output bars' colour.
export const MODEL_COLORS = ['var(--blue)', 'var(--purple)', 'var(--green)', 'var(--gold)', 'var(--magenta)', 'var(--umber)', 'var(--red)', 'var(--ink)'];
export const CSV_COLUMNS = ['day', 'model', 'cache_read', 'new_input', 'logical_input', 'output', 'requests'];

export const daysInMonth = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
export const previousMonth = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };
const dayNumber = (day) => Number(day.slice(8));
const dayKey = (month, number) => `${month}-${String(number).padStart(2, '0')}`;
const sum = (rows, key) => rows.reduce((total, row) => total + (finite(row[key]) ? row[key] : 0), 0);
const percent = (part, whole) => (whole > 0 ? fixed(part / whole * 100, 1, '%') : unknown());
const full = (value) => (finite(value) ? value.toLocaleString('en-US') : '');
const modelsOf = (day) => (Array.isArray(day?.models) ? day.models : []);

// The short weekday in the page's language ("Tue"; Korean uses its one-syllable form). Monday is 2024-01-01.
const weekdayFormats = new Map();
export function weekday(day, lang) {
  const name = locale(lang);
  if (!weekdayFormats.has(name)) weekdayFormats.set(name, new Intl.DateTimeFormat(name, { weekday: 'short', timeZone: 'UTC' }));
  return weekdayFormats.get(name).format(Date.parse(`${day}T00:00:00Z`));
}
const mondayFirst = (day) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

// The month's colour for each model; a day's model the month table lacks (an older server) gets the next one.
export function modelColors(usage) {
  const colors = new Map();
  const add = (name) => { if (!colors.has(name)) colors.set(name, MODEL_COLORS[colors.size % MODEL_COLORS.length]); };
  for (const model of usage?.models ?? []) add(model.modelName);
  for (const day of usage?.days ?? []) for (const model of modelsOf(day)) add(model.modelName);
  return colors;
}

// Days on which a model served that the previous day with records did not have (the first day of the month is
// compared with the last day of the month before).
export function modelChanges(days, previousDays = []) {
  const changed = new Set();
  let before = [...previousDays].reverse().find((day) => modelsOf(day).length);
  before = before ? modelsOf(before).map((model) => model.modelName) : null;
  for (const day of days) {
    const names = modelsOf(day).map((model) => model.modelName);
    if (!names.length) continue;
    if (before && names.some((name) => !before.includes(name))) changed.add(day.day);
    before = names;
  }
  return changed;
}

// The last day the month's figures run to: today in the current month, otherwise the month's last day.
export const throughDay = (usage) => (usage.day?.slice(0, 7) === usage.month ? dayNumber(usage.day) : daysInMonth(usage.month));

// Total tokens against the same days of last month: days 1 to today (a past month: the whole month, with all of a
// shorter last month). Only when the ledger recorded last month from its first day, and last month had any use.
export function monthComparison(usage, previous) {
  const prev = previousMonth(usage.month);
  if (!previous || previous.month !== prev || !Array.isArray(previous.days)) return null;
  const firstDay = usage.firstDay ?? previous.firstDay ?? previous.days[0]?.day ?? null;
  if (!firstDay || firstDay > `${prev}-01`) return null;
  const through = throughDay(usage), lastDay = Math.min(through, daysInMonth(prev));
  const before = sum(previous.days.filter((day) => dayNumber(day.day) <= lastDay), 'total');
  if (!(before > 0)) return null;
  const now = sum(usage.days.filter((day) => dayNumber(day.day) <= through), 'total');
  return { change: (now - before) / before * 100, previousTotal: before, previousMonth: prev, lastDay, whole: lastDay === daysInMonth(prev) };
}

// A count the engine does not export (unreported[key]) reads as unknown rather than 0.
function figure(key, value, unreported) {
  if (unreported[key] && !value) return { text: unknown(), title: '', missing: true };
  return { text: key === 'requests' ? fixed(value, 0) : compact(value), title: full(value), missing: false };
}
function cell(key, value, unreported, extra = '') {
  const f = figure(key, value, unreported);
  return `<td class="${[extra, f.missing ? 'unknown-value' : ''].filter(Boolean).join(' ')}"${f.title ? ` title="${f.title}"` : ''}>${f.text}</td>`;
}

const chip = (name, colors) => `<span class="chip" title="${esc(name)}"><i style="background:${colors.get(name)}"></i>${esc(name)}</span>`;
const chips = (day, colors) => modelsOf(day).map((model) => chip(model.modelName, colors)).join(' ');

// The figures over the month. Today shows only in the current month, the comparison only when it applies.
export function kpiHtml(usage, previous, unreported = {}) {
  const totals = usage.totals, current = usage.day?.slice(0, 7) === usage.month;
  const active = usage.days.filter((day) => day.total > 0 || day.requests > 0).length;
  const item = (cls, label, value, note = '', title = '') => `<div class="kpi${cls ? ` ${cls}` : ''}"><small>${label}</small><b${title ? ` title="${title}"` : ''}${value === unknown() ? ' class="unknown-value"' : ''}>${value}</b><em>${note}</em></div>`;
  const items = [item('kpi-total', `${t('ledger.totalTokens')}${helpButton('help.totalTokens')}`, compact(totals.total), full(totals.total))];
  if (current) {
    const today = usage.days.find((day) => day.day === usage.day);
    items.push(item('', t('ledger.kpi.today'), figure('output', today?.output ?? 0, unreported).text, t('ledger.kpi.requests', { count: today?.requests ?? 0, value: fixed(today?.requests ?? 0, 0) })));
  }
  const input = figure('input', totals.input, unreported), output = figure('output', totals.output, unreported), requests = figure('requests', totals.requests, unreported);
  items.push(item('', t('ledger.logicalInput'), input.text, unreported.cache || !totals.input ? '' : t('ledger.kpi.cacheHit', { percent: percent(totals.cache, totals.input) }), input.title));
  items.push(item('', t('ledger.output'), output.text, active && !output.missing ? t('ledger.kpi.perDay', { value: compact(totals.output / active) }) : '', output.title));
  items.push(item('', t('ledger.requests'), requests.text, totals.requests > 0 && !output.missing ? t('ledger.kpi.perRequest', { value: fixed(totals.output / totals.requests, 0) }) : ''));
  const versus = monthComparison(usage, previous);
  if (versus) {
    const rounded = Math.round(versus.change), sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
    const period = versus.whole ? monthName(versus.previousMonth) : `${dayLabel(`${versus.previousMonth}-01`)} – ${dayLabel(dayKey(versus.previousMonth, versus.lastDay))}`;
    items.push(item('', `${t('ledger.kpi.vsLast')}${helpButton('help.vsLastMonth')}`, `${sign}${Math.abs(rounded)}%`, t('ledger.kpi.vsSub', { value: compact(versus.previousTotal), period })));
  }
  return items.join('');
}

// The days the statement and the calendar cover: from the 1st (or the ledger's first day) to the month's end or today.
function shownDays(usage) {
  const first = usage.firstDay && usage.firstDay > `${usage.month}-01` ? usage.firstDay : `${usage.month}-01`;
  const days = [];
  for (let number = 1; number <= throughDay(usage); number++) { const key = dayKey(usage.month, number); if (key >= first) days.push(key); }
  return days;
}

// Statement: one row per day grouped by week (Monday to Sunday) under the week's subtotal, then the month's total.
export function statementHtml(usage, unreported = {}) {
  const colors = modelColors(usage), byDay = new Map(usage.days.map((day) => [day.day, day]));
  const current = usage.day?.slice(0, 7) === usage.month, maxOutput = Math.max(1, ...usage.days.map((day) => day.output));
  const keys = ['cache', 'compute', 'output', 'input', 'requests'];
  const figures = (row, bar) => `${cell('cache', row.cache, unreported, 'wide-col')}${cell('compute', row.compute, unreported, 'wide-col')}${cell('output', row.output, unreported)}<td class="bar-col" aria-hidden="true">${bar}</td>${cell('input', row.input, unreported)}${cell('requests', row.requests, unreported)}`;
  const weeks = [];
  for (const key of shownDays(usage)) {
    if (!weeks.length || mondayFirst(key) === 0) weeks.push([]);
    weeks.at(-1).push(key);
  }
  const body = weeks.map((week) => {
    const records = week.map((key) => byDay.get(key)).filter(Boolean);
    const subtotal = Object.fromEntries(keys.map((key) => [key, sum(records, key)]));
    const weekFigures = records.length ? figures(subtotal, '') : '<td class="wide-col"></td><td class="wide-col"></td><td></td><td class="bar-col"></td><td></td><td></td>';
    const rows = week.map((key) => {
      const day = byDay.get(key), date = `<span class="date">${esc(dayLabel(key))}</span> <span class="dow">${esc(weekday(key))}</span>`;
      const today = current && key === usage.day, attrs = (cls) => { const list = [cls, today ? 'today' : ''].filter(Boolean); return `${list.length ? ` class="${list.join(' ')}"` : ''}${today ? ` title="${t('ledger.today')}"` : ''}`; };
      if (!day) return `<tr${attrs('idle')}><th scope="row">${date}<span class="day-models">${t('ledger.noRecords')}</span></th><td class="model-col">${t('ledger.noRecords')}</td><td class="wide-col"></td><td class="wide-col"></td><td></td><td class="bar-col"></td><td></td><td></td></tr>`;
      const bar = `<i style="width:${(day.output / maxOutput * 100).toFixed(1)}%"></i>`;
      return `<tr${attrs('')}><th scope="row">${date}<span class="day-models">${chips(day, colors)}</span></th><td class="model-col">${chips(day, colors)}</td>${figures(day, bar)}</tr>`;
    }).join('');
    return `<tr class="week"><th scope="row">${t('ledger.week', { day: dayLabel(week[0]) })}</th><td class="model-col"></td>${weekFigures}</tr>${rows}`;
  }).join('');
  const label = t(current ? 'ledger.monthToDate' : 'ledger.monthTotal', { month: monthName(usage.month) });
  const head = `<thead><tr><th scope="col">${t('ledger.date')}</th><th scope="col" class="model-col">${t('ledger.model')}</th><th scope="col" class="wide-col">${t('ledger.cacheRead')}</th><th scope="col" class="wide-col">${t('ledger.newInput')}</th><th scope="col">${t('ledger.output')}</th><th class="bar-col" aria-hidden="true"></th><th scope="col">${t('ledger.logicalInput')}</th><th scope="col">${t('ledger.requests')}</th></tr></thead>`;
  const rows = usage.days.length ? body : `<tr class="empty"><td colspan="8">${t('ledger.noUsage')}</td></tr>`;
  return `<table class="statement"><caption class="sr-only">${t('ledger.tableCaption')}</caption>${head}<tbody>${rows}</tbody><tfoot><tr class="total"><th scope="row">${esc(label)}</th><td class="model-col"></td>${figures(usage.totals, '')}</tr></tfoot></table>`;
}

// Calendar: the month as a grid shaded by output (more output, more colour), a mark on the days a model changed, and
// the selected day's figures beside it.
export function calendarHtml(usage, previous, selected, unreported = {}) {
  const colors = modelColors(usage), byDay = new Map(usage.days.map((day) => [day.day, day]));
  const changes = modelChanges(usage.days, previous?.month === previousMonth(usage.month) ? previous.days : []);
  const current = usage.day?.slice(0, 7) === usage.month, through = throughDay(usage), maxOutput = Math.max(1, ...usage.days.map((day) => day.output));
  const heads = Array.from({ length: 7 }, (_, i) => `<span class="dow" aria-hidden="true">${esc(weekday(`2024-01-0${i + 1}`))}</span>`).join('');
  const blanks = '<span></span>'.repeat(mondayFirst(`${usage.month}-01`));
  const cells = Array.from({ length: daysInMonth(usage.month) }, (_, i) => {
    const key = dayKey(usage.month, i + 1), day = byDay.get(key), pressed = key === selected;
    const classes = ['cal-day', current && key === usage.day ? 'today' : ''];
    if (i + 1 > through) return `<button type="button" class="${[...classes, 'future'].join(' ')}" disabled><span class="d">${i + 1}</span></button>`;
    if (!day) return `<button type="button" class="${[...classes, 'empty'].join(' ')}" data-day="${key}" aria-pressed="${pressed}" title="${esc(t('ledger.bar.noRecord', { day: dayLabel(key) }))}"><span class="d">${i + 1}</span></button>`;
    const level = Math.round(8 + 42 * Math.sqrt(day.output / maxOutput));
    const mark = changes.has(key) ? `<i class="switch" title="${t('ledger.modelChanged')}"></i>` : '';
    return `<button type="button" class="${classes.join(' ').trim()}" data-day="${key}" aria-pressed="${pressed}" style="--level:${level}%" title="${esc(t('ledger.bar.output', { day: dayLabel(key), count: fixed(day.output, 0) }))}">${mark}<span class="d">${i + 1}</span><b>${figure('output', day.output, unreported).text}</b><small>${t('ledger.cal.requests', { value: fixed(day.requests, 0) })}</small></button>`;
  }).join('');
  const legend = `<div class="keys"><span><i class="shade" style="--level:10%"></i>${t('ledger.cal.less')}</span><span><i class="shade" style="--level:50%"></i>${t('ledger.cal.more')}</span><span><i class="switch-key"></i>${t('ledger.modelChanged')}</span></div>`;
  return `<div class="cal-view"><div><div class="cal" role="group" aria-label="${esc(t('ledger.cal.label', { month: monthName(usage.month) }))}">${heads}${blanks}${cells}</div>${legend}</div><aside class="day-detail" aria-live="polite">${detailHtml(usage, byDay.get(selected), selected, colors, unreported)}</aside></div>`;
}

function detailHtml(usage, day, selected, colors, unreported) {
  if (!selected) return '';
  const heading = `<h3>${esc(t('ledger.dayWeekday', { day: dayLabel(selected), weekday: weekday(selected) }))}</h3>`;
  if (!day) return `${heading}<p>${usage.firstDay && selected < usage.firstDay ? esc(t('ledger.detail.beforeStart', { day: dayLabel(usage.firstDay) })) : t('ledger.detail.noRecords')}</p>`;
  const value = (key, number) => { const f = figure(key, number, unreported); return f.missing ? f.text : full(number); };
  const rows = [
    [t('ledger.output'), value('output', day.output)],
    [t('ledger.newInput'), value('compute', day.compute)],
    [t('ledger.cacheRead'), value('cache', day.cache)],
    [t('ledger.logicalInput'), value('input', day.input)],
    [t('ledger.requests'), value('requests', day.requests)],
    [t('engine.cacheHit'), unreported.cache ? unknown() : percent(day.cache, day.input)],
    [t('ledger.detail.perRequest'), day.requests > 0 ? fixed(day.output / day.requests, 0) : unknown()],
  ];
  const share = day.input > 0 && !unreported.cache ? day.cache / day.input * 100 : null;
  const split = share === null ? '' : `<div class="split" aria-hidden="true"><i class="k-cache" style="width:${share.toFixed(1)}%"></i><i class="k-new"></i></div><div class="keys"><span><i class="k-cache"></i>${t('ledger.cacheRead')}</span><span><i class="k-new"></i>${t('ledger.newInput')}</span></div>`;
  return `${heading}<div class="detail-models">${chips(day, colors)}</div><dl>${rows.map(([label, text]) => `<dt>${label}</dt><dd>${text}</dd>`).join('')}</dl>${split}`;
}

// Day labels under a chart: the 1st, every fifth day and the last day, placed at the middle of their day.
function dayTicks(count) {
  const days = [1, ...[5, 10, 15, 20, 25].filter((d) => d < count - 2), count];
  // The last label ends at the right edge rather than centring past it.
  return `<div class="x-ticks" aria-hidden="true">${days.map((d) => (d === count ? `<span class="end">${d}</span>` : `<span style="left:${((d - 0.5) / count * 100).toFixed(2)}%">${d}</span>`)).join('')}</div>`;
}
// A chart frame: values on the left (the highest and half of it), the drawing, and the day labels under it.
function chartFrame(max, svg, count, extra = '') {
  const scale = max > 0 ? `<span style="top:6%">${compact(max)}</span><span style="top:53%">${compact(max / 2)}</span>` : '';
  return `<div class="lchart"><div class="y-ticks" aria-hidden="true">${scale}</div>${svg}${extra}${dayTicks(count)}</div>`;
}
const grid = (width) => `<line x1="0" x2="${width}" y1="6" y2="6" class="gridline" vector-effect="non-scaling-stroke"/><line x1="0" x2="${width}" y1="53" y2="53" class="gridline" vector-effect="non-scaling-stroke"/><line x1="0" x2="${width}" y1="100" y2="100" class="baseline" vector-effect="non-scaling-stroke"/>`;
// Bars per day over the whole month (days not reached yet show a thin track); series are stacked bottom up.
function bars(usage, series, label) {
  const count = daysInMonth(usage.month), width = count * 10, through = throughDay(usage), byDay = new Map(usage.days.map((day) => [day.day, day]));
  const max = Math.max(0, ...usage.days.map((day) => series.reduce((total, s) => total + (day[s.key] || 0), 0)));
  const y = (value) => 100 - (max > 0 ? value / max * 94 : 0);
  let marks = '';
  for (let number = 1; number <= count; number++) {
    const key = dayKey(usage.month, number), day = byDay.get(key), x = (number - 1) * 10 + 1.5;
    if (number > through) { marks += `<rect x="${x}" y="98.5" width="7" height="1.5" class="future-track"/>`; continue; }
    if (!day) continue;
    let base = 0;
    for (const s of series) {
      const value = day[s.key] || 0;
      if (value > 0) marks += `<rect x="${x}" y="${y(base + value).toFixed(2)}" width="7" height="${(y(base) - y(base + value)).toFixed(2)}" class="${s.cls}"><title>${esc(`${dayLabel(key)}: ${s.name} ${full(value)}`)}</title></rect>`;
      base += value;
    }
  }
  return { max, svg: `<svg viewBox="0 0 ${width} 100" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">${grid(width)}${marks}</svg>` };
}

// Charts: logical input per day (cache read under new input), output per day with the day's main model as a strip,
// and this month's running total against last month's. Input and output keep separate scales.
export function chartsHtml(usage, previous) {
  const colors = modelColors(usage), count = daysInMonth(usage.month), width = count * 10, byDay = new Map(usage.days.map((day) => [day.day, day]));
  const key = (cls, label) => `<span><i class="${cls}"></i>${label}</span>`;
  const input = bars(usage, [{ key: 'cache', name: t('ledger.cacheRead'), cls: 'k-cache' }, { key: 'compute', name: t('ledger.newInput'), cls: 'k-new' }], t('ledger.chart.input'));
  const output = bars(usage, [{ key: 'output', name: t('ledger.output'), cls: 'k-output' }], t('ledger.chart.output'));
  let strip = '';
  for (let number = 1; number <= count; number++) {
    const main = modelsOf(byDay.get(dayKey(usage.month, number)))[0];
    if (main) strip += `<rect x="${(number - 1) * 10 + 1.5}" y="0" width="7" height="10" style="fill:${colors.get(main.modelName)}"><title>${esc(`${dayLabel(dayKey(usage.month, number))}: ${main.modelName}`)}</title></rect>`;
  }
  const stripSvg = `<svg class="model-strip" viewBox="0 0 ${width} 10" preserveAspectRatio="none" aria-hidden="true">${strip}</svg>`;
  const modelKeys = [...colors].map(([name, color]) => `<span title="${esc(name)}"><i style="background:${color}"></i>${esc(name)}</span>`).join('');
  // Running totals by day of the month. Last month's line runs to its own last day, so where it ends matches its total;
  // when last month was longer, this chart's axis is too.
  const running = (days, month, last) => { const values = [], map = new Map(days.map((day) => [day.day, day])); let total = 0; for (let n = 1; n <= last; n++) { total += map.get(dayKey(month, n))?.total ?? 0; values.push(total); } return values; };
  const prev = previous?.month === previousMonth(usage.month) && previous.days?.length ? previous : null;
  const mine = running(usage.days, usage.month, throughDay(usage));
  const theirs = prev ? running(prev.days, prev.month, daysInMonth(prev.month)) : [];
  const span = Math.max(count, theirs.length), spanWidth = span * 10;
  const top = Math.max(0, ...mine, ...theirs), y = (value) => (100 - (top > 0 ? value / top * 94 : 0)).toFixed(2);
  const line = (values, cls) => (values.length ? `<path d="${values.map((v, i) => `${i ? 'L' : 'M'}${i * 10 + 5} ${y(v)}`).join(' ')}" class="${cls}" vector-effect="non-scaling-stroke"/>` : '');
  const runningSvg = `<svg viewBox="0 0 ${spanWidth} 100" preserveAspectRatio="none" role="img" aria-label="${esc(t('ledger.chart.running'))}">${grid(spanWidth)}${line(theirs, 'line-last')}${line(mine, 'line-this')}</svg>`;
  const prevFirst = prev?.firstDay && prev.firstDay > `${prev.month}-01` ? prev.firstDay : null;
  // The legend names both months, since "this month" would be wrong for a past one.
  const prevTotal = compact(prev?.totals?.total ?? 0);
  const lastKey = prev ? key('k-last', esc(prevFirst ? t('ledger.chart.monthFrom', { month: monthName(prev.month), value: prevTotal, day: dayLabel(prevFirst) }) : `${monthName(prev.month)} ${prevTotal}`)) : '';
  return `<div class="chart-box"><div class="chart-head"><h3>${t('ledger.chart.input')}</h3><div class="keys">${key('k-cache', t('ledger.cacheRead'))}${key('k-new', t('ledger.newInput'))}</div></div>${chartFrame(input.max, input.svg, count)}</div>`
    + `<div class="chart-pair"><div class="chart-box"><div class="chart-head"><h3>${t('ledger.chart.output')}</h3><small>${t('ledger.chart.strip')}</small></div>${chartFrame(output.max, output.svg, count, stripSvg)}<div class="keys model-keys">${modelKeys}</div></div>`
    + `<div class="chart-box"><div class="chart-head"><h3>${t('ledger.chart.running')}</h3><div class="keys">${key('k-this', esc(`${monthName(usage.month)} ${compact(usage.totals.total)}`))}${lastKey}</div></div>${chartFrame(top, runningSvg, span)}</div></div>`;
}

// The month by model: days used, logical input, output, requests and the share of the month's total tokens.
export function modelTableHtml(usage, unreported = {}) {
  const colors = modelColors(usage), models = usage.models ?? [], total = usage.totals.total;
  const rows = models.length ? models.map((model) => {
    const share = total > 0 ? model.total / total * 100 : 0;
    return `<tr><th scope="row"><span class="model-name" title="${esc(model.modelName)}"><i style="background:${colors.get(model.modelName)}"></i>${esc(model.modelName)}</span></th><td>${fixed(model.days, 0)}</td>${cell('input', model.input, unreported)}${cell('output', model.output, unreported)}${cell('requests', model.requests, unreported)}<td class="share"><span>${fixed(share, 1, '%')}</span><span class="share-bar" aria-hidden="true"><i style="width:${share.toFixed(1)}%;background:${colors.get(model.modelName)}"></i></span></td></tr>`;
  }).join('') : `<tr class="empty"><td colspan="6">${t('ledger.noUsage')}</td></tr>`;
  return `<h3>${t('ledger.byModel')}</h3><table class="model-table"><thead><tr><th scope="col">${t('ledger.model')}</th><th scope="col">${t('ledger.days')}</th><th scope="col">${t('ledger.logicalInput')}</th><th scope="col">${t('ledger.output')}</th><th scope="col">${t('ledger.requests')}</th><th scope="col">${t('ledger.share')}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// The month as CSV, one row per day and model. A field that a spreadsheet would read as a formula starts with '.
const csvField = (value) => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
export function ledgerCsv(usage, unreported = {}) {
  const value = (key, number) => (unreported[key] && !number ? '' : String(number ?? 0));
  const rows = [CSV_COLUMNS];
  for (const day of usage.days) {
    for (const part of modelsOf(day).length ? modelsOf(day) : [{ ...day, modelName: '' }]) {
      rows.push([day.day, part.modelName, value('cache', part.cache), value('compute', part.compute), value('input', part.input), value('output', part.output), value('requests', part.requests)]);
    }
  }
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}
