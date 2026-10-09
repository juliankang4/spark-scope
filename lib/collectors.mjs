import { spawn } from "node:child_process";
import { rdmaDevice } from "./topology.mjs";
import { RecentHistograms } from "./engines/prometheus.mjs";
import { parseMetricsResponse, readEngineMetrics } from "./engines/index.mjs";
import { resolveModelIdentity } from "./engines/vllm.mjs";
import { LlamacppSlots } from "./engines/llamacpp.mjs";
import { DARWIN_SCRIPT } from "./darwin.mjs";

export { parsePrometheus, metricValue, metricSum, metricTotal, metricMean, histogramBuckets, bucketsQuantile, histogramQuantile, bucketsSince, RecentHistograms } from "./engines/prometheus.mjs";
export { metricsEngine } from "./engines/index.mjs";
export { resolveModelIdentity } from "./engines/vllm.mjs";
export { normalizeSglangMetrics, sglangDecodeRate, speculativeAcceptancePercent } from "./engines/sglang.mjs";
export { normalizeTensorfoldMetrics, tensorfoldLiveTokens } from "./engines/tensorfold.mjs";

const LIMIT_SCRIPT = String.raw`limit() {
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
}`;

const REMOTE_SCRIPT = String.raw`set -u
set -o pipefail
line() { printf '%s|%s\n' "$1" "$2"; }
# Runs a command for at most $1 seconds, so a hung nvidia-smi or docker costs one reading, not the whole poll.
# Exit 124 or 137 means it was stopped. Uses coreutils timeout when present, otherwise a shell watchdog.
${LIMIT_SCRIPT}

line hostname "$(hostname)"
line uptime "$(cut -d. -f1 /proc/uptime)"
# systemd keeps a failed unit whose file is gone (the mount of a snap revision a refresh removed, say) until
# reset-failed or a reboot, and stays "degraded" because of it. Nothing is left to fix, so it does not count.
failed="$(systemctl --failed --no-legend --plain 2>/dev/null)"
failed_units="$(printf '%s\n' "$failed" | awk 'NF && $2 != "not-found" {count++} END {print count+0}')"
gone_units="$(printf '%s\n' "$failed" | awk '$2 == "not-found" {count++} END {print count+0}')"
system="$(systemctl is-system-running 2>/dev/null || true)"
if [ "$system" = "degraded" ] && [ "$failed_units" = 0 ] && [ "$gone_units" -gt 0 ]; then system="running"; fi
line system "$system"
line failed_units "$failed_units"

# An nvidia-smi stuck in the driver (state D for more than 10 s) usually means a GPU fault. Starting another
# one would only add a second stuck process, so the GPU readings are skipped and reported as stuck.
gpu=""
gpu_status="ok"
for stuck_pid in $(pgrep -x -O 10 nvidia-smi 2>/dev/null); do
  if [ "$(awk '/^State:/{print $2; exit}' "/proc/$stuck_pid/status" 2>/dev/null)" = "D" ]; then gpu_status="stuck"; fi
done
if [ "$gpu_status" = "ok" ]; then
  gpu="$(limit 1.5 nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw,clocks.current.sm,pstate,clocks_event_reasons.sw_thermal_slowdown,clocks_event_reasons.hw_thermal_slowdown,memory.used,memory.total,name --format=csv,noheader,nounits 2>/dev/null | head -1)"
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
# Vulkan and CPU servers may not appear in the compute-apps list.
if [ -z "$process_pid" ]; then
  process_pid="$(pgrep -x llama-server 2>/dev/null | head -1 || true)"
  if [ -n "$process_pid" ]; then process="$process_pid,llama-server,[N/A]"; fi
fi
process_state=""
process_comm=""
if [ -n "$process_pid" ] && [ -r "/proc/$process_pid/status" ]; then
  process_state="$(awk '/^State:/{print $2; exit}' "/proc/$process_pid/status" 2>/dev/null || true)"
  # The command name: nvidia-smi names a Python server after its interpreter, the kernel after its launcher script.
  process_comm="$(awk '/^Name:/{print $2; exit}' "/proc/$process_pid/status" 2>/dev/null | tr -d ',' || true)"
fi
line process "$process,$process_state,$process_comm"

container_id=""
if [ -n "$process_pid" ] && [ -r "/proc/$process_pid/cgroup" ]; then
  container_id="$(grep -oE '[0-9a-f]{64}' "/proc/$process_pid/cgroup" 2>/dev/null | head -1 || true)"
fi
# Optional: only when docker is installed and readable by this account, and only for a container that
# holds the GPU process or whose name or image names a known inference engine.
if [ -z "$container_id" ]; then
  container_id="$(limit 1.5 docker ps --format '{{.ID}} {{.Names}} {{.Image}}' 2>/dev/null | awk '{line=tolower($0)} line ~ /vllm|sglang|tensorfold|llama|strata|triton|tensorrt|trtllm/{print $1; exit}' || true)"
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

# _TRANSPORT=kernel rather than -k, which implies -b: an error that forced a reboot is still shown afterwards.
kernel_summary="$(
  timeout 2s journalctl -q _TRANSPORT=kernel --since '-24 hours' --no-pager -o short-unix \
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
    END { printf "%d\t%d\t%d\t%d\t%s\t%s", count+0, no_memory+0, xid+0, (count >= 1000), epoch, last }
  '
)"
kernel_rc="$?"
case "$kernel_rc" in
  0) kernel_status="ok" ;;
  124) kernel_status="timeout" ;;
  1)
    # No match, or no access: an account that cannot read the system journal still opens its own and exits 0, so
    # the journal counts as readable only when it shows a kernel line.
    if [ -n "$(timeout 1s journalctl -q _TRANSPORT=kernel --no-pager -n 1 2>/dev/null)" ]; then
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
  if (normalized.includes("tensorfold")) return "TensorFold";
  if (normalized.includes("strata")) return "Strata";
  if (normalized.includes("ollama")) return "Ollama";
  if (normalized.includes("omlx")) return "oMLX";
  if (normalized.includes("llama")) return "llama.cpp";
  if (normalized.includes("tensorrt") || normalized.includes("trtllm")) return "TensorRT-LLM";
  if (normalized.includes("triton")) return "Triton";
  return null;
}

function detectEngine(processName, command = null) {
  return knownEngine(processName) ?? knownEngine(command) ?? (processName ? String(processName).split(/[/:]/)[0] : null);
}

// The collector script for one node: the shared body plus the interfaces that node must report.
export function buildRemoteScript(interfaces = []) {
  const pairs = interfaces.map((nic) => `${nic} ${rdmaDevice(nic) ?? "-"}`).join(" ");
  if (!/^[A-Za-z0-9_. -]*$/.test(pairs)) throw new Error("invalid interface name for the collector script");
  return `SCOPE_IFACES='${pairs}'\nif [ "$(uname -s)" = "Darwin" ]; then\n${LIMIT_SCRIPT}\n${DARWIN_SCRIPT}\nexit\nfi\n${REMOTE_SCRIPT}`;
}

// "net:<interface>" lines become network[<interface>].
export function parseNetworkLines(lines, interfaces = []) {
  const network = {};
  for (const nic of interfaces) network[nic] = parseNetwork(lines[`net:${nic}`]);
  return network;
}

export function parseInferenceProcess(value) {
  const [pid, processName, usedMemoryMiB, state, command] = splitCsv(value);
  const rankMatch = String(processName ?? "").match(/(?:worker[_-]?)?tp\s*[_-]?(\d+)/i);
  const up = Boolean(processName);
  const alive = up && Boolean(state) && !["X", "x", "Z"].includes(state);
  return {
    up,
    alive,
    ready: alive,
    pid: integer(pid, null),
    processName: processName || null,
    command: command || null,
    engine: detectEngine(processName, command),
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

const UNKNOWN_GPU_MEMORY = { kind: null, totalBytes: null, availableBytes: null, usedBytes: null };

function framebufferBytes(value) {
  const text = String(value ?? "").trim();
  const bytes = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1048576 : NaN;
  return Number.isFinite(bytes) ? bytes : null;
}

function unifiedGpuMemory({ totalBytes, availableBytes, usedBytes }) {
  return { kind: "unified", totalBytes, availableBytes, usedBytes };
}

export function parseGpuMemory(name, usedMiB, totalMiB, systemMemory) {
  if (/\bGB10\b/i.test(String(name ?? "")) || /^Apple M\d+(?: (?:Pro|Max|Ultra))?$/i.test(String(name ?? ""))) return unifiedGpuMemory(systemMemory);
  const totalBytes = framebufferBytes(totalMiB);
  if (!name || !(totalBytes > 0)) return { ...UNKNOWN_GPU_MEMORY };
  const reportedUsed = framebufferBytes(usedMiB);
  const usedBytes = reportedUsed !== null && reportedUsed <= totalBytes ? reportedUsed : null;
  return { kind: "discrete", totalBytes, usedBytes, availableBytes: difference(totalBytes, usedBytes) };
}

export function applyGpuMemoryFallback(node, kind) {
  if (!node?.ok || !node.gpu || node.gpu.status === "ok" || node.gpu.memory?.kind) return;
  if (kind === "unified") node.gpu.memory = unifiedGpuMemory(node.memory);
  else if (kind === "discrete") node.gpu.memory = { ...UNKNOWN_GPU_MEMORY, kind };
}

// One node's snapshot from the collector's "key|value" lines. Lines that never arrived (a poll cut short) stay unknown.
function nodeSnapshot(lines, { id, name, host, local, role, expectedRank, interfaces, startedAt }) {
  const darwin = lines.platform === "darwin";
  const gpu = splitCsv(lines.gpu);
  const unified = splitCsv(lines.gpu_unified);
  const pressure = splitCsv(lines.memory_pressure);
  const power = splitCsv(lines.power);
  const memory = splitCsv(lines.memory);
  const disk = splitCsv(lines.disk);
  const container = splitCsv(lines.container);
  const inference = parseInferenceProcess(lines.process);
  if (darwin) inference.memoryBytes = integer(lines.process_memory, null);
  const thermals = parseThermals(lines.thermals);
  const hwmon = parseHwmon(lines.hwmon);
  const kernelEvents = parseKernelEvents(lines.kernel);
  const totalMemoryBytes = kibibytes(memory[0]);
  const availableMemoryBytes = kibibytes(memory[1]);
  const systemMemory = {
    totalBytes: totalMemoryBytes,
    availableBytes: availableMemoryBytes,
    usedBytes: difference(totalMemoryBytes, availableMemoryBytes),
    swapUsedBytes: difference(kibibytes(memory[2]), kibibytes(memory[3])),
    ...(darwin ? { pressureLevel: integer(pressure[0], null), freePercent: number(pressure[1]), compressedBytes: integer(pressure[2], null) } : {}),
  };
  const reportedMemory = parseGpuMemory(gpu.slice(9).join(","), gpu[7], gpu[8], systemMemory);
  const gpuMemory = darwin && reportedMemory.kind === "unified"
    ? { ...reportedMemory, inUseBytes: integer(unified[0], null), allocatedBytes: integer(unified[1], null) }
    : reportedMemory;
  const systemMilliwatts = number(power[0]);
  const engine = inference.up
    ? knownEngine(inference.processName) ?? knownEngine(inference.command) ?? knownEngine(container[1]) ?? knownEngine(container[0])
    : null;
  const gpuReadings = {
    utilization: number(gpu[0]),
    temperature: number(gpu[1]),
    powerWatts: number(gpu[2]),
    clockMHz: number(gpu[3]),
  };
  const gpuAvailable = Object.values(gpuReadings).some(Number.isFinite) || (gpuMemory.kind === "discrete" && gpuMemory.totalBytes !== null);
  const reportedStatus = GPU_STATUSES.has(lines.gpu_status) ? lines.gpu_status : null;

  return {
    ok: true,
    collected: true,
    id,
    name,
    host,
    local,
    hostname: lines.hostname || host,
    ...(darwin ? {
      platform: "darwin",
      thermalPressure: integer(lines.thermal_pressure, null),
      power: { hasBattery: lines.battery === "present" ? true : lines.battery === "absent" ? false : null, systemWatts: systemMilliwatts === null ? null : systemMilliwatts / 1000, batteryPercent: number(power[1]), onAC: power[2] === "Yes" ? true : power[2] === "No" ? false : null },
    } : {}),
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
      memory: gpuMemory,
      ...(darwin ? { cores: integer(unified[2], null) } : {}),
      performanceState: gpu[4] || "N/A",
      thermalSlowdown: [gpu[5], gpu[6]].some((value) => /active/i.test(value) && !/not active/i.test(value)),
      // NVIDIA queries may time out or hang in the driver.
      status: gpuAvailable ? "ok" : reportedStatus && reportedStatus !== "ok" ? reportedStatus : lines.gpu === undefined ? "timeout" : "error",
      available: gpuAvailable,
    },
    thermals,
    nvmeCelsius: hwmon.nvmeCelsius,
    nicCelsius: hwmon.nicCelsius,
    cpu: parseCpu(lines.cpu),
    kernelEvents,
    memory: systemMemory,
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

// Counters only grow within one engine run; a missing counter does not break the series.
function notLess(current, previous) {
  return current === null || previous === null || current >= previous;
}

function sameSeries(previous, current, fields) {
  return Boolean(previous) && previous.engine === current.engine && previous.modelName === current.modelName && fields.every((field) => notLess(current[field], previous[field]));
}
const PREFILL_FIELDS = ["promptTotal", "promptComputeTotal", "promptCacheTotal", "prefillTimeTotal", "prefillCount"];
const OUTPUT_FIELDS = ["generationTotal", "liveGenerationTotal", "promptTotal", "promptComputeTotal", "promptCacheTotal"];

export function holdPrefillRates(current, previous = null, held = null) {
  if (current.promptTotal === null || current.prefillTimeTotal === null) {
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
  // A counter missing from the previous poll (TensorFold's /health did not answer) has no baseline: wait for the next.
  if (continuing && PREFILL_FIELDS.some((field) => previous[field] === null && current[field] !== null)) return held ?? empty;

  if ((current.prefillCount !== null && completedPrefills <= 0) || elapsedPrefillSeconds <= 0 || promptTokens <= 0) {
    return continuing ? (held ?? empty) : empty;
  }

  return {
    promptTokensPerSecond: promptTokens / elapsedPrefillSeconds,
    promptComputeTokensPerSecond: part(current.promptComputeTotal, baseline.promptComputeTotal),
    promptCacheTokensPerSecond: part(current.promptCacheTotal, baseline.promptCacheTotal),
    updatedAt: new Date(current.at).toISOString(),
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

async function fetchOptionalJson(url) {
  const result = await fetchWithTiming(url).catch(() => null);
  if (!result?.response.ok) {
    discard(result?.response);
    return null;
  }
  return result.response.json().catch(() => null);
}

export class InferenceCollector {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.previous = null;
    this.prefillRates = null;
    this.models = [];
    this.modelsFetchedAt = 0;
    this.latency = new RecentHistograms();
    this.llamacppSlots = new LlamacppSlots();
  }

  async collect() {
    const collectedAt = Date.now();
    try {
      const settled = await Promise.allSettled([
        fetchWithTiming(`${this.baseUrl}/health`),
        fetchWithTiming(`${this.baseUrl}/metrics`),
      ]);
      const [healthResult, metricsResult] = settled.map((result) => (result.status === "fulfilled" ? result.value : null));
      const failed = settled.find((result) => result.status === "rejected");
      if (failed) {
        discard(healthResult?.response);
        discard(metricsResult?.response);
        throw failed.reason;
      }
      if (!metricsResult.response.ok) {
        discard(healthResult.response);
        discard(metricsResult.response);
        throw new Error(`metrics HTTP ${metricsResult.response.status}`);
      }
      const metricsText = await metricsResult.response.text();
      const metricsAt = Date.now();
      let parsed;
      try {
        parsed = parseMetricsResponse(metricsText);
      } catch (error) {
        discard(healthResult.response);
        throw error;
      }
      const { metrics, engine, json } = parsed;
      // Only the status of /health matters, except TensorFold's, whose JSON carries counters /metrics lacks.
      let health = null;
      if (engine === "TensorFold" && healthResult.response.ok) health = await healthResult.response.json().catch(() => null);
      else discard(healthResult.response);
      const reading = readEngineMetrics(engine, metrics, health, json);
      // GET /slots wakes a llama-server started with --sleep-idle-seconds and restarts its idle timer, which /metrics
      // does not: read slots only while /metrics shows running requests, and ask at once, before /v1/models.
      const pendingSlots = engine === "llama.cpp" && reading.runningRequests > 0
        ? fetchOptionalJson(`${this.baseUrl}/slots`).then((slots) => ({ slots, at: Date.now() }))
        : null;
      const metricModelName = reading.modelName ?? resolveModelIdentity(metrics).modelName;
      const modelCacheExpired = collectedAt - this.modelsFetchedAt >= 30_000;
      // Without a model name in the metrics (TensorFold), only the model list tells a model switch: read it every poll.
      const modelCacheMiss = !metricModelName || !this.models.some((model) => model?.id === metricModelName);
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
      const identity = resolveModelIdentity(metrics, this.models, reading.modelName);
      const { generationTotal, liveGenerationTotal, promptTotal, promptComputeTotal, promptCacheTotal, prefillTimeTotal, prefillCount } = reading;
      const snapshot = { at: collectedAt, engine, modelName: identity.modelName, generationTotal, liveGenerationTotal, promptTotal, promptComputeTotal, promptCacheTotal, prefillTimeTotal, prefillCount };
      const elapsedSeconds = sameSeries(this.previous, snapshot, OUTPUT_FIELDS) ? (collectedAt - this.previous.at) / 1000 : 0;
      // Unknown until two samples of the same run exist (the first poll, or right after a restart).
      const rate = (field) => (elapsedSeconds > 0 && snapshot[field] !== null && this.previous[field] !== null
        ? Math.max(0, (snapshot[field] - this.previous[field]) / elapsedSeconds)
        : null);
      const counterRate = rate("generationTotal");
      if (engine === "llama.cpp") {
        if (!sameSeries(this.previous, snapshot, OUTPUT_FIELDS)) this.llamacppSlots.reset();
        if (pendingSlots) {
          const { slots, at } = await pendingSlots;
          reading.decodeTokensPerSecond = this.llamacppSlots.rate(slots, at, identity.modelName);
        } else if (reading.runningRequests === 0) {
          reading.decodeTokensPerSecond = this.llamacppSlots.idle(metricsAt, identity.modelName);
        } else {
          this.llamacppSlots.reset();
          reading.decodeTokensPerSecond = null;
        }
      } else this.llamacppSlots.reset();
      const outputTokensPerSecond = reading.decodeTokensPerSecond !== undefined ? reading.decodeTokensPerSecond
        : liveGenerationTotal !== null ? rate("liveGenerationTotal") : counterRate;
      this.prefillRates = holdPrefillRates(snapshot, this.previous, this.prefillRates);
      this.previous = snapshot;

      this.latency.add(collectedAt, { ttft: reading.ttftBuckets, tpot: reading.tpotBuckets });

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
        runningRequests: reading.runningRequests,
        waitingRequests: reading.waitingRequests,
        kvCachePercent: reading.kvCachePercent,
        prefixCacheHitPercent: reading.prefixCacheHitPercent,
        speculativeAcceptancePercent: reading.speculativeAcceptancePercent,
        ttftP95Seconds: reading.ttftP95Seconds,
        tpotP95Seconds: reading.tpotP95Seconds,
        ttftP95RecentSeconds: this.latency.quantile("ttft", 0.95),
        tpotP95RecentSeconds: this.latency.quantile("tpot", 0.95),
        latencyWindowSeconds: this.latency.windowSeconds,
        completedRequestsTotal: reading.completedRequestsTotal,
        processStartedAt: reading.processStartedAt,
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
