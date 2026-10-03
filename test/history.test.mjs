import test from "node:test";
import assert from "node:assert/strict";
import { downsampleHistory, summarizeHistory } from "../lib/history.mjs";

const point = (at, output, running, temperature) => ({
  at, outputTokensPerSecond: output, promptTokensPerSecond: null, runningRequests: running, queue: 0,
  nodes: { 1: { temperature, memoryAvailableBytes: null } },
});

test("a long history is averaged down to at most the target count, keeping gaps as gaps", () => {
  const points = Array.from({ length: 10 }, (_, i) => point(i * 1000, i < 4 ? 10 * (i + 1) : null, 1, i < 2 ? null : 50 + i));
  assert.equal(downsampleHistory(points, 20), points);
  const down = downsampleHistory(points, 5);
  assert.equal(down.length, 5);
  // Each point stands for two samples and carries the later one's time.
  assert.deepEqual(down.map((p) => p.at), [1000, 3000, 5000, 7000, 9000]);
  assert.deepEqual(down.map((p) => p.outputTokensPerSecond), [15, 35, null, null, null]);
  assert.deepEqual(down.map((p) => p.nodes[1].temperature), [null, 52.5, 54.5, 56.5, 58.5]);
  assert.equal(down[0].nodes[1].memoryAvailableBytes, null);
});

test("the active average counts only samples with requests running", () => {
  const stats = summarizeHistory([point(0, 0, 0, 40), point(1, 60, 2, 41), point(2, 80, 1, 42), point(3, null, 1, 43)], 15);
  assert.deepEqual(stats, { activeOutputTokensPerSecond: 70, activeSamples: 2, windowMinutes: 15 });
  assert.equal(summarizeHistory([point(0, 0, 0, 40)]).activeOutputTokensPerSecond, null);
});

test("with several model servers, each server's own fields are averaged next to the totals", () => {
  const points = Array.from({ length: 4 }, (_, i) => ({ ...point(i * 1000, 30, 2, 50), servers: { a: { outputTokensPerSecond: 20 + i, promptTokensPerSecond: null, runningRequests: 1, queue: 0 }, b: { outputTokensPerSecond: i < 2 ? null : 10, promptTokensPerSecond: null, runningRequests: 1, queue: 0 } } }));
  const down = downsampleHistory(points, 2);
  assert.deepEqual(down.map((p) => p.servers.a.outputTokensPerSecond), [20.5, 22.5]);
  assert.deepEqual(down.map((p) => p.servers.b.outputTokensPerSecond), [null, 10]);
  assert.equal(downsampleHistory(points.map(({ servers, ...rest }) => rest), 2)[0].servers, undefined);
});
