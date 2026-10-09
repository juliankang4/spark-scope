# Configuration

[README](../README.md) · [Topology](topology.md) · **Configuration** · [Web page](dashboard.md) · [Rack panel](rack.md) · [HTTP API](api.md) · [Development](development.md)

The server is set with environment variables, all optional. Display preferences (units, colours, readings, design, language) are not set here: they live in each browser's settings ([Web page](dashboard.md#settings)), and the rack panel reads them from its address ([Rack panel](rack.md#units-colours-and-motion)).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SPARK_SCOPE_HOST` | `127.0.0.1` | Listen address. Set `0.0.0.0` (or a specific address) to serve other machines; see [Security](../README.md#security). |
| `SPARK_SCOPE_PORT` | `8787` | Listen port. |
| `SPARK_SCOPE_API_URL` | `http://127.0.0.1:8000` | Base URL of the OpenAI-compatible inference server, `http://` or `https://` and without a user name or password. With [model servers](topology.md#model-servers) in `topology.json`, each server's `api` is used instead. The dashboard reads `/health`, `/metrics` and `/v1/models`, plus `/slots` for llama.cpp live output speed while requests run. oMLX uses `/api/status` after its health response identifies it. vLLM and oMLX listen on 8000 by default, SGLang on 30000, TensorFold, llama.cpp and Strata on 8080. |
| `SPARK_SCOPE_API_KEY` | none | Optional engine Bearer key, read from the process environment for a single server. With several topology servers, each uses its own optional `apiKeyEnv` variable name instead. |
| `SPARK_SCOPE_TOPOLOGY` | `~/.config/spark-scope/topology.json` if it exists, otherwise `topology.json` next to `server.mjs` | Topology file. When set explicitly, a missing file is an error. |
| `SPARK_SCOPE_USAGE_DB` | `$XDG_DATA_HOME/spark-scope/usage.sqlite` (`~/.local/share/...`) | Token ledger database. The directory is created if needed. |
| `SPARK_SCOPE_TIME_ZONE` | the server's time zone | IANA time zone (for example `America/Los_Angeles`) that decides where ledger days begin. The page shows it next to the ledger. |
| `SPARK_SCOPE_NODE_INTERVAL_MS` | `5000` | Node polling interval in milliseconds, at least 1000. Each poll is limited to 4.5 seconds, and each `nvidia-smi` or `docker` call in it to 1.5 seconds. |
| `SPARK_SCOPE_API_INTERVAL_MS` | `2000` | Inference metrics polling interval in milliseconds, at least 500. |
| `SPARK_SCOPE_LINK_MIN_GBPS` | `200` | Per-plane speed below which an up link counts as slow. |
| `SPARK_SCOPE_ALLOWED_HOSTS` | none | Extra host names the pages may be opened under, comma-separated (`dash.example.org`); an entry starting with `.` allows a whole domain (`.lab.example`), `*` turns the check off. localhost, IP addresses and this machine's hostname (also `<hostname>.local` and `<hostname>.<tailnet>.ts.net`) always work. |

Example for a two-node cluster whose head serves SGLang, viewed from the LAN:

```bash
SPARK_SCOPE_HOST=0.0.0.0 SPARK_SCOPE_API_URL=http://127.0.0.1:30000 npm start
```

As a service, the same variables go on `Environment=` lines in the unit ([Running as a service](../README.md#running-as-a-service)). Load keys from a protected service environment or secret manager. Do not put key values in shell commands, process arguments, URLs or topology files. The dashboard sends the configured key as `Authorization: Bearer` on every engine GET poll, regardless of engine type. An unset variable sends no key. Multiple servers do not inherit `SPARK_SCOPE_API_KEY`; `apiKeyEnv` must name a variable for each keyed server. Only a single topology server without `apiKeyEnv` falls back to `SPARK_SCOPE_API_KEY`.

Keys are kept inside the collector and omitted from public state, logs, error messages and node-collector child environments. An explicitly named `apiKeyEnv` that is empty or unset produces a startup warning with only the server id. The configured `apiKeyEnv` string is never printed, because it may contain a mistakenly pasted key. Authenticated requests do not follow redirects. Use a trusted loopback address or HTTPS when sending a key. The dashboard performs only GET reads; an engine's key may grant broader privileges, so use the least-privileged key the engine supports.

## Mac nodes

Apple Silicon Macs use the same topology as Linux nodes. `"host": "local"` collects the Mac running Spark Scope; an SSH alias collects a remote Mac through `bash -s`. The collector uses built-in macOS commands and needs no sudo or helper binary.

- GPU load and GPU memory in use come from the IOAccelerator driver's `PerformanceStatistics`. Shared memory is identified by the Apple M-series chip name, never by a host name. The memory bar and free-memory slot use system memory; GPU memory in use is its separate GPU share.
- Memory used is `(anonymous - purgeable + wired + compressor pages) * page size`, with available memory equal to total minus used. The OS pressure level controls memory warnings (2 is warning, 4 is critical); a missing pressure reading causes no warning. Swap and compressed memory are also collected.
- Disk figures come from `/System/Volumes/Data`, rather than the sealed root volume. CPU load, core count and uptime use `sysctl`. oMLX's process is detected by `omlx-server` or its serving launcher; `llama-server` is also detected. A bounded `footprint` read reports process memory in bytes, including GPU allocations when accessible.
- The temperature slot shows thermal pressure state. Pressure levels 2 and above set the thermal-slowdown flag. The power slot shows MacBook whole-system power. It stays unknown when a reading temporarily fails; without a battery service, it shows swap use. That reading refreshes about once a minute; it is not GPU power and is excluded from GPU power totals. The clock slot shows GPU memory in use. These replacements keep the corresponding slots selected in the settings. NVMe and NIC slots show swap use and compressed memory respectively.
- GPU temperature, GPU power, clock, NVMe/NIC temperatures, ACPI zones and kernel diagnostics are hidden. Temperature trends and the rack temperature figure are hidden for Mac nodes. The mini window hides the GPU power chip when no node reports it and names the reporting-node count for a partial total. The server keeps the last platform and battery-service presence across failed polls, so unavailable Mac readings keep their labels without stale values.

## Inference engines

- **vLLM**: read directly from its `vllm:*` metrics.
- **SGLang**: its `sglang:*` metrics are mapped onto the same fields. Run SGLang with `--enable-metrics`. Differences:
  - decode and output speed come from SGLang's own throughput gauge while requests are running, because SGLang adds a request's output tokens to its counter only when the request finishes;
  - prefill time uses SGLang's time-to-first-token histogram (it includes queue time), and TPOT its inter-token latency histogram;
  - the cache hit rate is cached prompt tokens over all prompt tokens since start;
  - speculative acceptance is SGLang's recent-window gauge rather than a lifetime ratio.
- **TensorFold**: version 1.0 and later use the native Zig server, not the earlier Python server. Its `tensorfold:` families map to vLLM's names. The 1.0.2 parser fixtures contain trimmed captures of a running native server's `/metrics` and `/health`, matching [upstream metrics](https://github.com/ashhart/TensorFold/blob/v1.0.2/zig/src/server/metrics.zig) and [live status](https://github.com/ashhart/TensorFold/blob/v1.0.2/zig/src/server/live.zig). Tests replay captures, not a live dashboard connection. Differences:
  - output speed prefers increases in `generation_tokens_running + generation_tokens_total`, combining tokens in live streams with finished output. A stream can leave the running gauge before its tokens enter the finished counter. The rate therefore uses the highest sum seen in the same run. It needs two valid polls and resets when the finished counter falls or the model changes. The ledger keeps only finished output;
  - if those two metrics are unavailable, `/health`'s `live.decode_tokens_per_second` supplies the fallback, labelled **Decode (2 s)** because it covers a two-second window;
  - **Prefill (2 s)** is `live.prefill_tokens_per_second`: computed tokens over the last prompt pass's duration, retained for two seconds, then zero. Without that live reading, `request_prefill_time_seconds` (the mirror of `request_prefill_seconds`) supplies the held logical-input rate from its sum and count;
  - cache hit is shown only when prefix-cache query and hit counters are reported. Cache read needs a cached-token counter. Native 1.0.2 has no such counters, so both are hidden. A backend that exports them can fill these fields without an engine-name rule; backends without prompt caching keep them hidden;
  - the 0.6 Python CUDA `/health` counter path remains supported when those counters are present;
  - **Context used** is the average occupancy of the running streams' context windows, not KV memory use. The row stays visible while idle and reads **no requests**;
  - TPOT p95 comes from `request_time_per_output_token_seconds`: the p95 of each finished reply's mean token gap. One-token replies add no observation. On older builds without that histogram the field is hidden;
  - with API keys, configure the dashboard's Bearer key or start 1.0.2 with `--metrics-open` for unkeyed metrics. `/health` then returns status only. The metrics-based output rate still works, but the health rate fallback is unavailable. The dashboard never sends `reset_peak=1`.
- **llama.cpp** (`llama-server`): read from `llamacpp:*` metrics. Start it with `--metrics`; its default API port is 8080. Tested with b11193. Differences:
  - live output speed comes from increases in each processing slot's `next_token[].n_decoded`, tracked by slot id and `id_task` through GET `/slots` (enabled by default). The completed output counter feeds the ledger, not live speed;
  - `/slots` is read only while `/metrics` reports running requests: unlike `/metrics`, `/health` and `/v1/models`, a `/slots` request wakes a server started with `--sleep-idle-seconds` and restarts its idle timer. A poll with no running request reads zero and sets a zero-token baseline. The next active poll counts from zero over the time since that baseline, so the first reading of a request can be low;
  - if `/slots` is disabled or unavailable (for example HTTP 501), live output speed reads `unknown` while requests run. A series that starts with requests already running (after either side restarts, or after `/slots` failed) needs two valid slot samples. Rates are timed from when the `/slots` reply arrives;
  - when a task ends or a slot starts a new one, the tokens the earlier task produced after the last poll are missing from live speed, but the ledger still counts them;
  - input totals add computed and reported cached prompt tokens. Older builds without `prompt_tokens_cached_total` count computed tokens only and hide cache read and cache hit;
  - **Cache hit since start** is cached prompt tokens divided by computed plus cached prompt tokens since the engine started. It is unknown until the reported sum is positive. These counters update at different times during a request, so the ratio can change before the request finishes;
  - **Mean decode time** replaces TPOT p95: the increase in generation seconds divided by the increase in output tokens between polls, held until another generation completes. The token count includes the first token, but generation time does not, so this is not an unbiased mean inter-token gap and is not p95;
  - **Context used** is the average of `n_prompt_tokens / n_ctx` over processing slots, capped at 100% per slot, from the `/slots` response already read for live speed. In b11193, `n_prompt_tokens` already includes generated tokens. The row stays visible with **no requests** while idle, or **unknown** when an active slot lacks context data. No endpoint is added;
  - TTFT and completed-request counts are hidden: no per-request latency or completed-request counter is exported. Running and deferred requests remain visible;
  - speculative acceptance uses the reported draft and accepted token counters when available.
- **Strata**: a `/metrics` request with `Accept: text/plain` selects its Prometheus format, also available as `?format=prometheus`. The `strata:` families identify it even though it also emits vLLM names. Its default API port is 8080. JSON collection was tested with 0.1.41; the Prometheus fixture is rendered by that version's [upstream formatter](https://github.com/Niko1221/Strata/blob/v0.1.41/serve/prometheus.py). Differences:
  - the dashboard reads only `/health`, `/metrics` and `/v1/models`. None of them loads the model or counts as activity for Strata's `--idle-unload`, so polling neither wakes an unloaded model nor keeps a loaded one from unloading. A server that has unloaded its model, or started with `lazy_load` and not loaded it yet, reads as idle with zero output speed;
  - live output speed is `strata:live_tok_s` only in the generating state. Prometheus coerces missing rates to zero, so `strata:live_state` keeps Decode `unknown` while a prompt is read. The completed output counter feeds the ledger, not live speed;
  - **Prefill** shows the running request's reported positive prompt rate, or the held rate from finished-request totals otherwise. The label stays the same; its help explains the two sources;
  - running requests are 1 while Strata reads a prompt or generates, or `live.running` when it serves several requests at once (`"parallel": N`); waiting requests are `live.queued` plus `live.waiting`;
  - input totals are `totals.prompt_tokens`, which includes the tokens reused from Strata's prompt cache, and computed input is that total minus `totals.reused`. The cache hit rate is reused over prompt tokens. The `hit_rate` of each request belongs to Strata's expert cache, a different measure, and is not used;
  - TTFT p95 uses the first-token histogram and excludes queue and model-load time. TPOT p95 uses the inter-token histogram: a token-weighted p95 of each finished request's mean gap, not individual token times. Both use the existing five-minute histogram-difference window;
  - **Context used** is the newest running request's occupancy, not KV memory use. The row stays visible with **no requests** while idle. The Prometheus format does not export per-slot token sizes;
  - the Prometheus format omits `totals.since`. A second `/metrics` request with `Accept: application/json` reads that start time and the ledger counters from the same snapshot each poll, keeping the same ledger session across format changes and dashboard restarts. If that request fails or the start time is missing, the poll is unknown and the ledger skips it;
  - if the endpoint returns JSON despite the Accept header, the existing JSON parser remains available. It hides latency fields without histograms and uses context information from JSON, averaging processing slots when present;
  - speculative acceptance is accepted over offered draft tokens;
  - a server started with an API key needs the dashboard's environment-based Bearer key to read `/metrics`.
- **oMLX**: read-only health and status polling on Apple Silicon Macs, tested with 0.7.0. See [oMLX](#omlx) below.
- Other engines (Ollama, TensorRT-LLM, Triton) are recognised by process or image name on the node cards, but their throughput and token metrics are not read.

The engine panel and mini window hide fields that the engine does not report, using the server's `reported` map. Optional speculative acceptance is hidden when null. A failed poll retains the last known field support and shows `unknown` for supported fields. Engines without latency histograms hide those fields. vLLM and SGLang retain their latency rows before the first request creates histogram samples.

The engine label comes from the metric names, Strata's JSON format, oMLX's health shape or the GPU process name, and the number of serving nodes from how many nodes run a GPU process; neither is assumed. In multi-node serving, point `SPARK_SCOPE_API_URL` at the node that hosts the API.

### oMLX

Run Spark Scope on the Mac with its local node, or collect the Mac through SSH and point the engine URL at its reachable oMLX port. No metrics flag is needed. oMLX 0.7.0 has no `/metrics` route. Only after HTTP 404 does the dashboard identify oMLX by `/health`'s `default_model` and `engine_pool`, without needing a key. It then reads `GET /api/status`. Other engines keep their existing metrics detection order.

- With a key configured in oMLX, `/api/status` requires Bearer authentication. Set `SPARK_SCOPE_API_KEY` for a single server, or a topology server's `apiKeyEnv` variable for multiple servers. HTTP 401 reads `oMLX needs an API key`, including when a supplied key is invalid.
- Without an oMLX key and with a loopback bind, status is open. oMLX's `auth.skip_api_key_verification` setting is another no-key option, accepted only on a loopback bind. It also bypasses admin authentication; do not use it on an exposed endpoint. `allow_unauthenticated_inference` alone does not open `/api/status`.
- Polls never call admin routes, `/v1/models/status`, load, unload or stats-clear endpoints. Health and status reads do not lease an engine, load a model or refresh its idle timeout. They leave TTL unload and GPU keep-warm unchanged.
- **Mean prefill** is `avg_prefill_tps`: computed prompt tokens divided by prefill time for completed requests since server start. Cached tokens and idle time are excluded. **Mean decode** is `avg_generation_tps`: completed output tokens divided by generation time over that same session, excluding idle time. These values are already rounded by oMLX. They are not live rates, per-request means or a benchmark. Independent servers' session averages are not added in the combined mini view.
- Live output speed, the output trace and mini live-rate/run-speed views are hidden. TTFT, TPOT, KV cache, cache-read speed and speculative acceptance are also hidden because the status API does not report them. Running and waiting requests remain visible. **Cache hit since start** is cached over all prompt tokens, unknown before any prompt has completed.
- The ledger counts `total_prompt_tokens` (including cached tokens), `total_cached_tokens`, their non-negative difference, `total_completion_tokens` and `total_requests`. These counters move only when requests finish. They are server-wide, not per model.
- The display `modelName` is `default_model` with zero or one model loaded, even if another model is loaded. With several models loaded it is null. A change between non-null display labels restarts the chart. Ledger attribution always uses `default_model`, including multi-model polls. Its session key is `oMLX|server` (with a prefix for additional servers), independent of the display name. Changing the default does not rebook totals; the current default labels that server\'s daily row, including earlier tokens in that row. This is server-wide usage attributed to a label, not per-model accounting.
- `processStartedAt` is null. A drop in a completed counter starts a new ledger run. A restart whose new counters already exceed the previous reading cannot be detected from these counters alone.
