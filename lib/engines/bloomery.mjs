import { readLlamacppMetrics } from "./llamacpp.mjs";

// bloomery serves llama-server's API: llama.cpp's metric names with the same prompt token split, a few of its own,
// and the process start time in a /metrics response header. Its slots report n_past rather than n_prompt_tokens.
export const BLOOMERY_METRIC = "llamacpp:prompt_cache_seconds_total";
export const BLOOMERY_CONTEXT_FIELD = "n_past";

function startedAt(header) {
  if (!/^\d{1,12}$/.test(header ?? "")) return null;
  return new Date(Number(header) * 1000).toISOString();
}

export function readBloomeryMetrics(metrics, startHeader = null) {
  return { ...readLlamacppMetrics(metrics), processStartedAt: startedAt(startHeader) };
}
