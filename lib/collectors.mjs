import { spawn } from "node:child_process";
import { rdmaDevice } from "./topology.mjs";

const REMOTE_SCRIPT = String.raw`set -u
set -o pipefail
line() { printf '%s|%s\n' "$1" "$2"; }
# Runs a command for at most $1 seconds, so a hung nvidia-smi or docker costs one reading, not the whole poll.
# Exit 124 or 137 means it was stopped. Uses coreutils timeout when present, otherwise a shell watchdog.
limit() {
  limit_seconds="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout -k 1 "$limit_seconds" "$@"
    return
  fi
  "$@" &
  limit_pid=$!
  ( sleep "$limit_seconds"; kill -KILL "$limit_pid" 2>/dev/null ) >/dev/null 2>&1 &
  limit_watchdog=$!
  wait "$limit_pid"
  limit_rc=$?
  kill "$limit_watchdog" 2>/dev/null
  return "$limit_rc"
}

line hostname "$(hostname)"
line uptime "$(cut -d. -f1 /proc/uptime)"
line system "$(systemctl is-system-running 2>/dev/null || true)"
line failed_units "$(systemctl --failed --no-legend --plain 2>/dev/null | awk 'NF {count++} END {print count+0}')"

# An nvidia-smi stuck in the driver (state D for more than 10 s) usually means a GPU fault. Starting another
# one would only add a second stuck process, so the GPU readings are skipped and reported as stuck.
gpu=""
gpu_status="ok"
for stuck_pid in $(pgrep -x -O 10 nvidia-smi 2>/dev/null); do
  if [ "$(awk '/^State:/{print $2; exit}' "/proc/$stuck_pid/status" 2>/dev/null)" = "D" ]; then gpu_status="stuck"; fi
done
if [ "$gpu_status" = "ok" ]; then
  gpu="$(limit 1.5 nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw,clocks.current.sm,pstate,clocks_event_reasons.sw_thermal_slowdown,clocks_event_reasons.hw_thermal_slowdown --format=csv,noheader,nounits 2>/dev/null | head -1)"
  case "$?" in
    0|141) [ -n "$gpu" ] || gpu_status="error" ;;
    124|137) gpu_status="timeout"; gpu="" ;;
    127) gpu_status="missing" ;;
    *) gpu_status="error"; gpu="" ;;
  esac
fi
line gpu "$gpu"
line gpu_status "$gpu_status"

mem="$(awk '/MemTotal:/{t=$2}/MemAvailable:/{a=$2}/SwapTotal:/{st=$2}/SwapFree:/{sf=$2}END{printf "%s,%s,%s,%s",t,a,st,sf}' /proc/meminfo)"
line memory "$mem"

disk="$(df -B1 --output=size,avail,pcent / 2>/dev/null | tail -1 | awk '{gsub(/%/,"",$3); printf "%s,%s,%s",$1,$2,$3}')"
line disk "$disk"

process=""
if [ "$gpu_status" = "ok" ]; then
  process="$(limit 1.5 nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null | sort -t, -k3,3nr | head -1 || true)"
fi
process_pid="$(printf '%s' "$process" | cut -d, -f1 | tr -d ' ')"
process_state=""
if [ -n "$process_pid" ] && [ -r "/proc/$process_pid/status" ]; then
  process_state="$(awk '/^State:/{print $2; exit}' "/proc/$process_pid/status" 2>/dev/null || true)"
fi
line process "$process,$process_state"

container_id=""
if [ -n "$process_pid" ] && [ -r "/proc/$process_pid/cgroup" ]; then
  container_id="$(grep -oE '[0-9a-f]{64}' "/proc/$process_pid/cgroup" 2>/dev/null | head -1 || true)"
fi
# Optional: only when docker is installed and readable by this account, and only for a container that
# holds the GPU process or whose name or image names a known inference engine.
if [ -z "$container_id" ]; then
  container_id="$(limit 1.5 docker ps --format '{{.ID}} {{.Names}} {{.Image}}' 2>/dev/null | awk '{line=tolower($0)} line ~ /vllm|sglang|llama|triton|tensorrt|trtllm/{print $1; exit}' || true)"
fi
container=",,false,0,"
if [ -n "$container_id" ]; then
  container="$(limit 1.5 docker inspect --format '{{.Name}},{{.Config.Image}},{{.State.Running}},{{.RestartCount}},{{.State.StartedAt}}' "$container_id" 2>/dev/null || printf ',,false,0,')"
fi
line container "$container"

# Every ACPI thermal zone with a short name (GB10 boards: TSOC, TS0E, TS0P, TS1E, TS1P, TGPU, TUNC).
thermals=""
for zone in /sys/class/thermal/thermal_zone*; do
  path_file="$zone/device/path"
  [ -r "$path_file" ] || continue
  thermal_path=""
  IFS= read -r thermal_path < "$path_file" || true
  thermal_key="$(printf '%s' "$thermal_path" | awk -F. '{print $NF}')"
  case "$thermal_key" in
    ''|*[!A-Z0-9]*|?????????*) continue ;;
  esac
  [ -r "$zone/temp" ] || continue
  thermal_value=""
  IFS= read -r thermal_value < "$zone/temp" || true
  case "$thermal_value" in
    ''|*[!0-9-]*) continue ;;
  esac
  if [ -n "$thermals" ]; then
    thermals="$thermals,$thermal_key=$thermal_value"
  else
    thermals="$thermal_key=$thermal_value"
  fi
done
line thermals "$thermals"

# NVMe composite temperature and the hottest ConnectX NIC chip, from hwmon (millidegrees).
nvme_temp=""
nic_temp=""
for hwmon in /sys/class/hwmon/hwmon*; do
  hwmon_name=""
  IFS= read -r hwmon_name < "$hwmon/name" 2>/dev/null || true
  hwmon_value=""
  IFS= read -r hwmon_value < "$hwmon/temp1_input" 2>/dev/null || true
  case "$hwmon_value" in ''|*[!0-9-]*) continue ;; esac
  case "$hwmon_name" in
    nvme) [ -n "$nvme_temp" ] || nvme_temp="$hwmon_value" ;;
    mlx5*) if [ -z "$nic_temp" ] || [ "$hwmon_value" -gt "$nic_temp" ]; then nic_temp="$hwmon_value"; fi ;;
  esac
done
line hwmon "nvme=$nvme_temp,nic=$nic_temp"

# Load averages (1, 5, 15 min) and the number of CPU cores.
line cpu "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null | tr ' ' ','),$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"

kernel_summary="$(
  timeout 2s journalctl -q -k --since '-24 hours' --no-pager -o short-unix \
    -g 'NV_ERR|Xid|GPU has fallen off the bus|NVRM:.*([Ee]rror|[Ff]ail|[Ff]ault)' -n 1000 2>/dev/null |
  awk '
    {
      raw = $0
      epoch = $1
      if (raw ~ /NV_ERR_NO_MEMORY/) no_memory++
      if (raw ~ /Xid/) xid++
      sub(/^[^ ]+[ ]+[^ ]+[ ]+kernel:?[ ]*/, "", raw)
      gsub(/[|\t\r\n]/, " ", raw)
      if (length(raw) > 180) raw = substr(raw, 1, 177) "..."
      last = raw
      count++
    }
    END { printf "%d\t%d\t%d\t%d\t%s\t%s", count+0, no_memory+0, xid+0, count>=1000, epoch, last }
  '
)"
kernel_rc="$?"
case "$kernel_rc" in
  0) kernel_status="ok" ;;
  124) kernel_status="timeout" ;;
  1)
    if timeout 1s journalctl -q -k --no-pager -n 1 >/dev/null 2>&1; then
      kernel_status="ok"
    else
      kernel_status="unavailable"
    fi
    ;;
  *) kernel_status="unavailable" ;;
esac
line kernel "$kernel_status	$kernel_summary"

network_line() {
  nic="$1"
  rdma="$2"
  base="/sys/class/net/$nic"
  rdma_base="/sys/class/infiniband/$rdma/ports/1/counters"
  if [ ! -d "$base" ]; then
    line "net:$nic" ""
    return
  fi
  carrier="$(cat "$base/carrier" 2>/dev/null || printf 0)"
  speed="$(cat "$base/speed" 2>/dev/null || printf 0)"
  rx="$(cat "$base/statistics/rx_bytes" 2>/dev/null || printf 0)"
  tx="$(cat "$base/statistics/tx_bytes" 2>/dev/null || printf 0)"
  rxerr="$(cat "$base/statistics/rx_errors" 2>/dev/null || printf 0)"
  txerr="$(cat "$base/statistics/tx_errors" 2>/dev/null || printf 0)"
  rxdrop="$(cat "$base/statistics/rx_dropped" 2>/dev/null || printf 0)"
  txdrop="$(cat "$base/statistics/tx_dropped" 2>/dev/null || printf 0)"
  if [ "$rdma" != "-" ] && [ -d "$rdma_base" ]; then
    rdma_rx_words="$(cat "$rdma_base/port_rcv_data" 2>/dev/null || printf 0)"
    rdma_tx_words="$(cat "$rdma_base/port_xmit_data" 2>/dev/null || printf 0)"
    rdma_rxerr="$(cat "$rdma_base/port_rcv_errors" 2>/dev/null || printf 0)"
    rdma_txdrop="$(cat "$rdma_base/port_xmit_discards" 2>/dev/null || printf 0)"
    rx="$((rdma_rx_words * 4))"
    tx="$((rdma_tx_words * 4))"
    rxerr="$((rxerr + rdma_rxerr))"
    txdrop="$((txdrop + rdma_txdrop))"
  fi
  line "net:$nic" "$carrier,$speed,$rx,$tx,$rxerr,$txerr,$rxdrop,$txdrop"
}

# SCOPE_IFACES is prepended by buildRemoteScript: "netdev rdma" word pairs from topology.json, "-" for no RDMA device.
set -- $SCOPE_IFACES
while [ "$#" -ge 2 ]; do
  network_line "$1" "$2"
  shift 2
done
`;

