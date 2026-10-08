import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  applyNetworkRates,
  applyGpuMemoryFallback,
  buildRemoteScript,
  collectNode,
  collectorCommand,
  knownEngine,
  metricsEngine,
  parseNetworkLines,
  parseGpuMemory,
  histogramQuantile,
  bucketsQuantile,
  bucketsSince,
  RecentHistograms,
  holdPrefillRates,
  metricSum,
  metricValue,
  parseInferenceProcess,
  parseKernelEvents,
  parsePrometheus,
  parseThermals,
  resolveModelIdentity,
} from "../lib/collectors.mjs";

test("the last completed prefill rate is held until the next prefill completes", () => {
  const first = {
    at: Date.parse("2026-08-23T00:00:00Z"),
    modelName: "model-a",
    promptTotal: 200_000,
    promptComputeTotal: 160_000,
    promptCacheTotal: 40_000,
    prefillTimeTotal: 100,
    prefillCount: 1,
  };
  const sampled = holdPrefillRates(first);
  assert.equal(sampled.promptTokensPerSecond, 2000);
  assert.equal(sampled.promptComputeTokensPerSecond, 1600);
  assert.equal(sampled.promptCacheTokensPerSecond, 400);

  const unchanged = holdPrefillRates({ ...first, at: first.at + 2000 }, first, sampled);
  assert.deepEqual(unchanged, sampled);

  const next = {
    ...first,
    at: first.at + 4000,
    promptTotal: 210_000,
    promptComputeTotal: 168_000,
    promptCacheTotal: 42_000,
    prefillTimeTotal: 105,
    prefillCount: 2,
  };
  const refreshed = holdPrefillRates(next, first, sampled);
  assert.equal(refreshed.promptTokensPerSecond, 2000);
  assert.equal(refreshed.promptComputeTokensPerSecond, 1600);
  assert.equal(refreshed.promptCacheTokensPerSecond, 400);
  assert.equal(refreshed.updatedAt, "2026-08-23T00:00:04.000Z");

  const reset = holdPrefillRates({
    ...first,
    at: first.at + 6000,
    modelName: "model-b",
    promptTotal: 0,
    promptComputeTotal: 0,
    promptCacheTotal: 0,
    prefillTimeTotal: 0,
    prefillCount: 0,
  }, next, refreshed);
  assert.equal(reset.promptTokensPerSecond, 0);
  assert.equal(reset.updatedAt, null);

  // A poll whose prefill counters were missing (TensorFold's /health did not answer) is no baseline for the next one.
  const gap = { ...next, at: next.at + 2000, promptComputeTotal: null, promptCacheTotal: null, prefillTimeTotal: null, prefillCount: null };
  const afterGap = { ...next, at: next.at + 4000, promptTotal: 214_000, promptComputeTotal: 171_200, promptCacheTotal: 42_800, prefillTimeTotal: 107, prefillCount: 3 };
  assert.deepEqual(holdPrefillRates(afterGap, gap, refreshed), refreshed);
});

test("Prometheus samples and labels are parsed", () => {
  const metrics = parsePrometheus(`
# HELP vllm:num_requests_running running
vllm:num_requests_running{engine="0",model_name="model-a"} 2
vllm:request_success_total{finished_reason="error",model_name="model-a"} 3
`);
  assert.equal(metricValue(metrics, "vllm:num_requests_running"), 2);
  assert.equal(metricValue(metrics, "vllm:request_success_total", { finished_reason: "error" }), 3);
});

test("p95 is interpolated inside the bucket that reaches 95%, as Prometheus does", () => {
  const metrics = parsePrometheus(`
vllm:time_to_first_token_seconds_bucket{le="0.1"} 2
vllm:time_to_first_token_seconds_bucket{le="0.5"} 8
vllm:time_to_first_token_seconds_bucket{le="1"} 10
vllm:time_to_first_token_seconds_bucket{le="+Inf"} 10
`);
  // Rank 9.5 of 10 lies 1.5 of the 2 observations into the 0.5–1 s bucket.
  assert.equal(histogramQuantile(metrics, "vllm:time_to_first_token_seconds", 0.95), 0.875);
  // Inside the first bucket the lower bound is 0.
  assert.equal(histogramQuantile(metrics, "vllm:time_to_first_token_seconds", 0.1), 0.05);
  // In the +Inf bucket the estimate is the highest finite bound.
  const tail = parsePrometheus(`
vllm:time_to_first_token_seconds_bucket{le="1"} 5
vllm:time_to_first_token_seconds_bucket{le="+Inf"} 10
`);
  assert.equal(histogramQuantile(tail, "vllm:time_to_first_token_seconds", 0.95), 1);
});

test("per-label counter sums are computed", () => {
  const metrics = parsePrometheus(`
vllm:request_prefill_time_seconds_count{model_name="model-a"} 4
vllm:request_prefill_time_seconds_sum{model_name="model-a"} 10
vllm:request_success_total{finished_reason="stop"} 7
vllm:request_success_total{finished_reason="length"} 2
vllm:request_success_total{finished_reason="error"} 1
`);
  assert.equal(metricSum(metrics, "vllm:request_success_total"), 10);
  assert.equal(metricSum(metrics, "vllm:request_success_total", { finished_reason: "error" }), 1);
});

test("the model name comes from the metrics; the model list is kept as aliases", () => {
  const metrics = parsePrometheus(`
vllm:num_requests_running{model_name="current-model"} 0
`);
  const identity = resolveModelIdentity(metrics, [
    { id: "current-model", root: "org/new-checkpoint" },
    { id: "writing-alias", root: "org/new-checkpoint" },
  ]);
  assert.deepEqual(identity, {
    modelName: "current-model",
    modelRoot: "org/new-checkpoint",
    modelAliases: ["current-model", "writing-alias"],
  });
});

