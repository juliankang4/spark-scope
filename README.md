# Spark Scope

A read-only dashboard for NVIDIA DGX Spark-class machines (DGX Spark, ASUS Ascent GX10, MSI EdgeXpert and other GB10 boxes) and the vLLM or SGLang server running on them. It works with a single node or a small cluster.

I wrote it for my own four-node ring (three ASUS GX10s and an MSI EdgeXpert) in a 10-inch rack. This repository is that dashboard with my hostnames taken out and the layout reworked for one and two nodes. The 2U rack modules for the GX10 are on [MakerWorld](https://makerworld.com/en/models/3380382).

It is one Node.js process with no npm dependencies. It polls each node (locally or over SSH), reads the inference server's Prometheus metrics, keeps a token ledger in SQLite and serves two pages: the web dashboard at `/` and a 1920 x 480 rack panel at `/rack/`.

## Screenshots

The screenshots use synthetic data from `tools/fixtures.mjs`.

Web dashboard, four nodes:

![Web dashboard with four nodes](docs/screenshots/dashboard-4-nodes.png)

Rack panel, four nodes while serving, then with one node down and a broken link:

![Rack panel with four nodes](docs/screenshots/rack-4-nodes.png)

![Rack panel showing a node that stopped responding](docs/screenshots/rack-4-nodes-fault.png)

Rack panel with a single node:

![Rack panel with one node](docs/screenshots/rack-1-node.png)

Phone, dark theme, two nodes joined by two cables:

<img src="docs/screenshots/dashboard-phone-2-nodes.png" alt="Web dashboard on a phone with two nodes" width="300">

## What it shows

**Scope tab**

- **Node cards.** GPU load, temperature, power, SM clock and free unified memory. A details panel adds free disk, inference process memory, CPU load (1-minute load average and core count), NVMe and ConnectX NIC chip temperatures, every ACPI thermal zone by its firmware name (on GB10 boards TSOC, TS0E, TS0P, TS1E, TS1P, TGPU and TUNC), system state and failed units, the inference container, the TP rank and NVIDIA kernel errors (Xid, `NV_ERR_NO_MEMORY`) from the last 24 hours. Sensors, the container and the TP rank only appear when the node reports them. The status line adds up the GPU power of all nodes. GB10 systems expose no fan speed and no whole-system power, so neither is shown.
- **Node interconnect** (two or more nodes). A diagram and a table of every QSFP cable: the state of each logical plane (A/B), measured traffic in Gb/s, and whether the link is up, partially up, down, slow or not cabled yet. A single node has no such panel.
- **Inference.** Output tok/s over 15 minutes, 1 hour or 6 hours, with the active average and the queue. Below it: prefill, cache-read and decode rates, TTFT and TPOT p95, prefix-cache hit rate, KV-cache use, speculative-decoding acceptance and running/waiting requests.
- **Trends.** GPU temperature and available memory per node, and today's token totals.

**Token ledger tab**

Daily and monthly totals of logical input, new (computed) input, cache-read input, output and requests, the last seven days of output, and a month picker. The ledger is stored on disk. Everything else resets when the server restarts.

A new ledger starts from what the engine reports at that moment: tokens served before the dashboard first ran are not booked. A counter the engine does not export (vLLM without per-source prompt counters, for example) reads as `unknown` in the ledger rather than 0. If the ledger file cannot be opened, token counting is switched off and the rest of the dashboard keeps working.

The page follows the viewer's light or dark setting and has a toggle. It works on phones and shows times in the viewer's time zone. A value that was not observed shows as `unknown`, never as zero.

**Rack panel (`/rack/`)**

A dark 1920 x 480 panel for a bar display or a Raspberry Pi kiosk. Each node gets a bay with its GPU temperature (with the last hour drawn behind it), GPU load, memory and disk use, power, TSOC and a coloured dot per link. The bottom band shows the cluster state, the model and engine, node and link counts with the total GPU power, output tok/s over the last five minutes and today's tokens. See [Rack panel and kiosk](#rack-panel-and-kiosk).

## Requirements

- Node.js 22.13 or later (24 LTS recommended). The token ledger uses the built-in `node:sqlite`. Ubuntu 24.04's packaged `nodejs` is too old, so install Node from nodejs.org, NodeSource or a version manager such as nvm. Some Node versions print an "SQLite is an experimental feature" warning on start; it is harmless.
- On each monitored node: Linux with `bash`, `nvidia-smi` and the usual coreutils. DGX OS already has everything. `systemd`, `journalctl` and `docker` are used when present.
- For remote nodes: an SSH client on the dashboard machine and key-based SSH access to each node.
- Optionally an inference server with Prometheus metrics: vLLM (on by default) or SGLang (start it with `--enable-metrics`).

## Quick start: one node, dashboard on the Spark itself

The shipped `topology.json` describes a single node collected locally (`"host": "local"`), so no SSH is involved.

```bash
cd spark-scope
node --version          # 22.13 or later
SPARK_SCOPE_API_URL=http://127.0.0.1:8000 npm start
```

Open <http://127.0.0.1:8787/> on the Spark. To look at it from your laptop without exposing it on the network, forward the port over SSH and open the same address locally:

```bash
ssh -L 8787:127.0.0.1:8787 you@your-spark
```

Use `SPARK_SCOPE_API_URL=http://127.0.0.1:30000` for SGLang's default port. If no inference server is running, the node card still works and the inference panels read `unknown` or `stopped`.

## Multi-node setup (SSH)

The dashboard can run on one of the Sparks (that node uses `"host": "local"`, the others SSH) or on any other Linux or macOS machine that can reach them (every node uses SSH). Nothing is installed on the nodes: each poll sends a read-only shell script to `bash -s` over SSH and parses its output.

1. **Create a dedicated key** on the dashboard machine:

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_spark_scope -N "" -C spark-scope
   ```

2. **Authorize it on each node** by appending one line to `~/.ssh/authorized_keys` of the account the dashboard will use, with forwarding and terminals disabled:

   ```text
   no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA...your-public-key... spark-scope
   ```

   These options stop the key from being used for tunnels, agent forwarding or an interactive terminal. They do not limit which commands it can run: the collector needs a shell, so the key can run anything that account can. Use an account whose privileges you are comfortable with. (A forced `command="bash -s"` would not add protection, because the script arrives on stdin.)

3. **Add an SSH alias** per node in `~/.ssh/config` on the dashboard machine. The alias is what `topology.json` calls `host`:

   ```text
   Host spark-2
       HostName spark-2.lan              # a resolvable name or an IP address
       User your-user
       IdentityFile ~/.ssh/id_ed25519_spark_scope
       IdentitiesOnly yes
       # Optional: reuse one connection for the polls every five seconds.
       ControlMaster auto
       ControlPath ~/.ssh/spark-scope-%C
       ControlPersist 10m
   ```

4. **Accept each host key once, after checking it.** The collector runs SSH with `BatchMode=yes`, so an unknown or changed host key makes the poll fail instead of prompting. Connect once by hand and compare the fingerprint with the node's own (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the node):

   ```bash
   ssh spark-2 true
   ssh -o BatchMode=yes spark-2 'nvidia-smi -L'   # must work without any prompt
   ```

   To keep these keys separate from your everyday `known_hosts`, add `UserKnownHostsFile ~/.ssh/known_hosts_spark_scope` and `StrictHostKeyChecking yes` to the `Host` block after the first connection.

5. **Describe the cluster** by copying an example and editing it (see the next section):

   ```bash
   cp examples/topology.2-node.json topology.json
   npm start
   ```

Optional permissions on the nodes: kernel error summaries need read access to the kernel journal (`journalctl -k`), which non-root accounts get through the `systemd-journal` or `adm` group. Without it the panel says "Kernel diagnostics unavailable". Container details need access to the Docker socket. Membership of the `docker` group is equivalent to root, so do not grant it just for this dashboard. Without it, container details are not shown.

## Topology (`topology.json`)

`topology.json` maps dashboard cards to machines and cables to network interfaces. The server reads it at start; restart after editing. `SPARK_SCOPE_TOPOLOGY` can point at another file. If the default `topology.json` is missing, the server falls back to one locally collected node named after the machine.

| Example | Layout |
|---|---|
| `examples/topology.1-node.json` | One node, collected locally. Same as the shipped `topology.json`. |
| `examples/topology.2-node.json` | Two nodes joined by two cables (port 0 to port 0, port 1 to port 1). The dashboard runs on `spark-1`; `spark-2` is polled over SSH. Delete the second link if you use one cable. |
| `examples/topology.3-node.json` | Three-node ring polled over SSH. Each node's port 0 goes to the next node's port 1. |
| `examples/topology.4-node.json` | Four-node ring polled over SSH, same cabling pattern. |

Node fields:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Short unique id (letters, digits, `_`, `-`; up to 16). Shown in the interconnect diagram. |
| `name` | no | Display name on the card (defaults to `id`). |
| `host` | yes, unless `collect` is false | `"local"` to run the collector on this machine without SSH, or an SSH destination: a `~/.ssh/config` alias (recommended), a hostname, an address or `user@host`. |
| `local` | no | `true` is the same as `"host": "local"`. At most one node can be local. |
| `role` | no | `HEAD`, `WORKER` or anything else; shown under the name. |
| `hardware` | no | Free text shown under the name, for example `DGX Spark`, `ASUS Ascent GX10` or `MSI EdgeXpert`. |
| `collect` | no | `false` shows a card without contacting the node (for a machine that is not set up yet). Its links can still be judged from the other end. |
| `inference` | no | `false` lets this node run without an inference process while the API serves, without degrading the status. |
| `expectedRank` | no | If set, the TP rank parsed from the node's GPU process name must match it. |

Link fields:

| Field | Required | Meaning |
|---|---|---|
| `ends` | yes | Exactly two objects `{ "node": "<id>", "a": "<netdev>", "b": "<netdev>" }`. `a` and `b` are the interfaces of the two logical planes on that end; either may be omitted. |
| `id` | no | Unique id. Defaults to `<node>-<node>`, numbered when several cables join the same pair. |
| `label` | no | Display label. Defaults to `<node>–<node>`, plus `#1`, `#2` for parallel cables. |
| `cabled` | no | `false` for a cable that is not installed yet: dark ports read "not cabled yet" instead of "down" and do not degrade the status. |

On a DGX Spark-class machine each QSFP port of the ConnectX-7 appears as two network interfaces on different PCIe domains. Port 0 is `enp1s0f0np0` (plane A) and `enP2p1s0f0np0` (plane B); port 1 is `enp1s0f1np1` and `enP2p1s0f1np1`. Check yours with `ip -br link` or `ibdev2netdev`, and find which port a cable uses with `cat /sys/class/net/<interface>/carrier` while plugging it in. Traffic is read from the matching RoCE counters (`rocep1s0f0` and so on) when RDMA devices exist, otherwise from the interface statistics. Links run at 200 Gb/s per plane on these machines; a lower negotiated speed is flagged as slow (see `SPARK_SCOPE_LINK_MIN_GBPS`).

A plane is up when every end that could be observed has carrier. One observed end is enough, because a direct-attach cable only has carrier while its peer is up. A link that no collected node can see is `unknown`, not down.

## Configuration

All settings are optional environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `SPARK_SCOPE_HOST` | `127.0.0.1` | Listen address. Set `0.0.0.0` (or a specific address) to serve other machines; see Security. |
| `SPARK_SCOPE_PORT` | `8787` | Listen port. |
| `SPARK_SCOPE_API_URL` | `http://127.0.0.1:8000` | Base URL of the OpenAI-compatible inference server. The dashboard reads `/health`, `/metrics` and `/v1/models`. vLLM listens on 8000 by default, SGLang on 30000. |
| `SPARK_SCOPE_TOPOLOGY` | `topology.json` next to `server.mjs` | Topology file. When set explicitly, a missing file is an error. |
| `SPARK_SCOPE_USAGE_DB` | `$XDG_DATA_HOME/spark-scope/usage.sqlite` (`~/.local/share/...`) | Token ledger database. The directory is created if needed. |
| `SPARK_SCOPE_TIME_ZONE` | the server's time zone | IANA time zone (for example `America/Los_Angeles`) that decides where ledger days begin. The page shows it next to the ledger. |
| `SPARK_SCOPE_NODE_INTERVAL_MS` | `5000` | Node polling interval in milliseconds, at least 1000. Each poll is limited to 4.5 seconds, and each `nvidia-smi` or `docker` call in it to 1.5 seconds. |
| `SPARK_SCOPE_API_INTERVAL_MS` | `2000` | Inference metrics polling interval in milliseconds, at least 500. |
| `SPARK_SCOPE_LINK_MIN_GBPS` | `200` | Per-plane speed below which an up link counts as slow. |

Example for a two-node cluster whose head serves SGLang, viewed from the LAN:

```bash
SPARK_SCOPE_HOST=0.0.0.0 SPARK_SCOPE_API_URL=http://127.0.0.1:30000 SPARK_SCOPE_TOPOLOGY=$PWD/topology.json npm start
```

## Running as a service

`systemd/spark-scope.service.example` is a systemd user unit with placeholders. Copy it to `~/.config/systemd/user/spark-scope.service`, adjust `WorkingDirectory`, `ExecStart` (the path from `command -v node`) and the `Environment=` lines, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now spark-scope
journalctl --user -u spark-scope -f
sudo loginctl enable-linger "$USER"   # keep it running without a login session
```

## Inference engines

- **vLLM**: read directly from its `vllm:*` metrics.
- **SGLang**: its `sglang:*` metrics are mapped onto the same fields. Run SGLang with `--enable-metrics`. Differences: prefill time uses SGLang's time-to-first-token histogram (it includes queue time), TPOT uses its inter-token latency histogram, the cache hit rate is cached prompt tokens over all prompt tokens since start, and speculative acceptance is SGLang's recent-window gauge rather than a lifetime ratio.
- Other engines (llama.cpp, Ollama, TensorRT-LLM, Triton) are recognised by process or image name on the node cards, but their throughput and token metrics are not read.

The engine label comes from the metric names or the GPU process name, and the number of serving nodes from how many nodes run a GPU process; neither is assumed. In multi-node serving point `SPARK_SCOPE_API_URL` at the node that hosts the API.

## Rack panel and kiosk

Open `/rack/` (for example <http://127.0.0.1:8787/rack/>). The panel is laid out at 1920 x 480 and scales to fit the window, so it suits the common 1920 x 480 bar displays and works, letterboxed, on anything else. It reads `/api/state` every 2 seconds (every 30 seconds for the temperature traces), dims and says so when the server stops answering, and reloads itself every 12 hours while the server answers, so it picks up updates without touching the kiosk.

- **Layout by node count.** Three or four nodes share the width. Two nodes get two centred bays. A single node gets one wide bay with its meters side by side and no link dots. With two cables between two nodes, each bay shows a numbered dot per cable (`2 #1`, `2 #2`).
- **What the bays and the band say.** Each bay header shows its most severe condition: no response, missing GPU readings (`nvidia-smi stuck`, `GPU query timed out`, `GPU query failed`, `no nvidia-smi`), thermal slowdown, a link problem (`Link 2–3 down`, `Link 1–2 #2 down`, `Link 1–2 not cabled`), system state or failed units, a missing inference process while the API serves, disk at 95% or more, less than 2 GiB of free memory, or (for ten minutes) a container restart or a kernel error. The band shows the cluster title (Serving, Ready, Inference stopped, Inference down, Nodes unreachable), the model with its engine, node and link counts and up to two notes.
- **Other display sizes.** `?width=N` (1440 to 3840) lays the panel out N pixels wide instead of 1920, still 480 tall, so a display of another aspect ratio is filled edge to edge: use N = 480 x display width / display height (for example `?width=2560` for 2560 x 480 or 1280 x 240). Keep four nodes at 1920 or wider.

### Raspberry Pi kiosk (Raspberry Pi OS, labwc/Wayland)

The `kiosk/` folder has the three pieces. The Pi can run the dashboard itself or only show a dashboard that runs elsewhere.

1. Install the script and make it executable:

   ```bash
   mkdir -p ~/.local/bin ~/.config/autostart ~/.config/labwc
   install -m 755 kiosk/spark-scope-kiosk ~/.local/bin/spark-scope-kiosk
   ```

2. Autostart it with the desktop session: copy `kiosk/spark-scope-kiosk.desktop` to `~/.config/autostart/`, replace `YOUR_USER` with your account name and set the URL. `lwrespawn` (part of Raspberry Pi OS) restarts the kiosk if Chromium exits. The desktop must log in automatically (`sudo raspi-config`, System Options, Boot / Auto Login, Desktop Autologin).

3. Hide the mouse pointer: copy `kiosk/labwc-rc.xml` to `~/.config/labwc/rc.xml` (or merge its `<windowRules>` block into yours) and reload labwc with `kill -HUP $(pgrep -x labwc)`, or log out and in. The page hides the cursor itself, but on Wayland that only takes effect once the pointer enters the window; the labwc rule moves the pointer into the kiosk window and hides it.

4. Set the screen resolution and rotation in Raspberry Pi OS's Screen Configuration. If the panel does not fill the display, add `?width=N` to the URL as described above.

The script waits until `/api/health` answers before it opens Chromium, uses its own Chromium profile under `~/.local/share/spark-scope-kiosk`, and takes `SPARK_SCOPE_RACK_URL` and `CHROMIUM` from the environment.

**Showing a dashboard that runs on another machine.** Point `SPARK_SCOPE_RACK_URL` at it, for example `http://dashboard-host:8787/rack/` on the LAN or the machine's Tailscale name or address on a tailnet. The dashboard must then listen beyond localhost (`SPARK_SCOPE_HOST=0.0.0.0` or that interface's address), which exposes it to everyone on that network; see Security. To keep the dashboard on localhost instead, forward the port from the Pi with SSH (for example a user service running `ssh -N -L 8787:127.0.0.1:8787 dashboard-host`) and keep the default URL.

