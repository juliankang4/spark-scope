import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

test("engine names come only from metric prefixes and known process or image names", async () => {
  assert.equal(metricsEngine(parsePrometheus("vllm:num_requests_running 0\n")), "vLLM");
  assert.equal(metricsEngine(parsePrometheus("sglang:num_running_reqs 2\n")), "SGLang");
  assert.equal(metricsEngine(parsePrometheus("tensorfold:requests_running 1\n")), "TensorFold");
  assert.equal(metricsEngine(parsePrometheus("process_start_time_seconds 1\n")), null);
  assert.equal(knownEngine("sglang::scheduler_TP0"), "SGLang");
  assert.equal(knownEngine("lmsysorg/sglang:spark"), "SGLang");
  assert.equal(knownEngine("vllm/vllm-openai:latest"), "vLLM");
  assert.equal(knownEngine("ollama"), "Ollama");
  assert.equal(knownEngine("tensorfold"), "TensorFold");
  assert.equal(knownEngine("strata"), "Strata");
  assert.equal(knownEngine("omlx-server"), "oMLX");
  assert.equal(parseInferenceProcess("42, python3, 100, S, omlx").engine, "oMLX");
  assert.equal(knownEngine("python3"), null);
  const { readEngineMetrics } = await import("../lib/engines/index.mjs");
  for (const [engine, prefix] of [["vLLM", "vllm"], ["SGLang", "sglang"], ["TensorFold", "tensorfold"]]) {
    const metrics = parsePrometheus(`${prefix}:num_requests_running{model_name="example-model"} 1\n${prefix}:prompt_tokens_total 25\n`);
    const before = structuredClone([...metrics]);
    const first = readEngineMetrics(engine, metrics);
    assert.deepEqual(readEngineMetrics(engine, metrics), first);
    assert.deepEqual([...metrics], before, engine);
    assert.equal(metricsEngine(metrics), engine);
  }
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

test("node collector children do not inherit single-server or per-server credentials", async () => {
  const before = [process.env.SPARK_SCOPE_API_KEY, process.env.ENGINE_A_TOKEN];
  process.env.SPARK_SCOPE_API_KEY = process.env.ENGINE_A_TOKEN = "fixture-only-credential";
  try {
    await withFakeCommand("ssh", 'if [ -n "$SPARK_SCOPE_API_KEY$ENGINE_A_TOKEN" ]; then echo "credential inherited" >&2; exit 1; fi; echo "hostname|fixture-node"', async () => {
      const node = await collectNode({ host: "fixture-node" }, { apiKeyEnvNames: ["ENGINE_A_TOKEN"] });
      assert.equal(node.ok, true, node.error ?? "");
    });
  } finally {
    for (const [index, name] of ["SPARK_SCOPE_API_KEY", "ENGINE_A_TOKEN"].entries()) { if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index]; }
  }
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
  for (const name of ["Apple M1", "Apple M2 Max", "Apple M10 Ultra"]) assert.deepEqual(parseGpuMemory(name, "", "", system), { kind: "unified", ...system });
  const unknown = { kind: null, totalBytes: null, availableBytes: null, usedBytes: null };
  for (const name of ["", "Unknown GPU", "Jetson Thor", "Apple Intel GPU", "Apple Memory", "Apple M2-box"]) assert.deepEqual(parseGpuMemory(name, "[N/A]", "[N/A]", system), unknown);
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
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-fake-"));
  const commands = typeof name === "object" ? name : { [name]: body };
  for (const [command, script] of Object.entries(commands)) {
    writeFileSync(path.join(directory, command), `#!/bin/sh\n${script}\n`);
    chmodSync(path.join(directory, command), 0o755);
  }
  const savedPath = process.env.PATH;
  process.env.PATH = onlyFake ? directory : `${directory}:${savedPath}`;
  try {
    return await run();
  } finally {
    process.env.PATH = savedPath;
    rmSync(directory, { recursive: true, force: true });
  }
}
const withFakeNvidiaSmi = (body, run) => withFakeCommand({ uname: "echo Linux", "nvidia-smi": body }, null, run);

// A fake journalctl, with a pass-through timeout so this also runs where coreutils' timeout is missing (macOS).
async function withFakeJournal(body, run) {
  return withFakeCommand({ uname: "echo Linux", journalctl: body, timeout: 'shift; exec "$@"' }, null, run);
}

test("Darwin collection uses macOS commands on any test host, with pressure and missing readings", async () => {
  const commands = {
    uname: "echo Darwin",
    hostname: "echo test-node",
    date: "echo 1790646056",
    sysctl: `case "$2" in
      kern.boottime) echo '{ sec = 1790642456, usec = 923980 }' ;;
      hw.memsize) echo 34359738368 ;; hw.pagesize) echo 16384 ;;
      machdep.cpu.brand_string) echo 'Apple M1 Pro' ;;
      vm.swapusage) echo 'total = 1024.00M used = 307.12M free = 716.88M (encrypted)' ;;
      vm.loadavg) echo '{ 1.40 1.75 1.95 }' ;; hw.ncpu) echo 10 ;;
      kern.memorystatus_vm_pressure_level) echo 1 ;; kern.memorystatus_level) echo 85 ;;
    esac`,
    vm_stat: `printf '%s\\n' 'Mach Virtual Memory Statistics: (page size of 16384 bytes)' 'Anonymous pages: 554943.' 'Pages purgeable: 19673.' 'Pages wired down: 238561.' 'Pages occupied by compressor: 56530.'`,
    ioreg: `case "$*" in
      *IOAccelerator*) printf '%s\\n' '    "model" = "Apple M1 Pro"' '    "gpu-core-count" = 10' '    "PerformanceStatistics" = {"Device Utilization %"=99,"In use system memory"=1140359168,"Alloc system memory"=1872068608}' ;;
      *AppleSmartBattery*) printf '%s\\n' '+-o AppleSmartBattery <class AppleSmartBattery>' '    | "PowerTelemetryData" = {"SystemLoad"=4198}' '    | "CurrentCapacity" = 80' '    | "ExternalConnected" = Yes' ;;
    esac`,
    notifyutil: "echo 'com.apple.system.thermalpressurelevel 0'",
    df: `test "$*" = '-k /System/Volumes/Data' || exit 1; printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted' '/dev/disk1 971298980 249000000 720632152 24% /System/Volumes/Data'`,
    pgrep: `case "$*" in '-x omlx-server') echo 42 ;; esac`,
    ps: "echo S",
    footprint: "echo ' phys_footprint: 1448083456 B'",
    "nvidia-smi": "exit 9",
  };
  const poll = overrides => withFakeCommand({ ...commands, ...overrides }, null, () => collectNode({ id: "1", name: "GB10-is-not-hardware", host: "local", local: true }));
  const node = await poll({});
  assert.equal(node.ok, true, node.error ?? "");
  assert.equal(node.incomplete, false);
  assert.equal(node.platform, "darwin");
  assert.equal(node.uptimeSeconds, 3600);
  assert.equal(node.systemState, null);
  assert.equal(node.failedUnits, 0);
  assert.equal(node.gpu.status, "ok");
  assert.equal(node.gpu.utilization, 99);
  for (const field of ["temperature", "powerWatts", "clockMHz"]) assert.equal(node.gpu[field], null);
  assert.deepEqual(node.memory, { totalBytes: 34359738368, availableBytes: 34359738368 - (554943 - 19673 + 238561 + 56530) * 16384, usedBytes: (554943 - 19673 + 238561 + 56530) * 16384, swapUsedBytes: 1073741824 - 734085 * 1024, pressureLevel: 1, freePercent: 85, compressedBytes: 56530 * 16384 });
  assert.deepEqual(node.gpu.memory, { kind: "unified", totalBytes: node.memory.totalBytes, availableBytes: node.memory.availableBytes, usedBytes: node.memory.usedBytes, inUseBytes: 1140359168, allocatedBytes: 1872068608 });
  assert.equal(node.gpu.cores, 10);
  assert.deepEqual(node.power, { hasBattery: true, systemWatts: 4.198, batteryPercent: 80, onAC: true });
  assert.equal(node.disk.totalBytes, 971298980 * 1024);
  assert.equal(node.disk.availableBytes, 720632152 * 1024);
  assert.equal(node.disk.usedPercent, 24);
  assert.equal(node.inference.engine, "oMLX");
  assert.equal(node.inferenceProcessReady, true);
  assert.equal(node.processMemoryBytes, 1448083456);
  assert.deepEqual(node.cpu, { load1: 1.4, load5: 1.75, load15: 1.95, cores: 10 });
  assert.equal(node.kernelEvents.available, false);
  assert.deepEqual(node.network, {});
  for (let level = 0; level <= 4; level++) {
    const thermal = await poll({ notifyutil: `echo 'com.apple.system.thermalpressurelevel ${level}'` });
    assert.equal(thermal.thermalPressure, level);
    assert.equal(thermal.gpu.thermalSlowdown, level >= 2);
  }
  const missing = await poll({ ioreg: "exit 1", vm_stat: "exit 1", notifyutil: "exit 1", pgrep: "exit 1" });
  assert.equal(missing.ok, true);
  assert.equal(missing.gpu.available, false);
  assert.equal(missing.gpu.memory.kind, "unified");
  assert.equal(missing.gpu.memory.inUseBytes, null);
  assert.equal(missing.memory.availableBytes, null);
  assert.equal(missing.memory.compressedBytes, null);
  assert.equal(missing.thermalPressure, null);
  assert.equal(missing.power.systemWatts, null);
  assert.equal(missing.power.hasBattery, null);
  const desktop = await poll({ ioreg: 'exit 0' });
  assert.equal(desktop.power.hasBattery, false);
  assert.equal(missing.inferenceProcessUp, false);
  const inaccessible = await poll({ footprint: "exit 1", ps: "echo Z" });
  assert.equal(inaccessible.processMemoryBytes, null);
  assert.equal(inaccessible.inferenceProcessReady, false);
});

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
  const stale = await withFakeCommand({ uname: "echo Linux", systemctl: systemctl(gone) }, null, () => collectNode({ id: "1", name: "this", host: "local", local: true }));
  assert.equal(stale.systemState, "running");
  assert.equal(stale.failedUnits, 0);
  const mixed = await withFakeCommand({ uname: "echo Linux", systemctl: systemctl(`${gone} ${real}`) }, null, () => collectNode({ id: "1", name: "this", host: "local", local: true }));
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

test("llama-server is found by pgrep when the compute-apps list is empty", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
  const { spawn } = await import("node:child_process");
  await withFakeCommand("llama-server", uniqueSleep(), async () => {
    const server = spawn("llama-server", [], { stdio: "ignore", detached: true });
    await new Promise(resolve => server.once("spawn", resolve));
    try {
      const node = await withFakeNvidiaSmi('case "$*" in *compute-apps*) exit 0 ;; *) echo "0, 40, 10, 200, P8, Not Active, Not Active" ;; esac', () =>
        collectNode({ id: "1", name: "Test node", host: "local", local: true }));
      assert.equal(node.inference.pid, server.pid);
      assert.equal(node.inference.engine, "llama.cpp");
      assert.equal(node.inference.ready, true);
      assert.equal(node.processMemoryBytes, null);
    } finally {
      const exited = new Promise(resolve => server.once("exit", resolve));
      process.kill(-server.pid, "SIGKILL");
      await exited;
    }
  });
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

async function withFakeEngine(metricsText, run, { apiKey = null } = {}) {
  const http = await import("node:http");
  let body = metricsText;
  let health = null;
  let slots = null;
  let slotsStatus = 200;
  let slotsDelayMs = 0;
  let models = [{ id: "example-model" }];
  let modelsDelayMs = 0;
  const requested = [], responses = new Map();
  const server = http.createServer((request, response) => {
    requested.push(request.url);
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, apiKey ? `Bearer ${apiKey}` : undefined);
    if (responses.has(request.url)) {
      const { status, body, headers } = responses.get(request.url);
      response.writeHead(status, headers).end(typeof body === "string" ? body : JSON.stringify(body));
      return;
    }
    if (request.url === "/metrics") {
      assert.ok(["text/plain", "application/json"].includes(request.headers.accept));
      const json = request.headers.accept === "application/json";
      const content = typeof body === "string" ? body : json ? JSON.stringify(body.json) : body.text;
      response.writeHead(200, { "content-type": json ? "application/json" : "text/plain" }); response.end(content); return;
    }
    if (request.url === "/slots") {
      const status = slotsStatus, payload = JSON.stringify(slots);
      setTimeout(() => { response.writeHead(status, { "content-type": "application/json" }); response.end(payload); }, slotsDelayMs);
      return;
    }
    if (request.url === "/v1/models") {
      const payload = JSON.stringify({ data: models });
      setTimeout(() => { response.writeHead(200, { "content-type": "application/json" }); response.end(payload); requested.push("/v1/models replied"); }, modelsDelayMs);
      return;
    }
    if (request.url === "/health" && health) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(health)); return; }
    response.writeHead(200).end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, (next) => { body = next; }, (next) => { health = next; }, (next, delayMs = 0) => { models = next; modelsDelayMs = delayMs; }, (next, status = 200, delayMs = 0) => { slots = next; slotsStatus = status; slotsDelayMs = delayMs; }, requested,
      (path, status, body, headers = {}) => { responses.set(path, { status, body, headers }); });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("oMLX captured status keeps session averages separate from live speed and books each completed token once", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/omlx-v0.7.0.json", import.meta.url), "utf8"));
  const { InferenceCollector } = await import("../lib/collectors.mjs");
  const { UsageStore } = await import("../lib/usage-store.mjs");
  const { readOmlxMetrics } = await import("../lib/engines/omlx.mjs");
  const invalid = readOmlxMetrics({ ...fixture.cached, total_cached_tokens: 24000, avg_generation_tps: "46.2", avg_prefill_tps: -1 });
  assert.equal(invalid.promptComputeTotal, null);
  assert.equal(invalid.prefixCacheHitPercent, null);
  assert.equal(invalid.averageOutputTokensPerSecond, null);
  assert.equal(invalid.prefillTimeTotal, null);
  await withFakeEngine("", async (url, _setMetrics, setHealth, _setModels, _setSlots, requested, setResponse) => {
    setHealth(fixture.health);
    setResponse("/metrics", 404, { detail: "Not Found" });
    const collector = new InferenceCollector(url), ledger = new UsageStore(":memory:", { timeZone: "UTC" });
    const poll = async status => { setResponse("/api/status", 200, status); const reading = await collector.collect(); ledger.record(reading); return reading; };
    try {
      const idle = await poll(fixture.idle), running = await poll(fixture.running);
      assert.equal(idle.engine, "oMLX");
      assert.equal(idle.modelName, "example-model");
      assert.equal(running.runningRequests, 1);
      assert.equal(ledger.summary().allTime.total, 0);
      for (const reading of [idle, running, await poll(fixture.completed)]) {
        assert.equal(reading.ok, true);
        assert.equal(reading.outputTokensPerSecond, null);
        assert.equal(reading.reported.outputTokensPerSecond, false);
        assert.equal(reading.reported.averageOutputTokensPerSecond, true);
        assert.equal(reading.metricKinds.averageOutputTokensPerSecond, "sessionMean");
        assert.equal(reading.metricKinds.averagePromptTokensPerSecond, "sessionMean");
        for (const field of ["promptTokensPerSecond", "promptComputeTokensPerSecond"]) { assert.equal(reading[field], null); assert.equal(reading.reported[field], false); }
        for (const field of ["kvCachePercent", "ttftP95RecentSeconds", "tpotP95RecentSeconds", "speculativeAcceptancePercent", "promptCacheTokensPerSecond"]) assert.equal(reading.reported[field], false, field);
        for (const field of ["processStartedAt", "kvCachePercent", "ttftP95Seconds", "tpotP95Seconds", "ttftP95RecentSeconds", "tpotP95RecentSeconds", "prefillUpdatedAt"]) assert.equal(reading[field], null, field);
      }
      const cached = await poll(fixture.cached);
      assert.equal(cached.averageOutputTokensPerSecond, 46.2);
      assert.equal(cached.averagePromptTokensPerSecond, 2247);
      assert.equal(cached.ledgerModelName, "example-model");
      assert.equal(cached.promptTokensTotal, 23738);
      assert.equal(cached.promptComputeTokensTotal, 11962);
      assert.equal(cached.promptCacheTokensTotal, 11776);
      assert.equal(cached.prefixCacheHitPercent, 11776 / 23738 * 100);
      assert.equal(cached.completedRequestsTotal, 2);
      const totals = ledger.summary().allTime;
      await poll({ ...fixture.cached, models_loaded: 0, loaded_models: [] });
      const switched = await poll({ ...fixture.cached, loaded_models: ["another-model"] });
      assert.equal(switched.modelName, "example-model", "the default identifies server-wide totals even when another model is loaded");
      const several = await poll({ ...fixture.cached, models_loaded: 2, loaded_models: ["example-model", "another-model"] });
      assert.equal(several.modelName, null, "a multi-model snapshot must not borrow a discovered model name");
      assert.deepEqual(ledger.summary().allTime, totals, "TTL unload and model changes do not book the totals again");
      await poll({ ...fixture.cached, default_model: "another-default" });
      assert.deepEqual(ledger.summary().allTime, totals, "a changed default also keeps the server-wide ledger key");
      await poll(fixture.idle);
      assert.deepEqual(ledger.summary().allTime, totals, "a restart at zero does not subtract booked tokens");
      await poll(fixture.completed);
      const afterRestart = ledger.summary().allTime;
      assert.equal(afterRestart.input, 23738 + 11873);
      assert.equal(afterRestart.output, 2516 + 2500);
      assert.equal(afterRestart.requests, 3);
      const multi = new UsageStore(":memory:", { timeZone: "UTC" }), day = n => Date.UTC(2026, 9, n, 12);
      try {
        setResponse("/api/status", 200, fixture.idle);
        multi.record(await collector.collect(), day(1));
        for (const n of [2, 3]) {
          setResponse("/api/status", 200, { ...fixture.cached, models_loaded: 2, loaded_models: ["example-model", "another-model"], total_prompt_tokens: 23738 + (n - 2) * 1000, total_completion_tokens: 2516 + (n - 2) * 1000, total_requests: n });
          const reading = await collector.collect();
          assert.equal(reading.modelName, null);
          assert.equal(reading.ledgerModelName, "example-model");
          multi.record(reading, day(n));
        }
        assert.deepEqual(multi.month("2026-10").days.map(row => [row.day, row.input, row.requests]), [["2026-10-02", 23738, 2], ["2026-10-03", 1000, 1]]);
      } finally { multi.close(); }
      assert.ok(requested.every(path => ["/health", "/metrics", "/api/status"].includes(path)), "no models/status or admin endpoint is called");
    } finally { ledger.close(); }
  });
});

test("engine Bearer credentials are environment-only, private, bounded to GET polls and absent from errors", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/omlx-v0.7.0.json", import.meta.url), "utf8"));
  const { InferenceCollector } = await import("../lib/collectors.mjs");
  const { publicInference } = await import("../lib/public-state.mjs");
  const apiKey = "fixture-only-credential";
  await withFakeEngine("", async (url, _setMetrics, setHealth, _setModels, _setSlots, requested, setResponse) => {
    const collector = new InferenceCollector(url, { apiKeyEnv: "ENGINE_TOKEN", env: { ENGINE_TOKEN: apiKey } });
    setHealth(fixture.health);
    setResponse("/metrics", 404, "not found");
    setResponse("/api/status", 401, { detail: apiKey });
    const denied = await collector.collect();
    assert.equal(denied.error, "oMLX needs an API key");
    assert.equal(denied.engine, "oMLX");
    assert.equal(JSON.stringify([collector, publicInference(denied)]).includes(apiKey), false);
    setResponse("/api/status", 200, { ...fixture.completed, api_key: apiKey, model_path: "/private/model" });
    const accepted = await collector.collect();
    assert.equal(accepted.ok, true);
    assert.equal(JSON.stringify([collector, publicInference(accepted)]).includes(apiKey), false);
    setResponse("/api/status", 200, `{bad ${apiKey}`);
    assert.equal((await collector.collect()).error, "oMLX status response is invalid");
    setResponse("/metrics", 200, "vllm:num_requests_running 0\nvllm:generation_tokens_total 20\n");
    assert.equal((await collector.collect()).engine, "vLLM", "metrics detection still wins even with an oMLX-shaped health body");
    setResponse("/metrics", 200, `{bad ${apiKey}`);
    assert.equal((await collector.collect()).error, "invalid metrics JSON");
    setResponse("/metrics", 200, JSON.stringify({ echo: apiKey }));
    assert.equal((await collector.collect()).error, "unsupported metrics JSON format");
    setResponse("/metrics", 302, apiKey, { Location: "/admin/api/stats" });
    const redirected = await collector.collect();
    assert.equal(redirected.ok, false);
    assert.equal(redirected.error.includes(apiKey), false);
    assert.equal(requested.includes("/admin/api/stats"), false, "authenticated requests never follow a redirect");
    for (const invalidKey of [`${apiKey}\n`, `${apiKey} secret`]) assert.throws(() => new InferenceCollector(url, { apiKeyEnv: "ENGINE_TOKEN", env: { ENGINE_TOKEN: invalidKey } }), error => !error.message.includes(apiKey));
  }, { apiKey });
  await withFakeEngine("", async (url, _setMetrics, setHealth, _setModels, _setSlots, requested, setResponse) => {
    const collector = new InferenceCollector(url);
    setHealth(fixture.health);
    setResponse("/metrics", 404, "not found");
    setResponse("/api/status", 401, { detail: "API key required" });
    assert.equal((await collector.collect()).error, "oMLX needs an API key");
    setResponse("/api/status", 200, fixture.idle);
    assert.equal((await collector.collect()).ok, true, "loopback without a configured key works");
    setResponse("/api/status", 302, "redirect", { Location: "/admin/api/stats" });
    assert.equal((await collector.collect()).ok, false);
    assert.equal(requested.includes("/admin/api/stats"), false, "unkeyed oMLX status also refuses admin redirects");
    setHealth({ default_model: "other", engine_pool: [] });
    const start = requested.length;
    assert.equal((await collector.collect()).error, "metrics HTTP 404");
    assert.equal(requested.slice(start).includes("/api/status"), false);
    setHealth(fixture.health);
    setResponse("/metrics", 401, "denied");
    assert.equal((await collector.collect()).error, "metrics HTTP 401", "only HTTP 404 opens the oMLX detection path");
  });
});

