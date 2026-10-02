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
function runKiosk(env) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spark-scope-kiosk-"));
  const log = path.join(directory, "log");
  writeFileSync(path.join(directory, "curl"), `#!/bin/sh\nfor last; do :; done\necho "curl $last" >> "${log}"\nexit 0\n`);
  writeFileSync(path.join(directory, "chromium"), `#!/bin/sh\necho "chromium $*" >> "${log}"\n`);
  for (const name of ["curl", "chromium"]) chmodSync(path.join(directory, name), 0o755);
  try {
    const result = spawnSync("sh", [SCRIPT], {
      env: { PATH: `${directory}:/usr/bin:/bin`, HOME: directory, CHROMIUM: path.join(directory, "chromium"), ...env },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    return spawnSync("cat", [log], { encoding: "utf8" }).stdout.trim().split("\n");
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
