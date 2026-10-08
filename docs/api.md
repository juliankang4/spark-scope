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
| `inference` | The first server's inference metrics, for vLLM, SGLang, TensorFold and llama.cpp, including `prefillUpdatedAt` (when new prefills last completed, since the prefill rates are held between them). Also sent under its earlier name `vllm` for scripts written against earlier versions; that alias will be removed in a later release. |
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

For llama.cpp, `outputTokensPerSecond` comes from live `/slots` counters and is null while requests run if slots are disabled or unavailable. TTFT/TPOT p95, KV usage and cache hit rate are null. The ledger counts computed plus reported cached input tokens and completed output tokens, but has no completed request counter. Older builds without the cached-token counter report computed input only. See [Inference engines](configuration.md#inference-engines).

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