test("without a model label in the metrics, the API model list names the model", () => {
  const identity = resolveModelIdentity(new Map(), [{ id: "replacement-model", root: "org/replacement" }]);
  assert.equal(identity.modelName, "replacement-model");
  assert.equal(identity.modelRoot, "org/replacement");
});

test("engine, TP rank and readiness are read from the GPU process name and /proc state", () => {
  assert.deepEqual(parseInferenceProcess("152952, VLLM::Worker_TP0, 109270, S"), {
    up: true,
    alive: true,
    ready: true,
    pid: 152952,
    processName: "VLLM::Worker_TP0",
    command: null,
    engine: "vLLM",
    rank: 0,
    memoryBytes: 109270 * 1024 * 1024,
    state: "S",
  });
  assert.equal(parseInferenceProcess("42, llama-server, 8192, R").rank, null);
  assert.equal(parseInferenceProcess("42, llama-server, 8192, R").engine, "llama.cpp");
  assert.equal(parseInferenceProcess("42, VLLM::Worker_TP1, 8192, Z").ready, false);
  assert.equal(parseInferenceProcess("42, VLLM::Worker_TP1, 8192, ").ready, false);
  // A Python server that nvidia-smi names after its interpreter is recognised by its command name.
  assert.equal(parseInferenceProcess("42, /opt/venv/bin/python3, 8192, S, tensorfold").engine, "TensorFold");
});

test("every short-named ACPI thermal zone is converted to Celsius; TSOC and TS1P also get their own fields", () => {
  assert.deepEqual(parseThermals("TSOC=46800,TS0E=47100,TS1P=46300,TGPU=47800,bad name=1,TUNC=x"), {
    tsocCelsius: 46.8,
    ts1pCelsius: 46.3,
    zones: { TSOC: 46.8, TS0E: 47.1, TS1P: 46.3, TGPU: 47.8 },
  });
  assert.deepEqual(parseThermals(""), { tsocCelsius: null, ts1pCelsius: null, zones: {} });
});

test("NVMe and NIC temperatures and the CPU load are read, unknown when absent", async () => {
  const { parseHwmon, parseCpu } = await import("../lib/collectors.mjs");
  assert.deepEqual(parseHwmon("nvme=44850,nic=53000"), { nvmeCelsius: 44.85, nicCelsius: 53 });
  assert.deepEqual(parseHwmon("nvme=,nic="), { nvmeCelsius: null, nicCelsius: null });
  assert.deepEqual(parseCpu("0.23,0.18,0.18,20"), { load1: 0.23, load5: 0.18, load15: 0.18, cores: 20 });
  assert.deepEqual(parseCpu(""), { load1: null, load5: null, load15: null, cores: null });
});

test("the bounded kernel journal summary yields counts and the last message", () => {
  assert.deepEqual(parseKernelEvents("ok\t263\t97\t2\t0\t1787414172.25\tNVRM: NV_ERR_NO_MEMORY"), {
    available: true,
    status: "ok",
    windowHours: 24,
    total: 263,
    noMemory: 97,
    xid: 2,
    capped: false,
    lastAt: "2026-08-22T15:56:12.250Z",
    lastMessage: "NVRM: NV_ERR_NO_MEMORY",
  });
  const noMatch = parseKernelEvents("ok\t0\t0\t0\t0\t\t");
  assert.equal(noMatch.available, true);
  assert.equal(noMatch.total, 0);
  assert.equal(noMatch.lastAt, null);
  assert.equal(noMatch.lastMessage, null);

  const timedOut = parseKernelEvents("timeout\t3\t2\t0\t0\t\t");
  assert.equal(timedOut.available, false);
  assert.equal(timedOut.status, "timeout");

  const unavailable = parseKernelEvents("unavailable\t0\t0\t0\t0\t\t");
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.status, "unavailable");
});

test("Gb/s rates come from the network counters of two snapshots", () => {
  const previous = {
    ok: true,
    updatedAt: "2026-08-22T00:00:00.000Z",
    network: {
      a: { rxBytes: 1000, txBytes: 2000, rateGbps: 0 },
      b: { rxBytes: 3000, txBytes: 4000, rateGbps: 0 },
    },
  };
  const current = {
    ok: true,
    updatedAt: "2026-08-22T00:00:02.000Z",
    network: {
      a: { rxBytes: 1_000_001_000, txBytes: 1_000_002_000, rateGbps: 0 },
      b: { rxBytes: 500_003_000, txBytes: 500_004_000, rateGbps: 0 },
    },
  };
  applyNetworkRates(current, previous);
  assert.equal(current.network.a.rateGbps, 8);
  assert.equal(current.network.b.rateGbps, 4);
});

test("the collector script reads only the topology's interfaces and stays valid bash", () => {
  const script = buildRemoteScript(["enp1s0f1np1", "enP2p1s0f1np1", "eth9"]);
  assert.match(script, /^SCOPE_IFACES='enp1s0f1np1 rocep1s0f1 enP2p1s0f1np1 roceP2p1s0f1 eth9 -'\n/);
  assert.ok(!/enp1s0f0np0/.test(script), "no hard-coded interfaces");
  const syntax = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.throws(() => buildRemoteScript(["eth0'; reboot; '"]));
});

test("interface lines are read by name and missing interfaces stay unavailable", () => {
  const network = parseNetworkLines({ "net:enp1s0f0np0": "1,200000,10,20,0,0,1,2", "net:enp1s0f1np1": "" }, ["enp1s0f0np0", "enp1s0f1np1", "enP2p1s0f1np1"]);
  assert.equal(network.enp1s0f0np0.up, true);
  assert.equal(network.enp1s0f0np0.speedGbps, 200);
  assert.equal(network.enp1s0f0np0.dropped, 3);
  assert.equal(network.enp1s0f1np1.available, false);
  assert.equal(network.enP2p1s0f1np1.available, false);
});

