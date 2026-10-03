import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleOf, phaseOf, startRun, addToRun, finishRun, runsCsv } from '../public/mini/mini-view.js';

const state = (at, { decode = 0, prefill = 0, prefillAt = null, temps = [60, 62], watts = [20, 30], ttft = null, output = 0, input = 0, day = '2026-10-03' } = {}) => ({
  updatedAt: new Date(at).toISOString(),
  inference: { ok: true, outputTokensPerSecond: decode, promptComputeTokensPerSecond: prefill, promptTokensPerSecond: prefill, prefillUpdatedAt: prefillAt === null ? null : new Date(prefillAt).toISOString(), ttftP95RecentSeconds: ttft },
  nodes: { a: { ok: true, gpu: { temperature: temps[0], powerWatts: watts[0] } }, b: { ok: true, gpu: { temperature: temps[1], powerWatts: watts[1] } } },
  usage: { day, today: { output, input } },
});

test('a sample counts as prefill only when new prefills completed since the previous one', () => {
  const t0 = Date.parse('2026-10-03T09:00:00Z');
  // The server holds the last prefill rate; without a newer prefillUpdatedAt the poll saw decoding only.
  assert.equal(sampleOf(state(t0 + 2000, { decode: 60, prefill: 2100, prefillAt: t0 }), t0 + 2000, t0).prefill, 0);
  assert.equal(sampleOf(state(t0 + 2000, { decode: 60, prefill: 2100, prefillAt: t0 + 1500 }), t0 + 2000, t0).prefill, 2100);
  // The first sample has no previous one: a prefill within the last poll counts.
  assert.equal(sampleOf(state(t0, { prefill: 900, prefillAt: t0 - 1000 }), t0, null).prefill, 900);
  assert.equal(sampleOf(state(t0, { prefill: 900, prefillAt: t0 - 60_000 }), t0, null).prefill, 0);
  assert.equal(phaseOf({ prefill: 10, decode: 50 }), 'prefill');
  assert.equal(phaseOf({ prefill: 0, decode: 50 }), 'decode');
  assert.equal(phaseOf({ prefill: 0, decode: 0 }), 'idle');
  assert.equal(phaseOf(undefined), 'idle');
  // A server that is down or an engine that does not answer gives zeros, not unknown rates.
  assert.deepEqual(sampleOf({ inference: { ok: false }, nodes: {} }, t0, null), { at: t0, decode: 0, prefill: 0, nodes: {} });
});

test('a run folds averages, peaks, the hottest GPU and GPU energy, and takes tokens from the ledger', () => {
  const t0 = Date.parse('2026-10-03T09:00:00Z');
  const first = state(t0, { output: 1000, input: 50_000 });
  const run = startRun(first, t0);
  // 10 s at 100 tok/s, then 10 s at 50 tok/s; 50 W in total; the second node peaks at 71 °C.
  addToRun(run, state(t0 + 10_000, { decode: 100, ttft: 0.4 }), sampleOf(state(t0 + 10_000, { decode: 100 }), t0 + 10_000, t0));
  addToRun(run, state(t0 + 20_000, { decode: 50, ttft: 0.9, temps: [61, 71] }), sampleOf(state(t0 + 20_000, { decode: 50, prefill: 3000, prefillAt: t0 + 19_000, temps: [61, 71] }), t0 + 20_000, t0 + 10_000));
  const done = finishRun(run, state(t0 + 20_000, { output: 2500, input: 80_000 }), 3);
  assert.equal(done.number, 3);
  assert.equal(done.seconds, 20);
  assert.equal(done.avgDecode, 75);
  assert.equal(done.peakDecode, 100);
  assert.equal(done.peakPrefill, 3000);
  assert.equal(done.slowestTtft, 0.9);
  assert.equal(done.hottest, 71);
  assert.equal(done.hottestNode, 'b');
  assert.ok(Math.abs(done.energyWh - 50 * 20 / 3600) < 1e-9);
  // Within one day the ledger's counters give the exact tokens.
  assert.equal(done.outputTokens, 1500);
  assert.equal(done.promptTokens, 30_000);
  // Across midnight the ledger restarts, so the counts come from the rates instead.
  const overnight = finishRun({ ...run }, state(t0 + 20_000, { output: 10, input: 10, day: '2026-10-04' }), 4);
  assert.equal(overnight.outputTokens, 1500);
  assert.equal(overnight.promptTokens, 30_000);
});

test('runs export as CSV with one row each and quoted cells where needed', () => {
  const csv = runsCsv([{ number: 2, startedAt: Date.parse('2026-10-03T09:00:00Z'), seconds: 74, avgDecode: 96.25, peakDecode: 111, peakPrefill: 6120.4, slowestTtft: 1.4123, hottest: 74.04, hottestNode: 'node, "a"', energyWh: 1.6189, outputTokens: 7100, promptTokens: 52_000 },
    { number: 1, startedAt: Date.parse('2026-10-03T08:00:00Z'), seconds: 61, avgDecode: null, peakDecode: 0, peakPrefill: 0, slowestTtft: null, hottest: null, hottestNode: null, energyWh: 0, outputTokens: 0, promptTokens: 0 }]);
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^run,started,seconds,avg_decode_tok_s,/);
  assert.equal(lines[1], '2,2026-10-03T09:00:00.000Z,74,96.3,111,6120,1.412,74,"node, ""a""",1.619,7100,52000');
  assert.equal(lines[2], '1,2026-10-03T08:00:00.000Z,61,,0,0,,,,0,0,0');
});