function number(value, fallback = null) {
  const parsed = Number.parseFloat(String(value ?? "").replace(/[^0-9+-.]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integer(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitCsv(value) {
  return String(value ?? "").split(",").map((part) => part.trim());
}

// Known serving engines only; anything else (python3, a benchmark) is not an engine label.
export function knownEngine(text) {
  const normalized = String(text ?? "").toLowerCase();
  if (normalized.includes("vllm")) return "vLLM";
  if (normalized.includes("sglang")) return "SGLang";
  if (normalized.includes("ollama")) return "Ollama";
  if (normalized.includes("llama")) return "llama.cpp";
  if (normalized.includes("tensorrt") || normalized.includes("trtllm")) return "TensorRT-LLM";
  if (normalized.includes("triton")) return "Triton";
  return null;
}

function detectEngine(processName) {
  return knownEngine(processName) ?? (processName ? String(processName).split(/[/:]/)[0] : null);
}

// The collector script for one node: the shared body plus the interfaces that node must report.
export function buildRemoteScript(interfaces = []) {
  const pairs = interfaces.map((nic) => `${nic} ${rdmaDevice(nic) ?? "-"}`).join(" ");
  if (!/^[A-Za-z0-9_. -]*$/.test(pairs)) throw new Error("invalid interface name for the collector script");
  return `SCOPE_IFACES='${pairs}'\n${REMOTE_SCRIPT}`;
}

// "net:<interface>" lines become network[<interface>].
export function parseNetworkLines(lines, interfaces = []) {
  const network = {};
  for (const nic of interfaces) network[nic] = parseNetwork(lines[`net:${nic}`]);
  return network;
}

export function parseInferenceProcess(value) {
  const [pid, processName, usedMemoryMiB, state] = splitCsv(value);
  const rankMatch = String(processName ?? "").match(/(?:worker[_-]?)?tp\s*[_-]?(\d+)/i);
  const up = Boolean(processName);
  const alive = up && Boolean(state) && !["X", "x", "Z"].includes(state);
  return {
    up,
    alive,
    ready: alive,
    pid: integer(pid, null),
    processName: processName || null,
    engine: detectEngine(processName),
    rank: rankMatch ? integer(rankMatch[1], null) : null,
    memoryBytes: (() => { const mib = number(usedMemoryMiB, null); return mib === null ? null : mib * 1024 * 1024; })(),
    state: state || null,
  };
}

// ACPI thermal zones by name, in degrees Celsius. TSOC and TS1P are also kept as named fields.
export function parseThermals(value) {
  const zones = {};
  for (const part of String(value ?? "").split(",")) {
    const [label, rawValue] = part.split("=", 2).map((item) => item?.trim());
    const millidegrees = number(rawValue, null);
    if (!label || !/^[A-Z0-9]{1,8}$/.test(label) || !Number.isFinite(millidegrees)) continue;
    zones[label] = millidegrees / 1000;
  }
  return { tsocCelsius: zones.TSOC ?? null, ts1pCelsius: zones.TS1P ?? null, zones };
}

export function parseHwmon(value) {
  const fields = Object.fromEntries(String(value ?? "").split(",").map((part) => part.split("=", 2).map((item) => item?.trim())));
  const celsius = (raw) => { const parsed = number(raw, null); return parsed === null ? null : parsed / 1000; };
  return { nvmeCelsius: celsius(fields.nvme), nicCelsius: celsius(fields.nic) };
}

export function parseCpu(value) {
  const [load1, load5, load15, cores] = splitCsv(value);
  return { load1: number(load1), load5: number(load5), load15: number(load15), cores: integer(cores, null) };
}

export function parseKernelEvents(value) {
  const [status, total, noMemory, xid, capped, lastEpoch, ...messageParts] = String(value ?? "").split("\t");
  const epochSeconds = number(lastEpoch, null);
  const lastMessage = messageParts.join("\t").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 180);
  return {
    available: status === "ok",
    status: status || "unavailable",
    windowHours: 24,
    total: integer(total),
    noMemory: integer(noMemory),
    xid: integer(xid),
    capped: capped === "1",
    lastAt: Number.isFinite(epochSeconds) ? new Date(epochSeconds * 1000).toISOString() : null,
    lastMessage: lastMessage || null,
  };
}

function parseKeyValueLines(text) {
  const output = {};
  for (const rawLine of text.split("\n")) {
    const separator = rawLine.indexOf("|");
    if (separator < 1) continue;
    output[rawLine.slice(0, separator)] = rawLine.slice(separator + 1);
  }
  return output;
}

function parseNetwork(value) {
  const [carrier, speedMbps, rxBytes, txBytes, rxErrors, txErrors, rxDropped, txDropped] = splitCsv(value);
  return {
    available: Boolean(value),
    up: carrier === "1",
    speedGbps: number(speedMbps, 0) / 1000,
    rxBytes: integer(rxBytes),
    txBytes: integer(txBytes),
    errors: integer(rxErrors) + integer(txErrors),
    dropped: integer(rxDropped) + integer(txDropped),
    rateGbps: null,
  };
}

// BatchMode: never prompt for a password or an unknown host key; fail instead.
export const SSH_OPTIONS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=3",
  "-o", "ServerAliveInterval=2",
  "-o", "ServerAliveCountMax=1",
];

// How one node's collector script runs: a local node runs it with bash directly, any other node over
// SSH. Either way the script arrives on stdin, so nothing is installed on the node.
export function collectorCommand({ host, local = false }) {
  if (local) return { command: "bash", args: ["-s"], label: "local collector" };
  return { command: "ssh", args: [...SSH_OPTIONS, host, "bash -s"], label: host };
}

function runCollector(node, script, timeoutMs = 4500) {
  const { command, args, label } = collectorCommand(node);
  return new Promise((resolve, reject) => {
    // Its own process group, so a timeout can stop everything the collector started, not just bash or ssh.
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: true });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      // What arrived before the timeout is still worth showing; the caller marks the node incomplete.
      const error = new Error(`${label}: timed out after ${timeoutMs} ms`);
      error.partialOutput = stdout;
      reject(error);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim().split("\n").slice(-3).join(" ") || `${label}: exited with code ${code}`));
    });
    child.stdin.on("error", () => {}); // EPIPE when the command exits early; the close handler reports it.
    child.stdin.end(script);
  });
}

