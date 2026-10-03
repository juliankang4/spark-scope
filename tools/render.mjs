// Development check: renders the rack panel and the web dashboard with synthetic data (tools/fixtures.mjs) for
// one to six nodes, the longest ids and names, a 1024 x 600 screen and a phone in headless Chrome, in English and in
// Korean, saves PNGs and reports clipped or overlapping text on the rack panel, overflow or script errors on the web
// page and in its settings dialog, and English words left untranslated on the Korean pages.
// Nothing is collected and no other machine is contacted.
//
//   node tools/render.mjs                 # PNGs go to $OUT or <tmp>/spark-scope-renders
//   CHROME=/path/to/chrome node tools/render.mjs
//
// It needs Chrome or Chromium; it drives it over the DevTools protocol with Node's built-in WebSocket.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureState, usageMonth, MODES } from "./fixtures.mjs";
import { SECURITY_HEADERS } from "../lib/http-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const OUT = process.env.OUT || path.join(os.tmpdir(), "spark-scope-renders");
const COUNTS = (process.env.COUNTS || "1,2,3,4,5,6").split(",").map(Number);
mkdirSync(OUT, { recursive: true });

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const candidate of candidates) {
    if (candidate.startsWith("/") ? existsSync(candidate) : spawnSync("which", [candidate]).status === 0) return candidate;
  }
  throw new Error("Chrome or Chromium not found; set CHROME=/path/to/chrome");
}

// ---- fixture server: the real public/ files, /api/state from fixtures ----
let current = { count: 4, mode: "serving", longNames: false };
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript; charset=utf-8", ".woff2": "font/woff2" };
// The server's own security headers, so a page that breaks the Content-Security-Policy shows up as a console error.
const server = createServer((request, response) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/api/state") {
    if (current.mode === "lost") { response.writeHead(503).end("{}"); return; }
    const state = fixtureState(current.count, current.mode, Date.now(), { longNames: current.longNames });
    const minutes = Number(url.searchParams.get("minutes") || 60);
    state.history = state.history.filter((point) => point.at >= Date.now() - minutes * 60_000);
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(state));
    return;
  }
  if (url.pathname === "/api/usage") {
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(usageMonth(url.searchParams.get("month"), Date.now())));
    return;
  }
  const file = path.join(PUBLIC, url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- minimal DevTools protocol client ----
// Chrome runs with its background services off (updates, sync, safe browsing, metrics), so the check contacts
// nothing but the local fixture server. If anything below fails, the finally block at the end (or the exit hook
// here, for a failure before it) stops Chrome and removes its profile.
const profile = mkdtempSync(path.join(os.tmpdir(), "spark-scope-chrome-"));
const chrome = spawn(findChrome(), [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--force-color-profile=srgb", "--disable-extensions",
  "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
  "--disable-domain-reliability", "--disable-client-side-phishing-detection", "--metrics-recording-only", "--no-pings",
  "about:blank",
], { stdio: "ignore" });
const cleanUp = () => {
  chrome.kill();
  rmSync(profile, { recursive: true, force: true });
};
process.once("exit", cleanUp);
const portFile = path.join(profile, "DevToolsActivePort");
for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((resolve) => setTimeout(resolve, 100));
if (!existsSync(portFile)) {
  console.error("Chrome did not open its DevTools port within 10 seconds");
  server.close();
  process.exit(1);
}
const [debugPort, browserPath] = readFileSync(portFile, "utf8").trim().split("\n");
const socket = new WebSocket(`ws://127.0.0.1:${debugPort}${browserPath}`);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("could not connect to Chrome's DevTools port")); }).catch((error) => {
  console.error(error.message);
  server.close();
  process.exit(1);
});
let nextId = 0;
const pending = new Map();
const listeners = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  } else if (message.method) {
    for (const listener of listeners) listener(message);
  }
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

async function openPage({ width, height, colorScheme = "dark" }) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const errors = [];
  listeners.push((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    // Browser-reported problems such as Content-Security-Policy violations arrive in the Log domain.
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") errors.push(message.params.entry.text);
  });
  const call = (method, params) => send(method, params, sessionId);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: colorScheme }] });
  const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
  const go = async (url) => {
    await call("Page.navigate", { url });
    for (let i = 0; i < 50 && (await evaluate("document.readyState")) !== "complete"; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    await evaluate("document.fonts.ready.then(() => true)");
  };
  const waitFor = async (expression, timeoutMs = 8000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (await evaluate(expression)) return true; await new Promise((resolve) => setTimeout(resolve, 150)); }
    throw new Error(`timed out waiting for ${expression}`);
  };
  const shoot = async (file, { fullPage = false } = {}) => {
    // The visible part of the page, wherever it is scrolled to.
    const [scrollX, scrollY] = await evaluate("[scrollX, scrollY]");
    let clip = { x: scrollX, y: scrollY, width, height, scale: 1 };
    if (fullPage) {
      const fullHeight = await evaluate("document.documentElement.scrollHeight");
      await call("Emulation.setDeviceMetricsOverride", { width, height: fullHeight, deviceScaleFactor: 1, mobile: width < 600 });
      clip = { x: 0, y: 0, width, height: fullHeight, scale: 1 };
    }
    const { data } = await call("Page.captureScreenshot", { format: "png", clip });
    writeFileSync(path.join(OUT, file), Buffer.from(data, "base64"));
    if (fullPage) await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  };
  const close = () => send("Target.closeTarget", { targetId });
  return { evaluate, go, waitFor, shoot, close, errors };
}

