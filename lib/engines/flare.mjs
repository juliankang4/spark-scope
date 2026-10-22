import { metricTotal } from "./prometheus.mjs";

// NVIDIA Flare's Helios server exports flare_* counters and gauges without histograms or a model name.
// Prefill counts computed prompt tokens only; prefix-cache reuse is counted at admission, from GPU checkpoints
// and, beyond them, from the host prefix store.
export function readFlareMetrics(metrics) {
  const value = name => metricTotal(metrics, `flare_${name}`);
  const computed = value("prefill_tokens_total");
  const gpuReused = value("cache_reused_tokens_total");
  const cached = gpuReused === null ? null : gpuReused + (value("host_cache_reused_tokens_total") ?? 0);
  const prompt = computed === null || cached === null ? null : computed + cached;
  const drafts = value("verification_draft_tokens_total");
  const accepted = value("accepted_draft_tokens_total");
  return {
    // No prefill time is exported, so prompt rates cannot be derived.
    reported: { promptComputeTokensPerSecond: false, promptCacheTokensPerSecond: false },
    metricKinds: { prefixCacheHitPercent: "sinceStart" },
    generationTotal: value("generated_tokens_total"),
    liveGenerationTotal: null,
    promptTotal: prompt,
    promptComputeTotal: computed,
    promptCacheTotal: cached,
    prefillTimeTotal: null,
    prefillCount: null,
    runningRequests: value("active_requests"),
    // Requests queued in the model scheduler; requests still in tokenization or the ingress channel are not counted.
    waitingRequests: value("pending_requests"),
    // Free KV pages exclude prefix-cache checkpoints that admission evicts on demand, so a used-page share would
    // stay near full on a warm idle server; KV usage is left unreported.
    kvCachePercent: null,
    prefixCacheHitPercent: prompt > 0 ? cached / prompt * 100 : null,
    // null while no drafts run (MTP off), rather than a 0% that reads like a failing drafter.
    speculativeAcceptancePercent: drafts > 0 && accepted !== null && accepted <= drafts ? accepted / drafts * 100 : null,
    ttftP95Seconds: null,
    tpotP95Seconds: null,
    ttftBuckets: [],
    tpotBuckets: [],
    completedRequestsTotal: value("requests_completed_total"),
    // flare_uptime_seconds is whole seconds, so a start time derived from it would move between polls. The model
    // card's `created` time is fixed per serving instance but is not used: it needs the serving key on a keyed
    // server and does not mean what vLLM's process start time means.
    processStartedAt: null,
  };
}
