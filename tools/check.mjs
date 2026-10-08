import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";

const SCRIPT = /\.(mjs|js)$/;
const TEXT = /(\.(mjs|js|css|html|svg|json|xml|yml|yaml|desktop)$)|(^|\/)spark-scope-kiosk$/;
const FORBIDDEN = ["dependencies", "devDependencies", "optionalDependencies"];
const STOPGAP_FROM_SPLIT_WORDS = new RegExp(`\\b(?:${["TO" + "DO", "FIX" + "ME", "HA" + "CK"].join("|")})\\b|${["eslint-" + "disable", "@ts-" + "ignore", "@ts-" + "nocheck"].join("|")}`);

process.chdir(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", cwd: import.meta.dirname }).trim());
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const problems = [];

// The server serves public/ at the site root, so "/theme.js?v=1" is public/theme.js.
const PAGE_ROOT = "public";
const CLASSIC = new Set();
for (const page of tracked.filter((file) => file.endsWith(".html"))) {
  for (const [, attrs] of readFileSync(page, "utf8").matchAll(/<script\b([^>]*)>/g)) {
    if (/\btype\s*=\s*["']?module/.test(attrs)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1];
    if (!src) continue;
    const url = new URL(src, `http://site/${path.relative(PAGE_ROOT, page)}`);
    if (url.host === "site") CLASSIC.add(path.join(PAGE_ROOT, decodeURIComponent(url.pathname)));
  }
}

function syntaxProblem(file, output) {
  const lines = String(output).trim().split("\n");
  const at = lines.find((line) => line.startsWith(`${file}:`)) ?? `${file}:1`;
  const reason = lines.find((line) => /^[A-Za-z]+Error:/.test(line)) ?? "syntax error";
  problems.push(`${at} ${reason}`);
}

for (const file of tracked) {
  if (SCRIPT.test(file)) {
    try {
      if (CLASSIC.has(file)) new Script(readFileSync(file, "utf8"), { filename: file });
      else execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      syntaxProblem(file, error.stderr ?? error.stack ?? error.message);
    }
  }
  if (TEXT.test(file)) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (STOPGAP_FROM_SPLIT_WORDS.test(line)) problems.push(`${file}:${index + 1}: stopgap marker: ${line.trim()}`);
    });
  }
}

const pkgText = readFileSync("package.json", "utf8");
const pkg = JSON.parse(pkgText);
const keyLine = (key) => Math.max(1, pkgText.split("\n").findIndex((line) => line.includes(`"${key}"`)) + 1);
for (const key of FORBIDDEN) {
  if (Object.keys(pkg[key] ?? {}).length) problems.push(`package.json:${keyLine(key)}: ${key} is not allowed`);
}
if (pkg.private !== true) problems.push(`package.json:${keyLine("private")}: "private": true is required`);

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`check: ${tracked.length} tracked files, no problems`);
