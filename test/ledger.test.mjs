import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCsv, monthComparison, modelChanges, modelColors, previousMonth, daysInMonth, statementHtml, calendarHtml, calendarMetric, chartsHtml, kpiHtml, CSV_COLUMNS, MODEL_COLORS } from '../public/ledger.js';
import { validateMonth, compact, unknown } from '../public/view-data.js';
import { usageMonth, LEDGER_SCENARIO } from '../tools/fixtures.mjs';

const scenario = (month) => usageMonth(month, LEDGER_SCENARIO.now, { start: LEDGER_SCENARIO.start });
const row = (day, models) => {
  const parts = models.map(([modelName, output]) => ({ modelName, input: output * 10, compute: output * 2, cache: output * 8, output, requests: 1, total: output * 11 }));
  const sum = (key) => parts.reduce((total, part) => total + part[key], 0);
  return { day, input: sum('input'), compute: sum('compute'), cache: sum('cache'), output: sum('output'), requests: sum('requests'), total: sum('total'), models: parts };
};

test('month arithmetic crosses years and knows month lengths', () => {
  assert.equal(previousMonth('2027-01'), '2026-12');
  assert.equal(previousMonth('2027-06'), '2027-05');
  assert.deepEqual(['2027-02', '2028-02', '2027-04', '2027-05'].map(daysInMonth), [28, 29, 30, 31]);
});

test('the fixture scenario is a valid /api/usage month: a start on the 23rd, five models in a full month, three days now', () => {
  const [april, may, june] = LEDGER_SCENARIO.months.map(scenario);
  for (const month of [april, may, june]) assert.equal(validateMonth(month, month.month), month);
  assert.equal(april.days[0].day, '2027-04-23');
  assert.equal(may.models.length, 5);
  assert.deepEqual([may.days[0].day, may.days.at(-1).day], ['2027-05-01', '2027-05-31']);
  assert.deepEqual(june.days.map((day) => day.day), ['2027-06-01', '2027-06-02', '2027-06-03']);
});

test('the comparison with last month needs last month recorded from its first day', () => {
  const [april, may, june] = LEDGER_SCENARIO.months.map(scenario);
  // April started on the 23rd: no comparison for May, and none for April itself.
  assert.equal(monthComparison(may, april), null);
  assert.equal(monthComparison(april, null), null);
  // June 1 to 3 against May 1 to 3.
  const versus = monthComparison(june, may);
  const before = may.days.filter((day) => day.day <= '2027-05-03').reduce((total, day) => total + day.total, 0);
  assert.equal(versus.previousTotal, before);
  assert.equal(versus.lastDay, 3);
  assert.equal(versus.whole, false);
  assert.ok(Math.abs(versus.change - (june.totals.total - before) / before * 100) < 1e-9);
  // A finished 30-day month against a 31-day one compares the whole months.
  const july = { ...may, month: '2027-06', day: '2027-07-10', days: may.days.map((day) => ({ ...day, day: day.day.replace('-05-', '-06-') })).filter((day) => day.day <= '2027-06-30'), firstDay: LEDGER_SCENARIO.start };
  const whole = monthComparison(july, may);
  assert.equal(whole.lastDay, 30);
  assert.equal(whole.previousTotal, may.days.filter((day) => day.day <= '2027-05-30').reduce((total, day) => total + day.total, 0));
  // Without any use last month there is nothing to compare with.
  assert.equal(monthComparison(june, { ...may, days: [] }), null);
});

test('a model change is marked on the day a model appears that the last day with records did not have', () => {
  const days = [row('2027-05-01', [['a', 5]]), row('2027-05-02', [['a', 5], ['b', 1]]), row('2027-05-04', [['b', 5]]), row('2027-05-05', [['a', 2], ['b', 5]])];
  assert.deepEqual([...modelChanges(days)], ['2027-05-02', '2027-05-05']);
  // The first day is compared with the last day of the month before.
  assert.deepEqual([...modelChanges(days, [row('2027-04-30', [['z', 1]]), { day: '2027-04-31', models: [] }])], ['2027-05-01', '2027-05-02', '2027-05-05']);
  // Colours follow the month's table, then models only the days list.
  const colors = modelColors({ models: [{ modelName: 'b' }, { modelName: 'a' }], days: [row('2027-05-09', [['c', 1]])] });
  assert.deepEqual([...colors], [['b', MODEL_COLORS[0]], ['a', MODEL_COLORS[1]], ['c', MODEL_COLORS[2]]]);
});

test('the CSV has one row per day and model, quotes what needs quoting and leaves unreported counts empty', () => {
  const month = { month: '2027-05', days: [row('2027-05-01', [['plain', 100]]), row('2027-05-02', [['with, "comma"', 50], ['=SUM(A1)', 10]]), { day: '2027-05-03', input: 7, compute: 0, cache: 0, output: 3, requests: 1, total: 10 }] };
  const lines = ledgerCsv(month, { compute: true }).split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.equal(lines[1], '2027-05-01,plain,800,200,1000,100,1');
  assert.equal(lines[2], '2027-05-02,"with, ""comma""",400,100,500,50,1');
  // A model name that a spreadsheet would run as a formula is written as text.
  assert.equal(lines[3], "2027-05-02,'=SUM(A1),80,20,100,10,1");
  // A day from an older server without models; new input is not exported by this engine.
  assert.equal(lines[4], '2027-05-03,,0,,7,3,1');
  assert.equal(lines.at(-1), '');
  assert.equal(lines.length, 6);
});