test("engine names come only from metric prefixes and known process or image names", () => {
  assert.equal(metricsEngine(parsePrometheus("vllm:num_requests_running 0\n")), "vLLM");
  assert.equal(metricsEngine(parsePrometheus("sglang:num_running_reqs 2\n")), "SGLang");
  assert.equal(metricsEngine(parsePrometheus("tensorfold:requests_running 1\n")), "TensorFold");
  assert.equal(metricsEngine(parsePrometheus("process_start_time_seconds 1\n")), null);
  assert.equal(knownEngine("sglang::scheduler_TP0"), "SGLang");
  assert.equal(knownEngine("lmsysorg/sglang:spark"), "SGLang");
  assert.equal(knownEngine("vllm/vllm-openai:latest"), "vLLM");
  assert.equal(knownEngine("ollama"), "Ollama");
  assert.equal(knownEngine("tensorfold"), "TensorFold");
  assert.equal(knownEngine("python3"), null);
});

test("SGLang metrics are summed into the vLLM names the collector reads", async () => {
  const { normalizeSglangMetrics } = await import("../lib/collectors.mjs");
  const text = [
    'sglang:num_running_reqs{model_name="example-model",tp_rank="0"} 3',
    'sglang:num_queue_reqs{model_name="example-model",tp_rank="0"} 1',
    'sglang:token_usage{model_name="example-model",tp_rank="0"} 0.25',
    'sglang:generation_tokens_total{is_streaming="false",model_name="example-model"} 100',
    'sglang:generation_tokens_total{is_streaming="true",model_name="example-model"} 50',
    'sglang:prompt_tokens_total{model_name="example-model"} 1000',
    'sglang:cached_tokens_total{cache_source="device",model_name="example-model"} 400',
    'sglang:time_to_first_token_seconds_bucket{is_streaming="false",le="1.0"} 2',
    'sglang:time_to_first_token_seconds_bucket{is_streaming="true",le="1.0"} 1',
    'sglang:time_to_first_token_seconds_count{is_streaming="false"} 2',
    'sglang:time_to_first_token_seconds_count{is_streaming="true"} 1',
    'sglang:time_to_first_token_seconds_sum{is_streaming="false"} 1.5',
    'sglang:time_to_first_token_seconds_sum{is_streaming="true"} 0.5',
  ].join("\n");
  const metrics = parsePrometheus(text);
  assert.equal(metricsEngine(metrics), "SGLang");
  normalizeSglangMetrics(metrics);
  assert.equal(metricValue(metrics, "vllm:num_requests_running"), 3);
  assert.equal(metricValue(metrics, "vllm:num_requests_waiting"), 1);
  assert.equal(metricValue(metrics, "vllm:kv_cache_usage_perc"), 0.25);
  assert.equal(metricValue(metrics, "vllm:generation_tokens_total"), 150);
  assert.equal(metricValue(metrics, "vllm:prompt_tokens_by_source_total", { source: "local_cache_hit" }), 400);
  assert.equal(metricValue(metrics, "vllm:prompt_tokens_by_source_total", { source: "local_compute" }), 600);
  assert.equal(metricValue(metrics, "vllm:prefix_cache_queries_total"), 1000);
  assert.equal(metricValue(metrics, "vllm:prefix_cache_hits_total"), 400);
  assert.equal(metricValue(metrics, "vllm:request_prefill_time_seconds_count"), 3);
  assert.equal(metricValue(metrics, "vllm:request_prefill_time_seconds_sum"), 2);
  assert.equal(metricValue(metrics, "vllm:time_to_first_token_seconds_bucket", { le: "1.0" }), 3);
  assert.equal(resolveModelIdentity(metrics).modelName, "example-model");
});

test("SGLang inter-token latency stands in for TPOT and its accept-rate gauge for spec acceptance", async () => {
  const { normalizeSglangMetrics, speculativeAcceptancePercent } = await import("../lib/collectors.mjs");
  const text = [
    'sglang:num_running_reqs{model_name="example-model",tp_rank="0"} 1',
    'sglang:inter_token_latency_seconds_bucket{is_streaming="true",le="0.02"} 90',
    'sglang:inter_token_latency_seconds_bucket{is_streaming="true",le="0.04"} 100',
    'sglang:inter_token_latency_seconds_bucket{is_streaming="true",le="+Inf"} 100',
    'sglang:inter_token_latency_seconds_count{is_streaming="true"} 100',
    'sglang:inter_token_latency_seconds_sum{is_streaming="true"} 1.8',
    'sglang:spec_accept_rate{model_name="example-model",tp_rank="0"} 0.335',
  ].join("\n");
  const metrics = normalizeSglangMetrics(parsePrometheus(text));
  assert.equal(metricValue(metrics, "vllm:request_time_per_output_token_seconds_count"), 100);
  assert.equal(metricValue(metrics, "vllm:request_time_per_output_token_seconds_bucket", { le: "0.04" }), 100);
  assert.ok(Math.abs(speculativeAcceptancePercent(metrics) - 33.5) < 1e-9);
  // No speculative decoding at all reads as unknown, not as a 0% acceptance.
  assert.equal(speculativeAcceptancePercent(parsePrometheus("vllm:num_requests_running 0\n")), null);
});

test("a local node runs the collector with bash directly; any other node goes over SSH", () => {
  assert.deepEqual(collectorCommand({ local: true, host: "local" }), { command: "bash", args: ["-s"], label: "local collector" });
  const remote = collectorCommand({ host: "spark-2" });
  assert.equal(remote.command, "ssh");
  // Never prompt, and the host is its own argument right before the remote command, never part of a shell string.
  assert.deepEqual(remote.args.slice(0, 2), ["-o", "BatchMode=yes"]);
  assert.deepEqual(remote.args.slice(-2), ["spark-2", "bash -s"]);
});