## HTTP API

- `GET /` and `GET /rack/`: the web dashboard and the rack panel.
- `GET /api/state?minutes=15|60|360`: the full dashboard state as JSON: `topology` (nodes and links, without interface names), `nodes` keyed by node id, `ringLinks` keyed by link id (`state` is `up`, `partial`, `down`, `pending` or `unknown`), `vllm` (inference metrics, also used for SGLang), `serving`, `usage`, `history` and `historyStats`.
- `GET /api/health`: `status`, `message` and `updatedAt`; HTTP 503 when nothing can be reached.
- `GET /api/usage?month=YYYY-MM`: one month of the token ledger.

## Security

- **No authentication and no TLS.** Anyone who can reach the port can see node names, SSH aliases, model names, kernel error messages and token counts.
- **Localhost by default.** The server binds to `127.0.0.1`. Use SSH port forwarding, or expose it on a LAN or a private overlay network such as Tailscale only if you trust everyone on it. Do not expose it to the internet; if you need remote access with authentication, put it behind a reverse proxy that provides it.
- **Read-only.** The node script only reads system state (`nvidia-smi` queries, `/proc`, `/sys`, `df`, `systemctl` status, `journalctl -k`, `docker ps`/`inspect`); it never starts, stops or changes anything. The inference server is only read through `GET` requests. The pages load nothing from other hosts.
- **The SSH key can run commands** as the account it logs in to (see the multi-node setup). Use a dedicated key, the `authorized_keys` options above and an account you are comfortable with.
- Topology values are validated before they reach SSH or the script (interface names, host aliases), and SSH never prompts.

