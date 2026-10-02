import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  let output = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code}: ${output}`)); });
  });
  // Everything the server printed so far, including what it logged before listening.
  return { child, base: `http://127.0.0.1:${port}`, output: () => output };
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
    assert.equal(state.inference.ok, false);
    assert.equal(state.usage.timeZone, "UTC");
    assert.equal(state.historyStats.windowMinutes, 15);
    assert.deepEqual(state.pollIntervals, { nodeMs: 5000, apiMs: 2000 });
    assert.equal(state.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
    assert.ok(Array.isArray(state.history));
    // The status message comes with a key and parameters for the pages' other languages.
    const { t } = await import("../public/i18n.js");
    assert.match(state.messageKey, /^status\./);
    assert.equal(typeof state.messageParams, "object");
    assert.equal(t(state.messageKey, state.messageParams, "en"), state.message);
    const light = await (await fetch(`${base}/api/state?minutes=15&history=0`)).json();
    assert.equal(light.history, undefined);
    assert.equal(light.historyStats.windowMinutes, 15);
    // fetch() asks for gzip and decodes it; the raw response shows the encoding.
    const http = await import("node:http");
    const encoding = await new Promise((resolve, reject) => http.get(`${base}/api/state`, { headers: { "Accept-Encoding": "gzip" } }, (res) => { res.resume(); resolve(res.headers["content-encoding"]); }).on("error", reject));
    assert.equal(encoding, "gzip");

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

// One raw HTTP request, so the Host header and the request target are sent exactly as written. The socket stays open
// for writing until the server answers and closes it ("Connection: close"); a half-closed socket can be dropped
// before a slower (file) response is written.
async function rawRequest(base, lines) {
  const net = await import("node:net");
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), "127.0.0.1", () => socket.write(`${lines.join("\r\n")}\r\n\r\n`));
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1]), text: data }));
    socket.on("error", reject);
  });
}

test("requests for another site's host name are refused, every response carries the security headers, and a malformed target is a 400", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-server-host-"));
  const { child, base } = await startServer(directory, { SPARK_SCOPE_ALLOWED_HOSTS: "dash.example.org" });
  let log = "";
  child.stderr.on("data", (chunk) => { log += chunk; });
  try {
    const rebinding = await rawRequest(base, ["GET /api/state HTTP/1.1", "Host: attacker.example:8787", "Connection: close"]);
    assert.equal(rebinding.status, 403);
    assert.doesNotMatch(rebinding.text, /topology|nodes/);
    assert.match(rebinding.text, /Content-Security-Policy: default-src 'self'/i);
    for (const host of ["localhost:8787", "127.0.0.1", "dash.example.org"]) {
      assert.equal((await rawRequest(base, ["GET /api/health HTTP/1.1", `Host: ${host}`, "Connection: close"])).status, 503, host);
    }
    const page = await fetch(`${base}/`);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.doesNotMatch(await page.text(), /<script>/, "the page has no inline script for the policy to allow");
    assert.equal((await rawRequest(base, ["GET http://[ HTTP/1.1", "Host: localhost", "Connection: close"])).status, 400);
    const state = await (await fetch(`${base}/api/state?history=0`)).json();
    assert.equal(state.inference.baseUrl, undefined);
    assert.equal(state.vllm.ok, state.inference.ok);
    assert.match(log, /Refused a request for host "attacker\.example:8787"/);
    // Path tricks sent byte for byte (fetch() would normalise them first) never reach files outside public/.
    for (const target of ["/../server.mjs", "/%2e%2e/server.mjs", "/..%2fserver.mjs", "/%2e%2e%2f%2e%2e%2fetc%2fpasswd", "/..\\server.mjs", "/%00"]) {
      const response = await rawRequest(base, [`GET ${target} HTTP/1.1`, "Host: localhost", "Connection: close"]);
      assert.equal(response.status, 404, target);
      assert.doesNotMatch(response.text, /createServer|root:/, target);
    }
    assert.equal((await rawRequest(base, ["GET /%E0%A4%A HTTP/1.1", "Host: localhost", "Connection: close"])).status, 400);
  } finally {
    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a node whose SSH login fails is logged in full on the server and summarised in the API", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-server-ssh-"));
  const bin = path.join(directory, "bin");
  const { mkdirSync, chmodSync } = await import("node:fs");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\ncat >/dev/null\necho "admin@10.0.0.6: Permission denied (publickey)." >&2\nexit 255\n`);
  chmodSync(path.join(bin, "ssh"), 0o755);
  const topology = path.join(directory, "collected.json");
  writeFileSync(topology, JSON.stringify({ nodes: [{ id: "1", name: "spark-9", host: "spark-9" }], links: [] }));
  const { child, base, output } = await startServer(directory, { PATH: `${bin}:${process.env.PATH}`, SPARK_SCOPE_TOPOLOGY: topology });
  try {
    const state = await (await fetch(`${base}/api/state?history=0`)).json();
    assert.equal(state.nodes["1"].ok, false);
    assert.equal(state.nodes["1"].error, "SSH authentication failed");
    assert.doesNotMatch(JSON.stringify(state), /10\.0\.0\.6|admin@/);
    assert.match(output(), /Node spark-9: admin@10\.0\.0\.6: Permission denied \(publickey\)\./);
  } finally {
    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