test("local collection runs on this machine and leaves what it cannot read unknown instead of failing", async () => {
  const node = await collectNode({ id: "1", name: "this", host: "local", local: true, interfaces: ["spkmissing0"] });
  assert.equal(node.ok, true, node.error ?? "");
  assert.equal(node.local, true);
  assert.equal(typeof node.hostname, "string");
  assert.ok(node.hostname.length > 0);
  // On a machine without nvidia-smi, /proc or systemd (e.g. macOS) these stay null, never a made-up zero.
  for (const value of [node.gpu.utilization, node.gpu.temperature, node.memory.totalBytes, node.memory.availableBytes, node.disk.availableBytes]) {
    assert.ok(value === null || Number.isFinite(value), `unexpected value ${value}`);
  }
  assert.equal(node.memory.usedBytes === null, node.memory.totalBytes === null || node.memory.availableBytes === null);
  assert.equal(node.network.spkmissing0.available, false);
});

test("GPU memory uses reported GB10 system memory or discrete framebuffer readings, never the hostname", async () => {
  const system = { totalBytes: 128 * 1024 ** 3, availableBytes: 16 * 1024 ** 3, usedBytes: 112 * 1024 ** 3 };
  assert.deepEqual(parseGpuMemory("NVIDIA GB10", "[N/A]", "[N/A]", system), { kind: "unified", ...system });
  const unknown = { kind: null, totalBytes: null, availableBytes: null, usedBytes: null };
  for (const name of ["", "Unknown GPU", "Jetson Thor"]) assert.deepEqual(parseGpuMemory(name, "[N/A]", "[N/A]", system), unknown);
  // Captured RTX framebuffer capacity is MiB.
  const discrete = parseGpuMemory("NVIDIA GeForce RTX 5090", "0", "32607", system);
  assert.deepEqual(discrete, { kind: "discrete", totalBytes: 32607 * 1048576, usedBytes: 0, availableBytes: 32607 * 1048576 });
  for (const used of ["[N/A]", "", "-1", "40000"]) {
    assert.deepEqual(parseGpuMemory("NVIDIA GeForce RTX", used, "32607", system), { kind: "discrete", totalBytes: 32607 * 1048576, usedBytes: null, availableBytes: null });
  }
  assert.deepEqual(parseGpuMemory("NVIDIA GeForce RTX", "1", "0", system), unknown);
  const gpu = "0, 39, 12.16, 300, P8, Not Active, Not Active, 0, 32607, NVIDIA GeForce RTX 5090, Example";
  const node = await withFakeNvidiaSmi(`case "$*" in *compute-apps*) exit 0 ;; *memory.used,memory.total,name*) echo "${gpu}" ;; *) exit 1 ;; esac`, () =>
    collectNode({ id: "1", name: "GB10-name-is-not-hardware", host: "local", local: true }));
  assert.equal(node.ok, true, node.error ?? "");
  assert.deepEqual(node.gpu.memory, discrete);
  for (const status of ["timeout", "stuck", "error"]) {
    const unified = { ok: true, gpu: { status, memory: { ...unknown } }, memory: system };
    applyGpuMemoryFallback(unified, "unified");
    assert.deepEqual(unified.gpu.memory, { kind: "unified", ...system });
    const separate = { ok: true, gpu: { status, memory: { ...unknown } }, memory: system };
    applyGpuMemoryFallback(separate, "discrete");
    assert.deepEqual(separate.gpu.memory, { ...unknown, kind: "discrete" });
  }
  const unobserved = { ok: true, gpu: { status: "timeout", memory: { ...unknown } }, memory: system };
  applyGpuMemoryFallback(unobserved, null);
  assert.deepEqual(unobserved.gpu.memory, unknown);
});

