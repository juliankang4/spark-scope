# Contributing

Bug reports, fixes and small features are welcome. For anything larger, open an issue first so we can agree on the approach.

## Setup

Node.js 22.13 or later; there are no npm dependencies.

```bash
git clone https://github.com/juliankang4/spark-scope.git
cd spark-scope
npm test
```

To try it without a Spark, run `node server.mjs`: the shipped single-node topology collects the machine it runs on, and the inference panels read `unknown` until `SPARK_SCOPE_API_URL` points at a vLLM or SGLang server.

## Before opening a pull request

- `npm test` passes. Add or adjust a test for the behaviour you change; tests run offline and must not contact other machines.
- For changes to the pages, run `node tools/render.mjs` (needs Chrome or Chromium) and look at the PNGs. It checks one to six nodes, long names, a 1024 x 600 screen and a phone, and fails on clipped or overlapping text, overflow, script errors and Content-Security-Policy violations. CI runs it on every pull request and keeps the PNGs of a failed run as a `renders` artifact for a week.
- The README matches the change (settings, API fields, limitations).
- `shellcheck kiosk/spark-scope-kiosk` is clean if you touched the kiosk script.

## Ground rules

- **Read-only.** The collector only reads system state and the inference server's metrics. Nothing may start, stop or change anything on a node.
- **No npm dependencies** and nothing loaded from other hosts by the pages.
- **No personal data** in fixtures, screenshots or examples: use made-up host names and addresses.
- Values that were not observed stay `unknown`; never fill them with zeros.
