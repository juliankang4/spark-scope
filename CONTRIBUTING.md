# Contributing

Bug reports, fixes and small features are welcome. For anything larger, open an issue first so we can agree on the approach.

## Ground rules

- **Read-only.** The collector only reads system state and the inference server's metrics. Nothing may start, stop or change anything on a node.
- **No npm dependencies** and nothing loaded from other hosts by the pages.
- **No personal data** in fixtures, screenshots or examples: use made-up host names and addresses.
- Values that were not observed stay `unknown`; never fill them with zeros.

## Pull requests

- Say clearly what changes: for a fix, what was wrong and how it behaves now; for a feature, what it adds and how to use it. A screenshot helps for anything you can see.
- `npm test` passes (Node.js 22.13 or later, no install step), and `npm run check` holds the repository rules: no npm dependencies, no stopgap markers, every script parses. If you change what the pages show, `node tools/render.mjs` (needs Chrome or Chromium) shows whether anything got clipped or broken; CI runs all of these. `npm run demo` shows the pages on made-up data, and [Development](docs/development.md) has the details.
- English is enough. New text only needs its English entry in `public/i18n.js`; the Korean is added before the merge, and so are README updates if you leave them out.