// A fake command on PATH (nvidia-smi, ssh), so the collector's handling of hung or failing commands runs on any
// machine. With onlyFake, PATH holds nothing else, so a command that is not faked cannot be found at all.
async function withFakeCommand(name, body, run, { onlyFake = false } = {}) {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = mkdtempSync(path.join(os.tmpdir(), `spark-scope-fake-${name}-`));
  writeFileSync(path.join(directory, name), `#!/bin/sh\n${body}\n`);
  chmodSync(path.join(directory, name), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = onlyFake ? directory : `${directory}:${savedPath}`;
  try {
    return await run();
  } finally {
    process.env.PATH = savedPath;
    rmSync(directory, { recursive: true, force: true });
  }
}
const withFakeNvidiaSmi = (body, run) => withFakeCommand("nvidia-smi", body, run);

// A fake journalctl, with a pass-through timeout so this also runs where coreutils' timeout is missing (macOS).
async function withFakeJournal(body, run) {
  return withFakeCommand("journalctl", body, () => withFakeCommand("timeout", 'shift; exec "$@"', run));
}

test("kernel errors from before a reboot are counted: the journal is read across boots, not with -k", async () => {
  const line = "1790990000.000000 spark-1 kernel: NVRM: Xid (PCI:0000:01:00): 79, GPU has fallen off the bus.";
  // Like journalctl: -k implies the current boot, where this error is not; the kernel transport match reaches it.
  const node = await withFakeJournal(`case " $* " in *" -k "*) exit 1 ;; *_TRANSPORT=kernel*) echo "${line}" ;; *) exit 1 ;; esac`, () =>
    collectNode({ id: "1", name: "this", host: "local", local: true }));
  assert.equal(node.kernelEvents.status, "ok");
  assert.equal(node.kernelEvents.xid, 1);
  assert.match(node.kernelEvents.lastMessage, /fallen off the bus/);
});

test("a journal that shows no kernel lines (no access, only the account's own journal) reads as unavailable, not as 0 errors", async () => {
  // journalctl -q without access opens only the user's journal: no matches (exit 1), and the check prints nothing.
  const node = await withFakeJournal('case "$*" in *-g*) exit 1 ;; *) exit 0 ;; esac', () =>
    collectNode({ id: "1", name: "this", host: "local", local: true }));
  assert.equal(node.kernelEvents.status, "unavailable");
  assert.equal(node.kernelEvents.available, false);
});

test("a failed unit whose file is gone is not counted and does not leave the node degraded", async () => {
  const systemctl = (failed) => `case "$1" in is-system-running) echo degraded ;; --failed) printf '%s\\n' ${failed} ;; esac`;
  const gone = "'snap-thunderbird-1261.mount not-found failed failed snap-thunderbird-1261.mount'";
  const real = "'nginx.service loaded failed failed A high performance web server'";
  const stale = await withFakeCommand("systemctl", systemctl(gone), () => collectNode({ id: "1", name: "this", host: "local", local: true }));
  assert.equal(stale.systemState, "running");
  assert.equal(stale.failedUnits, 0);
  const mixed = await withFakeCommand("systemctl", systemctl(`${gone} ${real}`), () => collectNode({ id: "1", name: "this", host: "local", local: true }));
  assert.equal(mixed.systemState, "degraded");
  assert.equal(mixed.failedUnits, 1);
});

test("a server that nvidia-smi names after the Python interpreter is named by its launcher script", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  // A console-script launcher: the kernel names the process after the script, as with `tensorfold serve`.
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-launcher-"));
  writeFileSync(path.join(directory, "tensorfold"), `#!/bin/sh\n${uniqueSleep()}\n`);
  chmodSync(path.join(directory, "tensorfold"), 0o755);
  const { spawn } = await import("node:child_process");
  const server = spawn(path.join(directory, "tensorfold"), [], { stdio: "ignore", detached: true });
  try {
    const gpu = "10, 40, 20, 1000, P0, Not Active, Not Active";
    const node = await withFakeNvidiaSmi(`case "$*" in *compute-apps*) echo "${server.pid}, /opt/venv/bin/python3, 1024" ;; *) echo "${gpu}" ;; esac`, () =>
      collectNode({ id: "1", name: "this", host: "local", local: true }));
    assert.equal(node.ok, true, node.error ?? "");
    assert.equal(node.inference.processName, "/opt/venv/bin/python3");
    assert.equal(node.inference.engine, "TensorFold");
  } finally {
    process.kill(-server.pid, "SIGKILL"); // the launcher and its sleep
    rmSync(directory, { recursive: true, force: true });
  }
});

// A sleep duration unique to this run, so a parallel test run cannot be mistaken for a leftover of this one.
const uniqueSleep = () => `sleep 27.${process.pid}${Math.floor(Math.random() * 1e6)}`;

// Processes matching pattern that are still alive after up to 3 s (a killed process can take a moment to be reaped).
async function leftover(pattern) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const found = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout.trim();
    if (!found) return "";
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return spawnSync("pgrep", ["-fl", pattern], { encoding: "utf8" }).stdout.trim();
}

test("a hung nvidia-smi costs only the GPU readings and leaves no process behind", async () => {
  const hung = uniqueSleep();
  const node = await withFakeNvidiaSmi(`exec ${hung}`, async () => {
    const started = Date.now();
    const result = await collectNode({ id: "1", name: "this", host: "local", local: true });
    // Well inside the 4.5 s poll budget: the GPU query gave up on its own instead of hitting the poll timeout.
    assert.ok(Date.now() - started < 4400, "the poll waited for the hung command");
    return result;
  });
  assert.equal(node.ok, true, node.error ?? "");
  assert.equal(node.incomplete, false);
  assert.equal(node.gpu.available, false);
  assert.equal(node.gpu.status, "timeout");
  assert.equal(node.gpu.temperature, null);
  assert.ok(node.hostname.length > 0, "the rest of the node was still read");
  assert.equal(await leftover(hung), "");
});

test("a failing nvidia-smi is reported as an error, not as a healthy node with no data", async () => {
  const node = await withFakeNvidiaSmi("echo 'Failed to initialize NVML' >&2; exit 9", () =>
    collectNode({ id: "1", name: "this", host: "local", local: true }));
  assert.equal(node.ok, true, node.error ?? "");
  assert.equal(node.gpu.available, false);
  assert.equal(node.gpu.status, "error");
});

test("a poll cut short by the time limit keeps what arrived and stops the whole process group", async () => {
  const hung = uniqueSleep();
  const node = await withFakeNvidiaSmi(`exec ${hung}`, () =>
    collectNode({ id: "1", name: "this", host: "local", local: true }, { timeoutMs: 700 }));
  assert.equal(node.ok, true);
  assert.equal(node.incomplete, true);
  assert.match(node.error, /timed out after 700 ms/);
  assert.ok(node.hostname.length > 0);
  assert.equal(node.gpu.available, false);
  assert.equal(await leftover(hung), "");
});

