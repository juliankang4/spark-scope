import { readVllmMetrics } from "./vllm.mjs";
import { readSglangMetrics } from "./sglang.mjs";
import { readTensorfoldMetrics } from "./tensorfold.mjs";
import { readLlamacppMetrics } from "./llamacpp.mjs";
import { parseStrataMetrics, readStrataMetrics } from "./strata.mjs";
import { parsePrometheus } from "./prometheus.mjs";

export function metricsEngine(metrics) {
  if ([...metrics.keys()].some(name => name.startsWith("strata:"))) return "Strata";
  let engine = null;
  for (const name of metrics.keys()) {
    if (name.startsWith("vllm:")) return "vLLM";
    if (name.startsWith("sglang:")) engine = "SGLang";
    else if (name.startsWith("tensorfold:")) engine = "TensorFold";
    else if (name.startsWith("llamacpp:")) engine = "llama.cpp";
  }
  return engine;
}

// Strata answers /metrics with JSON unless the request asks for Prometheus text; the other engines always send text.
export function parseMetricsResponse(text) {
  if (text.trimStart().startsWith("{")) return { engine: "Strata", metrics: new Map(), json: parseStrataMetrics(text) };
  const metrics = parsePrometheus(text);
  return { engine: metricsEngine(metrics), metrics, json: null };
}

export function readEngineMetrics(engine, metrics, health = null, json = null) {
  let reading;
  if (engine === "Strata") reading = readStrataMetrics(json, metrics);
  else if (engine === "llama.cpp") reading = readLlamacppMetrics(metrics);
  else if (engine === "SGLang") reading = readSglangMetrics(metrics);
  else if (engine === "TensorFold") reading = readTensorfoldMetrics(metrics, health);
  else reading = readVllmMetrics(metrics);
  const standard = engine === "vLLM" || engine === "SGLang";
  reading.reported = {
    outputTokensPerSecond: true,
    promptTokensPerSecond: standard || reading.prefillTimeTotal !== null || reading.prefillTokensPerSecond !== undefined,
    promptComputeTokensPerSecond: standard || reading.promptComputeTotal !== null || reading.prefillTokensPerSecond !== undefined,
    promptCacheTokensPerSecond: standard || reading.promptCacheTotal !== null,
    prefixCacheHitPercent: reading.prefixCacheReported ?? (standard || reading.promptCacheTotal !== null),
    speculativeAcceptancePercent: reading.speculativeAcceptancePercent !== null,
    requests: true,
    kvCachePercent: standard || reading.metricKinds?.kvCachePercent === "context" || reading.kvCachePercent !== null,
    ttftP95RecentSeconds: standard || reading.ttftBuckets.length > 0,
    tpotP95RecentSeconds: standard || reading.tpotBuckets.length > 0,
    meanDecodeSeconds: engine === "llama.cpp" && reading.decodeTimeTotal !== null && reading.generationTotal !== null,
    completedRequestsTotal: reading.completedRequestsTotal !== null,
  };
  return reading;
}
