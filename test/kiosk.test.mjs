import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "kiosk", "spark-scope-kiosk");

// Runs the kiosk script with a fake curl (records the health URL, answers at once) and a fake Chromium
// (records its arguments instead of opening a window).
function runKiosk(env, { failures = 0 } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-kiosk-"));
  const log = path.join(directory, "log");
  // The fake curl fails the first `failures` calls, as a dashboard that is still starting would.
  writeFileSync(path.join(directory, "curl"), `#!/bin/sh\nfor last; do :; done\necho "curl $last" >> "${log}"\nn=$(grep -c '^curl' "${log}")\n[ "$n" -gt ${failures} ]\n`);
  writeFileSync(path.join(directory, "sleep"), "#!/bin/sh\nexit 0\n");
  writeFileSync(path.join(directory, "chromium"), `#!/bin/sh\necho "chromium $*" >> "${log}"\n`);
  for (const name of ["curl", "chromium", "sleep"]) chmodSync(path.join(directory, name), 0o755);
  try {
    const result = spawnSync("sh", [SCRIPT], {
      env: { PATH: `${directory}:/usr/bin:/bin`, HOME: directory, CHROMIUM: path.join(directory, "chromium"), ...env },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = spawnSync("cat", [log], { encoding: "utf8" }).stdout.trim().split("\n");
    lines.stderr = result.stderr;
    return lines;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the kiosk waits on the dashboard's health URL even when the host name starts with 'rack'", () => {
  const [curl, chromium] = runKiosk({ SPARK_SCOPE_RACK_URL: "http://rack-pi.local:8787/rack/?width=2560" });
  assert.equal(curl, "curl http://rack-pi.local:8787/api/health");
  assert.match(chromium, /http:\/\/rack-pi\.local:8787\/rack\/\?width=2560$/);
});

test("the kiosk uses Wayland whenever a Wayland display is set, and lets Chromium choose otherwise", () => {
  const wayland = runKiosk({ WAYLAND_DISPLAY: "wayland-0" }).at(-1);
  assert.match(wayland, /--ozone-platform=wayland /);
  assert.match(wayland, /http:\/\/127\.0\.0\.1:8787\/rack\/$/);
  assert.match(runKiosk({}).at(-1), /--ozone-platform-hint=auto /);
});

test("the kiosk starts Chromium with its own window class, so the labwc rule leaves other Chromium windows alone", () => {
  assert.match(runKiosk({}).at(-1), /--class=spark-scope-kiosk /);
  const rule = spawnSync("cat", [path.join(ROOT, "kiosk", "labwc-rc.xml")], { encoding: "utf8" }).stdout;
  assert.match(rule, /<windowRule identifier="spark-scope-kiosk">/);
  assert.doesNotMatch(rule, /identifier="chromium/);
});

test("while the dashboard is not up yet, the kiosk says what it waits for once a minute", () => {
  const lines = runKiosk({}, { failures: 13 });
  assert.equal(lines.filter((line) => line.startsWith("curl")).length, 14);
  assert.equal(lines.stderr.match(/waiting for http:\/\/127\.0\.0\.1:8787\/api\/health/g).length, 2);
  assert.match(lines.at(-1), /^chromium /);
});