// A local stand-in for an inference server's /health, /metrics and /v1/models. setHealth gives /health a JSON body.
async function withFakeEngine(metricsText, run) {
  const http = await import("node:http");
  let body = metricsText;
  let health = null;
  let models = [{ id: "example-model" }];
  const server = http.createServer((request, response) => {
    if (request.url === "/metrics") { response.writeHead(200, { "content-type": "text/plain" }); response.end(body); return; }
    if (request.url === "/v1/models") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: models })); return; }
    if (request.url === "/health" && health) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(health)); return; }
    response.writeHead(200).end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, (next) => { body = next; }, (next) => { health = next; }, (next) => { models = next; });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("vLLM data-parallel engines are added up, and metrics an engine does not export stay unknown", async () => {
  const { InferenceCollector } = await import("../lib/collectors.mjs");
  const engines = (output) => [
    `vllm:num_requests_running{engine="0",model_name="example-model"} 2`,
    `vllm:num_requests_running{engine="1",model_name="example-model"} 5`,
    `vllm:num_requests_waiting{engine="0",model_name="example-model"} 1`,
    `vllm:num_requests_waiting{engine="1",model_name="example-model"} 0`,
    `vllm:generation_tokens_total{engine="0",model_name="example-model"} ${output[0]}`,
    `vllm:generation_tokens_total{engine="1",model_name="example-model"} ${output[1]}`,
    `vllm:prompt_tokens_total{engine="0",model_name="example-model"} 4000`,
    `vllm:prompt_tokens_total{engine="1",model_name="example-model"} 6000`,
    `vllm:request_success_total{engine="0",finished_reason="stop",model_name="example-model"} 10`,
    `vllm:request_success_total{engine="1",finished_reason="stop",model_name="example-model"} 30`,
    `vllm:time_to_first_token_seconds_bucket{engine="0",le="0.1"} 99`,
    `vllm:time_to_first_token_seconds_bucket{engine="0",le="2.5"} 100`,
    `vllm:time_to_first_token_seconds_bucket{engine="0",le="+Inf"} 100`,
    `vllm:time_to_first_token_seconds_bucket{engine="1",le="0.1"} 0`,
    `vllm:time_to_first_token_seconds_bucket{engine="1",le="2.5"} 100`,
    `vllm:time_to_first_token_seconds_bucket{engine="1",le="+Inf"} 100`,
  ].join("\n");
  await withFakeEngine(engines([1000, 3000]), async (base, setMetrics) => {
    const collector = new InferenceCollector(base);
    const first = await collector.collect();
    assert.equal(first.ok, true, first.error ?? "");
    assert.equal(first.generationTokensTotal, 4000);
    assert.equal(first.promptTokensTotal, 10000);
    assert.equal(first.completedRequestsTotal, 40);
    assert.equal(first.runningRequests, 7);
    assert.equal(first.waitingRequests, 1);
    // Half of all first tokens took longer than 0.1 s, so p95 lies inside the 0.1–2.5 s bucket, not at engine 0's 0.1 s.
    assert.ok(Math.abs(first.ttftP95Seconds - (0.1 + 2.4 * (91 / 101))) < 1e-9, String(first.ttftP95Seconds));
    // Engine addresses and paths stay on the server side of the reading's public form (see public-state.mjs).
    assert.equal(first.baseUrl, undefined);
    // One sample cannot give a rate, and these metrics are simply not exported here.
    assert.equal(first.outputTokensPerSecond, null);
    for (const key of ["promptComputeTokensTotal", "promptCacheTokensTotal", "kvCachePercent", "prefixCacheHitPercent", "speculativeAcceptancePercent"]) {
      assert.equal(first[key], null, key);
    }
    collector.previous.at -= 2000;
    setMetrics(engines([1100, 3300]));
    const second = await collector.collect();
    assert.ok(second.outputTokensPerSecond > 100 && second.outputTokensPerSecond < 300, String(second.outputTokensPerSecond));
  });
});

test("process memory nvidia-smi does not report stays unknown", () => {
  assert.equal(parseInferenceProcess("1234,python3,[N/A],S").memoryBytes, null);
  assert.equal(parseInferenceProcess("1234,python3,1024,S").memoryBytes, 1024 * 1024 * 1024);
});

test("SGLang's live decode rate comes from its throughput gauge while requests run, not from the finish-time counter", async () => {
  const { sglangDecodeRate, InferenceCollector } = await import("../lib/collectors.mjs");
  const gauges = (throughput, running) => parsePrometheus(`sglang:gen_throughput{tp_rank="0"} ${throughput}\nsglang:num_running_reqs{tp_rank="0"} ${running}\n`);
  assert.equal(sglangDecodeRate(gauges(84.3, 2), 0), 84.3);
  // The gauge keeps its last value when idle; with nothing running there is no decode.
  assert.equal(sglangDecodeRate(gauges(84.3, 0), 0), 0);
  // Without the gauge (older SGLang) the counter's rate is all there is.
  assert.equal(sglangDecodeRate(parsePrometheus("sglang:num_running_reqs 1\n"), 12.5), 12.5);

  // While a request streams, generation_tokens_total does not move; the reading still shows the decode rate.
  const engine = (generated) => [
    `sglang:generation_tokens_total{is_streaming="true",model_name="example-model"} ${generated}`,
    `sglang:prompt_tokens_total{is_streaming="true",model_name="example-model"} 5000`,
    `sglang:num_requests_total{is_streaming="true",model_name="example-model"} 7`,
    `sglang:num_running_reqs{model_name="example-model",tp_rank="0"} 1`,
    `sglang:gen_throughput{model_name="example-model",tp_rank="0"} 79.8`,
  ].join("\n");
  await withFakeEngine(engine(1000), async (base) => {
    const collector = new InferenceCollector(base);
    await collector.collect();
    collector.previous.at -= 2000;
    const streaming = await collector.collect();
    assert.equal(streaming.engine, "SGLang");
    assert.equal(streaming.generationTokensTotal, 1000);
    assert.equal(streaming.outputTokensPerSecond, 79.8);
  });
});

