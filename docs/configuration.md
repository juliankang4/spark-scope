# Configuration

[README](../README.md) · [Topology](topology.md) · **Configuration** · [Web page](dashboard.md) · [Rack panel](rack.md) · [HTTP API](api.md) · [Development](development.md)

The server is set with environment variables, all optional. Display preferences (units, colours, readings, design, language) are not set here: they live in each browser's settings ([Web page](dashboard.md#settings)), and the rack panel reads them from its address ([Rack panel](rack.md#units-colours-and-motion)).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SPARK_SCOPE_HOST` | `127.0.0.1` | Listen address. Set `0.0.0.0` (or a specific address) to serve other machines; see [Security](../README.md#security). |
| `SPARK_SCOPE_PORT` | `8787` | Listen port. |
| `SPARK_SCOPE_API_URL` | `http://127.0.0.1:8000` | Base URL of the OpenAI-compatible inference server, `http://` or `https://` and without a user name or password. With [model servers](topology.md#model-servers) in `topology.json`, each server's `api` is used instead. The dashboard reads `/health`, `/metrics` and `/v1/models`, plus `/slots` for llama.cpp live output speed while requests run. vLLM listens on 8000 by default, SGLang on 30000, TensorFold, llama.cpp and Strata on 8080. |
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

As a service, the same variables go on `Environment=` lines in the unit ([Running as a service](../README.md#running-as-a-service)).

## Inference engines

- **vLLM**: read directly from its `vllm:*` metrics.
- **SGLang**: its `sglang:*` metrics are mapped onto the same fields. Run SGLang with `--enable-metrics`. Differences:
  - decode and output speed come from SGLang's own throughput gauge while requests are running, because SGLang adds a request's output tokens to its counter only when the request finishes;
  - prefill time uses SGLang's time-to-first-token histogram (it includes queue time), and TPOT its inter-token latency histogram;
  - the cache hit rate is cached prompt tokens over all prompt tokens since start;
  - speculative acceptance is SGLang's recent-window gauge rather than a lifetime ratio.
- **TensorFold**: it repeats its readings under vLLM's names with a `tensorfold:` prefix, which fill the same fields; on CUDA its `/health` adds a few counters. Its metrics are always on. Differences:
  - output speed comes from `/health`'s count of reply tokens, which includes replies still streaming, because TensorFold adds a reply's tokens to its counter only when the request finishes (the Mac server has no such count, so there the speed rises when replies end);
  - the cache hit rate and the prefill rates come from `/health`'s totals for finished requests, and read `unknown` on the Mac server;
  - KV cache is how full the running streams' context windows are on average, not the share of cache memory in use;
  - TPOT reads `unknown`: TensorFold has no per-token latency histogram.
- **llama.cpp** (`llama-server`): read from `llamacpp:*` metrics. Start it with `--metrics`; its default API port is 8080. Tested with b11193. Differences:
  - live output speed comes from increases in each processing slot's `next_token[].n_decoded`, tracked by slot id and `id_task` through GET `/slots` (enabled by default). The completed output counter feeds the ledger, not live speed;
  - `/slots` is read only while `/metrics` reports running requests: unlike `/metrics`, `/health` and `/v1/models`, a `/slots` request wakes a server started with `--sleep-idle-seconds` and restarts its idle timer. A poll with no running request reads zero and sets a zero-token baseline. The next active poll counts from zero over the time since that baseline, so the first reading of a request can be low;
  - if `/slots` is disabled or unavailable (for example HTTP 501), live output speed reads `unknown` while requests run. A series that starts with requests already running (after either side restarts, or after `/slots` failed) needs two valid slot samples. Rates are timed from when the `/slots` reply arrives;
  - when a task ends or a slot starts a new one, the tokens the earlier task produced after the last poll are missing from live speed, but the ledger still counts them;
  - input totals add computed and reported cached prompt tokens. Older builds without `prompt_tokens_cached_total` count computed tokens only, and cached tokens stay `unknown`;
  - completed request counts stay `unknown`: running and deferred request gauges are not counters of completed requests;
  - TTFT and TPOT p95, KV cache usage and cache hit rate read `unknown`;
  - speculative acceptance uses the reported draft and accepted token counters when available.
- **Strata**: read from the JSON that its `/metrics` returns by default. Its metrics are always on and its default API port is 8080. Tested with 0.1.41. Differences:
  - the dashboard reads only `/health`, `/metrics` and `/v1/models`. None of them loads the model or counts as activity for Strata's `--idle-unload`, so polling neither wakes an unloaded model nor keeps a loaded one from unloading. A server that has unloaded its model, or started with `lazy_load` and not loaded it yet, reads as idle with zero output speed;
  - live output speed is `live.tok_s`, which Strata reports only while generating, so it reads `unknown` while a prompt is read. The completed output counter feeds the ledger, not live speed;
  - running requests are 1 while Strata reads a prompt or generates, or `live.running` when it serves several requests at once (`"parallel": N`); waiting requests are `live.queued` plus `live.waiting`;
  - input totals are `totals.prompt_tokens`, which includes the tokens reused from Strata's prompt cache, and computed input is that total minus `totals.reused`. The cache hit rate is reused over prompt tokens. The `hit_rate` of each request belongs to Strata's expert cache, a different measure, and is not used;
  - TTFT and TPOT p95 and KV cache usage read `unknown`: the JSON has no latency histogram or KV usage reading;
  - speculative acceptance is accepted over offered draft tokens;
  - a server started with an API key answers `/metrics` with HTTP 401, so the dashboard cannot read it: it sends no key.
- Other engines (Ollama, TensorRT-LLM, Triton) are recognised by process or image name on the node cards, but their throughput and token metrics are not read.

The engine label comes from the metric names (or Strata's JSON format) or the GPU process name, and the number of serving nodes from how many nodes run a GPU process; neither is assumed. In multi-node serving, point `SPARK_SCOPE_API_URL` at the node that hosts the API.
