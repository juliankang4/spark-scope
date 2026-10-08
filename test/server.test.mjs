import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Starts the real server on a free port with a node that is never contacted and an inference URL that refuses
// connections, so nothing leaves this machine.
async function startServer(directory, extraEnv = {}, layout = { nodes: [{ id: "1", name: "spark-1", host: "spark-1", collect: false }], links: [] }) {
  const topology = path.join(directory, "topology.json");
  writeFileSync(topology, JSON.stringify(layout));
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
    const mini = await fetch(`${base}/mini/`);
    assert.equal(mini.status, 200);
    assert.match(await mini.text(), /mini\.js/);
    const miniRedirect = await fetch(`${base}/mini`, { redirect: "manual" });
    assert.equal(miniRedirect.status, 302);
    assert.equal(miniRedirect.headers.get("location"), "/mini/");
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
    // A rack panel's poll is remembered by time only; ordinary polls do not count as one.
    assert.equal(state.rackSeenAt, null);
    const before = Date.now();
    await fetch(`${base}/api/state?minutes=15&history=0&from=rack`);
    const seen = (await (await fetch(`${base}/api/state?history=0`)).json()).rackSeenAt;
    assert.ok(Date.parse(seen) >= before - 1000 && Date.parse(seen) <= Date.now(), seen);
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

test("/api/usage returns each day's models and the month's per-model totals next to the daily totals", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-server-usage-"));
  const { UsageStore } = await import("../lib/usage-store.mjs");
  const store = new UsageStore(path.join(directory, "usage.sqlite"), { timeZone: "UTC" });
  const sample = (modelName, output, at) => store.record({
    ok: true, modelName, processStartedAt: `start-${modelName}`, promptTokensTotal: output * 10, promptComputeTokensTotal: output * 4,
    promptCacheTokensTotal: output * 6, generationTokensTotal: output, completedRequestsTotal: output / 10,
  }, Date.parse(at));
  sample("model-a", 0, "2026-09-01T08:00:00Z");
  sample("model-a", 100, "2026-09-01T09:00:00Z");
  sample("model-b", 50, "2026-09-02T09:00:00Z");
  store.close();
  const { child, base } = await startServer(directory);
  try {
    const month = await (await fetch(`${base}/api/usage?month=2026-09`)).json();
    // The fields older pages read are unchanged.
    assert.deepEqual(month.days.map((day) => [day.day, day.output, day.input, day.total]), [["2026-09-01", 100, 1000, 1100], ["2026-09-02", 50, 500, 550]]);
    assert.deepEqual(month.totals, { input: 1500, compute: 600, cache: 900, output: 150, requests: 15, total: 1650 });
    assert.equal(month.firstMonth, "2026-09");
    // New: the models of each day and the month per model.
    assert.deepEqual(month.days.map((day) => day.models.map((model) => model.modelName)), [["model-a"], ["model-b"]]);
    assert.deepEqual(month.models.map((model) => [model.modelName, model.days, model.input, model.output, model.requests]), [["model-a", 1, 1000, 100, 10], ["model-b", 1, 500, 50, 5]]);
    assert.equal(month.firstDay, "2026-09-01");
    const empty = await (await fetch(`${base}/api/usage?month=2026-08`)).json();
    assert.deepEqual([empty.days, empty.models, empty.totals.total], [[], [], 0]);
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

// A stand-in vLLM server for one model; set(generated) changes its output counter.
async function fakeVllm(model) {
  const { createServer } = await import("node:http");
  let generated = 1000;
  const server = createServer((request, response) => {
    if (request.url === "/metrics") {
      response.end(`vllm:num_requests_running{model_name="${model}"} 1\nvllm:num_requests_waiting{model_name="${model}"} 0\nvllm:generation_tokens_total{model_name="${model}"} ${generated}\nvllm:prompt_tokens_total{model_name="${model}"} 5000\nprocess_start_time_seconds 1790000000\n`);
    } else if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: model }] }));
    } else {
      response.end("ok");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, set: (value) => { generated = value; }, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function waitFor(base, check, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await (await fetch(`${base}/api/state`)).json();
    if (check(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("model servers listed in topology.json are each read, judged and booked, and their URLs stay on the server", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-server-servers-"));
  const [a, b] = [await fakeVllm("big-model"), await fakeVllm("small-model")];
  const layout = {
    nodes: [{ id: "1", host: "spark-1", collect: false }, { id: "2", host: "spark-2", collect: false }],
    links: [],
    servers: [{ id: "a", api: a.url, nodes: ["1"] }, { id: "b", name: "Small", api: b.url, nodes: ["2"] }],
  };
  const { child, base, output } = await startServer(directory, { SPARK_SCOPE_API_INTERVAL_MS: "500" }, layout);
  try {
    const first = await waitFor(base, (state) => state.servers?.every((server) => server.inference?.ok), "both servers");
    assert.deepEqual(first.servers.map((server) => [server.id, server.name, server.nodes, server.inference.modelName]), [["a", null, ["1"], "big-model"], ["b", "Small", ["2"], "small-model"]]);
    // inference is the first server's, for pages and scripts written for one server.
    assert.equal(first.inference.modelName, "big-model");
    assert.deepEqual(first.topology.servers, [{ id: "a", name: null, nodes: ["1"] }, { id: "b", name: "Small", nodes: ["2"] }]);
    assert.doesNotMatch(JSON.stringify(first), new RegExp(`${a.url}|${b.url}`));
    assert.match(output(), /Model servers: a=http:\/\/127\.0\.0\.1:\d+ \(1\); b=http:\/\/127\.0\.0\.1:\d+ \(2\)/);
    // A new ledger takes a baseline from each server; then both servers' output is booked.
    a.set(1100);
    b.set(1030);
    const booked = await waitFor(base, (state) => state.usage?.today?.output === 130, "output from both servers");
    assert.equal(booked.servers[1].inference.ok, true);
    const history = (await (await fetch(`${base}/api/state?minutes=15`)).json()).history;
    assert.ok(history.length > 0 && history.every((point) => point.servers && "a" in point.servers && "b" in point.servers));
  } finally {
    child.kill();
    await Promise.all([a.close(), b.close()]);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a model server that never answers does not slow down the others", async () => {
  const { createServer: createTcpServer } = await import("node:net");
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-server-slow-"));
  const a = await fakeVllm("big-model");
  // Accepts connections and never answers, like a host whose API hangs: each request waits for the 4 s timeout.
  const sockets = new Set();
  const silent = createTcpServer((socket) => sockets.add(socket));
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const layout = {
    nodes: [{ id: "1", host: "spark-1", collect: false }, { id: "2", host: "spark-2", collect: false }],
    links: [],
    servers: [{ id: "a", api: a.url, nodes: ["1"] }, { id: "b", api: `http://127.0.0.1:${silent.address().port}`, nodes: ["2"] }],
  };
  const { child, base } = await startServer(directory, { SPARK_SCOPE_API_INTERVAL_MS: "500" }, layout);
  try {
    const seen = new Set();
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      const state = await (await fetch(`${base}/api/state?history=0`)).json();
      if (state.servers[0].inference?.ok) seen.add(state.servers[0].inference.updatedAt);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Every 500 ms over 3 s: about six readings of server a, not one per 4 s timeout of server b.
    assert.ok(seen.size >= 4, `server a was read ${seen.size} times in 3 s`);
  } finally {
    child.kill();
    for (const socket of sockets) socket.destroy();
    await Promise.all([a.close(), new Promise((resolve) => silent.close(resolve))]);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an inference URL with a password, or without a scheme, stops the server with a message that does not repeat it", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-server-url-"));
  try {
    for (const url of ["http://admin:s3cret@127.0.0.1:9", "127.0.0.1:8000"]) {
      await assert.rejects(startServer(directory, { SPARK_SCOPE_API_URL: url }), (error) => {
        assert.match(error.message, /exited with 1/);
        assert.match(error.message, /SPARK_SCOPE_API_URL must be an http:\/\/ or https:\/\/ URL/);
        assert.doesNotMatch(error.message, /s3cret|127\.0\.0\.1:8000\/health/);
        return true;
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

test("node memory kinds survive GPU failures independently and unified memory uses the current RAM reading", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-memory-kind-"));
  writeFileSync(path.join(directory, "ssh"), `#!/bin/sh
while IFS= read -r line; do :; done
for arg in "$@"; do
  case "$arg" in fixture-*) snapshot="$NODE_FIXTURE_DIR/$arg.txt" ;; esac
done
while IFS= read -r line; do echo "$line"; done < "$snapshot"
`);
  chmodSync(path.join(directory, "ssh"), 0o755);
  const sample = (id, gpu, status, available) => writeFileSync(path.join(directory, `fixture-${id}.txt`),
    `hostname|test-node\ngpu|${gpu}\ngpu_status|${status}\nmemory|131072000,${available},0,0\n`);
  sample("u", "0, 40, 10, 200, P8, Not Active, Not Active, [N/A], [N/A], NVIDIA GB10, Integrated GPU", "ok", 16000000);
  sample("d", "0, 40, 10, 200, P8, Not Active, Not Active, 16384, 32768, NVIDIA Discrete, Workstation", "ok", 32000000);
  sample("x", "", "error", 24000000);
  const layout = { nodes: ["u", "d", "x"].map(id => ({ id, host: `fixture-${id}` })), links: [] };
  const { child, base } = await startServer(directory, {
    PATH: `${directory}:${process.env.PATH}`, NODE_FIXTURE_DIR: directory, SPARK_SCOPE_NODE_INTERVAL_MS: "1000",
  }, layout);
  try {
    const first = await waitFor(base, state => state.nodes.u?.gpu?.memory?.kind === "unified" && state.nodes.d?.gpu?.memory?.kind === "discrete", "reported kinds");
    assert.equal(first.nodes.x.gpu.memory.kind, null);
    for (const [index, status] of ["timeout", "stuck", "error"].entries()) {
      sample("u", "", status, 24000000 + index);
      sample("d", "", status, 48000000 + index);
      const next = await waitFor(base, state => state.nodes.u?.gpu?.status === status && state.nodes.d?.gpu?.status === status, status);
      assert.equal(next.nodes.u.gpu.memory.kind, "unified");
      assert.equal(next.nodes.u.gpu.memory.availableBytes, (24000000 + index) * 1024);
      assert.equal(next.nodes.u.gpu.memory.totalBytes, next.nodes.u.memory.totalBytes);
      assert.equal(next.nodes.d.gpu.memory.kind, "discrete");
      assert.equal(next.nodes.d.gpu.memory.totalBytes, null);
      assert.equal(next.nodes.d.gpu.memory.usedBytes, null);
      assert.equal(next.nodes.d.gpu.memory.availableBytes, null);
      assert.equal(next.nodes.x.gpu.memory.kind, null);
    }
  } finally {
    const exited = new Promise(resolve => child.once("exit", resolve));
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