// TensorFold's scrape as its server renders it: its own families, then the same readings under vLLM's names.
function tensorfoldScrape({ finished = 50, prompt = 1000, streams = [0.5, 0.25] } = {}) {
  const histogram = (name, buckets, sum, count) => [
    `# TYPE tensorfold:${name} histogram`,
    ...buckets.map(([le, value]) => `tensorfold:${name}_bucket{le="${le}"} ${value}`),
    `tensorfold:${name}_sum ${sum}`,
    `tensorfold:${name}_count ${count}`,
  ];
  const ttft = [["0.1", 1], ["0.5", 3], ["1", 4], ["+Inf", 4]];
  return [
    "# HELP tensorfold:requests_running Requests in prefill or decode.",
    "# TYPE tensorfold:requests_running gauge",
    `tensorfold:requests_running ${streams.length}`,
    "tensorfold:requests_waiting 1",
    `tensorfold:prompt_tokens_total ${prompt}`,
    `tensorfold:generation_tokens_total ${finished}`,
    ...streams.map((ratio, index) => `tensorfold:kv_cache_usage_ratio{pool="${index}"} ${ratio}`),
    "tensorfold:mtp_drafted_total 200",
    "tensorfold:mtp_accepted_total 150",
    ...histogram("time_to_first_token_seconds", ttft, 1.6, 4),
    `tensorfold:num_requests_running ${streams.length}`,
    "tensorfold:num_requests_waiting 1",
    ...streams.map((ratio, index) => `tensorfold:kv_cache_usage_perc{stream="${index}"} ${ratio}`),
    "tensorfold:spec_decode_num_draft_tokens_total 200",
    "tensorfold:spec_decode_num_accepted_tokens_total 150",
    ...histogram("request_decode_time_seconds", [["1", 2], ["5", 4], ["+Inf", 4]], 9, 4),
  ].join("\n") + "\n";
}

test("TensorFold's vLLM-named readings fill the same fields, and its /health adds the cache and prefill counters", async () => {
  const { normalizeTensorfoldMetrics } = await import("../lib/collectors.mjs");
  const metrics = parsePrometheus(tensorfoldScrape());
  assert.equal(metricsEngine(metrics), "TensorFold");
  normalizeTensorfoldMetrics(metrics, { ok: true, requests_total: 4, prompt_tokens_total: 1000, cached_tokens_total: 600, prefill_seconds_total: 2, completion_tokens_total: 80 });
  assert.equal(metricValue(metrics, "vllm:num_requests_running"), 2);
  assert.equal(metricValue(metrics, "vllm:num_requests_waiting"), 1);
  assert.equal(metricValue(metrics, "vllm:generation_tokens_total"), 50);
  assert.equal(metricValue(metrics, "vllm:spec_decode_num_accepted_tokens_total"), 150);
  assert.equal(metricValue(metrics, "vllm:time_to_first_token_seconds_bucket", { le: "0.5" }), 3);
  assert.equal(metricValue(metrics, "vllm:prompt_tokens_by_source_total", { source: "local_cache_hit" }), 600);
  assert.equal(metricValue(metrics, "vllm:prompt_tokens_by_source_total", { source: "local_compute" }), 400);
  assert.equal(metricValue(metrics, "vllm:prefix_cache_hits_total"), 600);
  assert.equal(metricValue(metrics, "vllm:request_prefill_time_seconds_sum"), 2);
  assert.equal(metricValue(metrics, "vllm:request_prefill_time_seconds_count"), 4);

  // The Mac server's /health has no such counters: the cache and prefill fields stay absent, not zero.
  const mac = normalizeTensorfoldMetrics(parsePrometheus(tensorfoldScrape()), { ok: true });
  for (const name of ["vllm:prompt_tokens_by_source_total", "vllm:prefix_cache_queries_total", "vllm:request_prefill_time_seconds_count"]) {
    assert.equal(mac.has(name), false, name);
  }
});

test("TensorFold's output rate counts reply tokens while they stream; the ledger keeps the finished-request counter", async () => {
  const { InferenceCollector } = await import("../lib/collectors.mjs");
  const health = (completion) => ({
    ok: true, backend: "tensorfold", busy: true, requests_running: 2, requests_total: 4, prompt_tokens_total: 1000,
    completion_tokens_total: completion, cached_tokens_total: 600, prefill_seconds_total: 2, decode_seconds_total: 9,
  });
  await withFakeEngine(tensorfoldScrape(), async (base, setMetrics, setHealth) => {
    setHealth(health(80));
    const collector = new InferenceCollector(base);
    const first = await collector.collect();
    assert.equal(first.ok, true, first.error ?? "");
    assert.equal(first.engine, "TensorFold");
    assert.equal(first.generationTokensTotal, 50);
    assert.equal(first.runningRequests, 2);
    assert.equal(first.kvCachePercent, 37.5);
    assert.equal(first.prefixCacheHitPercent, 60);
    assert.equal(first.speculativeAcceptancePercent, 75);
    assert.ok(first.ttftP95Seconds > 0.5 && first.ttftP95Seconds <= 1, String(first.ttftP95Seconds));
    // No per-token latency histogram: TPOT stays unknown.
    assert.equal(first.tpotP95Seconds, null);

    // Two replies stream for 2 s: the finished-request counter stands still, /health's count moves.
    collector.previous.at -= 2000;
    setHealth(health(280));
    const streaming = await collector.collect();
    assert.equal(streaming.generationTokensTotal, 50);
    assert.ok(Math.abs(streaming.outputTokensPerSecond - 100) < 5, String(streaming.outputTokensPerSecond));

    // Without /health's counters (the Mac server), the rate comes from the finished-request counter.
    setHealth(null);
    collector.previous.at -= 2000;
    setMetrics(tensorfoldScrape({ finished: 250 }));
    const mac = await collector.collect();
    assert.equal(mac.prefixCacheHitPercent, null);
    assert.ok(Math.abs(mac.outputTokensPerSecond - 100) < 5, String(mac.outputTokensPerSecond));
  });
});

test("TensorFold's metrics carry no model name, so a model switch is read from the model list on the next poll", async () => {
  const { InferenceCollector } = await import("../lib/collectors.mjs");
  await withFakeEngine(tensorfoldScrape(), async (base, setMetrics, setHealth, setModels) => {
    const collector = new InferenceCollector(base);
    assert.equal((await collector.collect()).modelName, "example-model");
    // Restarted into another model within seconds: the ledger must not book the new run under the old name.
    setModels([{ id: "other-model" }]);
    setMetrics(tensorfoldScrape({ finished: 10, prompt: 100 }));
    assert.equal((await collector.collect()).modelName, "other-model");
  });
});