test("llama.cpp b11193 reads slots only while requests run and keeps completed counters out of the decode rate", async () => {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/llamacpp-b11193.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(fixture), ["metrics", "health", "models"]);
  assert.deepEqual(Object.keys(fixture.models.data[0]), ["id"]);
  const { InferenceCollector } = await import("../lib/collectors.mjs");
  const { LlamacppSlots, slotContextPercent, holdLlamacppAverages } = await import("../lib/engines/llamacpp.mjs");
  assert.ok(Math.abs(slotContextPercent([{ is_processing: true, n_ctx: 100, n_prompt_tokens: 20, next_token: [{ n_decoded: 10 }] }, { is_processing: true, n_ctx: 200, n_prompt_tokens: 80, next_token: [{ n_decoded: 20 }] }, { is_processing: false, n_ctx: 100, n_prompt_tokens: 90 }]) - 30) < 1e-9);
  assert.equal(slotContextPercent([{ is_processing: true, n_ctx: 4096, n_prompt_tokens: 124, next_token: [{ n_decoded: 100 }] }]), 124 / 4096 * 100);
  assert.equal(slotContextPercent([{ is_processing: true, n_ctx: 100, n_prompt_tokens: 40 }]), 40);
  const cachePolls = [[1000, 0], [1000, 8000], [3000, 8000], [3000, 8000], [0, 0], [null, 8000]];
  assert.deepEqual(cachePolls.map(([promptComputeTotal, promptCacheTotal]) => holdLlamacppAverages({ promptComputeTotal, promptCacheTotal }, null).prefixCacheHitPercent), [0, 8000 / 9000 * 100, 8000 / 11000 * 100, 8000 / 11000 * 100, null, null]);
  assert.equal(slotContextPercent([{ is_processing: true, n_ctx: 0 }]), null);
  const idleSlots = [{ id: 0, is_processing: false }, { id: 1, is_processing: false }];
  const slot = (id, task, decoded) => ({ id, id_task: task, is_processing: true, next_token: [{ n_decoded: decoded }] });
  const liveRate = new LlamacppSlots();
  assert.equal(liveRate.idle(0, "example-model"), 0);
  assert.equal(liveRate.rate([slot(0, 7, 8), slot(1, 9, 12)], 1000, "example-model"), 20, "the first active sample counts from zero");
  assert.equal(liveRate.rate([slot(0, 7, 20), slot(1, 10, 3)], 2000, "example-model"), 15);
  assert.equal(liveRate.rate(idleSlots, 3000, "example-model"), 0);
  assert.equal(liveRate.rate([slot(0, 11, 6)], 4000, "example-model"), 6, "a sample with every slot idle is a zero baseline too");
  assert.equal(liveRate.rate([slot(0, 11, 1)], 5000, "example-model"), null);
  assert.equal(liveRate.rate([slot(0, 7, 5)], 6000, "replacement-model"), null);
  assert.equal(liveRate.rate(null, 7000, "replacement-model"), null);
  assert.equal(liveRate.rate([slot(0, 7, 30)], 8000, "replacement-model"), null);
  assert.equal(metricsEngine(parsePrometheus(fixture.metrics)), "llama.cpp");
  await withFakeEngine(fixture.metrics, async (url, setMetrics, setHealth, setModels, setSlots, requested) => {
    const slotRequests = () => requested.filter((path) => path === "/slots").length;
    setHealth(fixture.health);
    setModels(fixture.models.data);
    setSlots(idleSlots);
    const collector = new InferenceCollector(url);
    const first = await collector.collect();
    assert.equal(first.ok, true);
    assert.equal(first.engine, "llama.cpp");
    assert.equal(first.modelName, "example-model");
    assert.equal(first.generationTokensTotal, 120);
    assert.equal(first.promptTokensTotal, 25);
    assert.equal(first.promptComputeTokensTotal, 25);
    assert.equal(first.promptCacheTokensTotal, 0);
    assert.equal(first.promptTokensPerSecond, 25 / 2.88704);
    assert.equal(first.outputTokensPerSecond, 0);
    assert.equal(slotRequests(), 0, "an idle poll does not request /slots, which would wake a sleeping llama-server");
    assert.equal(first.runningRequests, 0);
    assert.equal(first.waitingRequests, 0);
    assert.equal(first.reported.ttftP95RecentSeconds, false);
    assert.equal(first.reported.tpotP95RecentSeconds, false);
    assert.equal(first.reported.meanDecodeSeconds, true);
    assert.equal(first.reported.kvCachePercent, true);
    assert.equal(first.prefixCacheHitPercent, 0);
    assert.equal(first.metricKinds.prefixCacheHitPercent, "sinceStart");
    for (const key of ["completedRequestsTotal", "ttftP95Seconds", "tpotP95Seconds", "kvCachePercent"]) assert.equal(first[key], null, key);
    const activeMetrics = fixture.metrics
      .replace("llamacpp:tokens_predicted_total 120", "llamacpp:tokens_predicted_total 140")
      .replace(/llamacpp:tokens_predicted_seconds_total ([\d.]+)/, (_, seconds) => `llamacpp:tokens_predicted_seconds_total ${Number(seconds) + 0.4}`)
      .replace("llamacpp:prompt_tokens_total 25", "llamacpp:prompt_tokens_total 45")
      .replace("llamacpp:prompt_tokens_cached_total 0", "llamacpp:prompt_tokens_cached_total 5")
      .replace("llamacpp:prompt_seconds_total 2.88704", "llamacpp:prompt_seconds_total 4.88704")
      .replace("llamacpp:requests_processing 0", "llamacpp:requests_processing 1")
      .replace("llamacpp:requests_deferred 0", "llamacpp:requests_deferred 2")
      .replace("llamacpp:spec_decode_num_draft_tokens_total 0", "llamacpp:spec_decode_num_draft_tokens_total 40")
      .replace("llamacpp:spec_decode_num_accepted_tokens_total 0", "llamacpp:spec_decode_num_accepted_tokens_total 30");
    setMetrics(activeMetrics);
    setSlots([{ ...slot(0, 7, 15), n_ctx: 100, n_prompt_tokens: 35 }, idleSlots[1]], 200, 500);
    setModels(fixture.models.data, 300);
    collector.llamacppSlots.previous.at -= 1000;
    const polled = requested.length;
    const next = await collector.collect();
    setModels(fixture.models.data);
    assert.deepEqual(requested.slice(polled).filter((path) => path === "/slots" || path === "/v1/models replied"), ["/slots", "/v1/models replied"], "slots are asked for before the slow /v1/models reply");
    assert.equal(slotRequests(), 1);
    assert.equal(next.promptTokensTotal, 50);
    assert.ok(Math.abs(next.promptTokensPerSecond - 12.5) < 1e-9);
    assert.ok(Math.abs(next.promptComputeTokensPerSecond - 10) < 1e-9);
    assert.ok(Math.abs(next.promptCacheTokensPerSecond - 2.5) < 1e-9);
    assert.ok(next.outputTokensPerSecond > 0 && next.outputTokensPerSecond < 11, `timed from the /slots reply, not the poll start: ${next.outputTokensPerSecond}`);
    assert.equal(next.runningRequests, 1);
    assert.equal(next.waitingRequests, 2);
    assert.equal(next.speculativeAcceptancePercent, 75);
    assert.equal(next.prefixCacheHitPercent, 10);
    assert.ok(Math.abs(next.meanDecodeSeconds - 0.02) < 1e-9);
    assert.equal(next.kvCachePercent, 35);
    assert.equal(next.reported.kvCachePercent, true);
    assert.equal(next.latencyWindowSeconds, 0);
    setSlots([slot(0, 7, 20), idleSlots[1]]);
    collector.llamacppSlots.previous.at -= 1000;
    const decoding = await collector.collect();
    assert.equal(decoding.generationTokensTotal, next.generationTokensTotal);
    assert.equal(decoding.meanDecodeSeconds, next.meanDecodeSeconds);
    assert.equal(decoding.prefixCacheHitPercent, next.prefixCacheHitPercent);
    assert.equal(decoding.reported.kvCachePercent, true);
    assert.equal(decoding.kvCachePercent, null);
    assert.ok(decoding.outputTokensPerSecond > 0 && decoding.outputTokensPerSecond <= 5);
    setMetrics(activeMetrics.replace("llamacpp:tokens_predicted_total 140", "llamacpp:tokens_predicted_total 640").replace("llamacpp:requests_processing 1", "llamacpp:requests_processing 0"));
    setSlots(idleSlots);
    const complete = await collector.collect();
    assert.equal(slotRequests(), 2, "the idle poll after the request does not request /slots");
    assert.equal(complete.generationTokensTotal, 640);
    assert.equal(complete.outputTokensPerSecond, 0, "slot release is not a 500-token decode burst");
    assert.equal(complete.promptTokensPerSecond, next.promptTokensPerSecond);
    setMetrics(activeMetrics);
    setSlots(null, 501);
    assert.equal((await collector.collect()).outputTokensPerSecond, null);
    setMetrics(activeMetrics.replace("llamacpp:tokens_predicted_total 140", "llamacpp:tokens_predicted_total 640"));
    assert.equal((await collector.collect()).outputTokensPerSecond, null, "disabled slots never fall back to the completed counter");
    setSlots([{ id: 0, id_task: 7, is_processing: true }]);
    assert.equal((await collector.collect()).outputTokensPerSecond, null);
    setMetrics("llamacpp:requests_processing 0\nllamacpp:requests_deferred 0\n");
    const missing = await collector.collect();
    assert.equal(missing.promptTokensTotal, null);
    assert.equal(missing.promptTokensPerSecond, null);
    assert.equal(missing.generationTokensTotal, null);
    assert.equal(missing.outputTokensPerSecond, 0);
    setMetrics("llamacpp:requests_deferred 0\n");
    assert.equal((await collector.collect()).outputTokensPerSecond, null, "without the running-request gauge, slots are not read and the speed is unknown");
    setSlots(idleSlots);
    setMetrics(fixture.metrics.replace(/^llamacpp:prompt_tokens_cached_total .*\n/m, ""));
    const older = await collector.collect();
    assert.equal(older.promptTokensTotal, 25);
    assert.equal(older.promptComputeTokensTotal, 25);
    assert.equal(older.promptCacheTokensTotal, null);
    assert.equal(older.reported.prefixCacheHitPercent, false);
    assert.equal(older.prefixCacheHitPercent, null);
    setMetrics(fixture.metrics.replace("llamacpp:tokens_predicted_total 120", "llamacpp:tokens_predicted_total 0").replace("llamacpp:requests_processing 0", "llamacpp:requests_processing 1"));
    setSlots([slot(0, 99, 1), idleSlots[1]]);
    const reset = await collector.collect();
    assert.equal(reset.outputTokensPerSecond, null);
    assert.equal(reset.completedRequestsTotal, null);
    assert.equal(reset.meanDecodeSeconds, null);
    assert.equal(slotRequests(), 6, "only the six polls with running requests requested /slots");
  });
});