## Limitations

- Only the first GPU reported by `nvidia-smi` is shown per node, which matches GB10 systems.
- TSOC/TS1P temperatures and the A/B plane layout are specific to DGX Spark-class hardware. Other Linux machines with an NVIDIA GPU mostly work, but those parts read `unknown` or need a matching topology.
- One inference server per dashboard.
- Charts are kept in memory for six hours and reset when the server restarts or the served model changes.
- The token ledger adds up counter increases. Tokens served while the dashboard is down are counted when it returns. After an engine restart the new run counts from its own start: vLLM reports its start time, and for SGLang, which does not, a restart is recognised when its counters fall below the last values seen. If an SGLang run restarted while the dashboard was down and has already passed those values, the part of the previous run the dashboard never saw is lost. Latency p95 values are since engine start, not a rolling window.
- A node whose `nvidia-smi` hangs, fails or is missing is shown as such (and degrades the cluster status) rather than as healthy with blank readings. A poll that hits its 4.5-second limit keeps the readings that arrived and is marked incomplete.
- The page treats data older than 20 seconds as stale by comparing the server's timestamp with the viewer's clock, so a viewer clock that is far off shows the server as not responding.
- Numbers use one fixed format (`1,234.5`, `1.06B`) whatever the viewer's locale. Times and dates follow the viewer's locale and time zone.
- The rack panel is designed for 1920 x 480; other sizes are scaled or need `?width=`, and four nodes need at least 1920 logical pixels of width.

