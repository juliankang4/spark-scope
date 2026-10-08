function unescapeLabel(value) {
  return value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

export function parsePrometheus(text) {
  const metrics = new Map();
  const samplePattern = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([^\s]+)(?:\s+\d+)?$/;
  const labelPattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(samplePattern);
    if (!match) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    const labels = {};
    if (match[2]) {
      for (const labelMatch of match[2].matchAll(labelPattern)) {
        labels[labelMatch[1]] = unescapeLabel(labelMatch[2]);
      }
    }
    const sample = { name: match[1], labels, value };
    if (!metrics.has(sample.name)) metrics.set(sample.name, []);
    metrics.get(sample.name).push(sample);
  }
  return metrics;
}

export function copyMetrics(metrics) {
  return new Map([...metrics].map(([name, samples]) => [name, [...samples]]));
}

export function metricValue(metrics, name, labels = {}, fallback = 0) {
  const samples = metrics.get(name) ?? [];
  const match = samples.find((sample) => Object.entries(labels).every(([key, value]) => sample.labels[key] === value));
  return match?.value ?? fallback;
}

export function metricSum(metrics, name, labels = {}) {
  return (metrics.get(name) ?? [])
    .filter((sample) => Object.entries(labels).every(([key, value]) => sample.labels[key] === value))
    .reduce((sum, sample) => sum + sample.value, 0);
}

function matching(metrics, name, labels) {
  return (metrics.get(name) ?? []).filter((sample) => Object.entries(labels).every(([key, value]) => sample.labels[key] === value));
}

// Sum over every matching series; vLLM with data parallelism exposes one series per engine. null when the engine
// does not export the metric at all, so a missing value is never shown or stored as a zero.
export function metricTotal(metrics, name, labels = {}) {
  const samples = matching(metrics, name, labels);
  return samples.length ? samples.reduce((sum, sample) => sum + sample.value, 0) : null;
}

// Mean over the matching series, for per-engine gauges such as KV cache usage; null when absent.
export function metricMean(metrics, name, labels = {}) {
  const samples = matching(metrics, name, labels);
  return samples.length ? samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length : null;
}

// Cumulative buckets of one histogram, sorted by bound. Buckets with the same "le" from several series (one per
// engine) are added together.
export function histogramBuckets(metrics, name) {
  const byBound = new Map();
  for (const sample of metrics.get(`${name}_bucket`) ?? []) {
    const le = sample.labels.le === "+Inf" ? Infinity : Number(sample.labels.le);
    if (!(Number.isFinite(le) || le === Infinity)) continue;
    byBound.set(le, (byBound.get(le) ?? 0) + sample.value);
  }
  return [...byBound].map(([le, count]) => ({ le, count })).sort((a, b) => a.le - b.le);
}

// p-quantile interpolated linearly inside the bucket that reaches it, as Prometheus' histogram_quantile() does;
// when it falls in the +Inf bucket, the highest finite bound; null with no observations. The result is an estimate
// whose precision depends on the engine's buckets.
export function bucketsQuantile(buckets, quantile) {
  if (!buckets?.length) return null;
  const total = buckets.at(-1).count;
  if (!Number.isFinite(total) || total <= 0) return null;
  const rank = total * quantile;
  const index = buckets.findIndex((bucket) => bucket.count >= rank);
  if (index < 0) return null;
  const bucket = buckets[index];
  const below = index > 0 ? buckets[index - 1] : { le: 0, count: 0 };
  if (!Number.isFinite(bucket.le)) return index > 0 && Number.isFinite(below.le) ? below.le : null;
  if (bucket.count === below.count) return bucket.le;
  return below.le + (bucket.le - below.le) * ((rank - below.count) / (bucket.count - below.count));
}

export function histogramQuantile(metrics, name, quantile) {
  return bucketsQuantile(histogramBuckets(metrics, name), quantile);
}

// The observations added between two snapshots of a cumulative histogram; null when the bounds differ or a count
// went down, which means the engine restarted in between.
export function bucketsSince(current, earlier) {
  if (!current || !earlier || current.length !== earlier.length) return null;
  const delta = [];
  for (let index = 0; index < current.length; index++) {
    if (current[index].le !== earlier[index].le || current[index].count < earlier[index].count) return null;
    delta.push({ le: current[index].le, count: current[index].count - earlier[index].count });
  }
  return delta;
}

// Quantiles over a recent window (5 minutes), from the difference between the newest snapshot of the cumulative
// histograms and the newest one at least a window older, like rate() in Prometheus. The engine's own quantiles cover
// everything since it started. An engine restart, or a gap longer than the window, starts a new series; until two
// snapshots exist, and while the window is shorter than 5 minutes, the quantiles cover what there is.
export class RecentHistograms {
  constructor(windowMs = 5 * 60_000) {
    this.windowMs = windowMs;
    this.snapshots = [];
  }

  add(at, histograms) {
    const last = this.snapshots.at(-1);
    const keys = new Set([...Object.keys(histograms), ...Object.keys(last?.histograms ?? {})]);
    if (last && (at - last.at > this.windowMs || [...keys].some((key) => !bucketsSince(histograms[key], last.histograms[key])))) this.snapshots = [];
    this.snapshots.push({ at, histograms });
    while (this.snapshots.length > 2 && this.snapshots[1].at <= at - this.windowMs) this.snapshots.shift();
  }

  // Seconds between the oldest and newest snapshot; 0 until there are two.
  get windowSeconds() {
    return this.snapshots.length > 1 ? (this.snapshots.at(-1).at - this.snapshots[0].at) / 1000 : 0;
  }

  // null until there are two snapshots, and when nothing finished in the window.
  quantile(key, quantile) {
    if (this.snapshots.length < 2) return null;
    return bucketsQuantile(bucketsSince(this.snapshots.at(-1).histograms[key], this.snapshots[0].histograms[key]), quantile);
  }
}
