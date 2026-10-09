import { metricTotal } from "./prometheus.mjs";

const counter = value => Number.isSafeInteger(value) && value >= 0;
const IDLE_SLOT = Object.freeze({ task: null, decoded: 0 });

function slotCounters(slots) {
  if (!Array.isArray(slots)) return null;
  const result = new Map();
  for (const slot of slots) {
    if (!slot || !counter(slot.id) || typeof slot.is_processing !== "boolean" || result.has(slot.id)) return null;
    if (!slot.is_processing) {
      result.set(slot.id, IDLE_SLOT);
      continue;
    }
    if (!counter(slot.id_task) || !Array.isArray(slot.next_token) || !slot.next_token.length) return null;
    if (!slot.next_token.every(token => token && counter(token.n_decoded))) return null;
    const decoded = slot.next_token.reduce((sum, token) => sum + token.n_decoded, 0);
    if (!counter(decoded)) return null;
    result.set(slot.id, { task: slot.id_task, decoded });
  }
  return result;
}

export class LlamacppSlots {
  constructor() {
    this.previous = null;
  }

  reset() {
    this.previous = null;
  }

  idle(at, modelName) {
    this.previous = { allIdle: true, slots: new Map(), at, modelName };
    return 0;
  }

  rate(slots, at, modelName) {
    const current = slotCounters(slots);
    const previous = this.previous;
    const active = current && [...current].filter(([, slot]) => slot.task !== null);
    this.previous = current && { allIdle: !active.length, slots: current, at, modelName };
    if (!active) return null;
    if (!active.length) return 0;
    if (!previous || previous.modelName !== modelName || at <= previous.at) return null;
    let generated = 0;
    for (const [id, slot] of active) {
      const earlier = previous.allIdle ? IDLE_SLOT : previous.slots.get(id);
      if (!earlier) return null;
      const continued = earlier.task === slot.task;
      if (continued && slot.decoded < earlier.decoded) return null;
      generated += slot.decoded - (continued ? earlier.decoded : 0);
    }
    return generated / ((at - previous.at) / 1000);
  }
}

export function slotContextPercent(slots) {
  if (!Array.isArray(slots)) return null;
  const active = slots.filter(slot => slot?.is_processing === true);
  if (!active.length) return null;
  const ratios = active.map(slot => {
    if (!counter(slot.n_ctx) || slot.n_ctx === 0 || !counter(slot.n_prompt_tokens)) return null;
    return Math.min(1, slot.n_prompt_tokens / slot.n_ctx);
  });
  return ratios.some(ratio => ratio === null) ? null : ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length * 100;
}

export function holdLlamacppAverages(current, previous, held = null) {
  const comparable = fields => previous && previous.engine === current.engine && previous.modelName === current.modelName
    && fields.every(key => Number.isFinite(current[key]) && Number.isFinite(previous[key]) && current[key] >= previous[key]);
  let prefixCacheHitPercent = null, meanDecodeSeconds = null;
  const computed = current.promptComputeTotal, cached = current.promptCacheTotal;
  if (counter(computed) && counter(cached) && computed + cached > 0) {
    prefixCacheHitPercent = cached / (computed + cached) * 100;
  }
  if (comparable(["generationTotal", "decodeTimeTotal"])) {
    const generated = current.generationTotal - previous.generationTotal;
    const seconds = current.decodeTimeTotal - previous.decodeTimeTotal;
    meanDecodeSeconds = generated > 0 ? seconds / generated : held?.meanDecodeSeconds ?? null;
  }
  return { prefixCacheHitPercent, meanDecodeSeconds };
}

// llama.cpp b11193 counts computed prompt tokens separately from reused prompt tokens.
export function readLlamacppMetrics(metrics) {
  const value = name => metricTotal(metrics, `llamacpp:${name}`);
  const compute = value("prompt_tokens_total");
  const cached = value("prompt_tokens_cached_total");
  const draft = value("spec_decode_num_draft_tokens_total");
  const accepted = value("spec_decode_num_accepted_tokens_total");
  return {
    generationTotal: value("tokens_predicted_total"),
    decodeTimeTotal: value("tokens_predicted_seconds_total"),
    liveGenerationTotal: null,
    metricKinds: { kvCachePercent: "context", prefixCacheHitPercent: "sinceStart" },
    promptTotal: compute === null ? null : compute + (cached ?? 0),
    promptComputeTotal: compute,
    promptCacheTotal: cached,
    prefillTimeTotal: value("prompt_seconds_total"),
    prefillCount: null,
    runningRequests: value("requests_processing"),
    waitingRequests: value("requests_deferred"),
    kvCachePercent: null,
    prefixCacheHitPercent: null,
    speculativeAcceptancePercent: draft > 0 && accepted !== null && accepted >= 0 ? accepted / draft * 100 : null,
    ttftP95Seconds: null,
    tpotP95Seconds: null,
    ttftBuckets: [],
    tpotBuckets: [],
    completedRequestsTotal: null,
    processStartedAt: null,
  };
}