// A node that topology.json marks "collect": false: never contacted, shown as "not collected" rather than as a fault.
export function uncollectedNode({ id, name, host, local = false, role, expectedRank }) {
  return {
    ok: false, collected: false, id, name, host, local, hostname: null, role, expectedRank: expectedRank ?? null,
    updatedAt: new Date().toISOString(), error: null,
  };
}

// Kibibytes from /proc/meminfo as bytes; null when the value was not reported (for example on a non-Linux host).
function kibibytes(value) {
  const parsed = integer(value, null);
  return parsed === null ? null : parsed * 1024;
}

function difference(total, available) {
  return total === null || available === null ? null : Math.max(0, total - available);
}

const GPU_STATUSES = new Set(["ok", "timeout", "stuck", "missing", "error"]);

// One node's snapshot from the collector's "key|value" lines. Lines that never arrived (a poll cut short) stay unknown.
function nodeSnapshot(lines, { id, name, host, local, role, expectedRank, interfaces, startedAt }) {
  const gpu = splitCsv(lines.gpu);
  const memory = splitCsv(lines.memory);
  const disk = splitCsv(lines.disk);
  const container = splitCsv(lines.container);
  const inference = parseInferenceProcess(lines.process);
  const thermals = parseThermals(lines.thermals);
  const hwmon = parseHwmon(lines.hwmon);
  const kernelEvents = parseKernelEvents(lines.kernel);
  const totalMemoryBytes = kibibytes(memory[0]);
  const availableMemoryBytes = kibibytes(memory[1]);
  const engine = inference.up
    ? knownEngine(inference.processName) ?? knownEngine(container[1]) ?? knownEngine(container[0])
    : null;
  const gpuReadings = {
    utilization: number(gpu[0]),
    temperature: number(gpu[1]),
    powerWatts: number(gpu[2]),
    clockMHz: number(gpu[3]),
  };
  const gpuAvailable = Object.values(gpuReadings).some(Number.isFinite);
  const reportedStatus = GPU_STATUSES.has(lines.gpu_status) ? lines.gpu_status : null;

  return {
    ok: true,
    collected: true,
    id,
    name,
    host,
    local,
    hostname: lines.hostname || host,
    role,
    expectedRank,
    rank: inference.rank,
    inferenceProcessUp: inference.up,
    inferenceProcessReady: inference.ready,
    processMemoryBytes: inference.memoryBytes,
    inference: { ...inference, engine },
    latencyMs: Date.now() - startedAt,
    uptimeSeconds: integer(lines.uptime, null),
    // null when systemctl is not available (no systemd); that is not reported as a fault.
    systemState: lines.system || null,
    failedUnits: integer(lines.failed_units),
    container: {
      detected: Boolean(container[0]),
      name: String(container[0] ?? "").replace(/^\/+/, "") || null,
      image: container[1] || null,
      running: container[2] === "true",
      restarts: integer(container[3]),
      startedAt: container[4] || null,
    },
    gpu: {
      ...gpuReadings,
      performanceState: gpu[4] || "N/A",
      thermalSlowdown: [gpu[5], gpu[6]].some((value) => /active/i.test(value) && !/not active/i.test(value)),
      // ok, timeout (nvidia-smi did not answer in time), stuck (an earlier nvidia-smi is hung in the driver),
      // missing (no nvidia-smi) or error. A node without GPU readings is shown as such, not as healthy.
      status: gpuAvailable ? "ok" : reportedStatus && reportedStatus !== "ok" ? reportedStatus : lines.gpu === undefined ? "timeout" : "error",
      available: gpuAvailable,
    },
    thermals,
    nvmeCelsius: hwmon.nvmeCelsius,
    nicCelsius: hwmon.nicCelsius,
    cpu: parseCpu(lines.cpu),
    kernelEvents,
    memory: {
      totalBytes: totalMemoryBytes,
      availableBytes: availableMemoryBytes,
      usedBytes: difference(totalMemoryBytes, availableMemoryBytes),
      swapUsedBytes: difference(kibibytes(memory[2]), kibibytes(memory[3])),
    },
    disk: {
      totalBytes: integer(disk[0], null),
      availableBytes: integer(disk[1], null),
      usedPercent: number(disk[2], null),
    },
    network: parseNetworkLines(lines, interfaces),
    incomplete: false,
    updatedAt: new Date().toISOString(),
    error: null,
  };
}