// Text that leaves the panel, overflows its box or overlaps other text (big figures are trimmed to their glyph band).
// Text cut off on purpose (overflow hidden with an ellipsis) is clipped to its box and listed as truncated.
const CHECK_RACK = `(() => {
  const screen = document.querySelector(".screen");
  const S = screen.getBoundingClientRect();
  const issues = [], texts = [], truncated = [];
  const walker = document.createTreeWalker(screen, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    const r = range.getBoundingClientRect(); if (!r.width) continue;
    const el = node.parentElement, fig = Boolean(el.closest(".num"));
    const box = fig ? { left: r.left, right: r.right, top: r.top + r.height * 0.18, bottom: r.bottom - r.height * 0.22 } : { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    const text = node.textContent.trim().slice(0, 40);
    const clip = el.closest("*") && [...(function* () { for (let a = el; a && a !== screen; a = a.parentElement) yield a; })()].find((a) => { const cs = getComputedStyle(a); return cs.textOverflow === "ellipsis" && cs.overflowX !== "visible"; });
    if (clip) {
      const cr = clip.getBoundingClientRect();
      if (r.right > cr.right + 1) truncated.push(text);
      box.left = Math.max(box.left, cr.left); box.right = Math.min(box.right, cr.right);
    }
    texts.push({ el, text, box });
    if (box.left < S.left - 1 || box.right > S.right + 1 || box.top < S.top - 1 || box.bottom > S.bottom + 1) issues.push("outside panel: " + text);
    for (let a = el; a && a !== screen; a = a.parentElement) {
      if (clip && (a === clip || clip.contains(a))) continue;
      const cs = getComputedStyle(a);
      if (cs.display.startsWith("inline") && cs.display !== "inline-flex" && cs.display !== "inline-block") continue;
      const ar = a.getBoundingClientRect();
      if (box.left < ar.left - 1 || box.right > ar.right + 1) { issues.push("overflow: " + text + " exceeds ." + a.className); break; }
    }
  }
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const p = texts[i], q = texts[j]; if (p.el === q.el) continue;
    const w = Math.min(p.box.right, q.box.right) - Math.max(p.box.left, q.box.left);
    const h = Math.min(p.box.bottom, q.box.bottom) - Math.max(p.box.top, q.box.top);
    if (w > 1 && h > 1) issues.push("overlap: " + p.text + " / " + q.text);
  }
  const fonts = { archivo: document.fonts.check('20px "Archivo"'), bebas: document.fonts.check('100px "Bebas Neue"') };
  const bays = [...document.querySelectorAll(".bay")].map((bay) => bay.querySelector(".name")?.textContent + " [" + bay.className + "] " + bay.querySelector(".reason")?.textContent + " | " + (bay.querySelector(".lk")?.textContent ?? "no link dots"));
  const band = [...document.querySelectorAll(".cl > *")].map((el) => el.textContent).join(" / ");
  for (const bay of document.querySelectorAll(".bay")) {
    const body = bay.querySelector(".main, .down"), foot = bay.querySelector(".foot");
    if (body && body.scrollHeight > body.clientHeight + 1) issues.push("bay content taller than its space: " + bay.querySelector(".name")?.textContent);
    if (foot && foot.getBoundingClientRect().bottom > bay.getBoundingClientRect().bottom + 1) issues.push("bay footer below the bay: " + bay.querySelector(".name")?.textContent);
  }
  const W = innerWidth, H = innerHeight;
  if (Math.abs(S.left - (W - S.width) / 2) > 2 || Math.abs(S.top - (H - S.height) / 2) > 2) issues.push("panel not centred: " + [S.left, S.top, S.width, S.height].map(Math.round).join(","));
  return { issues, fonts, bays, band, truncated, texts: texts.length };
})()`;

// Web page: page overflow, text wider than its own box (unless cut off on purpose) and diagram labels outside their shape.
const CHECK_WEB = `(() => {
  const issues = [];
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  if (overflow > 0) issues.push("horizontal overflow " + overflow + "px");
  // Reading labels stay whole on one line unless Full labels were chosen (Auto switches narrow cards to the short ones).
  if (document.documentElement.dataset.labels !== "full") for (const el of document.querySelectorAll(".reading small")) {
    if (el.getClientRects().length && el.scrollWidth > el.clientWidth + 1) issues.push("reading label cut: " + el.innerText.trim().slice(0, 40));
  }
  for (const el of document.querySelectorAll("#scope h1, #scope h2, .identity h1, .badge, .role span, .reading b, .extra span, .links td, .trend p span, .legend div, .status .sub span, #tokens h2, #tokens h3, .month-metrics small, .month-metrics b, .history th, .history td, .day-bar span")) {
    if (!el.getClientRects().length) continue;
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== "ellipsis") issues.push("text wider than its box: " + el.textContent.trim().slice(0, 40));
  }
  for (const group of document.querySelectorAll("#fabric-nodes g")) {
    const text = group.querySelector("text").getBBox(), shape = group.querySelector("circle, rect").getBBox();
    if (text.x < shape.x - 1 || text.x + text.width > shape.x + shape.width + 1) issues.push("diagram label outside its node: " + group.querySelector("text").textContent);
  }
  const svg = document.querySelector(".fabric");
  if (svg && !document.querySelector("#fabric-panel").hidden) {
    const box = svg.getBBox(), view = svg.viewBox.baseVal;
    if (box.x < -1 || box.y < -1 || box.x + box.width > view.width + 1 || box.y + box.height > view.height + 1) issues.push("diagram drawn outside its view box");
  }
  return issues;
})()`;