test("response bodies the collector does not read are released, so connections are reused", async () => {
  const { createServer } = await import("node:http");
  const { InferenceCollector } = await import("../lib/collectors.mjs");
  // A large /health page (as some proxies serve) and a failing /v1/models: neither body is read.
  const big = "x".repeat(512 * 1024);
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.url === "/health") return response.end(big);
    if (request.url === "/metrics") return response.end('vllm:num_requests_running{model_name="example-model"} 0\nvllm:generation_tokens_total{model_name="example-model"} 1\n');
    response.writeHead(500).end(big);
  });
  server.on("connection", (socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const collector = new InferenceCollector(`http://127.0.0.1:${server.address().port}`);
    for (let i = 0; i < 20; i += 1) {
      collector.modelsFetchedAt = 0;
      const reading = await collector.collect();
      assert.equal(reading.ok, true, reading.error ?? "");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const open = [...sockets].filter((socket) => !socket.destroyed).length;
    // Unread bodies kept their connections open (about 40 after 20 polls); released ones are closed or reused.
    assert.ok(open <= 6, `${open} of ${sockets.size} connections still open after 20 polls`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an SSH login that fails reports the node as unreachable, and the browser only gets a short reason", async () => {
  const { publicNode } = await import("../lib/public-state.mjs");
  const node = await withFakeCommand("ssh", `cat >/dev/null\necho "admin@10.0.0.6: Permission denied (publickey)." >&2\nexit 255`, () => collectNode({ id: "9", name: "spark-9", host: "spark-9" }));
  assert.equal(node.ok, false);
  assert.equal(node.collected, true);
  assert.match(node.error, /Permission denied/);
  assert.equal(publicNode(node).error, "SSH authentication failed");
});

test("an SSH session that hangs is cut off at the poll limit and leaves no process behind", async () => {
  const hung = uniqueSleep();
  const node = await withFakeCommand("ssh", `exec ${hung}`, () => collectNode({ id: "9", name: "spark-9", host: "spark-9" }, { timeoutMs: 600 }));
  assert.equal(node.ok, false);
  assert.match(node.error, /spark-9: timed out after 600 ms/);
  assert.equal(await leftover(hung.slice(6)), "");
});

test("a missing ssh binary is reported instead of crashing the poll", async () => {
  const node = await withFakeCommand("unrelated", "exit 0", () => collectNode({ id: "9", name: "spark-9", host: "spark-9" }), { onlyFake: true });
  assert.equal(node.ok, false);
  assert.match(node.error, /ENOENT/);
});

test("recent latency comes from histogram differences over the last 5 minutes and restarts with the engine", () => {
  const buckets = (counts) => [0.1, 0.5, 1, Infinity].map((le, index) => ({ le, count: counts[index] }));
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
  assert.deepEqual(bucketsSince(buckets([3, 8, 10, 10]), buckets([1, 2, 2, 2])).map((b) => b.count), [2, 6, 8, 8]);
  assert.equal(bucketsSince(buckets([0, 1, 1, 1]), buckets([1, 2, 2, 2])), null, "a count went down: the engine restarted");
  assert.equal(bucketsSince(buckets([1, 1, 1, 1]), buckets([1, 1, 1, 1]).slice(0, 3)), null, "different bounds");

  const MIN = 60_000;
  const recent = new RecentHistograms(5 * MIN);
  recent.add(0, { ttft: buckets([1000, 1000, 1000, 1000]) });
  assert.equal(recent.quantile("ttft", 0.95), null, "one snapshot is not a window");
  assert.equal(recent.windowSeconds, 0);
  // Two minutes later 10 more requests finished, all slow (0.5 to 1 s), while the engine's own p95 still says fast.
  recent.add(2 * MIN, { ttft: buckets([1000, 1000, 1010, 1010]) });
  assert.equal(recent.windowSeconds, 120);
  near(recent.quantile("ttft", 0.95), 0.975);
  near(bucketsQuantile(buckets([1000, 1000, 1010, 1010]), 0.95), 0.09595);
  // Snapshots older than the window drop out, keeping the newest one at or before its start (minute 4).
  for (let minute = 3; minute <= 9; minute++) recent.add(minute * MIN, { ttft: buckets([1000 + minute, 1000 + minute, 1010 + minute, 1010 + minute]) });
  assert.equal(recent.windowSeconds, 300);
  near(recent.quantile("ttft", 0.95), 0.095);
  // Nothing finished in the window: no value, not zero.
  recent.add(10 * MIN, { ttft: buckets([1009, 1009, 1019, 1019]) });
  recent.add(15 * MIN, { ttft: buckets([1009, 1009, 1019, 1019]) });
  assert.equal(recent.quantile("ttft", 0.95), null);
  // An engine restart starts over from the new counts.
  recent.add(16 * MIN, { ttft: buckets([2, 2, 2, 2]) });
  assert.equal(recent.windowSeconds, 0);
  assert.equal(recent.quantile("ttft", 0.95), null);
  recent.add(17 * MIN, { ttft: buckets([2, 3, 4, 4]) });
  near(recent.quantile("ttft", 0.95), 0.95);
  // A gap longer than the window (the server could not reach the engine) starts over as well.
  recent.add(30 * MIN, { ttft: buckets([2, 3, 9, 9]) });
  assert.equal(recent.windowSeconds, 0);
  // So does a histogram that appears or disappears.
  recent.add(31 * MIN, { ttft: buckets([2, 3, 9, 9]), tpot: buckets([1, 1, 1, 1]) });
  assert.equal(recent.windowSeconds, 0);
});
