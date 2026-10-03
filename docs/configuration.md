# Configuration

[README](../README.md) · [Topology](topology.md) · **Configuration** · [Web page](dashboard.md) · [Rack panel](rack.md) · [HTTP API](api.md) · [Development](development.md)

The server is set with environment variables, all optional. Display preferences (units, colours, readings, design, language) are not set here: they live in each browser's settings ([Web page](dashboard.md#settings)), and the rack panel reads them from its address ([Rack panel](rack.md#units-colours-and-motion)).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SPARK_SCOPE_HOST` | `127.0.0.1` | Listen address. Set `0.0.0.0` (or a specific address) to serve other machines; see [Security](../README.md#security). |
| `SPARK_SCOPE_PORT` | `8787` | Listen port. |
| `SPARK_SCOPE_API_URL` | `http://127.0.0.1:8000` | Base URL of the OpenAI-compatible inference server. The dashboard reads `/health`, `/metrics` and `/v1/models`. vLLM listens on 8000 by default, SGLang on 30000. |
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
- Other engines (llama.cpp, Ollama, TensorRT-LLM, Triton) are recognised by process or image name on the node cards, but their throughput and token metrics are not read.

The engine label comes from the metric names or the GPU process name, and the number of serving nodes from how many nodes run a GPU process; neither is assumed. In multi-node serving, point `SPARK_SCOPE_API_URL` at the node that hosts the API.
