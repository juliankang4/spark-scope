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
  catch { throw new Error("invalid metrics JSON"); }
  if (!record(json) || !record(json.engine) || !record(json.live) || typeof json.live.state !== "string"
    || !record(json.totals) || !Array.isArray(json.requests)) throw new Error("unsupported metrics JSON format");
  return json;
}

export function readStrataMetrics(json) {
  const { engine, live, totals } = json;
  const prompt = number(totals.prompt_tokens), cached = number(totals.reused);
  const reusedWithinPrompt = prompt !== null && cached !== null && cached <= prompt;
  const prefillMs = number(totals.prompt_ms);
  const offered = number(totals.drafts_offered), accepted = number(totals.drafts_accepted);
  const queued = number(live.queued);
  const running = number(live.running) ?? RUNNING.get(live.state) ?? null;
  return {
    modelName: typeof engine.model === "string" ? engine.model : null,
    generationTotal: number(totals.output_tokens),
    liveGenerationTotal: null,
    // totals.prompt_tokens counts the reused tokens too; totals.prompt_ms is the time spent reading the others.
    promptTotal: prompt,
    promptComputeTotal: reusedWithinPrompt ? prompt - cached : null,
    promptCacheTotal: cached,
    prefillTimeTotal: prefillMs === null ? null : prefillMs / 1000,
    prefillCount: number(totals.requests),
    // live.tok_s is null unless the state is generating.
    decodeTokensPerSecond: running === 0 ? 0 : number(live.tok_s),
    runningRequests: running,
    waitingRequests: queued === null ? null : queued + (number(live.waiting) ?? 0),
    kvCachePercent: null,
    // requests[].hit_rate is the hit rate of Strata's expert cache, not of its prompt cache.
    prefixCacheHitPercent: reusedWithinPrompt && prompt > 0 ? cached / prompt * 100 : null,
    speculativeAcceptancePercent: offered > 0 && accepted !== null && accepted <= offered ? accepted / offered * 100 : null,
    ttftP95Seconds: null,
    tpotP95Seconds: null,
    ttftBuckets: [],
    tpotBuckets: [],
    completedRequestsTotal: number(totals.requests),
    processStartedAt: isoTime(totals.since),
  };
}
