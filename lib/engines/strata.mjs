import { metricValue, histogramBuckets, histogramQuantile } from "./prometheus.mjs";
import { readVllmMetrics } from "./vllm.mjs";
import { EngineError } from "./errors.mjs";

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function isoTime(seconds) {
  const date = number(seconds) === null ? null : new Date(seconds * 1000);
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

// live.state is one of these. Strata serves one request at a time unless it runs parallel slots ("parallel": N),
// which add live.running and live.waiting.
const RUNNING = new Map([["unloaded", 0], ["idle", 0], ["reading", 1], ["generating", 1]]);

// The JSON of Strata 0.1.41. With lazy_load, live.state is "unloaded" and engine has fewer keys until the first load.
export function parseStrataMetrics(text) {
  let json;
  try { json = JSON.parse(text); }
  catch { throw new EngineError("invalid metrics JSON"); }
  if (!record(json) || !record(json.engine) || !record(json.live) || typeof json.live.state !== "string"
    || !record(json.totals) || !Array.isArray(json.requests)) throw new EngineError("unsupported metrics JSON format");
  return json;
}

const metricKinds = { kvCachePercent: "context", ttftP95RecentSeconds: "queueExcluded", tpotP95RecentSeconds: "tokenWeightedMean" };

// totals.prompt_tokens includes reused tokens; prompt_ms is the time spent reading the others.
function readTotals(totals = {}) {
  const prompt = number(totals.prompt_tokens), cached = number(totals.reused);
  const reusedWithinPrompt = prompt !== null && cached !== null && cached <= prompt;
  const prefillMs = number(totals.prompt_ms);
  return {
    generationTotal: number(totals.output_tokens),
    promptTotal: prompt,
    promptComputeTotal: reusedWithinPrompt ? prompt - cached : null,
    promptCacheTotal: cached,
    prefillTimeTotal: prefillMs === null ? null : prefillMs / 1000,
    prefillCount: number(totals.requests),
    completedRequestsTotal: number(totals.requests),
    processStartedAt: isoTime(totals.since),
    // requests[].hit_rate belongs to Strata's expert cache, not its prompt cache.
    prefixCacheHitPercent: reusedWithinPrompt && prompt > 0 ? cached / prompt * 100 : null,
  };
}

function readStrataPrometheus(metrics, json) {
  const reading = readVllmMetrics(metrics);
  const state = metrics.get("strata:live_state")?.find(sample => sample.value === 1)?.labels.state;
  const busy = state === "reading" || state === "generating";
  const livePrefill = metricValue(metrics, "strata:live_prefill_tok_s_mean", {}, null);
  return {
    ...reading,
    ...readTotals(json?.totals),
    modelName: typeof json?.engine?.model === "string" ? json.engine.model : null,
    metricKinds,
    prefillActive: state === "reading",
    decodeTokensPerSecond: state === "generating" ? metricValue(metrics, "strata:live_tok_s", {}, null)
      : state === "idle" || state === "unloaded" ? 0 : null,
    ...(busy && livePrefill > 0 ? { prefillTokensPerSecond: livePrefill, prefillRateKind: "request" } : {}),
    kvCachePercent: busy && metricValue(metrics, "strata:engine_max_context", {}, null) > 0 ? reading.kvCachePercent : null,
    tpotBuckets: histogramBuckets(metrics, "vllm:inter_token_latency_seconds"),
    tpotP95Seconds: histogramQuantile(metrics, "vllm:inter_token_latency_seconds", 0.95),
  };
}

function contextPercent(engine, live) {
  const ctx = number(engine.max_context);
  if (!ctx || !["reading", "generating"].includes(live.state)) return null;
  const slots = Array.isArray(live.slots) ? live.slots.filter(slot => ["reading", "generating"].includes(slot?.state)) : [];
  const active = slots.length ? slots : [live];
  const used = active.map(slot => {
    const prompt = number(slot.prompt_tokens), generated = number(slot.generated);
    return prompt === null || generated === null ? null : Math.min(1, (prompt + generated) / ctx);
  });
  return used.some(value => value === null) ? null : used.reduce((sum, value) => sum + value, 0) / used.length * 100;
}

export function readStrataMetrics(json, metrics) {
  if (metrics?.size) return readStrataPrometheus(metrics, json);
  const { engine, live, totals } = json;
  const offered = number(totals.drafts_offered), accepted = number(totals.drafts_accepted);
  const queued = number(live.queued);
  const running = number(live.running) ?? RUNNING.get(live.state) ?? null;
  return {
    modelName: typeof engine.model === "string" ? engine.model : null,
    metricKinds,
    prefillActive: live.state === "reading",
    ...(["reading", "generating"].includes(live.state) && number(live.prefill_tok_s_mean) !== null
      ? { prefillTokensPerSecond: number(live.prefill_tok_s_mean), prefillRateKind: "request" } : {}),
    ...readTotals(totals),
    liveGenerationTotal: null,
    // live.tok_s is null unless the state is generating.
    decodeTokensPerSecond: running === 0 ? 0 : number(live.tok_s),
    runningRequests: running,
    waitingRequests: queued === null ? null : queued + (number(live.waiting) ?? 0),
    kvCachePercent: contextPercent(engine, live),
    speculativeAcceptancePercent: offered > 0 && accepted !== null && accepted <= offered ? accepted / offered * 100 : null,
    ttftP95Seconds: null,
    tpotP95Seconds: null,
    ttftBuckets: [],
    tpotBuckets: [],
  };
}
