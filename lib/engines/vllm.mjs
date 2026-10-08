import { metricValue, metricTotal, metricMean, histogramBuckets, histogramQuantile } from "./prometheus.mjs";

// vLLM keeps cumulative draft and accepted token counters.
// null when no speculative decoding runs, rather than a 0% that reads like a broken draft model.
export function vllmSpeculativeAcceptancePercent(metrics) {
  const draftTokens = metricTotal(metrics, "vllm:spec_decode_num_draft_tokens_total");
  if (draftTokens > 0) {
    return ((metricTotal(metrics, "vllm:spec_decode_num_accepted_tokens_total") ?? 0) / draftTokens) * 100;
  }
  return null;
}

export function resolveModelIdentity(metrics, models = [], reportedModelName = null) {
  const modelSample = (metrics.get("vllm:num_requests_running") ?? [])
    .find((sample) => sample.labels.model_name);
  const aliases = [...new Set(models.map((model) => model?.id).filter(Boolean))];
  const modelName = modelSample?.labels.model_name ?? reportedModelName ?? aliases[0] ?? null;
  const selected = models.find((model) => model?.id === modelName) ?? models[0] ?? null;
  return {
    modelName,
    modelRoot: selected?.root ?? null,
    modelAliases: aliases,
  };
}

export function readVllmMetrics(metrics) {
  const prefixQueries = metricTotal(metrics, "vllm:prefix_cache_queries_total");
  const prefixHits = metricTotal(metrics, "vllm:prefix_cache_hits_total");
  const kvCacheUsage = metricMean(metrics, "vllm:kv_cache_usage_perc");
  const processStartedAt = metricValue(metrics, "process_start_time_seconds", {}, null);
  return {
    modelName: resolveModelIdentity(metrics).modelName,
    generationTotal: metricTotal(metrics, "vllm:generation_tokens_total"),
    liveGenerationTotal: null,
    promptTotal: metricTotal(metrics, "vllm:prompt_tokens_total"),
    promptComputeTotal: metricTotal(metrics, "vllm:prompt_tokens_by_source_total", { source: "local_compute" }),
    promptCacheTotal: metricTotal(metrics, "vllm:prompt_tokens_by_source_total", { source: "local_cache_hit" }),
    prefillTimeTotal: metricTotal(metrics, "vllm:request_prefill_time_seconds_sum"),
    prefillCount: metricTotal(metrics, "vllm:request_prefill_time_seconds_count"),
    runningRequests: metricTotal(metrics, "vllm:num_requests_running"),
    waitingRequests: metricTotal(metrics, "vllm:num_requests_waiting"),
    kvCachePercent: kvCacheUsage === null ? null : kvCacheUsage * 100,
    prefixCacheHitPercent: prefixQueries > 0 ? ((prefixHits ?? 0) / prefixQueries) * 100 : null,
    speculativeAcceptancePercent: vllmSpeculativeAcceptancePercent(metrics),
    ttftP95Seconds: histogramQuantile(metrics, "vllm:time_to_first_token_seconds", 0.95),
    tpotP95Seconds: histogramQuantile(metrics, "vllm:request_time_per_output_token_seconds", 0.95),
    ttftBuckets: histogramBuckets(metrics, "vllm:time_to_first_token_seconds"),
    tpotBuckets: histogramBuckets(metrics, "vllm:request_time_per_output_token_seconds"),
    completedRequestsTotal: metricTotal(metrics, "vllm:request_success_total"),
    processStartedAt: processStartedAt ? new Date(processStartedAt * 1000).toISOString() : null,
  };
}