test("Strata 0.1.41 captured JSON remains a fallback without latency histograms", async () => {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/strata-v0.1.41.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(fixture), ["idle", "running", "completed"]);
  const { InferenceCollector } = await import("../lib/collectors.mjs");
  await withFakeEngine(JSON.stringify(fixture.idle), async (url, setMetrics, _setHealth, setModels, _setSlots, requested) => {
    setModels([{ id: "example-alias" }, { id: "example-model" }]);
    const collector = new InferenceCollector(url);
    const poll = async (metrics) => {
      setMetrics(typeof metrics === "string" ? metrics : JSON.stringify(metrics));
      return collector.collect();
    };
    const idle = await collector.collect();
    assert.equal(idle.ok, true);
    assert.equal(idle.engine, "Strata");
    assert.equal(idle.modelName, "example-model", "the model Strata reports wins over the first entry of its model list");
    assert.deepEqual(idle.modelAliases, ["example-alias", "example-model"]);
    assert.equal(idle.processStartedAt, "2026-10-08T15:26:37.121Z");
    assert.equal(idle.completedRequestsTotal, 0);
    assert.equal(idle.outputTokensPerSecond, 0);
    assert.equal(idle.runningRequests, 0);
    assert.equal(idle.waitingRequests, 0);
    const running = await poll(fixture.running);
    assert.equal(running.outputTokensPerSecond, 148);
    assert.equal(running.runningRequests, 1);
    assert.equal(running.generationTokensTotal, 0, "the live rate does not come from the completed counter");
    const completed = await poll(fixture.completed);
    assert.equal(completed.completedRequestsTotal, 1);
    assert.equal(completed.generationTokensTotal, 64);
    assert.equal(completed.promptTokensTotal, 24);
    assert.equal(completed.promptComputeTokensTotal, 24);
    assert.equal(completed.promptCacheTokensTotal, 0);
    assert.ok(Math.abs(completed.promptTokensPerSecond - 24 / 0.3273) < 1e-9);
    assert.equal(completed.outputTokensPerSecond, 0, "the finished request's decode rate is not kept");
    assert.equal(completed.prefixCacheHitPercent, 0, "requests[].hit_rate belongs to the expert cache");
    assert.equal(completed.speculativeAcceptancePercent, 100);
    assert.equal(completed.latencyWindowSeconds, 0);
    assert.equal(completed.reported.ttftP95RecentSeconds, false);
    for (const key of ["ttftP95Seconds", "tpotP95Seconds", "kvCachePercent"]) assert.equal(completed[key], null, key);
    const next = (live, totals) => ({ ...fixture.completed, live: { ...fixture.completed.live, ...live }, totals: { ...fixture.completed.totals, ...totals } });
    const reused = await poll(next({}, { requests: 2, prompt_tokens: 64, reused: 16, prompt_ms: 627.3 }));
    assert.equal(reused.promptTokensTotal, 64);
    assert.equal(reused.promptComputeTokensTotal, 48);
    assert.equal(reused.promptCacheTokensTotal, 16);
    assert.equal(reused.prefixCacheHitPercent, 25);
    assert.ok(Math.abs(reused.promptTokensPerSecond - 40 / 0.3) < 1e-9);
    assert.ok(Math.abs(reused.promptComputeTokensPerSecond - 24 / 0.3) < 1e-9);
    assert.ok(Math.abs(reused.promptCacheTokensPerSecond - 16 / 0.3) < 1e-9);
    const reading = await poll(next({ state: "reading" }));
    assert.equal(reading.runningRequests, 1);
    assert.equal(reading.outputTokensPerSecond, null, "Strata reports no rate while it reads a prompt");
    const batch = await poll(next({ state: "generating", running: 3, queued: 1, waiting: 2, tok_s: 90 }));
    assert.equal(batch.runningRequests, 3);
    assert.equal(batch.waitingRequests, 3);
    assert.equal(batch.outputTokensPerSecond, 90);
    const unloaded = await poll({ engine: { model: "example-model", version: null }, live: { state: "unloaded", queued: 0, tok_s: null }, requests: [], totals: fixture.idle.totals });
    assert.equal(unloaded.ok, true, "a server that has not loaded its model yet has no engine version key");
    assert.equal(unloaded.runningRequests, 0);
    assert.equal(unloaded.outputTokensPerSecond, 0);
    const partial = await poll({ engine: {}, live: { state: "starting" }, requests: [], totals: { output_tokens: "64", prompt_tokens: 8, reused: 9, prompt_ms: -1, since: 1e20 } });
    for (const key of ["generationTokensTotal", "promptComputeTokensTotal", "promptTokensPerSecond", "runningRequests", "waitingRequests", "completedRequestsTotal", "prefixCacheHitPercent", "processStartedAt"]) assert.equal(partial[key], null, key);
    assert.equal((await poll("{invalid")).error, "invalid metrics JSON");
    assert.equal((await poll("{}")).error, "unsupported metrics JSON format");
    assert.equal((await poll({ ...fixture.idle, live: {} })).error, "unsupported metrics JSON format");
    assert.equal(requested.includes("/slots"), false, "a Strata poll reads /health, /metrics and /v1/models only");
  });
});