## Fonts

`public/fonts/` bundles latin subsets of Archivo (text and numbers) and Bebas Neue (the rack panel's large figures), each under the SIL Open Font License 1.1 with its license text next to it. They keep that license whatever license applies to the rest of Spark Scope. Without them the pages fall back to the system UI font.

## Development

```bash
npm test
node tools/render.mjs        # optional: needs Chrome or Chromium
```

The tests use only `node:test` and cover topology parsing (including one-node, two-cable and ring layouts), link and cluster status, the collector script and local-mode dispatch, metric parsing for vLLM and SGLang, the token ledger, the browser-side formatting and diagram layout, the rack panel's view logic for one to four nodes, and the HTTP routes of a running server. They do not contact any other machine.

`tools/render.mjs` serves the pages with synthetic data (`tools/fixtures.mjs`) for one to four nodes and renders the rack panel and the web dashboard (desktop and phone) in headless Chrome through the DevTools protocol. It writes PNGs to `$OUT` (default: a `spark-scope-renders` folder in the system temp directory) and reports clipped or overlapping text, horizontal overflow and script errors. Set `CHROME` if Chrome is not found, and `COUNTS=1,2` to limit the node counts. The screenshots in this README come from it.

## License

MIT, see [LICENSE](LICENSE). The bundled fonts keep their own license (SIL Open Font License 1.1, see [Fonts](#fonts)).
