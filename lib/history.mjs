// The in-memory chart history: what /api/state sends for the selected range, and the active output average.

export const HISTORY_FIELDS = ["outputTokensPerSecond", "promptTokensPerSecond", "runningRequests", "queue"];
export const HISTORY_NODE_FIELDS = ["temperature", "memoryAvailableBytes"];

const mean = (values) => {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
};

// At most targetCount points: consecutive samples are averaged into one point stamped with the last one's time.
// Missing values are left out of an average, and a bucket with none stays null so the chart line breaks.
export function downsampleHistory(points, targetCount = 360) {
  if (points.length <= targetCount) return points;
  const bucketSize = Math.ceil(points.length / targetCount);
  const output = [];
  for (let index = 0; index < points.length; index += bucketSize) {
    const bucket = points.slice(index, index + bucketSize);
    const last = bucket.at(-1);
    const averaged = { ...last };
    for (const key of HISTORY_FIELDS) averaged[key] = mean(bucket.map((point) => point[key]));
    averaged.nodes = Object.fromEntries(Object.keys(last.nodes ?? {}).map((id) => [id,
      Object.fromEntries(HISTORY_NODE_FIELDS.map((field) => [field, mean(bucket.map((point) => point.nodes?.[id]?.[field]))]))]));
    output.push(averaged);
  }
  return output;
}

// The mean output rate over the samples with requests running (idle periods would pull it towards zero).
export function summarizeHistory(points, minutes = 60) {
  const activeOutputRates = points
    .filter((point) => point.runningRequests > 0 && Number.isFinite(point.outputTokensPerSecond))
    .map((point) => point.outputTokensPerSecond);
  return {
    activeOutputTokensPerSecond: activeOutputRates.length
      ? activeOutputRates.reduce((sum, value) => sum + value, 0) / activeOutputRates.length
      : null,
    activeSamples: activeOutputRates.length,
    windowMinutes: minutes,
  };
}