export async function collectNode({ id = null, name = null, host, local = false, role, expectedRank = null, interfaces = [] }, { timeoutMs = 4500 } = {}) {
  const startedAt = Date.now();
  const meta = { id, name, host, local, role, expectedRank, interfaces, startedAt };
  try {
    return nodeSnapshot(parseKeyValueLines(await runCollector({ host, local }, buildRemoteScript(interfaces), timeoutMs)), meta);
  } catch (error) {
    // The node answered but a command hung past the poll budget: keep what arrived and say the poll was cut short.
    const partial = parseKeyValueLines(error.partialOutput ?? "");
    if (partial.hostname !== undefined) {
      return { ...nodeSnapshot(partial, meta), incomplete: true, error: error.message };
    }
    return {
      ok: false,
      collected: true,
      id,
      name,
      host,
      local,
      hostname: host,
      role,
      expectedRank,
      latencyMs: Date.now() - startedAt,
      updatedAt: new Date().toISOString(),
      error: error.message,
    };
  }
}

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

// Counters only grow within one engine run; a missing counter does not break the series.
function notLess(current, previous) {
  return current === null || previous === null || current >= previous;
}

// Two counter snapshots belong to the same engine run when the model is the same and none of the fields went down.
function sameSeries(previous, current, fields) {
  return Boolean(previous) && previous.modelName === current.modelName && fields.every((field) => notLess(current[field], previous[field]));
}
const PREFILL_FIELDS = ["promptTotal", "promptComputeTotal", "promptCacheTotal", "prefillTimeTotal", "prefillCount"];
const OUTPUT_FIELDS = ["generationTotal", "promptTotal", "promptComputeTotal", "promptCacheTotal"];