// Settings dialog: it stays inside the window, nothing in it is wider than its box, and the preview card fits.
const CHECK_SETTINGS = `(() => {
  const issues = [];
  const dialog = document.querySelector("#settings");
  if (!dialog.open) return ["settings dialog did not open"];
  const box = dialog.getBoundingClientRect();
  if (box.left < -1 || box.right > innerWidth + 1 || box.top < -1 || box.bottom > innerHeight + 1) issues.push("dialog outside the window: " + [box.left, box.top, box.width, box.height].map(Math.round).join(","));
  for (const el of dialog.querySelectorAll(".settings-frame, .settings-body, .settings-preview, .settings-nav, .settings-foot")) {
    if (el.getClientRects().length && el.scrollWidth > el.clientWidth + 1) issues.push("dialog part scrolls sideways: ." + el.className);
  }
  for (const el of dialog.querySelectorAll("h2, h3, legend, .pills span, .check span, .about dd, .settings-nav button, .settings-foot button, .settings-note, .reading small, .reading b, .memline span, .badge")) {
    if (el.getClientRects().length && el.scrollWidth > el.clientWidth + 1) issues.push("text wider than its box: " + el.textContent.trim().slice(0, 40));
  }
  return issues;
})()`;

// Korean pages: English words on screen that are neither technical terms kept in English nor data from the fixture
// (names, hosts, hardware, models, engines, containers, time zones) are text that missed the string table.
const TERMS = "GPU CPU NVMe NIC ACPI TSOC TS0E TS0P TS1E TS1P TGPU TUNC Xid NO MEMORY TP rank TTFT TPOT KV cache Prefill Decode Spec acceptance tok API QSFP SPARK SCOPE Spark Scope MHz GiB GB TiB Gb SSH RAM nvidia smi ms English rack URL";
function dataWords(state) {
  const values = [state.usage?.timeZone, state.usage?.modelName, state.inference?.modelName, state.inference?.engine, state.serving?.engine];
  for (const node of state.topology?.nodes ?? []) values.push(node.id, node.name, node.host, node.hardware);
  for (const node of Object.values(state.nodes ?? {})) values.push(node?.container?.name, node?.inference?.engine);
  for (const link of state.topology?.links ?? []) values.push(link.id, link.label);
  return values.filter(Boolean).join(" ");
}
const CHECK_ENGLISH = (allowed) => `(() => {
  const allowed = new Set(${JSON.stringify(`${TERMS} ${allowed}`)}.match(/[A-Za-z]{2,}/g));
  const words = (document.body.innerText.match(/[A-Za-z]{2,}/g) ?? []).filter((word) => !allowed.has(word));
  return [...new Set(words)];
})()`;
// English left on a Korean page is listed at the end; it fails the check only with STRICT_I18N=1, since contributors
// only add English and the Korean is filled in before a merge.
const untranslated = new Set();
const englishLeft = async (page, state) => {
  const words = await page.evaluate(CHECK_ENGLISH(dataWords(state)));
  if (process.env.STRICT_I18N === "1") return words.length ? [`untranslated: ${words.join(" ")}`] : [];
  for (const word of words) untranslated.add(word);
  return [];
};

// A "?" explanation opened with a click: it shows text, stays inside the window and leaves its own button uncovered.
const CHECK_HELP = (selector) => `(async () => {
  const button = document.querySelector(${JSON.stringify(selector)});
  if (!button) return { issues: ["no help button " + ${JSON.stringify(selector)}], text: "" };
  button.scrollIntoView({ block: "center" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const tip = document.querySelector("#help-tip"), issues = [];
  if (!tip || tip.hidden || !tip.textContent.trim()) return { issues: ["help did not open: " + ${JSON.stringify(selector)}], text: "" };
  const box = tip.getBoundingClientRect(), own = button.getBoundingClientRect();
  if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) issues.push("help outside the window");
  if (!(box.bottom <= own.top + 1 || box.top >= own.bottom - 1)) issues.push("help covers its button");
  if (button.getAttribute("aria-expanded") !== "true") issues.push("help button not marked expanded");
  return { issues, text: tip.textContent };
})()`;
async function checkHelp(web, label, suffix, extra = async () => []) {
  await web.evaluate("document.querySelector('[data-section=\"units\"]').click()");
  for (const [where, selector] of [["settings", '[data-help="help.memUnits"]'], ["page", '[data-help="help.ttft"]']]) {
    // Closing the dialog returns focus to the gear button a moment later, which scrolls the page back to the top.
    if (where === "page") { await web.evaluate("document.querySelector('#settings').close()"); await new Promise((resolve) => setTimeout(resolve, 300)); }
    const result = await web.evaluate(CHECK_HELP(selector));
    const name = `web-${label}-help-${where}${suffix}.png`;
    await web.shoot(name);
    report(name, [`help: ${result.text}`], [...result.issues, ...await extra(), ...web.errors.splice(0)]);
    await web.evaluate("document.body.click()");
  }
}

