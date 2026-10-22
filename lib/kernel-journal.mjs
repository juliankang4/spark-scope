// The cursor and rolling window live in the collector, never on a monitored node.
export const KERNEL_SCRIPT = String.raw`
# _TRANSPORT=kernel includes errors from before a reboot, unlike -k.
kernel_mode="full"
kernel_tail=""
if [ -n "$SCOPE_KERNEL_CURSOR" ]; then
  # A removed cursor can silently seek to a nearby entry. Check its exact identity first.
  kernel_check="$(timeout 1s journalctl -q _TRANSPORT=kernel --cursor "$SCOPE_KERNEL_CURSOR" --no-pager -n 1 --show-cursor -o cat 2>/dev/null)"
  if [ "$?" = 0 ] && [ "$(printf '%s\n' "$kernel_check" | awk '/^-- cursor: / {print substr($0, 12)}')" = "$SCOPE_KERNEL_CURSOR" ]; then
    kernel_mode="incremental"
  fi
fi
if [ "$kernel_mode" = "incremental" ]; then
  set -- --after-cursor "$SCOPE_KERNEL_CURSOR"
else
  # Save the tail before the bounded reverse read, whose footer points backwards.
  set -- --since '-24 hours' -n 1000 --reverse
  if kernel_check="$(timeout 1s journalctl -q _TRANSPORT=kernel --no-pager -n 1 --show-cursor -o cat 2>/dev/null)"; then
    kernel_tail="$(printf '%s\n' "$kernel_check" | awk '/^-- cursor: / {print substr($0, 12)}')"
  fi
fi
line kernel_mode "$kernel_mode"
line kernel_clock "$(date +%s.%6N)"
kernel_data="$(
  timeout 2s journalctl -q _TRANSPORT=kernel "$@" --no-pager -o short-unix --show-cursor \
    -g 'NV_ERR|Xid|GPU has fallen off the bus|NVRM:.*([Ee]rror|[Ff]ail|[Ff]ault)' 2>/dev/null |
  awk '
    /^-- cursor: / {cursor = substr($0, 12); next}
    /^[0-9]+\.[0-9]+ / {
      raw = $0
      epoch = $1
      no_memory = (raw ~ /NV_ERR_NO_MEMORY/)
      xid = (raw ~ /Xid/)
      sub(/^[^ ]+[ ]+[^ ]+[ ]+kernel:?[ ]*/, "", raw)
      gsub(/[|\t\r\n]/, " ", raw)
      if (length(raw) > 180) raw = substr(raw, 1, 177) "..."
      entries[count % 1000] = epoch "\t" no_memory "\t" xid "\t" raw
      count++
    }
    END {
      first = count > 1000 ? count - 1000 : 0
      for (i = first; i < count; i++) printf "kernel_event:%d|%s\n", i - first, entries[i % 1000]
      if (cursor != "") printf "kernel_cursor|%s\n", cursor
    }
  '
)"
kernel_rc="$?"
printf '%s\n' "$kernel_data"
if [ "$kernel_mode" = "full" ]; then line kernel_cursor "$kernel_tail"; fi
case "$kernel_rc" in
  0) kernel_status="ok" ;;
  1)
    # A quiet 24-hour window has no cursor footer; the tail probe still proves access.
    if [ -n "$kernel_tail" ] || printf '%s\n' "$kernel_data" | grep -q '^kernel_cursor|'; then kernel_status="ok"; else kernel_status="unavailable"; fi
    ;;
  124|137) kernel_status="timeout" ;;
  *) kernel_status="unavailable" ;;
esac
line kernel "$kernel_status"
`;

export function isKernelCursor(cursor) {
  return typeof cursor === "string" && cursor.length <= 1024 && /^[A-Za-z0-9_=;:-]*$/.test(cursor);
}

export class KernelJournal {
  cursor = "";
  entries = [];

  summary(lines) {
    if (!lines.kernel_mode) return lines.kernel;
    const now = Number(lines.kernel_clock);
    const cutoff = (Number.isFinite(now) && now > 0 ? now : Date.now() / 1000) - 86400;
    const incoming = Object.entries(lines).filter(([key]) => key.startsWith("kernel_event:")).map(([, value]) => {
      const [epoch, noMemory, xid, ...message] = value.split("\t");
      return { epoch: Number(epoch), noMemory: Number(noMemory), xid: Number(xid), message: message.join("\t") };
    }).filter(entry => Number.isFinite(entry.epoch));
    const previous = lines.kernel_mode === "full" ? [] : this.entries;
    const key = entry => `${entry.epoch}\t${entry.message}`;
    const seen = new Set(previous.map(key));
    const entries = [...previous, ...incoming.filter(entry => !seen.has(key(entry)))]
      .filter(entry => entry.epoch >= cutoff).sort((left, right) => left.epoch - right.epoch).slice(-1000);
    // A timeout or interrupted SSH response must not advance past errors we may not have received.
    if (lines.kernel === "ok" && lines.kernel_cursor) {
      this.cursor = isKernelCursor(lines.kernel_cursor) ? lines.kernel_cursor : "";
      this.entries = entries;
    }
    const last = entries.at(-1);
    return [lines.kernel || "unavailable", entries.length,
      entries.reduce((sum, entry) => sum + entry.noMemory, 0),
      entries.reduce((sum, entry) => sum + entry.xid, 0),
      Number(entries.length >= 1000), last?.epoch ?? "", last?.message ?? ""].join("\t");
  }
}
