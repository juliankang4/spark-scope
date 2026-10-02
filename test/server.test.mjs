import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Starts the real server on a free port with a node that is never contacted and an inference URL that refuses
// connections, so nothing leaves this machine.
async function startServer(directory, extraEnv = {}) {
  const topology = path.join(directory, "topology.json");
  writeFileSync(topology, JSON.stringify({ nodes: [{ id: "1", name: "spark-1", host: "spark-1", collect: false }], links: [] }));
  const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    env: {
      ...process.env,
      SPARK_SCOPE_HOST: "127.0.0.1",
      SPARK_SCOPE_PORT: "0",
      SPARK_SCOPE_API_URL: "http://127.0.0.1:9",
      SPARK_SCOPE_TOPOLOGY: topology,
      SPARK_SCOPE_USAGE_DB: path.join(directory, "usage.sqlite"),
      SPARK_SCOPE_TIME_ZONE: "UTC",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code}: ${output}`)); });
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

test("the server serves the dashboard, the rack panel, the fonts and the JSON API", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-server-"));
  const { child, base } = await startServer(directory);
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /SPARK SCOPE/);
    const redirect = await fetch(`${base}/rack?width=2560`, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "/rack/?width=2560");
    const rack = await fetch(`${base}/rack/`);
    assert.equal(rack.status, 200);
    assert.match(await rack.text(), /rack\.js/);
    const icon = await fetch(`${base}/favicon.ico`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/x-icon");
    assert.equal((await fetch(`${base}/favicon.svg`)).headers.get("content-type"), "image/svg+xml");
    const font = await fetch(`${base}/fonts/BebasNeue-latin.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("content-type"), "font/woff2");

    const state = await (await fetch(`${base}/api/state?minutes=15`)).json();
    assert.deepEqual(state.topology.nodes.map((node) => [node.id, node.collect]), [["1", false]]);
    assert.deepEqual(state.ringLinks, {});
    assert.equal(state.nodes["1"].collected, false);
    assert.equal(state.vllm.ok, false);
    assert.equal(state.usage.timeZone, "UTC");
    assert.equal(state.historyStats.windowMinutes, 15);

    assert.equal((await fetch(`${base}/api/usage?month=2026-13`)).status, 400);
    assert.equal((await fetch(`${base}/api/usage?month=2026-09`)).status, 200);
    assert.notEqual((await fetch(`${base}/%2e%2e/server.mjs`)).status, 200);
    assert.equal((await fetch(`${base}/`, { method: "POST" })).status, 405);
  } finally {
    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("poll intervals must be whole numbers within limits; '2s' is refused instead of read as 2 ms", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-server-interval-"));
  try {
    for (const [name, value] of [["SPARK_SCOPE_API_INTERVAL_MS", "2s"], ["SPARK_SCOPE_NODE_INTERVAL_MS", "1e4"], ["SPARK_SCOPE_API_INTERVAL_MS", "100"]]) {
      await assert.rejects(startServer(directory, { [name]: value }), new RegExp(`server exited with 1: .*${name} must be a whole number of at least`, "s"));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a ledger file that cannot be opened turns off token counting, not the dashboard", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-server-ledger-"));
  const broken = path.join(directory, "broken.sqlite");
  writeFileSync(broken, Buffer.alloc(4096, 0x5a));
  const { child, base } = await startServer(directory, { SPARK_SCOPE_USAGE_DB: broken });
  try {
    // The server keeps running and serving; this test setup has no reachable node or API, so health reads offline.
    assert.equal((await fetch(`${base}/`)).status, 200);
    const stateResponse = await fetch(`${base}/api/state`);
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.usage.persistent, false);
    assert.match(state.usage.error, /Token ledger unavailable/);
    const month = await fetch(`${base}/api/usage?month=2026-10`);
    assert.equal(month.status, 503);
  } finally {
    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
