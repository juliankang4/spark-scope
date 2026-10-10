<h1 align="center">Spark Scope</h1>

<p align="center">A read-only monitoring dashboard and rack panel for NVIDIA DGX Spark-class machines<br>and the vLLM, SGLang, TensorFold, llama.cpp, Strata or oMLX server running on them.<br>Linux machines with an NVIDIA GPU and Apple Silicon Macs running oMLX work too.</p>

<p align="center">
  <a href="https://github.com/juliankang4/spark-scope/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/juliankang4/spark-scope"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/juliankang4/spark-scope"></a>
  <img alt="Engines: vLLM, SGLang, TensorFold, llama.cpp, Strata and oMLX" src="https://img.shields.io/badge/engines-vLLM%20%7C%20SGLang%20%7C%20TensorFold%20%7C%20llama.cpp%20%7C%20Strata%20%7C%20oMLX-76b900">
</p>

<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

<p align="center"><img src="docs/screenshots/dashboard-4-nodes.png" alt="Web dashboard with four nodes"></p>

## About

Spark Scope watches NVIDIA DGX Spark-class machines (DGX Spark, ASUS Ascent GX10, MSI EdgeXpert and other GB10 boxes) and the inference server running on them, from a single node to a small cluster. Those machines come first. Other Linux machines with an NVIDIA GPU work as nodes too, and so do Apple Silicon Macs, locally or over SSH, with oMLX as their inference server or with none.

