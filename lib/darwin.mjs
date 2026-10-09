export const DARWIN_SCRIPT = String.raw`set -u
set -o pipefail
line() { printf '%s|%s\n' "$1" "$2"; }
line platform darwin
line hostname "$(hostname)"
boot="$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \([0-9]*\),.*/\1/p')"
if [ -n "$boot" ]; then line uptime "$(( $(date +%s) - boot ))"; else line uptime ""; fi
line system ""
line failed_units 0

accel="$(ioreg -r -c IOAccelerator -d 1 -w0 2>/dev/null)"
gpu_name="$(printf '%s\n' "$accel" | sed -n 's/^ *"model" = "\(.*\)"$/\1/p' | head -1)"
[ -n "$gpu_name" ] || gpu_name="$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
gpu_name="$(printf '%s' "$gpu_name" | tr ',|\r\n' '    ')"
gpu_cores="$(printf '%s\n' "$accel" | sed -n 's/^ *"gpu-core-count" = \([0-9]*\)$/\1/p' | head -1)"
perf="$(printf '%s\n' "$accel" | grep -o '"PerformanceStatistics" = {[^}]*}' | head -1)"
perf_value() { printf '%s\n' "$perf" | sed -n "s/.*\"$1\"=\([0-9][0-9]*\).*/\1/p"; }
util="$(perf_value 'Device Utilization %')"
thermal="$(notifyutil -g com.apple.system.thermalpressurelevel 2>/dev/null | awk '{print $2}')"
case "$thermal" in 2|3|4) slowdown="Active" ;; *) slowdown="Not Active" ;; esac
line gpu "$util,,,,N/A,$slowdown,Not Active,,,$gpu_name"
if [ -n "$util" ]; then line gpu_status ok; else line gpu_status missing; fi
line gpu_unified "$(perf_value 'In use system memory'),$(perf_value 'Alloc system memory'),$gpu_cores"
line thermal_pressure "$thermal"

total="$(sysctl -n hw.memsize 2>/dev/null)"
pagesize="$(sysctl -n hw.pagesize 2>/dev/null)"
vm="$(vm_stat 2>/dev/null)"
mem="$(printf '%s\n' "$vm" | awk -F: -v total="$total" -v size="$pagesize" '
  { gsub(/[^0-9]/, "", $2); pages[$1] = $2 }
  END {
    if (total !~ /^[0-9]+$/ || size !~ /^[0-9]+$/ || size == 0) exit
    printf "%.0f,", total / 1024
    if (pages["Anonymous pages"] == "" || pages["Pages purgeable"] == "" || pages["Pages wired down"] == "" || pages["Pages occupied by compressor"] == "") exit
    activity_monitor_used = (pages["Anonymous pages"] - pages["Pages purgeable"] + pages["Pages wired down"] + pages["Pages occupied by compressor"]) * size
    if (activity_monitor_used < 0) activity_monitor_used = 0; if (activity_monitor_used > total) activity_monitor_used = total
    printf "%.0f", (total - activity_monitor_used) / 1024
  }')"
swap="$(sysctl -n vm.swapusage 2>/dev/null)"
swap_kb() { printf '%s\n' "$swap" | awk -v field="$1" '{ v = $field; u = substr(v, length(v)); if (v !~ /^[0-9.]+[KMG]$/) exit; sub(/[KMG]$/, "", v); printf "%.0f", v * (u == "G" ? 1048576 : u == "M" ? 1024 : 1) }'; }
[ -n "$mem" ] || mem=,
line memory "$mem,$(swap_kb 3),$(swap_kb 9)"
compressed="$(printf '%s\n' "$vm" | awk -F: -v size="$pagesize" '$1 == "Pages occupied by compressor" && size ~ /^[0-9]+$/ { gsub(/[^0-9]/, "", $2); if ($2 != "") printf "%.0f", $2 * size }')"
line memory_pressure "$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null),$(sysctl -n kern.memorystatus_level 2>/dev/null),$compressed"
line disk "$(df -k /System/Volumes/Data 2>/dev/null | tail -1 | awk '{ gsub(/%/, "", $5); if ($2 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/) printf "%.0f,%.0f,%s", $2 * 1024, $4 * 1024, $5 }')"

pid="$(pgrep -x omlx-server 2>/dev/null | head -1)"
process_name=omlx-server
if [ -z "$pid" ]; then
  pid="$(pgrep -f '(^|[ /])(omlx(-cli)? serve|python[^ ]* +(-[^ ]* +)*-m +omlx(\.cli)? +serve([ ]|$))' 2>/dev/null | head -1)"
  process_name=omlx
fi
if [ -z "$pid" ]; then pid="$(pgrep -x llama-server 2>/dev/null | head -1)"; process_name=llama-server; fi
process=""
footprint=""
if [ -n "$pid" ]; then
  state="$(ps -o state= -p "$pid" 2>/dev/null | tr -d ' ' | cut -c1)"
  footprint="$(limit 1.5 footprint -f bytes --noCategories -p "$pid" 2>/dev/null | sed -n 's/^ *phys_footprint: \([0-9]*\) B$/\1/p' | head -1)"
  process="$pid,$process_name,,$state,$process_name"
fi
line process "$process"
line process_memory "$footprint"
line container ",,false,0,"
line thermals ""
line hwmon "nvme=,nic="
line cpu "$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{ print $1 "," $2 "," $3 }'),$(sysctl -n hw.ncpu 2>/dev/null)"

# AppleSmartBattery reports whole-system milliwatts, refreshed about once a minute.
battery="$(ioreg -rn AppleSmartBattery -w0 2>/dev/null)"
battery_rc=$?
if [ "$battery_rc" != 0 ]; then line battery unknown
elif printf '%s\n' "$battery" | grep -q AppleSmartBattery; then line battery present
else line battery absent; fi
system_load="$(printf '%s\n' "$battery" | grep -o '"SystemLoad"=[0-9]*' | head -1 | cut -d= -f2)"
charge="$(printf '%s\n' "$battery" | sed -n 's/^ *| *"CurrentCapacity" = \([0-9]*\)$/\1/p' | head -1)"
external="$(printf '%s\n' "$battery" | sed -n -E 's/^ *\| *"ExternalConnected" = (Yes|No)$/\1/p' | head -1)"
line power "$system_load,$charge,$external"
line kernel "unavailable	0	0	0	0		"
`;
