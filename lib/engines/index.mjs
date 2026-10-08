import { readVllmMetrics } from "./vllm.mjs";
import { readSglangMetrics } from "./sglang.mjs";
import { readTensorfoldMetrics } from "./tensorfold.mjs";
import { readLlamacppMetrics } from "./llamacpp.mjs";

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

export function readEngineMetrics(engine, metrics, health = null) {
  if (engine === "llama.cpp") return readLlamacppMetrics(metrics);
  if (engine === "SGLang") return readSglangMetrics(metrics);
  if (engine === "TensorFold") return readTensorfoldMetrics(metrics, health);
  return readVllmMetrics(metrics);
}