export function holdPrefillRates(current, previous = null, held = null) {
  if (current.promptTotal === null || current.prefillCount === null || current.prefillTimeTotal === null) {
    return { promptTokensPerSecond: null, promptComputeTokensPerSecond: null, promptCacheTokensPerSecond: null, updatedAt: null };
  }
  const continuing = sameSeries(previous, current, PREFILL_FIELDS);
  const baseline = continuing ? previous : {
    promptTotal: 0,
    promptComputeTotal: 0,
    promptCacheTotal: 0,
    prefillTimeTotal: 0,
    prefillCount: 0,
  };
  const completedPrefills = current.prefillCount - (baseline.prefillCount ?? 0);
  const elapsedPrefillSeconds = current.prefillTimeTotal - (baseline.prefillTimeTotal ?? 0);
  const promptTokens = current.promptTotal - (baseline.promptTotal ?? 0);
  const part = (now, before) => (now === null ? null : Math.max(0, now - (before ?? 0)) / elapsedPrefillSeconds);
  const empty = {
    promptTokensPerSecond: 0,
    promptComputeTokensPerSecond: 0,
    promptCacheTokensPerSecond: 0,
    updatedAt: null,
  };

  if (completedPrefills <= 0 || elapsedPrefillSeconds <= 0 || promptTokens <= 0) {
    return continuing ? (held ?? empty) : empty;
  }

  return {
    promptTokensPerSecond: promptTokens / elapsedPrefillSeconds,
    promptComputeTokensPerSecond: part(current.promptComputeTotal, baseline.promptComputeTotal),
    promptCacheTokensPerSecond: part(current.promptCacheTotal, baseline.promptCacheTotal),
    updatedAt: new Date(current.at).toISOString(),
  };
}

