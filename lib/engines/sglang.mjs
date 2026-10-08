import { metricValue, metricSum, copyMetrics } from "./prometheus.mjs";
import { readVllmMetrics, vllmSpeculativeAcceptancePercent } from "./vllm.mjs";

// SGLang exposes its own metric names. Add the vLLM names this collector reads, so
// one parser serves both engines. Counters and histograms are summed over SGLang's extra labels
// (is_streaming, cache_source); gauges use the first sample (usually rank 0). SGLang has no
// prefill-time histogram, so time to first token stands in for it (it includes queue time). It
// has no per-request TPOT histogram either; its inter-token histogram spreads each streamed
// chunk's interval over the chunk's tokens, so its quantiles stand in for TPOT.
const SGLANG_COUNTERS = {
  "vllm:generation_tokens_total": "sglang:generation_tokens_total",
  "vllm:prompt_tokens_total": "sglang:prompt_tokens_total",
  "vllm:request_success_total": "sglang:num_requests_total",
};
const SGLANG_GAUGES = {
  "vllm:num_requests_running": "sglang:num_running_reqs",
  "vllm:num_requests_waiting": "sglang:num_queue_reqs",
  "vllm:kv_cache_usage_perc": "sglang:token_usage",
};
const SGLANG_HISTOGRAMS = {
  "vllm:time_to_first_token_seconds": "sglang:time_to_first_token_seconds",
  "vllm:request_prefill_time_seconds": "sglang:time_to_first_token_seconds",
  "vllm:request_time_per_output_token_seconds": "sglang:inter_token_latency_seconds",
};

export function normalizeSglangMetrics(metrics) {
  const modelName = [...metrics.values()].flat().find((sample) => sample.name.startsWith("sglang:") && sample.labels.model_name)?.labels.model_name;
  const base = modelName ? { model_name: modelName } : {};
  const put = (name, labels, value) => {
    if (!metrics.has(name)) metrics.set(name, []);
    metrics.get(name).push({ name, labels: { ...base, ...labels }, value });
  };
  const total = (name) => (metrics.has(name) ? metricSum(metrics, name) : null);
  for (const [target, source] of Object.entries(SGLANG_COUNTERS)) {
    const value = total(source);
    if (value !== null && !metrics.has(target)) put(target, {}, value);
  }
  for (const [target, source] of Object.entries(SGLANG_GAUGES)) {
    const sample = (metrics.get(source) ?? [])[0];
    if (sample && !metrics.has(target)) put(target, {}, sample.value);
  }
  const prompt = total("sglang:prompt_tokens_total");
  const cached = total("sglang:cached_tokens_total");
  if (prompt !== null && !metrics.has("vllm:prompt_tokens_by_source_total")) {
    put("vllm:prompt_tokens_by_source_total", { source: "local_cache_hit" }, cached ?? 0);
    put("vllm:prompt_tokens_by_source_total", { source: "local_compute" }, Math.max(0, prompt - (cached ?? 0)));
  }
  // vLLM counts prefix-cache queries and hits in tokens, so SGLang's prompt and cached token
  // counters give the same since-start hit rate.
  if (prompt !== null && !metrics.has("vllm:prefix_cache_queries_total")) {
    put("vllm:prefix_cache_queries_total", {}, prompt);
    put("vllm:prefix_cache_hits_total", {}, cached ?? 0);
  }
  for (const [target, source] of Object.entries(SGLANG_HISTOGRAMS)) {
    if (!metrics.has(`${source}_count`) || metrics.has(`${target}_count`)) continue;
    put(`${target}_count`, {}, metricSum(metrics, `${source}_count`));
    put(`${target}_sum`, {}, metricSum(metrics, `${source}_sum`));
    const buckets = new Map();
    for (const sample of metrics.get(`${source}_bucket`) ?? []) {
      buckets.set(sample.labels.le, (buckets.get(sample.labels.le) ?? 0) + sample.value);
    }
    for (const [le, value] of buckets) put(`${target}_bucket`, { le }, value);
  }
  return metrics;
}

// SGLang adds a request's output tokens to generation_tokens_total only when the request finishes, so the counter's
// rate reads 0 while tokens stream and spikes when a request ends. Its scheduler publishes the measured generation
// throughput (sglang:gen_throughput, refreshed every few decode steps), which is the live decode rate while requests
// run; the gauge keeps its last value when idle, so with nothing running the rate is 0.
export function sglangDecodeRate(metrics, counterRate = null) {
  const throughput = metricValue(metrics, "sglang:gen_throughput", {}, null);
  if (throughput === null) return counterRate;
  const running = metricValue(metrics, "sglang:num_running_reqs", {}, null);
  return running > 0 ? Math.max(0, throughput) : 0;
}

export function sglangSpeculativeAcceptancePercent(metrics) {
  const value = metricValue(metrics, "sglang:spec_accept_rate", {}, null);
  return value === null ? null : value * 100;
}

export function speculativeAcceptancePercent(metrics) {
  return vllmSpeculativeAcceptancePercent(metrics) ?? sglangSpeculativeAcceptancePercent(metrics);
}

export function readSglangMetrics(metrics) {
  const reading = readVllmMetrics(normalizeSglangMetrics(copyMetrics(metrics)));
  const decode = sglangDecodeRate(metrics);
  return { ...reading, ...(decode === null ? {} : { decodeTokensPerSecond: decode }), speculativeAcceptancePercent: speculativeAcceptancePercent(metrics) };
}