let failures = 0;
const report = (name, lines, problems) => {
  console.log(`${problems.length ? "FAIL" : "ok  "} ${name}`);
  for (const line of lines) console.log(`       ${line}`);
  for (const problem of problems) console.log(`     - ${problem}`);
  if (problems.length) failures++;
};

try {
  // Rack panel, 1920 x 480.
  const rack = await openPage({ width: 1920, height: 480 });
  for (const count of COUNTS) {
    for (const mode of MODES) {
      current = { count, mode };
      await rack.go(`${base}/rack/`);
      await rack.waitFor("document.querySelectorAll('.bay').length > 0 && !document.querySelector('.bay:empty')");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = await rack.evaluate(CHECK_RACK);
      const name = `rack-${count}-node-${mode}.png`;
      await rack.shoot(name);
      const missingFonts = Object.entries(result.fonts).filter(([, ok]) => !ok).map(([font]) => `font not loaded: ${font}`);
      report(name, [...result.bays, `band: ${result.band}`], [...result.issues, ...missingFonts, ...rack.errors.splice(0)]);
    }
    // Lost connection: the next poll fails and the panel dims.
    current = { count, mode: "serving" };
    await rack.go(`${base}/rack/`);
    await rack.waitFor("document.querySelectorAll('.bay').length > 0");
    current = { count, mode: "lost" };
    await rack.waitFor("document.querySelector('#screen').classList.contains('stale')");
    const lost = await rack.evaluate(CHECK_RACK);
    await rack.shoot(`rack-${count}-node-lost.png`);
    report(`rack-${count}-node-lost.png`, [`band: ${lost.band}`], lost.issues);
    rack.errors.splice(0);
  }
  // The longest ids and names: names give way to the status with an ellipsis.
  for (const mode of ["serving", "fault"]) {
    current = { count: 4, mode, longNames: true };
    await rack.go(`${base}/rack/`);
    await rack.waitFor("document.querySelectorAll('.bay').length > 0 && !document.querySelector('.bay:empty')");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await rack.evaluate(CHECK_RACK);
    const name = `rack-4-node-${mode}-long-names.png`;
    await rack.shoot(name);
    report(name, [...result.bays, `truncated: ${result.truncated.join(" / ") || "none"}`], [...result.issues, ...rack.errors.splice(0)]);
  }
  current = { count: 4, mode: "serving", longNames: false };
  // The rack panel's own settings from its address: °F, GB, node colours and a still band.
  for (const [count, mode] of [[4, "serving"], [4, "fault"], [6, "serving"]]) {
    current = { count, mode, longNames: false };
    await rack.go(`${base}/rack/?temp=f&mem=gb&colors=purple,ff8800&motion=still`);
    await rack.waitFor("document.querySelectorAll('.bay').length > 0 && !document.querySelector('.bay:empty')");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await rack.evaluate(CHECK_RACK);
    const look = await rack.evaluate(`(() => ({
      units: [...document.querySelectorAll(".temp sup")].map((el) => el.textContent).join(" ") + " | " + [...document.querySelectorAll(".meter span em")].map((el) => el.textContent).slice(0, 2).join(" "),
      bars: [...document.querySelectorAll(".bay")].slice(0, 3).map((bay) => getComputedStyle(bay.querySelector(".bar i") ?? bay).backgroundColor),
      band: getComputedStyle(document.querySelector("#band-svg")).transitionDuration,
    }))()`);
    const problems = [...result.issues, ...rack.errors.splice(0)];
    if (!/°F/.test(look.units) || !/GB|TB/.test(look.units)) problems.push("units not applied: " + look.units);
    if (count === 4 && mode === "serving" && (look.bars[0] !== "rgb(195, 166, 239)" || look.bars[1] !== "rgb(255, 136, 0)")) problems.push("node colours not applied: " + look.bars.join(" / "));
    if (look.band !== "0s") problems.push("band still moves: " + look.band);
    const name = `rack-${count}-node-${mode}-options.png`;
    await rack.shoot(name);
    report(name, [`units: ${look.units}`, `bars: ${look.bars.join(" / ")}`], problems);
  }
  // A wider bar display (2560 x 480) with the width parameter.
  const wide = await openPage({ width: 2560, height: 480 });
  current = { count: 4, mode: "serving" };
  await wide.go(`${base}/rack/?width=2560`);
  await wide.waitFor("document.querySelectorAll('.bay').length > 0");
  const wideResult = await wide.evaluate(CHECK_RACK);
  await wide.shoot("rack-4-node-serving-2560.png");
  report("rack-4-node-serving-2560.png", [], [...wideResult.issues, ...wide.errors]);
  await wide.close();
  // A 1024 x 600 screen: the default panel letterboxed in the middle, and ?width=819 filling it.
  const small = await openPage({ width: 1024, height: 600 });
  for (const [query, counts] of [["", [4]], ["?width=819", [1, 2, 3, 4]]]) {
    for (const count of counts) {
      for (const mode of ["serving", "fault"]) {
        current = { count, mode, longNames: false };
        await small.go(`${base}/rack/${query}`);
        await small.waitFor("document.querySelectorAll('.bay').length > 0 && !document.querySelector('.bay:empty')");
        await new Promise((resolve) => setTimeout(resolve, 300));
        const result = await small.evaluate(CHECK_RACK);
        const name = `rack-${count}-node-${mode}-1024x600${query ? "-width-819" : ""}.png`;
        await small.shoot(name);
        report(name, [`band: ${result.band}`, `truncated: ${result.truncated.join(" / ") || "none"}`], [...result.issues, ...small.errors.splice(0)]);
      }
    }
  }
  await small.close();

  // The rack panel in Korean (?lang=ko): one, four and six nodes, a lost connection, and the 1024 x 600 screen.
  for (const count of [1, 4, 6].filter((count) => COUNTS.includes(count))) {
    for (const mode of ["serving", "fault"]) {
      current = { count, mode, longNames: false };
      await rack.go(`${base}/rack/?lang=ko`);
      await rack.waitFor("document.querySelectorAll('.bay').length > 0 && !document.querySelector('.bay:empty')");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = await rack.evaluate(CHECK_RACK);
      const lang = await rack.evaluate("document.documentElement.lang");
      const name = `rack-${count}-node-${mode}-ko.png`;
      await rack.shoot(name);
      report(name, [...result.bays, `band: ${result.band}`, `truncated: ${result.truncated.join(" / ") || "none"}`], [...result.issues, ...(lang === "ko" ? [] : [`page language ${lang}`]), ...await englishLeft(rack, fixtureState(count, mode)), ...rack.errors.splice(0)]);
    }
  }
  current = { count: 4, mode: "serving", longNames: false };
  await rack.go(`${base}/rack/?lang=ko`);
  await rack.waitFor("document.querySelectorAll('.bay').length > 0");
  current = { count: 4, mode: "lost", longNames: false };
  await rack.waitFor("document.querySelector('#screen').classList.contains('stale')");
  const lostKo = await rack.evaluate(CHECK_RACK);
  await rack.shoot("rack-4-node-lost-ko.png");
  report("rack-4-node-lost-ko.png", [`band: ${lostKo.band}`], [...lostKo.issues, ...await englishLeft(rack, fixtureState(4, "serving"))]);
  rack.errors.splice(0);
  await rack.close();
  const smallKo = await openPage({ width: 1024, height: 600 });
  for (const count of [1, 2, 3, 4]) {
    for (const mode of ["serving", "fault"]) {
      current = { count, mode, longNames: false };
      await smallKo.go(`${base}/rack/?width=819&lang=ko`);
      await smallKo.waitFor("document.querySelectorAll('.bay').length > 0 && !document.querySelector('.bay:empty')");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = await smallKo.evaluate(CHECK_RACK);
      const name = `rack-${count}-node-${mode}-1024x600-width-819-ko.png`;
      await smallKo.shoot(name);
      report(name, [`band: ${result.band}`, `truncated: ${result.truncated.join(" / ") || "none"}`], [...result.issues, ...await englishLeft(smallKo, fixtureState(count, mode)), ...smallKo.errors.splice(0)]);
    }
  }
  await smallKo.close();

  // Web dashboard at desktop and phone widths.
  for (const [label, width, height, scheme] of [["desktop", 1440, 1000, "light"], ["phone", 390, 844, "dark"]]) {
    const web = await openPage({ width, height, colorScheme: scheme });
    for (const [count, longNames] of [...COUNTS.map((count) => [count, false]), [4, true]]) {
      for (const mode of ["serving", "fault"]) {
        current = { count, mode, longNames };
        await web.go(`${base}/`);
        await web.waitFor("document.querySelectorAll('#nodes .node').length > 0 && /\\d/.test(document.querySelector('#updated-at').textContent)");
        await new Promise((resolve) => setTimeout(resolve, 300));
        const issues = await web.evaluate(CHECK_WEB);
        const info = await web.evaluate(`(() => ({
          cards: [...document.querySelectorAll('.node')].map((n) => n.querySelector('h2').textContent + ' ' + n.querySelector('.badge').textContent).join(' / '),
          fabric: document.querySelector('#fabric-panel').hidden ? 'interconnect hidden' : [...document.querySelectorAll('#link-rows tr')].map((r) => r.innerText.replace(/\\t/g, ' ')).join(' / '),
          status: document.querySelector('#status-title').textContent,
        }))()`);
        const name = `web-${label}-${count}-node-${mode}${longNames ? "-long-names" : ""}.png`;
        await web.shoot(name, { fullPage: true });
        report(name, [`status: ${info.status}`, `cards: ${info.cards}`, `links: ${info.fabric}`], [...issues, ...web.errors.splice(0)]);
      }
    }
    await web.close();
  }

  // Settings dialog at desktop and phone widths, one PNG per section, then a settings link (°F, GB, 12-hour clock,
  // 15-minute range) that the page applies and removes from the address.
  for (const [label, width, height, scheme] of [["desktop", 1440, 1000, "light"], ["phone", 390, 844, "dark"]]) {
    const web = await openPage({ width, height, colorScheme: scheme });
    current = { count: 4, mode: "serving", longNames: false };
    await web.go(`${base}/`);
    await web.waitFor("document.querySelectorAll('#nodes .node').length > 0 && /\\d/.test(document.querySelector('#updated-at').textContent)");
    await web.evaluate("document.querySelector('#settings-open').click()");
    for (const section of ["card", "colors", "units", "dashboard", "about"]) {
      await web.evaluate(`document.querySelector('[data-section="${section}"]').click()`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const issues = await web.evaluate(CHECK_SETTINGS);
      const name = `web-${label}-settings-${section}.png`;
      await web.shoot(name);
      report(name, [], [...issues, ...web.errors.splice(0)]);
    }
    // Selecting a reading on the preview card opens its slot in Node card.
    await web.evaluate(`document.querySelector('[data-section="units"]').click(); document.querySelector('#preview-nodes .reading[data-slot="2"]').click()`);
    const picked = await web.evaluate("[document.querySelector('[data-section=card]').getAttribute('aria-current'), document.activeElement?.dataset.slot ?? null, Boolean(document.querySelector('.slots label.flash'))]");
    report(`web-${label}-settings-preview-pick`, [`section current: ${picked[0]}, focused slot: ${picked[1]}, highlighted: ${picked[2]}`], picked[0] === "true" && picked[1] === "2" && picked[2] ? [] : ["selecting a preview reading did not open its slot"]);
    // Rack settings: hidden until a rack panel has been seen, shown on request, with the kiosk URL.
    await web.evaluate(`document.querySelector('[data-section="dashboard"]').click()`);
    const before = await web.evaluate("[document.querySelector('[data-section=rack]').hidden, document.querySelector('#rack-hint').hidden]");
    await web.evaluate("document.querySelector('#rack-show').click()");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const rackIssues = await web.evaluate(CHECK_SETTINGS);
    const kiosk = await web.evaluate("document.querySelector('#kiosk-url').value");
    if (!before[0] || before[1]) rackIssues.push("rack settings shown before a rack panel was seen");
    if (!/\/rack\/$/.test(kiosk)) rackIssues.push("kiosk URL: " + kiosk);
    await web.shoot(`web-${label}-settings-rack.png`);
    report(`web-${label}-settings-rack.png`, [`kiosk: ${kiosk}`], [...rackIssues, ...web.errors.splice(0)]);
    await checkHelp(web, label, "");
    await web.go(`${base}/?temp=f&mem=gb&clock=12&range=15`);
    await web.waitFor("document.querySelectorAll('#nodes .node').length > 0 && /\\d/.test(document.querySelector('#updated-at').textContent)");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const linked = await web.evaluate(`(() => ({
      address: location.search,
      units: [...document.querySelectorAll('#nodes .node:first-child .reading em')].map((em) => em.textContent).join(" "),
      updated: document.querySelector('#updated-at').textContent,
      range: document.querySelector('[data-range][aria-pressed=true]')?.textContent,
      stored: localStorage.getItem('spark-scope-settings'),
    }))()`);
    const problems = [...await web.evaluate(CHECK_WEB), ...web.errors.splice(0)];
    if (linked.address) problems.push("settings link left in the address: " + linked.address);
    if (!/°F/.test(linked.units) || !/GB/.test(linked.units)) problems.push("units not applied: " + linked.units);
    if (!/[AP]M/.test(linked.updated)) problems.push("12-hour clock not applied: " + linked.updated);
    if (linked.range !== "15m") problems.push("chart range not applied: " + linked.range);
    const name = `web-${label}-settings-link.png`;
    await web.shoot(name, { fullPage: true });
    report(name, [`units: ${linked.units}`, `updated: ${linked.updated}`, `stored: ${linked.stored}`], problems);
    // A card set up like a setup shared on social media: °F, disk used in a slot and a root filesystem bar; engine
    // panel and trends hidden.
    await web.evaluate("localStorage.clear()");
    await web.go(`${base}/?temp=f&readings=temp,power,disk,clock&bars=unified,disk&hide=engine,trends&colors=purple,ff8800`);
    await web.waitFor("document.querySelectorAll('#nodes .node').length > 0 && /\\d/.test(document.querySelector('#updated-at').textContent)");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const card = await web.evaluate(`(() => ({
      readings: [...document.querySelectorAll('#nodes .node:first-child .reading')].map((r) => r.innerText.replace(/\\s+/g, " ")).join(" / "),
      bars: [...document.querySelectorAll('#nodes .node:first-child [data-bar]')].map((b) => b.innerText.replace(/\\s+/g, " ")).join(" / "),
      hidden: [document.querySelector('.engine').hidden, document.querySelector('.trends').hidden, document.querySelector('.lower').classList.contains('single')],
      colors: [...document.querySelectorAll('#nodes .node h2')].slice(0, 2).map((h) => getComputedStyle(h, '::before').backgroundColor).concat([...document.querySelectorAll('#fabric-nodes circle')].slice(0, 2).map((c) => getComputedStyle(c).stroke)),
      purple: getComputedStyle(document.documentElement).getPropertyValue('--purple').trim(),
    }))()`);
    const cardProblems = [...await web.evaluate(CHECK_WEB), ...web.errors.splice(0)];
    if (!/Disk used/.test(card.readings) || !/°F/.test(card.readings)) cardProblems.push("readings not applied: " + card.readings);
    if (!/Root filesystem/.test(card.bars)) cardProblems.push("root filesystem bar missing: " + card.bars);
    if (card.hidden.some((value) => !value)) cardProblems.push("panels not hidden: " + card.hidden.join(","));
    // The first two nodes in purple and #ff8800, on the cards and in the interconnect diagram.
    const hex = (rgb) => "#" + (rgb.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
    const [card1, card2, ring1, ring2] = card.colors.map(hex);
    if (card1 !== card.purple || ring1 !== card.purple || card2 !== "#ff8800" || ring2 !== "#ff8800") cardProblems.push("node colours not applied: " + card.colors.join(" / ") + " (purple " + card.purple + ")");
    await web.shoot(`web-${label}-card-setup.png`, { fullPage: true });
    report(`web-${label}-card-setup.png`, [`readings: ${card.readings}`, `bars: ${card.bars}`], cardProblems);
    await web.evaluate("localStorage.clear()");
    await web.close();
  }

  // The two other designs: the main view, the token ledger and the settings dialog. Console stays dark even with a
  // light system theme; in Soft the ring value ("88%" as one unit) and its label sit centred on the ring.
  for (const [design, label, width, height, scheme] of [["console", "desktop", 1440, 1000, "light"], ["console", "phone", 390, 844, "dark"], ["soft", "desktop", 1440, 1000, "light"], ["soft", "desktop", 1440, 1000, "dark"], ["soft", "phone", 390, 844, "dark"]]) {
    const web = await openPage({ width, height, colorScheme: scheme });
    current = { count: 4, mode: "serving", longNames: false };
    await web.go(`${base}/?design=${design}`);
    await web.waitFor("document.querySelectorAll('#nodes .node').length > 0 && /\\d/.test(document.querySelector('#updated-at').textContent)");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const look = await web.evaluate(`(() => {
      const gauge = document.querySelector('#nodes .node .gauge'), value = gauge.querySelector('strong'), label = gauge.querySelector('span');
      const range = document.createRange(); range.selectNodeContents(value);
      const g = gauge.getBoundingClientRect(), v = range.getBoundingClientRect(), l = label.getBoundingClientRect();
      return { design: document.documentElement.dataset.design, scheme: getComputedStyle(document.documentElement).colorScheme,
        dx: (v.left + v.right) / 2 - (g.left + g.right) / 2, dy: (Math.min(v.top, l.top) + Math.max(v.bottom, l.bottom)) / 2 - (g.top + g.bottom) / 2 };
    })()`);
    const problems = [...await web.evaluate(CHECK_WEB), ...web.errors.splice(0)];
    if (look.design !== design) problems.push("design not applied: " + look.design);
    if (design === "console" && look.scheme !== "dark") problems.push("Console is not dark: " + look.scheme);
    if (design === "soft" && (Math.abs(look.dx) > 1.5 || Math.abs(look.dy) > 1.5)) problems.push(`ring value off centre by ${look.dx.toFixed(1)}, ${look.dy.toFixed(1)} px`);
    const name = `web-${label}-${design}-${scheme}.png`;
    await web.shoot(name, { fullPage: true });
    report(name, [`ring value offset: ${look.dx.toFixed(1)}, ${look.dy.toFixed(1)} px`], problems);
    await web.evaluate("document.querySelector('#tab-tokens').click()");
    await web.waitFor("document.querySelectorAll('#token-days tr').length > 1");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await web.shoot(`web-${label}-${design}-${scheme}-tokens.png`, { fullPage: true });
    report(`web-${label}-${design}-${scheme}-tokens.png`, [], [...await web.evaluate(CHECK_WEB), ...web.errors.splice(0)]);
    await web.evaluate("document.querySelector('#tab-scope').click(); document.querySelector('#settings-open').click()");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await web.shoot(`web-${label}-${design}-${scheme}-settings.png`);
    report(`web-${label}-${design}-${scheme}-settings.png`, [], [...await web.evaluate(CHECK_SETTINGS), ...web.errors.splice(0)]);
    await web.evaluate("localStorage.clear()");
    await web.close();
  }

  // The web page in Korean, opened with a settings link (?lang=ko): four nodes serving and with a fault, and the token
  // ledger with its Korean month and day labels.
  for (const [label, width, height, scheme] of [["desktop", 1440, 1000, "light"], ["phone", 390, 844, "dark"]]) {
    const web = await openPage({ width, height, colorScheme: scheme });
    for (const mode of ["serving", "fault"]) {
      current = { count: 4, mode, longNames: false };
      await web.go(`${base}/?lang=ko`);
      await web.waitFor("document.querySelectorAll('#nodes .node').length > 0 && /\\d/.test(document.querySelector('#updated-at').textContent)");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const issues = await web.evaluate(CHECK_WEB);
      const info = await web.evaluate(`(() => ({
        lang: document.documentElement.lang,
        address: location.search,
        status: document.querySelector('#status-title').textContent,
        meta: document.querySelector('#model-meta').textContent,
        cards: [...document.querySelectorAll('.node')].map((n) => n.querySelector('h2').textContent + ' ' + n.querySelector('.badge').textContent).join(' / '),
      }))()`);
      const problems = [...issues, ...await englishLeft(web, fixtureState(4, mode)), ...web.errors.splice(0)];
      if (info.lang !== "ko") problems.push("page language " + info.lang);
      if (info.address) problems.push("settings link left in the address: " + info.address);
      const name = `web-${label}-4-node-${mode}-ko.png`;
      await web.shoot(name, { fullPage: true });
      report(name, [`status: ${info.status}`, `header: ${info.meta}`, `cards: ${info.cards}`], problems);
    }
    current = { count: 4, mode: "serving", longNames: false };
    await web.go(`${base}/?lang=ko#tokens`);
    await web.waitFor("document.querySelectorAll('#token-days tr th').length > 0");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ledger = await web.evaluate(`(() => ({
      title: document.querySelector('#month-title').textContent,
      period: document.querySelector('#month-period').textContent,
      month: document.querySelector('#token-month').selectedOptions[0]?.textContent,
    }))()`);
    const ledgerName = `web-${label}-tokens-ko.png`;
    await web.shoot(ledgerName, { fullPage: true });
    report(ledgerName, [`title: ${ledger.title}`, `period: ${ledger.period}`, `month: ${ledger.month}`], [...await web.evaluate(CHECK_WEB), ...await englishLeft(web, fixtureState(4, "serving")), ...web.errors.splice(0)]);
    await web.evaluate("localStorage.clear()");
    await web.close();
  }

  // The settings dialog: the page opens in English, Korean is picked in the dialog and applies at once to the page
  // behind it and to the preview; then one PNG per section in Korean.
  for (const [label, width, height, scheme] of [["desktop", 1440, 1000, "light"], ["phone", 390, 844, "dark"]]) {
    const web = await openPage({ width, height, colorScheme: scheme });
    current = { count: 4, mode: "serving", longNames: false };
    await web.go(`${base}/`);
    await web.waitFor("document.querySelectorAll('#nodes .node').length > 0 && /\\d/.test(document.querySelector('#updated-at').textContent)");
    await web.evaluate("document.querySelector('#settings-open').click()");
    await web.evaluate(`document.querySelector('[data-section="dashboard"]').click()`);
    const before = await web.evaluate("[document.querySelector('#nodes .badge').textContent, document.querySelector('#preview-nodes .badge').textContent, document.querySelector('#settings-title').textContent]");
    await web.evaluate("document.querySelector('input[name=lang][value=ko]').click()");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await web.evaluate("[document.querySelector('#nodes .badge').textContent, document.querySelector('#preview-nodes .badge').textContent, document.querySelector('#settings-title').textContent, document.documentElement.lang, localStorage.getItem('spark-scope-settings')]");
    const switched = [];
    if (after[3] !== "ko") switched.push("page language " + after[3]);
    for (const [index, part] of ["page card", "preview card", "dialog title"].entries()) if (after[index] === before[index]) switched.push(`${part} still reads ${after[index]}`);
    for (const section of ["card", "colors", "units", "dashboard", "about"]) {
      await web.evaluate(`document.querySelector('[data-section="${section}"]').click()`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const issues = await web.evaluate(CHECK_SETTINGS);
      const name = `web-${label}-settings-${section}-ko.png`;
      await web.shoot(name);
      report(name, section === "dashboard" ? [`before: ${before.join(" / ")}`, `after: ${after.join(" / ")}`] : [], [...issues, ...(section === "dashboard" ? switched : []), ...await englishLeft(web, fixtureState(4, "serving")), ...web.errors.splice(0)]);
    }
    await checkHelp(web, label, "-ko", () => englishLeft(web, fixtureState(4, "serving")));
    await web.evaluate("localStorage.clear()");
    await web.close();
  }
} finally {
  socket.close();
  chrome.kill();
  server.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  cleanUp();
}
if (untranslated.size) console.log(`\nnote: English on the Korean pages (fails with STRICT_I18N=1): ${[...untranslated].join(" ")}`);
console.log(`\nPNGs in ${OUT}`);
process.exit(failures ? 1 : 0);