I wrote it for my own four-node ring (three ASUS GX10s and an MSI EdgeXpert) in a 10-inch rack. This repository is that dashboard with my hostnames taken out and the layout reworked for one and two nodes. The 2U rack modules for the GX10 are on [MakerWorld](https://makerworld.com/en/models/3380382).

It is one Node.js process with no npm dependencies. It polls each node (locally or over SSH), reads the inference server's metrics and keeps a token ledger in SQLite. It serves two pages: the web dashboard at `/` (above) and a 1920 x 480 rack panel at `/rack/` for a bar display or a Raspberry Pi kiosk:

![Rack panel with four nodes](docs/screenshots/rack-4-nodes.png)

- It only reads, and installs nothing on the nodes. Each poll sends a read-only shell script over SSH (or runs it locally) and parses the output. Nothing on a node or the inference server is started, stopped or changed.
- A value that was not observed reads `unknown`, never zero. Fields an engine cannot report are hidden.
- The pages load nothing from other hosts, on a desktop, a phone or a rack display.

### What it shows

- Nodes: GPU load, temperature, power, clock and free GPU memory (unified memory on a GB10, the card's own on a discrete GPU), with disk, CPU, NVMe and NIC temperatures, thermal zones, the inference container and kernel errors in the details.
- Interconnect: each QSFP cable's two planes, traffic and state (two or more nodes).
- Inference: output tok/s over 15 minutes to 6 hours, prefill and decode rates, TTFT and TPOT p95 over the last 5 minutes, cache hit, KV cache and queue.
- Token ledger: one month as a statement, a calendar or charts, with a table by model and a CSV export.
- Mini window: a small view for watching a model test, with runs recorded between Start and Stop. It stays on top of other windows in Chrome and Edge. In Safari and on phones the page itself switches to it.
- Rack panel: a bay for each of the first four nodes and a band with the cluster state, model and throughput.

More in [Web page](docs/dashboard.md) and [Rack panel](docs/rack.md). The screenshots use synthetic data from `tools/fixtures.mjs`.

## Installation

### Install with a coding agent

A coding agent such as Claude Code or Codex can do the setup below for you. Paste this prompt into it on the machine that will run the dashboard. It follows this README, asks you about your nodes and leaves the nodes and the inference server alone.

```text
Install Spark Scope (https://github.com/juliankang4/spark-scope) on this machine. Follow its
README.md, sections "Installation" and "Applying it to your setup", and ask me before each choice.

1. Clone the repository into ~/spark-scope, or a folder I name. Check that `node --version` is
   22.13 or later. If it is older, stop and show me the README's "Requirements" section.
2. Ask me how many nodes there are, and for each one whether it is this machine ("local") or
   reached over SSH, and under which SSH alias. For two or more nodes, ask how they are cabled.
   Write ~/.config/spark-scope/topology.json from the closest file in examples/ and show it to me.
3. For each SSH node, check that `ssh -o BatchMode=yes <alias> true` runs without a prompt. If it
   does not, tell me which step of "Several nodes over SSH" is missing. Do not create keys, edit
   authorized_keys or accept host keys for me.
4. Ask which inference server runs (vLLM, SGLang, TensorFold, llama.cpp, Strata, oMLX or none),
   its URL, and whether it needs an API key. If it needs one, do not ask me for the key. Create
   ~/.config/spark-scope/engine.env with mode 600 and let me add the line
   SPARK_SCOPE_API_KEY=... myself (or the variables named by apiKeyEnv for several servers).
5. If systemd is available, set up the user service as described in "Running as a service":
   fill in WorkingDirectory, ExecStart (the path from `command -v node`) and the Environment=
   lines, load engine.env with EnvironmentFile= if it exists, and keep SPARK_SCOPE_HOST=127.0.0.1
   unless I ask otherwise. Ask me before running any command that needs sudo. Without systemd
   (for example on macOS), give me the `npm start` command to run myself, with the key entered
   as the README shows under "vLLM, SGLang, TensorFold, llama.cpp, Strata or oMLX".
6. Once it runs, check `curl -s http://127.0.0.1:8787/api/health` and the last lines of the
   log. Tell me the result and the address to open.

Rules: Spark Scope only reads from the nodes and the inference server. Do not install, change,
start or stop anything on them. Never put an API key or other secret in a command argument, a
file you print, your messages or any output.
```

The manual steps follow.

### Requirements

- Node.js 22.13 or later (24 LTS recommended). The token ledger uses the built-in `node:sqlite`, and the server stops with a clear message on an older Node. The `nodejs` packages of Ubuntu 24.04 (DGX OS) and Raspberry Pi OS are too old. NodeSource has arm64 and x86 packages for both:

  ```bash
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```

  A version manager such as nvm works too. Some Node versions print an "SQLite is an experimental feature" warning on start; it is harmless.
- On a Linux node: `bash`, `nvidia-smi` and the usual coreutils. DGX OS already has everything. `systemd`, `journalctl` and `docker` are used when present. Apple Silicon Macs need only the built-in macOS tools and no sudo. To run the dashboard on a Mac, install the macOS arm64 build of Node.js.
- For remote nodes: an SSH client on the dashboard machine and key-based SSH access to each node.
- Optionally an inference server with metrics: vLLM (on by default), SGLang (start it with `--enable-metrics`), TensorFold (always on), llama.cpp (start `llama-server` with `--metrics`), Strata (always on) or oMLX (status API, no metrics flag).

### Try it without a Spark

```bash
git clone https://github.com/juliankang4/spark-scope.git
cd spark-scope
npm run demo
```

This serves the dashboard at <http://127.0.0.1:8787/>, with the rack panel at `/rack/` and the mini window at `/mini/`, all on made-up data. Nothing is collected or written, and no other machine is contacted.

Options: `npm run demo -- --nodes 2 --mode fault` shows two nodes with a fault (modes: `serving`, `fault`, `idle`). `--servers 2` splits the nodes into two model servers, and `--off` switches the last one off. `--discrete` adds a separate GPU workstation with its own VRAM after the Sparks. `--port` picks another port.

### One node: the dashboard on the Spark itself

The shipped `topology.json` describes a single node collected locally (`"host": "local"`), so no SSH is involved.

```bash
git clone https://github.com/juliankang4/spark-scope.git
cd spark-scope
node --version          # 22.13 or later
SPARK_SCOPE_API_URL=http://127.0.0.1:8000 npm start
```

Open <http://127.0.0.1:8787/> on the Spark. To look at it from your laptop without exposing it on the network, forward the port over SSH and open the same address locally:

```bash
ssh -L 8787:127.0.0.1:8787 you@your-spark
```

Use `SPARK_SCOPE_API_URL=http://127.0.0.1:30000` for SGLang's default port and `http://127.0.0.1:8080` for TensorFold, llama.cpp or Strata. If no inference server is running, the node card still works and the inference panels read `unknown` or `stopped`.

## Applying it to your setup

### Several nodes over SSH

The dashboard can run on one of the Sparks (that node uses `"host": "local"`, the others SSH) or on any other Linux or macOS machine that can reach them (every node uses SSH). Nothing is installed on the nodes: each poll sends a read-only shell script to `bash -s` over SSH and parses its output.

1. Create a dedicated key on the dashboard machine:

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_spark_scope -N "" -C spark-scope
   ```

2. Authorize it on each node by appending one line to `~/.ssh/authorized_keys` of the account the dashboard will use, with forwarding and terminals disabled:

   ```text
   no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA...your-public-key... spark-scope
   ```

   These options stop the key from being used for tunnels, agent forwarding or an interactive terminal. They do not limit which commands it can run: the collector needs a shell, so the key can run anything that account can. Use an account whose privileges you are comfortable with. (A forced `command="bash -s"` would not add protection, because the script arrives on stdin.)

3. Add an SSH alias per node in `~/.ssh/config` on the dashboard machine. The alias is what `topology.json` calls `host`:

   ```text
   Host spark-2
       HostName spark-2.lan              # a resolvable name or an IP address
       User your-user
       IdentityFile ~/.ssh/id_ed25519_spark_scope
       IdentitiesOnly yes
       # Optional: keep these host keys apart from your everyday known_hosts. Set it before the first
       # connection in step 4, so the key you accept there is stored in this file.
       UserKnownHostsFile ~/.ssh/known_hosts_spark_scope
       # Optional: reuse one connection for the polls every five seconds.
       ControlMaster auto
       ControlPath ~/.ssh/spark-scope-%C
       ControlPersist 10m
   ```

4. Accept each host key once, after checking it. The collector runs SSH with `BatchMode=yes`, so an unknown or changed host key makes the poll fail instead of prompting. Connect once by hand and compare the fingerprint with the node's own (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the node):

   ```bash
   ssh spark-2 true
   ssh -o BatchMode=yes spark-2 'nvidia-smi -L'   # must work without any prompt
   ```

   Once every node is accepted, you can add `StrictHostKeyChecking yes` to the `Host` blocks, so a changed host key is refused instead of offered.

5. Describe the cluster: copy an example to your config directory and edit it there, where `git pull` never conflicts with your edits:

   ```bash
   mkdir -p ~/.config/spark-scope
   cp examples/topology.2-node.json ~/.config/spark-scope/topology.json
   npm start
   ```

   `examples/` has one-node, two-node (two cables) and three- and four-node ring layouts. Each node has an `id`, a `host` (an SSH alias or `"local"`) and optional `name`, `role` and `hardware`; each link names the network interface of both planes at each end. Fields, interface names and link states: [Topology](docs/topology.md).

Optional permissions on the nodes: kernel error summaries need read access to the kernel journal (`journalctl -k`), which non-root accounts get through the `systemd-journal` or `adm` group. Without it the panel says "Kernel diagnostics unavailable". Container details need access to the Docker socket. Membership of the `docker` group is equivalent to root, so do not grant it just for this dashboard. Without it, container details are not shown.

### vLLM, SGLang, TensorFold, llama.cpp, Strata or oMLX

Point `SPARK_SCOPE_API_URL` at the inference server. In multi-node serving, point it at the node that hosts the API. The engine is recognised from what the server answers, so there is nothing else to set.

| Engine | Setup | Not shown, or shown differently |
|---|---|---|
| vLLM | Metrics are on by default. | Speculative acceptance only while speculative decoding is on. |
| SGLang | Start it with `--enable-metrics`. | Same as vLLM. |
| TensorFold | Metrics are always on. | Builds after 1.0.4 export prompt cache counters for models that keep prompt states, which fill cache hit and cache read; 1.0.2 to 1.0.4 hide both. Prefill is a two-second rate. |
| llama.cpp | Start `llama-server` with `--metrics`. Keep `/slots` on (the default) for live output speed. | No TTFT or completed-request count. Mean decode time replaces TPOT p95, and context use replaces KV cache. |
| Strata | Metrics are always on. | Context use replaces KV cache. |
| oMLX | No flag needed; it reads the status API. | No live output speed, TTFT, TPOT, KV cache, cache-read speed or speculative acceptance. Prefill and decode are averages over completed requests. |

The engine panel and the mini window show only the fields an engine reports. How each figure is measured: [Inference engines](docs/configuration.md#inference-engines).

Polling never loads a model, and it does not keep an idle Strata, oMLX or llama.cpp server from unloading its model. oMLX counters cover the whole server, so the model label and the ledger use its `default_model` when at most one model is loaded.

If the engine requires a key, set `SPARK_SCOPE_API_KEY` in the dashboard's environment. The key is never read from a URL or from `topology.json`. In a Bash terminal, this asks for the key without echoing it or putting it in shell history:

```bash
read -r -s -p 'Engine API key: ' SPARK_SCOPE_API_KEY
printf '\n'
export SPARK_SCOPE_API_KEY
npm start
```

The key is sent as a Bearer header on every engine GET poll, so send it only to a trusted loopback address or over HTTPS. Without a valid key, oMLX reports `oMLX needs an API key`. An oMLX bound to loopback with no key configured needs no dashboard key. Its `skip_api_key_verification` setting is another loopback-only option, but it also opens the admin routes. See [oMLX](docs/configuration.md#omlx).

When the nodes serve in separate groups (two cabled nodes each running its own model, four as 2 + 2, three as 2 + 1), list each group as a model server in `topology.json` with its API and nodes instead of setting `SPARK_SCOPE_API_URL`:

```json
"servers": [
  { "id": "a", "api": "http://spark-1:8000", "apiKeyEnv": "ENGINE_A_TOKEN", "nodes": ["1", "2"] },
  { "id": "b", "api": "http://spark-3:30000", "apiKeyEnv": "ENGINE_B_TOKEN", "nodes": ["3", "4"] }
]
```

`apiKeyEnv` is optional and names an environment variable, not a key. With several servers, a server without it sends no key; `SPARK_SCOPE_API_KEY` is not shared across them.

One dashboard then shows every server. A strip under the status line has a segment per server, and each server gets its own line on the chart and its own engine panel (the settings can show one at a time instead). The rack panel's band shows a chip per server, and one token ledger covers them all. Fields and rules: [Model servers](docs/topology.md#model-servers).

### Apple Silicon Mac nodes

The shipped one-node topology works on a Mac too. Run `SPARK_SCOPE_API_URL=http://127.0.0.1:8000 npm start` on the Mac to collect it locally and read oMLX on its default port, with the key above if oMLX needs one. To collect a Mac from another machine, use its SSH alias as the node's `host`. No helper or elevated permissions are needed.

Mac cards show GPU load and shared system memory. macOS does not report GPU temperature, GPU power or clock without root, so those slots show other readings in the same place: thermal state, whole-system power on MacBooks (swap use on a Mac without a battery) and GPU memory in use. The NVMe and NIC slots show swap use and compressed memory. A failed poll keeps the slots and their labels in place and shows the values as unknown. Linux-only diagnostics are hidden, and memory warnings follow the OS pressure level. System power refreshes about once a minute and is never counted as GPU power. Details: [Mac nodes](docs/configuration.md#mac-nodes).

### Running as a service

`systemd/spark-scope.service.example` is a systemd user unit with placeholders. Copy it to `~/.config/systemd/user/spark-scope.service`, adjust `WorkingDirectory`, `ExecStart` (the path from `command -v node`) and the `Environment=` lines, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now spark-scope
journalctl --user -u spark-scope -f
sudo loginctl enable-linger "$USER"   # keep it running without a login session
```

Keep an engine API key out of the unit file. Put the line `SPARK_SCOPE_API_KEY=...` in a file only your account can read (`chmod 600`), for example `~/.config/spark-scope/engine.env`, and load it with `EnvironmentFile=%h/.config/spark-scope/engine.env` in the `[Service]` section.

To update later, run `git pull --ff-only` and restart the service. Your topology in `~/.config/spark-scope/` and the ledger in `~/.local/share/spark-scope/` stay as they are. [CHANGELOG.md](CHANGELOG.md) notes anything a release asks you to change.

### Rack panel kiosk

A Raspberry Pi with a bar display can show `/rack/` full screen from boot. `kiosk/` has the script, the autostart entry and a labwc rule that hides the pointer. The Pi can run the dashboard itself or show one that runs elsewhere. Steps, display sizes and address options: [Rack panel](docs/rack.md#raspberry-pi-kiosk).

## DeepSeek Harness plugin (dsh-spark-scope)

[dsh-spark-scope](https://github.com/juliankang4/dsh-spark-scope) puts the Glance view of the mini window in the left sidebar of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), so you can watch the nodes and the model server while you work. It works in the browser (`dsh web`) and in the Desktop app.

<p align="center"><img src="docs/screenshots/dsh-spark-scope.png" alt="DeepSeek Harness with the Spark Scope card at the bottom of the left sidebar, showing decode and prefill rates and four nodes" width="820"></p>

```bash
dsh plugin --profile web add dsh-spark-scope
```

Then open the Spark Scope tab in the dsh settings and enter the dashboard's address. dsh fetches the data itself, so the address must work from the computer that runs dsh. A name other than localhost, an IP address or the dashboard machine's own hostname has to be added to `SPARK_SCOPE_ALLOWED_HOSTS`. The plugin only reads `/api/state`. Setup and details are in its [README](https://github.com/juliankang4/dsh-spark-scope#readme).

## Settings

<p align="center"><img src="docs/screenshots/settings.png" alt="Settings dialog, Node card section" width="820"></p>

The gear button opens the settings:

- Node card: the four readings and their order, the bars, full or short labels, the levels that turn a reading orange.
- Colors: a colour per node, from the palette or custom.
- Units: °C or °F, GiB or GB, a 24- or 12-hour clock.
- Dashboard: English or Korean, which panels to show, the chart range, the refresh interval, the design (Default, Console or Soft) and the theme.
- Rack panel: band motion and the kiosk URL with the current settings.

They are kept per browser, and "Copy settings link" carries them to another one. Details: [Web page](docs/dashboard.md#settings).

The server itself is set with environment variables. The ones most setups need:

| Variable | Default | Purpose |
|---|---|---|
| `SPARK_SCOPE_API_URL` | `http://127.0.0.1:8000` | The inference server (vLLM and oMLX listen on 8000, SGLang on 30000, TensorFold, llama.cpp and Strata on 8080). |
| `SPARK_SCOPE_API_KEY` | none | Optional Bearer key for a single server, read only from the environment. |
| `SPARK_SCOPE_HOST` | `127.0.0.1` | Listen address. `0.0.0.0` serves other machines; see [Security](#security). |
| `SPARK_SCOPE_PORT` | `8787` | Listen port. |
| `SPARK_SCOPE_TOPOLOGY` | `~/.config/spark-scope/topology.json` | Topology file (the shipped one-node `topology.json` when that does not exist). |

All of them, including the ledger's time zone and the poll intervals: [Configuration](docs/configuration.md). The JSON endpoints: [HTTP API](docs/api.md).

## Security

- There is no authentication and no TLS. Anyone who can reach the port can see node names, SSH aliases, model names, kernel error messages and token counts.
- The server binds to `127.0.0.1` by default. Use SSH port forwarding, or open it on a LAN or a private overlay network such as Tailscale only if you trust everyone on it. Do not expose it to the internet. For remote access with authentication, put it behind a reverse proxy that provides it.
- Requests whose `Host` header names another site are refused (HTTP 403). A web page elsewhere therefore cannot point its own domain at this machine (DNS rebinding) and read the API through a visitor's browser. localhost, IP addresses and this machine's hostname work out of the box. Add other names, such as a reverse proxy's, with `SPARK_SCOPE_ALLOWED_HOSTS`.
- Every response carries a Content-Security-Policy that allows only the server's own scripts, styles, fonts and requests, and forbids framing.
- The SSH key can run any command the account it logs in to can run. Use a dedicated key, the `authorized_keys` options above and an account you are comfortable with.
- An engine API key stays in the server. It is not sent to the pages or written to the logs.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Limitations

- Only the first GPU reported by `nvidia-smi` is shown per node, its VRAM included, so a machine with several GPUs shows GPU 0. GB10 systems have one.
- TSOC and TS1P temperatures and the A/B plane layout are specific to DGX Spark-class hardware. On other Linux machines with an NVIDIA GPU those parts read `unknown` or need a matching topology.
- Native TensorFold parser tests replay captured metrics; they do not cover a live dashboard connection to that server.
- Charts are kept in memory for six hours and reset when the server restarts or the served model changes. The token ledger is kept on disk and adds up counter increases. How it handles restarts: [Token ledger](docs/dashboard.md#token-ledger).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, [Development](docs/development.md) for the tests and the render check, and [CHANGELOG.md](CHANGELOG.md) for what changed between releases.

## License

MIT, see [LICENSE](LICENSE). The fonts in `public/fonts/` (Archivo and Bebas Neue) keep their own license, the SIL Open Font License 1.1, with its text next to them.
