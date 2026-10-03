# Development

[README](../README.md) · [Topology](topology.md) · [Configuration](configuration.md) · [Web page](dashboard.md) · [Rack panel](rack.md) · [HTTP API](api.md) · **Development**

There is no install step: Spark Scope has no npm dependencies and runs on Node.js 22.13 or later. See [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a pull request.

```bash
npm run demo                 # the pages on made-up data, http://127.0.0.1:8787/
npm test
node tools/render.mjs        # needs Chrome or Chromium; CI runs it too
```

## Demo

`npm run demo` serves the dashboard, the rack panel and the mini window with the synthetic data from `tools/fixtures.mjs`. The engine runs through a request every 20 seconds (a prefill burst, then decoding, then idle) so the charts move. `npm run demo -- --nodes 2 --mode fault` shows two nodes with a fault (modes: `serving`, `fault`, `idle`; 1 to 8 nodes); `--port` picks another port. Nothing is collected or written, and no other machine is contacted.

## Tests

The tests use only `node:test` and cover topology parsing and validation (one-node, two-cable and ring layouts), link and cluster status, the collector script with fake `nvidia-smi` and `ssh` commands (hangs, failures, missing binaries), metric parsing for vLLM, SGLang and TensorFold against a fake engine, the token ledger, the chart history, the browser-side formatting and layout helpers, the settings, the English and Korean string tables, the rack panel's view logic, the mini window, the demo server, the kiosk script, and a running server (routes, host checks, security headers, path tricks sent over a raw socket, what the browser payload leaves out). They do not contact any other machine.

CI runs them on Node 22.13 and 24, on x64 and arm64, runs the render check below and runs `shellcheck` on the kiosk script.

## Render check

`tools/render.mjs` serves the pages with synthetic data and the server's security headers, and renders them in headless Chrome through the DevTools protocol:

- the rack panel with one to six nodes, the longest ids and names, a 2560 x 480 bar and a 1024 x 600 screen;
- the web dashboard on a desktop and a phone, the settings dialog, the explanations and the three designs in light and dark;
- the mini window in each shape and tab;
- the token ledger's three views over three months of a synthetic ledger in every design;
- English and Korean.

Chrome runs with its background services off, so nothing but the local fixture server is contacted. It writes PNGs to `$OUT` (default: a `spark-scope-renders` folder in the system temp directory) and reports clipped or overlapping text, overflow, script errors and Content-Security-Policy violations, and lists English words left on the Korean pages.

- `CHROME`: the browser binary, if Chrome is not found.
- `COUNTS=1,2`: limit the node counts.
- `STRICT_I18N=1`: English left on a Korean page becomes an error. With the same variable, `npm test` requires every Korean text.

The screenshots in the README and these pages come from it.

## Translations

All page text is in `public/i18n.js`, English first and Korean below it. A new string only needs its English entry; a missing Korean entry falls back to English, and plain `npm test` lists it without failing.

## Fonts

`public/fonts/` bundles latin subsets of Archivo (text and numbers) and Bebas Neue (the rack panel's large figures), each under the SIL Open Font License 1.1 with its license text next to it. They keep that license whatever license applies to the rest of Spark Scope. Without them the pages fall back to the system UI font.
