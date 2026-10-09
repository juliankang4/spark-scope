import { readVllmMetrics } from "./vllm.mjs";
import { copyMetrics, metricTotal } from "./prometheus.mjs";

// Native TensorFold 1.0.2 exports context occupancy per stream, TPOT and prefill histograms.
// Its /health exposes live rates, not the counters returned by the 0.6 Python CUDA server.
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
  const prompt = healthNumber(health, "prompt_tokens_total") ?? metricTotal(metrics, "vllm:prompt_tokens_total");
  const cached = healthNumber(health, "cached_tokens_total") ?? metricTotal(metrics, "vllm:prompt_tokens_cached_total");
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

// The native metrics split generated tokens between live streams and finished requests.
export function tensorfoldLiveTokens(health, metrics = null) {
  const running = metrics && metricTotal(metrics, "tensorfold:generation_tokens_running");
  const finished = metrics && metricTotal(metrics, "tensorfold:generation_tokens_total");
  return running !== null && running >= 0 && finished !== null && finished >= 0 ? running + finished : healthNumber(health, "completion_tokens_total");
}

export function readTensorfoldMetrics(metrics, health) {
  const normalized = normalizeTensorfoldMetrics(copyMetrics(metrics), health);
  const reading = readVllmMetrics(normalized);
  const liveGenerationTotal = tensorfoldLiveTokens(health, metrics);
  const live = health?.live;
  const modern = metrics.has("tensorfold:request_time_per_output_token_seconds_bucket");
  const healthDecode = liveGenerationTotal === null && Boolean(live || modern);
  const prefill = healthNumber(live, "prefill_tokens_per_second");
  return {
    ...reading,
    liveGenerationTotal,
    prefixCacheReported: normalized.has("vllm:prefix_cache_queries_total") && normalized.has("vllm:prefix_cache_hits_total"),
    ...(healthDecode ? { decodeTokensPerSecond: healthNumber(live, "decode_tokens_per_second") } : {}),
    ...(live ? { prefillTokensPerSecond: prefill, prefillRateKind: "twoSecond" } : {}),
    metricKinds: { kvCachePercent: "context", tpotP95RecentSeconds: "requestMean", ...(healthDecode ? { outputTokensPerSecond: "twoSecond" } : {}) },
  };
}