test('the views cover the whole month: weeks from Monday, every calendar day, and a chart axis to the last day', () => {
  const [april, may, june] = LEDGER_SCENARIO.months.map(scenario);
  // May 2027 starts on a Saturday: weeks of May 1, 3, 10, 17, 24 and 31.
  assert.equal((statementHtml(may).match(/class="week"/g) ?? []).length, 6);
  // April shows only the days from the ledger's first day.
  assert.equal((statementHtml(april).match(/<th scope="row"><span class="date">/g) ?? []).length, 8);
  assert.match(statementHtml(june), /class="today"/);
  const calendar = calendarHtml(june, may, '2027-06-03');
  assert.equal((calendar.match(/class="cal-day/g) ?? []).length, 30);
  assert.equal((calendar.match(/ disabled>/g) ?? []).length, 27);
  // June 1 follows May's last model, so the model changed that day.
  assert.match(calendar, /data-day="2027-06-01"[^>]*>\s*<i class="switch"/);
  const charts = chartsHtml(june, may);
  assert.equal((charts.match(/viewBox="0 0 300 100"/g) ?? []).length, 2);
  // The running total's axis also covers May's 31 days, so May's line ends at its total.
  assert.match(charts, /viewBox="0 0 310 100"/);
  // Today and the comparison show only in the current month.
  assert.equal((kpiHtml(june, may).match(/class="kpi/g) ?? []).length, 6);
  assert.equal((kpiHtml(may, april).match(/class="kpi/g) ?? []).length, 4);
});

test('the calendar shows and shades by output, new input + output or total tokens, and marks the chosen one', () => {
  const [, may, june] = LEDGER_SCENARIO.months.map(scenario);
  const day = june.days.find((item) => item.day === '2027-06-02');
  const shown = (html) => html.match(/data-day="2027-06-02"[^>]*>(?:<i[^>]*><\/i>)?<span class="d">2<\/span><b[^>]*>([^<]*)<\/b>/)?.[1];
  const pressed = (html) => html.match(/data-cal-metric="(\w+)" aria-pressed="true"/)?.[1];
  const output = calendarHtml(june, may, '2027-06-02');
  assert.equal(shown(output), compact(day.output));
  assert.equal(pressed(output), 'output');
  const work = calendarHtml(june, may, '2027-06-02', {}, 'work');
  assert.equal(shown(work), compact(day.compute + day.output));
  assert.equal(pressed(work), 'work');
  const total = calendarHtml(june, may, '2027-06-02', {}, 'total');
  assert.equal(shown(total), compact(day.total));
  assert.match(total, /title="[^"]*Total tokens [\d,]+"/);
  // The busiest day by the chosen figure, and only that day, gets the darkest shade (day cells only, not the legend).
  // In May the most output and the most new input + output fall on different days.
  const levels = (html) => new Map([...html.matchAll(/data-day="([\d-]+)"[^>]*style="--level:(\d+)%"/g)].map((match) => [match[1], Number(match[2])]));
  const busiest = (value) => may.days.reduce((best, item) => (value(item) > value(best) ? item : best)).day;
  const byOutput = busiest((item) => item.output), byWork = busiest((item) => item.compute + item.output);
  assert.notEqual(byOutput, byWork);
  const shades = Object.fromEntries(['output', 'work', 'total'].map((name) => [name, levels(calendarHtml(may, null, '2027-05-01', {}, name))]));
  assert.equal(shades.output.get(byOutput), 50);
  assert.equal(shades.work.get(byWork), 50);
  assert.equal(shades.total.get(busiest((item) => item.total)), 50);
  assert.ok(shades.output.get(byWork) < 50 && shades.work.get(byOutput) < 50);
  // A name from an older browser falls back to output.
  assert.equal(calendarMetric('tokens'), 'output');
  assert.equal(pressed(calendarHtml(june, may, '2027-06-02', {}, 'tokens')), 'output');
  // Without new input, New input + output reads unknown rather than output alone.
  const noSplit = { ...june, days: june.days.map((item) => ({ ...item, compute: 0, cache: 0 })) };
  assert.equal(shown(calendarHtml(noSplit, may, '2027-06-02', { compute: true, cache: true }, 'work')), unknown());
  assert.equal(shown(calendarHtml(noSplit, may, '2027-06-02', { compute: true, cache: true }, 'output')), compact(day.output));
  // A day recorded without the split reads unknown too when today's engine exports it, and does not set the scale.
  const oldDay = { ...june, days: june.days.map((item) => (item.day === '2027-06-02' ? { ...item, compute: 0, cache: 0, output: item.output * 100 } : item)) };
  const mixed = calendarHtml(oldDay, may, '2027-06-02', {}, 'work');
  assert.equal(shown(mixed), unknown());
  assert.equal(levels(mixed).get('2027-06-02'), 0);
  assert.equal(Math.max(...levels(mixed).values()), 50);
});

test('without the cache and new-input split, the input chart draws logical input as one series', () => {
  const [, may, june] = LEDGER_SCENARIO.months.map(scenario);
  const charts = chartsHtml(june, may, { cache: true, compute: true });
  const inputChart = charts.split('class="chart-pair"')[0];
  assert.match(inputChart, /<rect [^>]*class="k-new"><title>[^<]*Logical input/);
  assert.doesNotMatch(inputChart, /class="k-cache"/);
});
