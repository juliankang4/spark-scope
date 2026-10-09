import { EngineError } from "./errors.mjs";

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function isOmlxHealth(health) {
  return record(health) && Object.hasOwn(health, "default_model")
    && (health.default_model === null || typeof health.default_model === "string")
    && record(health.engine_pool) && number(health.engine_pool.model_count) !== null
    && number(health.engine_pool.loaded_count) !== null;
}

// oMLX 0.7.0's /api/status reports server-wide completed-request totals, not live token counters.
export function readOmlxMetrics(status) {
  if (!record(status) || !Object.hasOwn(status, "default_model") || number(status.models_loaded) === null) {
    throw new EngineError("oMLX status response is invalid");
  }
  const prompt = number(status.total_prompt_tokens), cached = number(status.total_cached_tokens);
  const computed = prompt !== null && cached !== null && cached <= prompt ? prompt - cached : null;
  const defaultModel = typeof status.default_model === "string" ? status.default_model : null;
  return {
    modelName: status.models_loaded <= 1 ? defaultModel : null,
    ledgerModelName: defaultModel,
    reported: {
      outputTokensPerSecond: false, averageOutputTokensPerSecond: true, averagePromptTokensPerSecond: true,
      promptTokensPerSecond: false, promptComputeTokensPerSecond: false, promptCacheTokensPerSecond: false,
      prefixCacheHitPercent: true, completedRequestsTotal: true,
    },
    metricKinds: {
      averageOutputTokensPerSecond: "sessionMean",
      averagePromptTokensPerSecond: "sessionMean",
      prefixCacheHitPercent: "sinceStart",
    },
    generationTotal: number(status.total_completion_tokens),
    liveGenerationTotal: null,
    promptTotal: prompt,
    promptComputeTotal: computed,
    promptCacheTotal: cached,
    prefillTimeTotal: null,
    prefillCount: number(status.total_requests),
    completedRequestsTotal: number(status.total_requests),
    processStartedAt: null,
    decodeTokensPerSecond: null,
    averageOutputTokensPerSecond: number(status.avg_generation_tps),
    averagePromptTokensPerSecond: number(status.avg_prefill_tps),
    runningRequests: number(status.active_requests),
    waitingRequests: number(status.waiting_requests),
    prefixCacheHitPercent: computed !== null && prompt > 0 ? cached / prompt * 100 : null,
    kvCachePercent: null,
    speculativeAcceptancePercent: null,
    ttftP95Seconds: null,
    tpotP95Seconds: null,
    ttftBuckets: [],
    tpotBuckets: [],
  };
}
