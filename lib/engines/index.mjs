import { readVllmMetrics } from "./vllm.mjs";
import { readSglangMetrics } from "./sglang.mjs";
import { readTensorfoldMetrics } from "./tensorfold.mjs";
import { readLlamacppMetrics } from "./llamacpp.mjs";
import { parseStrataMetrics, readStrataMetrics } from "./strata.mjs";
import { parsePrometheus } from "./prometheus.mjs";

export function metricsEngine(metrics) {
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
  if (engine === "Strata") return readStrataMetrics(json);
  if (engine === "llama.cpp") return readLlamacppMetrics(metrics);
  if (engine === "SGLang") return readSglangMetrics(metrics);
  if (engine === "TensorFold") return readTensorfoldMetrics(metrics, health);
  return readVllmMetrics(metrics);
}