// Which engine exposes these metrics, from the metric name prefixes (vllm:* or sglang:*).
export function metricsEngine(metrics) {
  let engine = null;
  for (const name of metrics.keys()) {
    if (name.startsWith("vllm:")) return "vLLM";
    if (name.startsWith("sglang:")) engine = "SGLang";
  }
  return engine;
}

// SGLang exposes its own metric names. Add the vLLM names this collector reads, so
// one parser serves both engines. Counters and histograms are summed over SGLang's extra labels
// (is_streaming, cache_source); gauges use the first sample (usually rank 0). SGLang has no
// prefill-time histogram, so time to first token stands in for it (it includes queue time). It
// has no per-request TPOT histogram either; its inter-token histogram spreads each streamed
// chunk's interval over the chunk's tokens, so its quantiles stand in for TPOT.
const SGLANG_COUNTERS = {
  "vllm:generation_tokens_total": "sglang:generation_tokens_total",
  "vllm:prompt_tokens_total": "sglang:prompt_tokens_total",
  "vllm:request_success_total": "sglang:num_requests_total",
};
const SGLANG_GAUGES = {
  "vllm:num_requests_running": "sglang:num_running_reqs",
  "vllm:num_requests_waiting": "sglang:num_queue_reqs",
  "vllm:kv_cache_usage_perc": "sglang:token_usage",
};
const SGLANG_HISTOGRAMS = {
  "vllm:time_to_first_token_seconds": "sglang:time_to_first_token_seconds",
  "vllm:request_prefill_time_seconds": "sglang:time_to_first_token_seconds",
  "vllm:request_time_per_output_token_seconds": "sglang:inter_token_latency_seconds",
};

export function normalizeSglangMetrics(metrics) {
  const modelName = [...metrics.values()].flat().find((sample) => sample.name.startsWith("sglang:") && sample.labels.model_name)?.labels.model_name;
  const base = modelName ? { model_name: modelName } : {};
  const put = (name, labels, value) => {
    if (!metrics.has(name)) metrics.set(name, []);
    metrics.get(name).push({ name, labels: { ...base, ...labels }, value });
  };
  const total = (name) => (metrics.has(name) ? metricSum(metrics, name) : null);
  for (const [target, source] of Object.entries(SGLANG_COUNTERS)) {
    const value = total(source);
    if (value !== null && !metrics.has(target)) put(target, {}, value);
  }
  for (const [target, source] of Object.entries(SGLANG_GAUGES)) {
    const sample = (metrics.get(source) ?? [])[0];
    if (sample && !metrics.has(target)) put(target, {}, sample.value);
  }
  const prompt = total("sglang:prompt_tokens_total");
  const cached = total("sglang:cached_tokens_total");
  if (prompt !== null && !metrics.has("vllm:prompt_tokens_by_source_total")) {
    put("vllm:prompt_tokens_by_source_total", { source: "local_cache_hit" }, cached ?? 0);
    put("vllm:prompt_tokens_by_source_total", { source: "local_compute" }, Math.max(0, prompt - (cached ?? 0)));
  }
  // vLLM counts prefix-cache queries and hits in tokens, so SGLang's prompt and cached token
  // counters give the same since-start hit rate.
  if (prompt !== null && !metrics.has("vllm:prefix_cache_queries_total")) {
    put("vllm:prefix_cache_queries_total", {}, prompt);
    put("vllm:prefix_cache_hits_total", {}, cached ?? 0);
  }
  for (const [target, source] of Object.entries(SGLANG_HISTOGRAMS)) {
    if (!metrics.has(`${source}_count`) || metrics.has(`${target}_count`)) continue;
    put(`${target}_count`, {}, metricSum(metrics, `${source}_count`));
    put(`${target}_sum`, {}, metricSum(metrics, `${source}_sum`));
    const buckets = new Map();
    for (const sample of metrics.get(`${source}_bucket`) ?? []) {
      buckets.set(sample.labels.le, (buckets.get(sample.labels.le) ?? 0) + sample.value);
    }
    for (const [le, value] of buckets) put(`${target}_bucket`, { le }, value);
  }
  return metrics;
}

