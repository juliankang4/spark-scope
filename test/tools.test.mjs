import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { usageMonth, fixtureState } from "../tools/fixtures.mjs";
import { validateMonth } from "../public/view-data.js";

test("the render fixtures always have a ledger row for today, on every day of a month", () => {
  for (let day = 1; day <= 31; day += 1) {
    const now = Date.UTC(2026, 9, day, 12);
    const month = validateMonth(usageMonth("2026-10", now), "2026-10");
    assert.equal(month.days.at(-1).day, `2026-10-${String(day).padStart(2, "0")}`);
    assert.ok(fixtureState(2, "serving", now).usage.today.output > 0, `day ${day}`);
  }
});

test("the demo serves the pages and moving made-up data without touching anything else", async () => {
  const { demoServer, liveState } = await import("../tools/demo.mjs");
  // A 20-second cycle: prefill, then decoding, then idle.
  const base = Math.floor(Date.parse("2026-10-03T09:00:00Z") / 20_000) * 20_000;
  const prefill = liveState(4, "serving", base + 1000), decode = liveState(4, "serving", base + 8000), idle = liveState(4, "serving", base + 17_000);
  assert.equal(prefill.inference.outputTokensPerSecond, 0);
  assert.equal(Date.parse(prefill.inference.prefillUpdatedAt), base + 1000);
  assert.ok(decode.inference.outputTokensPerSecond > 50);
  assert.ok(Date.parse(decode.inference.prefillUpdatedAt) < base + 8000);
  assert.equal(idle.inference.runningRequests, 0);
  assert.equal(Object.keys(liveState(2, "fault", base).nodes).length, 2);
  const mixed = liveState(4, "serving", base + 8000, { discreteGpu: true });
  assert.equal(Object.keys(mixed.nodes).length, 5);
  assert.equal(mixed.nodes["5"].gpu.memory.kind, "discrete");
  assert.equal(mixed.servers[0].serving.parallel, 4);
  assert.equal(mixed.servers.at(-1).serving.parallel, 1);
  const unified = fixtureState(1, "serving").nodes["1"];
  assert.equal(unified.gpu.memory.kind, "unified");
  assert.equal(unified.gpu.memory.availableBytes, unified.memory.availableBytes);
  const fixture = fixtureState(1, "serving", Date.now(), { discreteGpu: true });
  assert.equal(fixture.nodes["1"].gpu.memory.kind, "unified");
  assert.equal(fixture.nodes["2"].gpu.memory.totalBytes, 32 * 1024 ** 3);
  assert.notEqual(fixture.nodes["2"].gpu.memory.totalBytes, fixture.nodes["2"].memory.totalBytes);
  assert.equal(fixture.history.at(-1).nodes["2"].memoryAvailableBytes, fixture.nodes["2"].gpu.memory.availableBytes);
  assert.equal(fixture.nodes["2"].name, "gpu-2");
  assert.equal(fixture.nodes["2"].host, "gpu-2");
  assert.equal(fixture.topology.nodes.at(-1).hardware, "GPU workstation");
  assert.deepEqual(mixed.topology.links, fixtureState(4, "serving").topology.links);
  assert.equal(mixed.topology.nodes.length, 5);
  assert.deepEqual(mixed.servers.at(-1).nodes, ["5"]);
  const tooMany = spawnSync(process.execPath, [fileURLToPath(new URL("../tools/demo.mjs", import.meta.url)), "--nodes", "8", "--discrete"], { encoding: "utf8", timeout: 2000 });
  assert.equal(tooMany.status, 2);
  assert.match(tooMany.stderr, /8 total nodes maximum/);

  const server = demoServer(3, "serving");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const page of ["/", "/rack/", "/mini/", "/app.js", "/mini/mini-view.js"]) assert.equal((await fetch(url + page)).status, 200, page);
    assert.equal((await fetch(`${url}/mini`, { redirect: "manual" })).headers.get("location"), "/mini/");
    assert.equal((await fetch(`${url}/../package.json`)).status, 404);
    const state = await (await fetch(`${url}/api/state?minutes=15`)).json();
    assert.equal(Object.keys(state.nodes).length, 3);
    assert.ok(Array.isArray(state.history) && state.history.length > 0);
    assert.equal(state.rackSeenAt, null);
    await fetch(`${url}/api/state?history=0&from=rack`);
    assert.ok((await (await fetch(`${url}/api/state?history=0`)).json()).rackSeenAt);
    assert.equal((await (await fetch(`${url}/api/usage?month=2026-10`)).json()).month, "2026-10");
  } finally {
    server.close();
  }
});
