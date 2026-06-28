# Contributing

Thanks for your interest in ChatGML! This file covers the dev workflow, conventions, and
the PR checklist.

## Toolchain

- **Node >= 24** (CI runs 24.x and 25.x; `.nvmrc` pins `25`).
- **TypeScript ~5.7.3** (pinned for predictable strict-flag behavior).
- **Native global `fetch`** — no `node-fetch`, no `undici`.

## Scripts

| Script | What it does |
|---|---|
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` over **`src` + `test`** (so type-level tests are checked). |
| `npm run lint` | `oxlint --max-warnings 0` — any warning fails the run (exit 1). |
| `npm run format` | `prettier --write .` (formats; `format:check` verifies without writing). |
| `npm run format:check` | `prettier --check .` — CI gate. |
| `npm run build` | `tsc -p tsconfig.build.json` (src-only, emits to `dist/`). |
| `npm test` | `vitest run`. |
| `npm run coverage` | `vitest run --coverage` (per-file thresholds: lines 80 / branches 75 / functions 80 / statements 80). |
| `npm run ci` | `format:check && typecheck && lint && build && coverage` — the single CI gate. |

## Style / lint / format

- **Lint:** [oxlint](https://oxc.rs) with `.oxlintrc.json`. The config enables the `correctness`
  category as **errors** plus a curated set of real-bug rules (`eqeqeq` smart, `no-var`,
  `prefer-const`, `no-throw-literal`, `no-debugger`, unused-vars with `^_` ignore). Stylistic-only
  categories (`suspicious`/`perf`) are intentionally **not** enabled wholesale — rules like
  `no-await-in-loop` would flag the deliberately-sequential agent/stream loops. `npm run lint` exits
  0 on the current tree; new code must keep it clean (do not blanket-disable rules — fix the cause).
- **Format:** [prettier](https://prettier.io) with `.prettierrc` (100 cols, single quotes,
  trailing commas, LF). `format:check` is part of `npm run ci`.
- **No new `any` types.** `typescript/no-explicit-any` is a `warn` and `--max-warnings 0` makes
  it a CI failure. Reach for `unknown` + a type guard instead.
- **Lint/format exit 0 must be preserved** on the current tree; new code keeps it clean.

## tsconfig flags

`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and `isolatedModules` are **on**.
`exactOptionalPropertyTypes` is **off** for v1: `strict` + `noUncheckedIndexedAccess` give the
safety that matters, while `exactOptionalPropertyTypes` would force conditional-spread on every
optional-property construction (`Usage`/`AgentEvent`/`Citation`/`Config` builders) with no real
correctness gain. Module resolution is `NodeNext`, so **all relative imports use the `.js`
extension** (e.g. `import { x } from './foo.js'`) even though the source is `.ts`; a missing
extension is a typecheck error (TS2835), not just a runtime failure.

## Tests

See **[test/README.md](test/README.md)** for the harness, helpers, and how to add a new test.

Quick rules:

- New behavior gets a test in the matching `test/<area>/<name>.test.ts` file.
- Headless / deterministic only — no real network, no real filesystem outside `mkdtempSync`
  temp dirs, no real wall-clock timing beyond a small (1–2s) grace window for handshakes.
- Use `mkdtempSync` + `afterEach` cleanup so tests are hermetic and parallelizable.
- Use `vi.useFakeTimers()` when the SUT depends on timeouts.
- The `forks` pool (`vitest.config.ts`) gives each test file its own process — `globalThis.fetch`
  mocks do not leak between files.
- Tests for security-critical code (sandbox, config, approval gate, secrets) need a positive
  and a negative case at minimum.

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

`.github/workflows/ci.yml` runs `npm run ci` on a matrix of
`[windows-latest, ubuntu-latest] × [node 24.x, 25.x]`. The legacy
`.github/workflows/python-publish.yml` is **neutralized** (kept for history, `workflow_dispatch`
only, no-op job) — the Python `talk_codebase` tree is never auto-published.

Required to merge: `npm run ci` green on the latest push. See
`docs/superpowers/specs/2026-06-24-chatgml-agentic-rewrite-design.md` for the design rationale.

## Security-critical areas

These paths are covered by CODEOWNERS and warrant an extra reviewer:

- `src/tools/sandbox.ts` — the single filesystem chokepoint (lexical + realpath + atomic
  rename). All `fs`-touching tools route through it.
- `src/config.ts` — the four-layer config merge + untrusted-project-config guards + secret
  resolution + literal-secret refusal. The whole security model funnels through here.
- `src/agent.ts` — the agent loop + the approval gate (GAP4 destructive-edit backstop
  + per-request policy overrides + the terminal-event contract).

See [SECURITY.md](SECURITY.md) for the threat model.

## PR checklist

- [ ] `npm run ci` green locally before pushing (covers format, typecheck, lint, build, coverage).
- [ ] Tests added for new behavior; regression tests for fixes.
- [ ] No new `any` types.
- [ ] If you changed `src/agent.ts` / `src/tools/sandbox.ts` / `src/config.ts`: a security reviewer
      is requested on the PR (CODEOWNERS).
- [ ] If you changed the wire protocol (`src/protocol.ts` / `src/types.ts` AgentEvent /
      ApprovalRequest / ToolContext shapes): the docs in `docs/agent-api.md` are updated and the
      fixture in `test/fixtures/agent-api-transcript.ndjson` is updated in lockstep (the
      `docs.conformance` test enforces deep equality).
- [ ] If you added a tool: it appears in `src/tools/index.ts`, has a `kind` (`read` / `gated` /
      `command`), goes through the sandbox if it touches the fs, and is mode-filtered via
      `MODE_TOOL_KINDS`.
- [ ] Commit messages are imperative, scoped, and reference a milestone (`M4`/`GAP5`/etc.) or
      issue number.

## Release process

1. Bump version in `package.json` and `dist/cli.js`'s `readPackageVersion()` resolves it.
2. `npm run build` to regenerate `dist/`.
3. `git tag v0.X.Y` and push (no signed-tag policy yet — same as the Python era).
4. The release is the tagged commit; no separate publish step.
