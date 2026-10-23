// The in-memory chart history: what /api/state sends for the selected range, and the active output average. The chart
// fields are totals over the model servers; with several, each point also has every server's own under `servers`.

export const HISTORY_FIELDS = ["outputTokensPerSecond", "promptTokensPerSecond", "runningRequests", "queue"];
export const HISTORY_NODE_FIELDS = ["temperature", "memoryAvailableBytes"];

// The mean of one field over a bucket, read with pick; non-finite values are left out, and null when none is left.
// Added in the bucket's order, so the result is the same as summing a filtered list.
function mean(bucket, pick) {
  let sum = 0, count = 0;
  for (const point of bucket) {
    const value = pick(point);
    if (Number.isFinite(value)) { sum += value; count += 1; }
  }
  return count ? sum / count : null;
}

// At most targetCount points: consecutive samples are averaged into one point stamped with the last one's time.
// Missing values are left out of an average, and a bucket with none stays null so the chart line breaks. A six-hour
// window holds about 10,800 samples, so the averages read the samples in place instead of copying them per field.
export function downsampleHistory(points, targetCount = 360) {
  if (points.length <= targetCount) return points;
  const bucketSize = Math.ceil(points.length / targetCount);
  const output = [];
  for (let index = 0; index < points.length; index += bucketSize) {
    const bucket = points.slice(index, index + bucketSize);
    const last = bucket.at(-1);
    const averaged = { ...last };
    for (const key of HISTORY_FIELDS) averaged[key] = mean(bucket, (point) => point[key]);
    averaged.nodes = Object.fromEntries(Object.keys(last.nodes ?? {}).map((id) => [id,
      Object.fromEntries(HISTORY_NODE_FIELDS.map((field) => [field, mean(bucket, (point) => point.nodes?.[id]?.[field])]))]));
    // With several model servers, each server's own fields are averaged the same way.
    if (last.servers) {
      averaged.servers = Object.fromEntries(Object.keys(last.servers).map((id) => [id,
        Object.fromEntries(HISTORY_FIELDS.map((field) => [field, mean(bucket, (point) => point.servers?.[id]?.[field])]))]));
    }
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