// SGLang adds a request's output tokens to generation_tokens_total only when the request finishes, so the counter's
// rate reads 0 while tokens stream and spikes when a request ends. Its scheduler publishes the measured generation
// throughput (sglang:gen_throughput, refreshed every few decode steps), which is the live decode rate while requests
// run; the gauge keeps its last value when idle, so with nothing running the rate is 0.
export function sglangDecodeRate(metrics, counterRate = null) {
  const throughput = metricValue(metrics, "sglang:gen_throughput", {}, null);
  if (throughput === null) return counterRate;
  const running = metricValue(metrics, "sglang:num_running_reqs", {}, null);
  return running > 0 ? Math.max(0, throughput) : 0;
}

// vLLM keeps cumulative draft and accepted token counters. SGLang only publishes the acceptance
// rate of its most recent decode-log window as a gauge, so for SGLang this is the recent rate.
// null when no speculative decoding runs, rather than a 0% that reads like a broken draft model.
export function speculativeAcceptancePercent(metrics) {
  const draftTokens = metricTotal(metrics, "vllm:spec_decode_num_draft_tokens_total");
  if (draftTokens > 0) {
    return ((metricTotal(metrics, "vllm:spec_decode_num_accepted_tokens_total") ?? 0) / draftTokens) * 100;
  }
  const sglangRate = metricValue(metrics, "sglang:spec_accept_rate", {}, null);
  return sglangRate === null ? null : sglangRate * 100;
}

export function resolveModelIdentity(metrics, models = []) {
  const modelSample = (metrics.get("vllm:num_requests_running") ?? [])
    .find((sample) => sample.labels.model_name);
  const aliases = [...new Set(models.map((model) => model?.id).filter(Boolean))];
  const modelName = modelSample?.labels.model_name ?? aliases[0] ?? null;
  const selected = models.find((model) => model?.id === modelName) ?? models[0] ?? null;
  return {
    modelName,
    modelRoot: selected?.root ?? null,
    modelAliases: aliases,
  };
}

async function fetchWithTiming(url, timeoutMs = 4000) {
  const startedAt = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  return {
    response,
    latencyMs: performance.now() - startedAt,
  };
}

// A response whose body is not needed is cancelled, so its connection is released instead of held until garbage
// collection (behind a proxy with large /health pages, unread bodies kept dozens of sockets open).
function discard(response) {
  response?.body?.cancel().catch(() => {});
}