test("Strata Prometheus reads histograms and keeps its JSON ledger epoch across format changes", async () => {
  const { readFileSync } = await import("node:fs");
  const { InferenceCollector } = await import("../lib/collectors.mjs");
  const text = readFileSync(new URL("./fixtures/strata-v0.1.41-prometheus.txt", import.meta.url), "utf8");
  assert.equal(metricsEngine(parsePrometheus(text)), "Strata", "strata: families take precedence over its vllm: aliases");
  const json = JSON.parse(readFileSync(new URL("./fixtures/strata-v0.1.41.json", import.meta.url), "utf8"));
  const { UsageStore } = await import("../lib/usage-store.mjs");
  const store = new UsageStore(":memory:", { timeZone: "UTC" });
  await withFakeEngine(JSON.stringify(json.idle), async (base, setMetrics, _health, _models, _slots, requested) => {
    let collector = new InferenceCollector(base);
    const at = Date.parse("2026-10-09T00:00:00Z");
    store.record(await collector.collect(), at);
    setMetrics(JSON.stringify(json.completed));
    const booked = store.record(await collector.collect(), at + 1000).today;
    assert.equal(booked.output, 64);
    collector = new InferenceCollector(base);
    const setPrometheus = (body, metadata = json.completed) => setMetrics({ text: body, json: metadata });
    setPrometheus(text);
    const first = await collector.collect();
    assert.equal(first.engine, "Strata");
    assert.equal(first.outputTokensPerSecond, 148);
    assert.equal(first.promptComputeTokensPerSecond, 201.5);
    assert.equal(first.metricKinds.promptComputeTokensPerSecond, "request");
    assert.equal(first.promptComputeTokensTotal, 24);
    assert.equal(first.promptCacheTokensTotal, 0);
    assert.equal(first.completedRequestsTotal, 1);
    assert.equal(first.kvCachePercent, 8.59);
    assert.ok(first.ttftP95Seconds > 0.1 && first.ttftP95Seconds <= 0.25);
    assert.ok(first.tpotP95Seconds > 0.001 && first.tpotP95Seconds <= 0.005);
    assert.equal(first.reported.ttftP95RecentSeconds, true);
    assert.equal(first.reported.tpotP95RecentSeconds, true);
    assert.equal(first.processStartedAt, "2026-10-08T15:26:37.121Z");
    assert.deepEqual(store.record(first, at + 2000).today, booked, "a dashboard restart and JSON-to-Prometheus switch do not rebook completed tokens");
    const { sampleOf, phaseOf } = await import("../public/mini/mini-view.js");
    await new Promise(resolve => setTimeout(resolve, 10));
    const streaming = await collector.collect();
    assert.equal(phaseOf(sampleOf({ inference: streaming }, Date.parse(streaming.updatedAt), Date.parse(first.updatedAt))), "decode", "a held live prompt rate does not mark every generating poll as prefill");
    const reading = text.replace(/(strata:live_state\{[^}]*state="generating"\}) 1/, "$1 0").replace(/(strata:live_state\{[^}]*state="reading"\}) 0/, "$1 1");
    setPrometheus(reading);
    const prefill = await collector.collect();
    assert.equal(prefill.outputTokensPerSecond, null, "a reading state must not turn a coerced gauge into measured decode");
    assert.equal(prefill.prefillUpdatedAt, prefill.updatedAt, "the reading state still records live prefill activity");
    const unloaded = reading.replace(/(strata:live_state\{[^}]*state="reading"\}) 1/, "$1 0").replace(/(strata:live_state\{[^}]*state="unloaded"\}) 0/, "$1 1");
    setPrometheus(unloaded);
    const idle = await collector.collect();
    assert.equal(idle.outputTokensPerSecond, 0);
    assert.equal(idle.kvCachePercent, null);
    assert.equal(idle.reported.kvCachePercent, true);
    assert.equal(requested.filter(path => path === "/metrics").length, 10);
    setPrometheus(text, null);
    const unavailable = await collector.collect();
    assert.equal(unavailable.ok, false);
    assert.match(unavailable.error, /counter start time unavailable/);
    assert.deepEqual(store.record(unavailable, at + 3000).allTime, booked);
    setPrometheus(text);
    assert.deepEqual(store.record(await collector.collect(), at + 4000).today, booked);
    const restarted = { ...json.completed, totals: { ...json.completed.totals, since: json.completed.totals.since + 60, output_tokens: 10 } };
    setPrometheus(text, restarted);
    assert.equal(store.record(await collector.collect(), at + 5000).today.output, 74, "an engine restart between the two scrapes uses counters from the same response as the epoch");
    setMetrics(JSON.stringify(restarted));
    assert.equal(store.record(await collector.collect(), at + 6000).today.output, 74, "the reverse format switch keeps that run");
    store.close();
    assert.ok(requested.every(path => ["/metrics", "/health", "/v1/models", "/v1/models replied"].includes(path)), "no load, unload, slots or generation endpoint");
  });
});

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
    assert.equal(first.reported.speculativeAcceptancePercent, false);
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
  const { readEngineMetrics } = await import("../lib/engines/index.mjs");
  const beforeRequests = readEngineMetrics("SGLang", gauges(0, 0));
  assert.equal(beforeRequests.reported.ttftP95RecentSeconds, true);
  assert.equal(beforeRequests.reported.tpotP95RecentSeconds, true);
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
const tensorfoldNative = JSON.parse(readFileSync(new URL("./fixtures/tensorfold-v1.0.2.json", import.meta.url), "utf8"));

