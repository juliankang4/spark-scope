// What /api/state sends to browsers: everything the pages show, without engine URLs or local model paths,
// interface names, or raw SSH error text (which can carry user@address). The server keeps the full readings for the
// link states and the token ledger, and logs the full collection errors.

// The inference fields the pages read (also documented in docs/api.md).
export const INFERENCE_FIELDS = [
  "ok", "engine", "modelName", "latencyMs", "reported", "metricKinds", "meanDecodeSeconds",
  "outputTokensPerSecond", "promptTokensPerSecond", "promptComputeTokensPerSecond", "promptCacheTokensPerSecond",
  "runningRequests", "waitingRequests", "kvCachePercent", "prefixCacheHitPercent", "speculativeAcceptancePercent",
  "ttftP95Seconds", "tpotP95Seconds", "ttftP95RecentSeconds", "tpotP95RecentSeconds", "latencyWindowSeconds", "prefillUpdatedAt", "updatedAt", "error",
];

const NODE_ERRORS = [
  [/timed out/i, "timed out"],
  [/permission denied|authentication/i, "SSH authentication failed"],
  [/host key|remote host identification/i, "SSH host key check failed"],
  [/could not resolve|name or service not known|nodename nor servname/i, "host name not found"],
  [/connection refused|no route to host|network is unreachable|connection timed out|connect to host|connection closed|connection reset/i, "SSH connection failed"],
  [/ENOENT|not found/i, "command not found"],
];

// A short reason for a failed node poll; the full message goes to the server log.
export function nodeErrorSummary(message) {
  if (!message) return null;
  return NODE_ERRORS.find(([pattern]) => pattern.test(message))?.[1] ?? "collection failed";
}

export function publicInference(inference) {
  if (!inference) return null;
  return Object.fromEntries(INFERENCE_FIELDS.filter((key) => key in inference).map((key) => [key, inference[key]]));
}

export function publicNode(node) {
  if (!node) return node;
  const { network, hostname, error, ...rest } = node;
  return { ...rest, error: nodeErrorSummary(error) };
}

// state is the server's live state; extra is merged last (history, historyStats, pollIntervals).
export function publicState(state, extra = {}) {
  const inference = publicInference(state.inference);
  return {
    ...state,
    inference,
    // The same object under its earlier name, for pages and scripts written against earlier versions.
    vllm: inference,
    servers: (state.servers ?? []).map((server) => ({ ...server, inference: publicInference(server.inference) })),
    nodes: Object.fromEntries(Object.entries(state.nodes ?? {}).map(([id, node]) => [id, publicNode(node)])),
    ...extra,
  };
}
