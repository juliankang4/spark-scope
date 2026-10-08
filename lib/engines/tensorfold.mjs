import { readVllmMetrics } from "./vllm.mjs";
import { copyMetrics } from "./prometheus.mjs";

// TensorFold repeats its readings under vLLM's names with its own prefix (tensorfold:num_requests_running,
// tensorfold:kv_cache_usage_perc, ...), so swapping the prefix fills the vLLM fields. Its kv_cache_usage_perc is one
// series per running stream (that stream's tokens over its context window), averaged like vLLM's per-engine series.
// It has no per-token latency histogram, so TPOT stays unknown. On CUDA its /health JSON adds the finished requests'
// cached prompt tokens and prefill seconds, which give the cache hit rate and the prefill rates; without them (the
// Mac server) those stay unknown rather than zero.
const TENSORFOLD_PREFIX = "tensorfold:";

function healthNumber(health, key) {
  const value = health?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeTensorfoldMetrics(metrics, health = null) {
  const put = (name, labels, value) => {
    if (!metrics.has(name)) metrics.set(name, []);
    metrics.get(name).push({ name, labels, value });
  };
  for (const [name, samples] of [...metrics]) {
    if (!name.startsWith(TENSORFOLD_PREFIX)) continue;
    const target = `vllm:${name.slice(TENSORFOLD_PREFIX.length)}`;
    if (!metrics.has(target)) metrics.set(target, samples.map((sample) => ({ ...sample, name: target })));
  }
  const prompt = healthNumber(health, "prompt_tokens_total");
  const cached = healthNumber(health, "cached_tokens_total");
  if (prompt !== null && cached !== null && !metrics.has("vllm:prompt_tokens_by_source_total")) {
    put("vllm:prompt_tokens_by_source_total", { source: "local_cache_hit" }, Math.min(cached, prompt));
    put("vllm:prompt_tokens_by_source_total", { source: "local_compute" }, Math.max(0, prompt - cached));
  }
  if (prompt !== null && cached !== null && !metrics.has("vllm:prefix_cache_queries_total")) {
    put("vllm:prefix_cache_queries_total", {}, prompt);
    put("vllm:prefix_cache_hits_total", {}, Math.min(cached, prompt));
  }
  const prefillSeconds = healthNumber(health, "prefill_seconds_total");
  const finished = healthNumber(health, "requests_total");
  if (prefillSeconds !== null && finished !== null && !metrics.has("vllm:request_prefill_time_seconds_count")) {
    put("vllm:request_prefill_time_seconds_sum", {}, prefillSeconds);
    put("vllm:request_prefill_time_seconds_count", {}, finished);
  }
  return metrics;
}

// TensorFold, like SGLang, adds a reply's tokens to generation_tokens_total only when the request finishes. Its CUDA
// /health counts the running replies' tokens as they stream (completion_tokens_total), which gives the live rate.
export function tensorfoldLiveTokens(health) {
  return healthNumber(health, "completion_tokens_total");
}

export function readTensorfoldMetrics(metrics, health) {
  const reading = readVllmMetrics(normalizeTensorfoldMetrics(copyMetrics(metrics), health));
  return { ...reading, liveGenerationTotal: tensorfoldLiveTokens(health) };
}
