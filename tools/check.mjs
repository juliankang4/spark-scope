// Repository rules from AGENTS.md, run by npm run check: every tracked script parses, package.json stays private and
// free of npm dependencies, and no tracked source, style or markup file carries a stopgap marker. A checkout is all
// it needs: git and node, nothing installed and nothing contacted.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = /\.(mjs|js)$/;
// Source, style, markup and config, plus the extensionless kiosk shell script.
const TEXT = /(\.(mjs|js|css|html|svg|json|xml|desktop)$)|(^|\/)spark-scope-kiosk$/;
const MARKER = /\b(TODO|FIXME|HACK|XXX)\b|eslint-disable|@ts-(ignore|nocheck)/;
const FORBIDDEN = ["dependencies", "devDependencies", "optionalDependencies"];

// The marker pattern holds the words it looks for, so the check never scans itself. npm runs the script at the
// package root, where git ls-files reports the same relative paths.
const SELF = path.relative(process.cwd(), fileURLToPath(import.meta.url));

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const problems = [];

for (const file of tracked) {
  if (SCRIPT.test(file)) {
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      const lines = String(error.stderr).trim().split("\n").filter(Boolean);
      problems.push(lines.length ? `${lines[0]} ${lines.at(-1)}` : `${file}:1 syntax error`);
    }
  }
  if (file !== SELF && TEXT.test(file)) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (MARKER.test(line)) problems.push(`${file}:${index + 1}: stopgap marker: ${line.trim()}`);
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