// Reads the inference engine's /health, /metrics and (every 30 s) /v1/models; vLLM and SGLang are both supported.
export class InferenceCollector {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.previous = null;
    this.prefillRates = null;
    this.models = [];
    this.modelsFetchedAt = 0;
    this.latency = new RecentHistograms();
  }

  async collect() {
    const collectedAt = Date.now();
    try {
      const settled = await Promise.allSettled([
        fetchWithTiming(`${this.baseUrl}/health`),
        fetchWithTiming(`${this.baseUrl}/metrics`),
      ]);
      const [healthResult, metricsResult] = settled.map((result) => (result.status === "fulfilled" ? result.value : null));
      // Only the status of /health matters.
      discard(healthResult?.response);
      const failed = settled.find((result) => result.status === "rejected");
      if (failed) {
        discard(metricsResult?.response);
        throw failed.reason;
      }
      if (!metricsResult.response.ok) {
        discard(metricsResult.response);
        throw new Error(`metrics HTTP ${metricsResult.response.status}`);
      }
      const metrics = parsePrometheus(await metricsResult.response.text());
      const engine = metricsEngine(metrics);
      if (engine === "SGLang") normalizeSglangMetrics(metrics);
      const metricModelName = resolveModelIdentity(metrics).modelName;
      const modelCacheExpired = collectedAt - this.modelsFetchedAt >= 30_000;
      const modelCacheMiss = metricModelName && !this.models.some((model) => model?.id === metricModelName);
      if (modelCacheExpired || modelCacheMiss) {
        const modelsResult = await fetchWithTiming(`${this.baseUrl}/v1/models`).catch(() => null);
        this.modelsFetchedAt = collectedAt;
        if (modelsResult?.response.ok) {
          const payload = await modelsResult.response.json().catch(() => null);
          if (Array.isArray(payload?.data)) this.models = payload.data;
        } else {
          discard(modelsResult?.response);
        }
      }
      const identity = resolveModelIdentity(metrics, this.models);
      const generationTotal = metricTotal(metrics, "vllm:generation_tokens_total");
      const promptTotal = metricTotal(metrics, "vllm:prompt_tokens_total");
      const promptComputeTotal = metricTotal(metrics, "vllm:prompt_tokens_by_source_total", { source: "local_compute" });
      const promptCacheTotal = metricTotal(metrics, "vllm:prompt_tokens_by_source_total", { source: "local_cache_hit" });
      const prefillTimeTotal = metricTotal(metrics, "vllm:request_prefill_time_seconds_sum");
      const prefillCount = metricTotal(metrics, "vllm:request_prefill_time_seconds_count");
      const snapshot = { at: collectedAt, modelName: identity.modelName, generationTotal, promptTotal, promptComputeTotal, promptCacheTotal, prefillTimeTotal, prefillCount };
      const elapsedSeconds = sameSeries(this.previous, snapshot, OUTPUT_FIELDS) ? (collectedAt - this.previous.at) / 1000 : 0;
      // Unknown until two samples of the same run exist (the first poll, or right after a restart).
      const counterRate = elapsedSeconds > 0 && generationTotal !== null && this.previous.generationTotal !== null
        ? Math.max(0, (generationTotal - this.previous.generationTotal) / elapsedSeconds)
        : null;
      const outputTokensPerSecond = engine === "SGLang" ? sglangDecodeRate(metrics, counterRate) : counterRate;
      this.prefillRates = holdPrefillRates(snapshot, this.previous, this.prefillRates);
      this.previous = snapshot;

      const prefixQueries = metricTotal(metrics, "vllm:prefix_cache_queries_total");
      const prefixHits = metricTotal(metrics, "vllm:prefix_cache_hits_total");
      const kvCacheUsage = metricMean(metrics, "vllm:kv_cache_usage_perc");
      const processStartedAt = metricValue(metrics, "process_start_time_seconds", {}, null);
      this.latency.add(collectedAt, {
        ttft: histogramBuckets(metrics, "vllm:time_to_first_token_seconds"),
        tpot: histogramBuckets(metrics, "vllm:request_time_per_output_token_seconds"),
      });

      // The full reading stays on the server (the ledger needs the counter totals); browsers get the fields in
      // public-state.mjs.
      return {
        ok: healthResult.response.ok,
        engine,
        ...identity,
        latencyMs: healthResult.latencyMs,
        outputTokensPerSecond,
        promptTokensPerSecond: this.prefillRates.promptTokensPerSecond,
        promptComputeTokensPerSecond: this.prefillRates.promptComputeTokensPerSecond,
        promptCacheTokensPerSecond: this.prefillRates.promptCacheTokensPerSecond,
        // When new prefills last completed: the prefill rates above are held between them, so this tells whether
        // a poll saw prefill work (the mini window's phase shading).
        prefillUpdatedAt: this.prefillRates.updatedAt,
        generationTokensTotal: generationTotal,
        promptTokensTotal: promptTotal,
        promptComputeTokensTotal: promptComputeTotal,
        promptCacheTokensTotal: promptCacheTotal,
        runningRequests: metricTotal(metrics, "vllm:num_requests_running"),
        waitingRequests: metricTotal(metrics, "vllm:num_requests_waiting"),
        kvCachePercent: kvCacheUsage === null ? null : kvCacheUsage * 100,
        prefixCacheHitPercent: prefixQueries > 0 ? ((prefixHits ?? 0) / prefixQueries) * 100 : null,
        speculativeAcceptancePercent: speculativeAcceptancePercent(metrics),
        ttftP95Seconds: histogramQuantile(metrics, "vllm:time_to_first_token_seconds", 0.95),
        tpotP95Seconds: histogramQuantile(metrics, "vllm:request_time_per_output_token_seconds", 0.95),
        ttftP95RecentSeconds: this.latency.quantile("ttft", 0.95),
        tpotP95RecentSeconds: this.latency.quantile("tpot", 0.95),
        latencyWindowSeconds: this.latency.windowSeconds,
        completedRequestsTotal: metricTotal(metrics, "vllm:request_success_total"),
        processStartedAt: processStartedAt ? new Date(processStartedAt * 1000).toISOString() : null,
        updatedAt: new Date(collectedAt).toISOString(),
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        updatedAt: new Date(collectedAt).toISOString(),
        error: error.message,
      };
    }
  }
}

export function applyNetworkRates(current, previous) {
  if (!current?.ok || !previous?.ok) return current;
  const elapsedSeconds = (Date.parse(current.updatedAt) - Date.parse(previous.updatedAt)) / 1000;
  if (!(elapsedSeconds > 0)) return current;
  for (const rail of Object.keys(current.network ?? {})) {
    const now = current.network[rail];
    const before = previous.network?.[rail];
    if (!now || !before || now.available === false || before.available === false
      || now.up === false || before.up === false || now.rxBytes < before.rxBytes || now.txBytes < before.txBytes) {
      if (now) now.rateGbps = null;
      continue;
    }
    const byteDelta = Math.max(0, now.rxBytes - before.rxBytes) + Math.max(0, now.txBytes - before.txBytes);
    const instantRate = (byteDelta * 8) / elapsedSeconds / 1e9;
    now.rateGbps = Number.isFinite(before.rateGbps) && before.rateGbps > 0
      ? (before.rateGbps * 0.55) + (instantRate * 0.45)
      : instantRate;
  }
  return current;
}
