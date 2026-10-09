# HTTP API

[README](../README.md) · [Topology](topology.md) · [Configuration](configuration.md) · [Web page](dashboard.md) · [Rack panel](rack.md) · **HTTP API** · [Development](development.md)

All responses are JSON unless noted, carry the server's security headers and are refused when the `Host` header names another site ([Security](../README.md#security)).

## Pages

- `GET /`: the web dashboard.
- `GET /rack/`: the rack panel ([Rack panel](rack.md)).
- `GET /mini/`: the mini window as a page of its own ([Web page](dashboard.md#mini-window)).

## `GET /api/state?minutes=15|60|360[&history=0]`

The full dashboard state, gzip-compressed when the client accepts it. `history=0` leaves out the samples: the web page requests that at its refresh interval (2 seconds by default) and the rack panel every 2 seconds, and both fetch the full history every 30 seconds.

| Field | Contents |
|---|---|
| `topology` | Nodes, links and model servers, without interface names or API URLs. |
| `nodes` | Node readings keyed by node id. A failed node carries a short `error` such as `timed out` or `SSH authentication failed`; the full message is in the server log. |
| `ringLinks` | Links keyed by link id; `state` is `up`, `partial`, `down`, `pending` or `unknown`. |
| `servers` | One entry per model server ([Model servers](topology.md#model-servers)): `id`, `name`, `nodes`, `implicit` (true for the single server at `SPARK_SCOPE_API_URL`), and its own `inference`, `serving` and `inferenceState`. |
| `inference` | The first server's inference metrics, for vLLM, SGLang, TensorFold, llama.cpp and Strata, including `prefillUpdatedAt` (when prefill work was last observed, from counter increases or the engine's live window and state). Also sent under its earlier name `vllm` for scripts written against earlier versions; that alias will be removed in a later release. |
| `serving`, `inferenceState` | Which of the first server's nodes serve, and the inference state of the whole cluster: `serving` while any server serves, `stopped` when every server is. |
| `usage` | Today's token totals, over every server. |
| `history`, `historyStats` | Chart samples for the requested range. The output, prompt, running and queue fields are totals over the servers; with several servers each sample also has every server's own under `servers`. |
| `status`, `message` | The cluster status and its message in English. |
| `messageKey`, `messageParams` | The same message as a stable key, such as `status.nodeConnection`, and its values, such as `{"connected": 3, "count": 4}`. The pages show a known key in their own language and `message` otherwise. |
| `startedAt`, `updatedAt` | When the server started and when this state was built. |
| `pollIntervals` | The node and API poll intervals, which the page uses to decide when data is stale. |
| `version` | The Spark Scope version, shown under About in the settings. |
| `rackSeenAt` | When a rack panel last polled (time only, kept in memory); the rack adds `from=rack` to its requests. |

It leaves out what the pages do not show: the engine URL and local model path, interface names and raw SSH error text.

Mac node readings carry `platform: "darwin"`, `thermalPressure` (0 to 4), `power.hasBattery` (true, false, or null before the battery service is known), `power.systemWatts`, `power.batteryPercent` and `power.onAC` (null without battery telemetry). `memory.pressureLevel`, `memory.freePercent` and `memory.compressedBytes` describe OS memory pressure. Apple Silicon's `gpu.memory` uses system memory for total, used and available bytes, with `inUseBytes` and `allocatedBytes` for the GPU's own share. `gpu.cores` is the GPU core count. Failed polls retain the last platform and battery-service presence but not their numeric readings. GPU temperature, GPU power, clock and Linux-only diagnostics remain null or unavailable in the API and are hidden on the pages.

Each inference reading includes field support and meaning:

| Field | Contents |
|---|---|
| `reported` | Boolean map. `false` hides an unsupported or currently inapplicable field, not a temporary missing reading. Keys are `outputTokensPerSecond`, `promptTokensPerSecond`, `promptComputeTokensPerSecond`, `promptCacheTokensPerSecond`, `prefixCacheHitPercent`, `speculativeAcceptancePercent`, `requests` (running and waiting together), `kvCachePercent`, `ttftP95RecentSeconds`, `tpotP95RecentSeconds`, `meanDecodeSeconds` and `completedRequestsTotal`. The last counter remains server-side; the ledger exposes its support as `usage.reported.requests`. |
| `metricKinds` | Optional meaning overrides by field: `context` for context occupancy rather than KV memory, `twoSecond` for engine-reported rates with a two-second window, `request` for a live prompt rate, `sinceStart` for llama.cpp cache hit since engine start, `queueExcluded` for Strata TTFT, `tokenWeightedMean` for Strata TPOT, and `requestMean` for TensorFold TPOT. Omitted entries keep the usual meaning. |
| `meanDecodeSeconds` | llama.cpp's mean generation seconds per output token from counter increases between polls. Null until two valid samples exist; held while no new generation completes. It is separate from TPOT p95, whose fields stay null for llama.cpp. |

Field support does not guarantee a numeric reading: first polls, empty histograms and transient failures can still yield null. A failed collection preserves the last known `reported` and `metricKinds` maps without retaining stale numeric values. Before an engine is identified, failures have no support map and remain unknown. `latencyWindowSeconds` is zero when neither latency histogram exists, so an absent histogram does not become "no requests".

For llama.cpp, `outputTokensPerSecond` comes from live `/slots` counters and is null while requests run if slots are disabled or unavailable. `prefixCacheHitPercent` is cached prompt tokens over computed plus cached prompt tokens since engine start. `kvCachePercent` is processing-slot context occupancy from the same `/slots` response, with `metricKinds.kvCachePercent = "context"`, and stays reported while idle or without context data. The value is null; the pages show **no requests** only when the engine reports zero running requests. The ledger counts computed plus reported cached input and completed output tokens, but no completed requests. Older builds without the cached-token counter report computed input only.

For Strata, a single Prometheus `/metrics` response supplies TTFT and inter-token histograms. `outputTokensPerSecond` is its own live rate and is null while a prompt is read. `prefixCacheHitPercent` is reused over prompt tokens, not expert-cache hit rate. `kvCachePercent` is the newest running request's context occupancy, with a persistent row showing **no requests** while idle. A second JSON metrics read supplies `totals.since` and the ledger counters from one snapshot to preserve the ledger session across format changes and restarts between scrapes. A missing start time makes that poll unknown. The JSON fallback has no latency histograms. The ledger counts input including reused tokens, computed and cached input, output tokens and completed requests.

For native TensorFold 1.0.2, output speed uses increases in the highest observed `generation_tokens_running + generation_tokens_total` sum within the run, because TensorFold updates the two values at different moments when a stream ends; a scrape that lands between them can still shift a few tokens into the next sample, but the total stays right. The baseline resets when the finished counter falls or the model changes. Its ledger still uses finished output only. Without both metrics, `/health.live.decode_tokens_per_second` is a two-second fallback, identified by `metricKinds.outputTokensPerSecond = "twoSecond"`. Health supplies the two-second prefill rate, with the prefill histogram supplying the held logical-input rate when live prefill is unavailable. Cache support follows counter presence: query and hit counters for cache hit, cached-token counters for cache read. KV is labelled context occupancy. The 0.6 Python CUDA health counter path remains supported. Tests replay trimmed native-server captures; a live dashboard connection is not covered. See [Inference engines](configuration.md#inference-engines) for the latency definitions and version limits.

## `GET /api/health`

`status`, `message` and `updatedAt`; HTTP 503 when nothing can be reached. The kiosk script waits for it before opening Chromium.

## `GET /api/usage?month=YYYY-MM`

One month of the token ledger:

| Field | Contents |
|---|---|
| `days` | Each day's totals and its `models`, largest first. |
| `totals` | The month's totals. |
| `models` | Each model's totals for the month and the number of `days` it was used. |
| `firstDay` | The ledger's first booked day. |
| `firstMonth`, `lastMonth` | The months the ledger covers. |
| `day`, `timeZone` | Today in the ledger's time zone, and that time zone. |
