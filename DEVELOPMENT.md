# Development

## Toolchain

ChatGML (the TypeScript rewrite) targets **Node >= 24** (CI runs 24.x and 25.x) and uses native
global `fetch` — there is no `node-fetch`/`undici` dependency. TypeScript is pinned to `~5.7.3`
(off the 6.x line) for predictable strict-flag behavior.

## Scripts

| script | what it does |
|---|---|
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` over **`src` + `test`** (so type-level tests are checked). |
| `npm run lint` | `oxlint --max-warnings 0` — any warning fails the run (exit 1). |
| `npm run format` | `prettier --write .` (formats; `format:check` verifies without writing). |
| `npm run build` | `tsc -p tsconfig.build.json` (src-only, emits to `dist/`). |
| `npm run test` | `vitest run`. |
| `npm run coverage` | `vitest run --coverage` (per-file thresholds: lines 80 / branches 75 / functions 80 / statements 80). |
| `npm run ci` | `typecheck && lint && build && coverage` — the single CI gate. |

## Lint / format

- **Lint:** [`oxlint`](https://oxc.rs) with `.oxlintrc.json`. The config enables the `correctness`
  category as **errors** plus a curated set of real-bug rules (`eqeqeq` smart, `no-var`,
  `prefer-const`, `no-throw-literal`, `no-debugger`, unused-vars with `^_` ignore). Stylistic-only
  categories (`suspicious`/`perf`) are intentionally **not** enabled wholesale — rules like
  `no-await-in-loop` would flag the deliberately-sequential agent/stream loops. `npm run lint` exits
  0 on the current tree; new code must keep it clean (do not blanket-disable rules — fix the cause).
- **Format:** [`prettier`](https://prettier.io) with `.prettierrc` (100 cols, single quotes,
  trailing commas, LF). `.prettierignore` excludes `dist/`, `coverage/`, the legacy Python tree,
  test fixtures (exact bytes), and Markdown.

### Platform note

`oxlint` and `prettier` install and run on this Windows ARM64 dev host (verified: oxlint 1.71,
prettier 3.8). The GitHub CI runners are x64 (`windows-latest`, `ubuntu-latest`) and run the lint
leg via `npm run ci` regardless. If a future host cannot run `oxlint` natively, fall back to an
ESLint flat config but keep `ci.yml` invoking the `lint` script.

## tsconfig flags

`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and `isolatedModules` are **on**.
`exactOptionalPropertyTypes` is **off** for v1: `strict` + `noUncheckedIndexedAccess` give the
safety that matters, while `exactOptionalPropertyTypes` would force conditional-spread on every
optional-property construction (`Usage`/`AgentEvent`/`Citation`/`Config` builders) with no real
correctness gain. Module resolution is `NodeNext`, so **all relative imports use the `.js`
extension** (e.g. `import { x } from './foo.js'`) even though the source is `.ts`; a missing
extension is a typecheck error (TS2835), not just a runtime failure.

## Configuration & secrets

Config resolves flags > `CHATGML_*` env > config file > defaults. There are two config files:

- **User-global** `~/.config/chatgml/config.json` (or `$XDG_CONFIG_HOME/chatgml/config.json`) —
  **trusted**, lives outside any repo.
- **Project-local** `<root>/.chatgml.json` — **untrusted** (gitignored); may not override a
  secret-bearing endpoint while the matching key resolves from `env:`, and may not set
  `approval:'auto'`, unless `--trust-project-config` is passed.

`chatgml config set <field> <value>` writes durably to the **user-global** file only. Secret fields
(`chat.apiKey`, `embed.apiKey`, `memory.hippo.key`) **refuse a literal value** — pass an
`env:NAME` reference instead, so a raw key is never written to disk and never into a repo-tracked
file.

## CI

`.github/workflows/ci.yml` runs `npm ci && npm run ci` on a matrix of
`[windows-latest, ubuntu-latest] × [node 24.x, 25.x]`. The legacy
`.github/workflows/python-publish.yml` is **neutralized** (kept for history, `workflow_dispatch`
only, no-op job) — the Python `talk_codebase` tree is never auto-published.

## GMEdit plugin (M6 — modernized onto `chatgml serve`)

The plugin (`plugin/`) is thin Electron-renderer glue that spawns the core as a child process and
speaks NDJSON over its stdio — no Python venv, no `git pull`, no YAML. Symlink the repo's `plugin/`
dir into GMEdit's plugins folder (the folder name + `config.json` `name` are both `chatgml`):

```
cd %APPDATA%\AceGM\GMEdit\plugins
mklink /D "chatgml" "C:\Users\you\Development\ChatGML\plugin"
```

Build the core first (`npm run build`) so `dist/cli.js` exists, or set the *ChatGML binary path*
plugin Preference / `CHATGML_BIN` to a resolved `chatgml`. The plugin↔core transport is proven
headlessly by `test/serve.spawn-integration.test.ts` (spawns the real `node dist/cli.js serve`
against a local SSE stub and drives a full streaming turn + an `apply_patch` approve round-trip). See
[docs/gmedit-plugin.md](docs/gmedit-plugin.md) for the full install, config, and event→UI mapping.
The companion plugins (`plugin-inline/`, `plugin-explain/`) share the main plugin's
`plugin/child-process.js` + `plugin/state.js` via `require('../chatgml/…')` so protocol logic and
spawn plumbing live in one place.
