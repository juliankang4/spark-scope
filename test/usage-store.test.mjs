import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageStore } from "../lib/usage-store.mjs";

function snapshot(overrides = {}) {
  return {
    ok: true,
    modelName: "model-a",
    processStartedAt: "2026-08-22T15:00:00.000Z",
    promptTokensTotal: 1000,
    promptComputeTokensTotal: 800,
    promptCacheTokensTotal: 200,
    generationTokensTotal: 100,
    completedRequestsTotal: 2,
    ...overrides,
  };
}

test("a fresh ledger takes a baseline, then books only increases and never counts the same counters twice", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-usage-"));
  const databasePath = path.join(directory, "usage.sqlite");
  const at = Date.parse("2026-08-23T00:10:00Z");
  let store = new UsageStore(databasePath, { timeZone: "UTC" });
  try {
    // The engine had already served these tokens before the ledger existed; they are not booked to today.
    const first = store.record(snapshot(), at);
    assert.equal(first.day, "2026-08-23");
    assert.deepEqual(first.today, { input: 0, compute: 0, cache: 0, output: 0, requests: 0, total: 0 });

    const duplicate = store.record(snapshot(), at + 2000);
    assert.deepEqual(duplicate.today, first.today);

    const increased = store.record(snapshot({
      promptTokensTotal: 1500,
      promptComputeTokensTotal: 1000,
      promptCacheTokensTotal: 500,
      generationTokensTotal: 150,
      completedRequestsTotal: 3,
    }), at + 4000);
    assert.deepEqual(increased.today, { input: 500, compute: 200, cache: 300, output: 50, requests: 1, total: 550 });
    store.close();

    store = new UsageStore(databasePath, { timeZone: "UTC" });
    const afterRestart = store.record(snapshot({
      promptTokensTotal: 1500,
      promptComputeTokensTotal: 1000,
      promptCacheTokensTotal: 500,
      generationTokensTotal: 150,
      completedRequestsTotal: 3,
    }), at + 6000);
    assert.equal(afterRestart.allTime.total, 550);

    const nextSession = store.record(snapshot({
      modelName: "model-b",
      processStartedAt: "2026-08-22T16:00:00.000Z",
      promptTokensTotal: 10,
      promptComputeTokensTotal: 10,
      promptCacheTokensTotal: 0,
      generationTokensTotal: 5,
      completedRequestsTotal: 1,
    }), at + 8000);
    // A new engine run once the ledger exists counts from its own start.
    assert.equal(nextSession.session.total, 15);
    assert.equal(nextSession.allTime.total, 565);
    assert.equal(nextSession.allTime.requests, 2);
    assert.deepEqual(nextSession.models.map((model) => model.modelName), ["model-a", "model-b"]);
  } finally {
    try { store.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a month returns its daily rows oldest first with period totals", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-usage-month-"));
  const databasePath = path.join(directory, "usage.sqlite");
  const store = new UsageStore(databasePath, { timeZone: "UTC" });
  try {
    store.record(snapshot(), Date.parse("2026-07-31T23:50:00Z"));
    store.record(snapshot({
      promptTokensTotal: 1400,
      promptComputeTokensTotal: 1100,
      promptCacheTokensTotal: 300,
      generationTokensTotal: 140,
      completedRequestsTotal: 3,
    }), Date.parse("2026-08-02T00:10:00Z"));
    store.record(snapshot({
      promptTokensTotal: 1900,
      promptComputeTokensTotal: 1450,
      promptCacheTokensTotal: 450,
      generationTokensTotal: 200,
      completedRequestsTotal: 5,
    }), Date.parse("2026-08-24T10:00:00Z"));

    const august = store.month("2026-08", Date.parse("2026-08-24T10:00:01Z"));
    assert.equal(august.day, "2026-08-24");
    assert.deepEqual(august.days.map((day) => day.day), ["2026-08-02", "2026-08-24"]);
    assert.deepEqual(august.totals, {
      input: 900,
      compute: 650,
      cache: 250,
      output: 100,
      requests: 3,
      total: 1000,
    });
    // 31 July only set the baseline, so the first booked day is in August.
    assert.equal(august.firstMonth, "2026-08");
    assert.equal(august.lastMonth, "2026-08");
    assert.deepEqual(store.month("2026-09").days, []);
    assert.throws(() => store.month("2026-13"), /Invalid month/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a month lists the models of each day, largest first, and each model's month totals with its days", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-usage-models-"));
  const store = new UsageStore(path.join(directory, "usage.sqlite"), { timeZone: "UTC" });
  // Counters of one engine run; each call books the increase since the last one.
  const run = (modelName, processStartedAt) => {
    let last = { input: 0, compute: 0, cache: 0, output: 0, requests: 0 };
    return (add, at) => {
      last = Object.fromEntries(Object.keys(last).map((key) => [key, last[key] + (add[key] ?? 0)]));
      store.record(snapshot({
        modelName, processStartedAt,
        promptTokensTotal: last.input, promptComputeTokensTotal: last.compute, promptCacheTokensTotal: last.cache,
        generationTokensTotal: last.output, completedRequestsTotal: last.requests,
      }), Date.parse(at));
    };
  };
  try {
    const a = run("model-a", "2026-08-31T00:00:00.000Z");
    a({}, "2026-08-31T23:00:00Z"); // baseline only
    a({ input: 1000, compute: 400, cache: 600, output: 50, requests: 2 }, "2026-09-01T10:00:00Z");
    a({ input: 300, compute: 100, cache: 200, output: 10, requests: 1 }, "2026-09-02T09:00:00Z");
    // Switched to model-b on 2 September: that day has both models, the larger one first.
    const b = run("model-b", "2026-09-02T12:00:00.000Z");
    b({ input: 2000, compute: 500, cache: 1500, output: 80, requests: 4 }, "2026-09-02T13:00:00Z");
    // model-a again later the same day, as a new run: still one entry for model-a that day.
    const a2 = run("model-a", "2026-09-02T18:00:00.000Z");
    a2({ input: 100, compute: 100, cache: 0, output: 5, requests: 1 }, "2026-09-02T19:00:00Z");
    b({ input: 10, compute: 10, cache: 0, output: 1, requests: 1 }, "2026-09-03T08:00:00Z");

    const september = store.month("2026-09", Date.parse("2026-09-03T09:00:00Z"));
    assert.deepEqual(september.days.map((day) => [day.day, day.models.map((model) => model.modelName)]), [
      ["2026-09-01", ["model-a"]],
      ["2026-09-02", ["model-b", "model-a"]],
      ["2026-09-03", ["model-b"]],
    ]);
    const second = september.days[1];
    assert.deepEqual(second.models[1], { modelName: "model-a", input: 400, compute: 200, cache: 200, output: 15, requests: 2, total: 415 });
    // A day's totals are the sum of its models.
    assert.deepEqual({ ...second, models: undefined }, { day: "2026-09-02", input: 2400, compute: 700, cache: 1700, output: 95, requests: 6, total: 2495, models: undefined });
    assert.deepEqual(september.models, [
      { modelName: "model-b", days: 2, input: 2010, compute: 510, cache: 1500, output: 81, requests: 5, total: 2091 },
      { modelName: "model-a", days: 2, input: 1400, compute: 600, cache: 800, output: 65, requests: 4, total: 1465 },
    ]);
    assert.equal(september.totals.total, 2091 + 1465);
    assert.equal(september.firstDay, "2026-09-01");
    assert.deepEqual(store.month("2026-10").models, []);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("calendar days follow the configured time zone, and default to the server's own", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-usage-zone-"));
  const tokyo = new UsageStore(path.join(directory, "tokyo.sqlite"), { timeZone: "Asia/Tokyo" });
  const local = new UsageStore(path.join(directory, "local.sqlite"));
  try {
    // 15:30 UTC on 31 July is already 1 August in UTC+9.
    assert.equal(tokyo.record(snapshot(), Date.parse("2026-07-31T15:30:00Z")).day, "2026-08-01");
    assert.equal(local.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  } finally {
    tokyo.close();
    local.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function sglang(overrides = {}) {
  // SGLang publishes no process start time, so every run of a model shares one session key.
  return snapshot({ processStartedAt: null, ...overrides });
}

test("an SGLang restart (counters going down) starts a new run instead of losing its tokens", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-usage-restart-"));
  const store = new UsageStore(path.join(directory, "usage.sqlite"), { timeZone: "UTC" });
  const at = Date.parse("2026-10-02T01:00:00Z");
  try {
    store.record(sglang({ generationTokensTotal: 1000 }), at);
    assert.equal(store.record(sglang({ generationTokensTotal: 10_000 }), at + 2000).today.output, 9000);
    // Restarted while the dashboard was down; the new run already served 4,500 tokens.
    const afterRestart = store.record(sglang({ generationTokensTotal: 4500, promptTokensTotal: 10, promptComputeTokensTotal: 8, promptCacheTokensTotal: 2, completedRequestsTotal: 1 }), at + 60_000);
    assert.equal(afterRestart.today.output, 13_500);
    assert.equal(store.record(sglang({ generationTokensTotal: 4600, promptTokensTotal: 10, promptComputeTokensTotal: 8, promptCacheTokensTotal: 2, completedRequestsTotal: 1 }), at + 62_000).today.output, 13_600);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a clock that went back (a Pi without its RTC after a power cut) does not book a restarted run again on every poll", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-usage-clock-"));
  const store = new UsageStore(path.join(directory, "usage.sqlite"), { timeZone: "UTC" });
  const at = Date.parse("2026-10-02T12:00:00Z");
  try {
    store.record(sglang({ generationTokensTotal: 1000 }), at);
    assert.equal(store.record(sglang({ generationTokensTotal: 5000 }), at + 2000).today.output, 4000);
    // Power cut: the engine restarted and the clock came back an hour early.
    const early = at - 3_600_000;
    assert.equal(store.record(sglang({ generationTokensTotal: 100 }), early).today.output, 4100);
    assert.equal(store.record(sglang({ generationTokensTotal: 150 }), early + 2000).today.output, 4150);
    assert.equal(store.record(sglang({ generationTokensTotal: 250 }), early + 4000).today.output, 4250);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an existing ledger keeps counting into its current session", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-usage-continue-"));
  const databasePath = path.join(directory, "usage.sqlite");
  const at = Date.parse("2026-10-02T01:00:00Z");
  let store = new UsageStore(databasePath, { timeZone: "UTC" });
  try {
    store.record(sglang({ generationTokensTotal: 1000 }), at);
    store.record(sglang({ generationTokensTotal: 1500 }), at + 2000);
    store.close();
    // The dashboard restarts (or moves to a new install with the same database) while the engine keeps running.
    store = new UsageStore(databasePath, { timeZone: "UTC" });
    assert.equal(store.record(sglang({ generationTokensTotal: 1700 }), at + 60_000).today.output, 700);
  } finally {
    try { store.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test("counters the engine does not export add nothing and are marked as not reported", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-usage-missing-"));
  const store = new UsageStore(path.join(directory, "usage.sqlite"), { timeZone: "UTC" });
  const at = Date.parse("2026-10-02T01:00:00Z");
  const noSources = (output, input) => snapshot({ generationTokensTotal: output, promptTokensTotal: input, promptComputeTokensTotal: null, promptCacheTokensTotal: undefined });
  try {
    store.record(noSources(100, 1000), at);
    const summary = store.record(noSources(150, 1600), at + 2000);
    assert.deepEqual(summary.today, { input: 600, compute: 0, cache: 0, output: 50, requests: 0, total: 650 });
    assert.deepEqual(summary.reported, { input: true, compute: false, cache: false, output: true, requests: true });
    assert.deepEqual(store.month("2026-10", at + 2000).reported, summary.reported);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("idle polls do not write to the ledger", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-usage-idle-"));
  const databasePath = path.join(directory, "usage.sqlite");
  const store = new UsageStore(databasePath, { timeZone: "UTC" });
  const at = Date.parse("2026-10-02T01:00:00Z");
  const lastSeen = () => {
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try { return reader.prepare("SELECT last_seen_at FROM usage_sessions").get().last_seen_at; } finally { reader.close(); }
  };
  try {
    store.record(snapshot(), at);
    store.record(snapshot({ generationTokensTotal: 110 }), at + 2000);
    const afterChange = lastSeen();
    for (let poll = 1; poll <= 30; poll += 1) store.record(snapshot({ generationTokensTotal: 110 }), at + 2000 + poll * 2000);
    assert.equal(lastSeen(), afterChange);
    // Still touched now and then, so the session's last-seen time stays roughly right.
    store.record(snapshot({ generationTokensTotal: 110 }), at + 2000 + 16 * 60_000);
    assert.notEqual(lastSeen(), afterChange);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