function tensorfoldScrape({ finished, prompt, streams = [0.5, 0.25], modern = false, runningTokens = 80 } = {}) {
  finished ??= modern ? 10848 : 50;
  prompt ??= modern ? 2032 : 1000;
  if (modern) return tensorfoldNative.metrics
    .replace(/(tensorfold:generation_tokens_total) \d+/, `$1 ${finished}`)
    .replace(/(tensorfold:prompt_tokens_total) \d+/, `$1 ${prompt}`)
    .replace(/(tensorfold:generation_tokens_running) \d+/, `$1 ${streams.length ? runningTokens : 0}`)
    .replace(/(tensorfold:num_requests_running) \d+/, `$1 ${streams.length}`)
    .replace(/^tensorfold:kv_cache_usage_perc\{.*$/m, (streams.length ? streams : [0]).map((ratio, index) => `tensorfold:kv_cache_usage_perc{stream="${index}"} ${ratio}`).join("\n"));
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

test("TensorFold 1.0.2 native captures hold the token high-water mark through non-atomic completion updates", async () => {
  const { InferenceCollector } = await import("../lib/collectors.mjs");
  assert.equal(tensorfoldNative.version, "1.0.2");
  for (const key of ["completion_tokens_total", "prompt_tokens_total", "cached_tokens_total", "prefill_seconds_total", "requests_total"]) assert.equal(key in tensorfoldNative.healthEnd, false, key);
  await withFakeEngine(tensorfoldScrape({ modern: true }), async (base, setMetrics, setHealth, _models, _slots, requested) => {
    const health = { ...tensorfoldNative.healthEnd, live: { ...tensorfoldNative.healthEnd.live, decode_tokens_per_second: 85.3, prefill_tokens_per_second: 800 } };
    setHealth(health);
    const collector = new InferenceCollector(base);
    const first = await collector.collect();
    assert.equal(first.outputTokensPerSecond, null, "the token sum needs two polls");
    assert.equal(first.promptComputeTokensPerSecond, 800);
    assert.equal(first.metricKinds.outputTokensPerSecond, undefined);
    assert.equal(first.metricKinds.promptComputeTokensPerSecond, "twoSecond");
    assert.ok(first.tpotP95Seconds > 0.01 && first.tpotP95Seconds <= 0.015);
    assert.equal(first.reported.tpotP95RecentSeconds, true);
    assert.equal(first.reported.prefixCacheHitPercent, false);
    assert.equal(first.reported.promptCacheTokensPerSecond, false);
    setMetrics(tensorfoldScrape({ modern: true, runningTokens: 100 }));
    collector.previous.at -= 2000;
    assert.ok(Math.abs((await collector.collect()).outputTokensPerSecond - 10) < 0.5, "the token total takes precedence over health's rate");
    setMetrics(tensorfoldScrape({ modern: true, streams: [] }));
    collector.previous.at -= 2000;
    assert.equal((await collector.collect()).outputTokensPerSecond, 0, "stream release can precede the finished-counter update");
    setMetrics(tensorfoldScrape({ modern: true, finished: 10948, streams: [] }));
    collector.previous.at -= 2000;
    setHealth(tensorfoldNative.healthStart);
    const released = await collector.collect();
    assert.equal(released.outputTokensPerSecond, 0, "running tokens transfer to finished totals without a burst or a negative delta");
    assert.equal(released.promptComputeTokensPerSecond, 0);
    setMetrics(tensorfoldScrape({ modern: true, finished: 10, streams: [] }));
    assert.equal((await collector.collect()).outputTokensPerSecond, null, "a counter reset has no live baseline");
    const noRunning = tensorfoldScrape({ modern: true }).replace(/^tensorfold:generation_tokens_running .*\n/m, "");
    setMetrics(noRunning);
    setHealth(health);
    const fallback = await collector.collect();
    assert.equal(fallback.outputTokensPerSecond, 85.3);
    assert.equal(fallback.metricKinds.outputTokensPerSecond, "twoSecond");
    setHealth({ status: "ok" });
    const restricted = await collector.collect();
    assert.equal(restricted.outputTokensPerSecond, null);
    assert.equal(restricted.promptTokensPerSecond, 2032 / 2.142097);
    assert.equal(restricted.reported.promptComputeTokensPerSecond, false);
    setMetrics(noRunning + "tensorfold:prefix_cache_queries_total 0\ntensorfold:prefix_cache_hits_total 0\ntensorfold:prompt_tokens_cached_total 0\n");
    const emptyCache = await collector.collect();
    assert.equal(emptyCache.reported.prefixCacheHitPercent, true, "counter presence decides support, even before the first query");
    assert.equal(emptyCache.prefixCacheHitPercent, null);
    setMetrics(noRunning + "tensorfold:prefix_cache_queries_total 100\ntensorfold:prefix_cache_hits_total 25\ntensorfold:prompt_tokens_cached_total 25\n");
    const cached = await collector.collect();
    assert.equal(cached.prefixCacheHitPercent, 25);
    assert.equal(cached.reported.prefixCacheHitPercent, true);
    assert.equal(cached.promptCacheTokensTotal, 25);
    assert.ok(requested.every(path => ["/metrics", "/health", "/v1/models", "/v1/models replied"].includes(path)), "no reset_peak or control request");
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
  let metrics = 'vllm:num_requests_running{model_name="example-model"} 0\nvllm:generation_tokens_total{model_name="example-model"} 1\n';
  const server = createServer((request, response) => {
    if (request.url === "/health") return response.end(big);
    if (request.url === "/metrics") return response.end(metrics);
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
    metrics = "{invalid";
    for (let i = 0; i < 20; i += 1) assert.equal((await collector.collect()).error, "invalid metrics JSON");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const open = [...sockets].filter((socket) => !socket.destroyed).length;
    // Unread bodies kept their connections open (about 40 after 20 polls); released ones are closed or reused.
    assert.ok(open <= 6, `${open} of ${sockets.size} connections still open after 40 polls`);
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

  const empty = new RecentHistograms();
  empty.add(0, { ttft: [], tpot: [] });
  empty.add(2000, { ttft: [], tpot: [] });
  assert.equal(empty.windowSeconds, 0, "an absent histogram is not a measured window with no requests");

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
