# Changelog

All notable changes to ChatGML are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are scoped to the
TypeScript rewrite (`0.1.x`).

## [Unreleased]

### Added
- **Mode-filtered tool surface.** `serve` `tool_catalog` and MCP `tools/list` now hide
  `apply_patch` / `search_replace` / `execute_command` when `config.mode` is `ask`. The
  agent loop already filtered by mode (so the model never sees them); this aligns the
  advertised wire surface with what the loop will actually accept.
- **MCP `forceGate` warning surface.** When MCP applies a high-risk `apply_patch` in
  auto mode (because the agent IDE owns the human gate), the destructive-edit
  warning is now appended to the tool result text instead of being silently dropped.
- **Shared process plumbing for all three GMEdit plugins.** `plugin/child-process.js`
  is the new home for binary resolution, env whitelist, Windows `.cmd` shim wrap,
  spawn, NDJSON framing, handshake gate, watchdog, and cleanup. The companion
  plugins (`plugin-inline/`, `plugin-explain/`) require it from the main plugin's
  directory.
- **GMEdit-plugin cleanup callbacks.** `plugin-inline` and `plugin-explain` no
  longer orphan their child processes on GMEdit shutdown — the `cleanup` callback
  stops the active session.
- **`plugin/child-process.js` unit tests** — `buildMinimalEnv`, `wrapCmdForWindows`,
  `resolveDistCliPath`. Full spawn/handshake round-trips are still covered by
  `test/plugin/client.test.ts`.
- **Boundary tests for `assessEditRisk`** at `WHOLE_FILE_REPLACE_MIN_LINES` /
  `DESTRUCTIVE_NET_DELETE_LINES` / `DESTRUCTIVE_DELETE_FRACTION` (exact-at vs
  just-above).
- **`src/tools/util.ts`** — shared `countLines` + `assessLineRisk` so the unified-diff
  edit tool and the SEARCH/REPLACE tool apply the same destructive-edit thresholds
  (no drift).
- **`src/http.ts`** — shared `scrubBody`, `resolveFetch`, `trimTrailingSlash`. The chat
  client, embeddings client, and hippo memory client previously duplicated each.
- **Hermetic CLI/config tests** — `baseEnv()` and the required-field tests now set
  `XDG_CONFIG_HOME` to a tmpdir so they don't silently load the developer's real
  `~/.config/chatgml/config.json`.

### Changed
- **MCP per-tool approvals honor `policy: 'gated'`.** The gate's per-request
  policy override (`ApprovalRequest.policy`) is checked before falling back to
  the global `autoApprove`. A `toolApproval: { 'mcp_mock_echo': 'gated' }` setting
  correctly gates the MCP tool even when `config.approval === 'auto'`.
- **`plugin/client.js`, `plugin-inline/inline.js`, `plugin-explain/explain.js`**
  refactored around the shared `startCore()` helper. The four near-identical
  spawn/cleanup loops collapsed into one.
- **`plugin-inline/inline.js` drops the dead `editWithAI()`** and the
  `setTimeout(50)`-raced button-wiring hack (Accept/Reject are now wired
  synchronously when the overlay is built).
- **`src/tools/index.ts`** — `toOpenAiToolSpecs` already takes an optional `mode`
  parameter; serve and MCP now use it.
- **`src/memory/persist.ts`** — dropped the redundant `.slice()` on
  `new Uint8Array(v.buffer, v.byteOffset, v.byteLength)` before
  `Buffer.from(...)` (Buffer.from copies; the slice was an extra allocation).
- **`search_replace` tool** now delegates to the shared `assessLineRisk` instead of
  a duplicate risk helper.
- **Prettier is a CI gate.** `npm run ci` now invokes `prettier --check .` so
  formatting drift can't land.

### Fixed
- **`run-index.ts` validation** (already in uncommitted WIP): a non-existent
  index target now exits 2 with `index: <path> is not an existing directory`
  before any `.chatgml/` store is created (was F1). A file path now exits 2
  with `index: <path> is a file, expected a directory` instead of leaking a raw
  `ENOTDIR` (was F2).
- **`hippo` `fromWalk` tie-break** (D4): `extra` no longer carries a `depth` key
  when the input node lacks one. Test asserted this.
- **`config.test.ts` "missing required field" tests** were silently loading the
  developer's real `~/.config/chatgml/config.json`; the harness now points
  `XDG_CONFIG_HOME` at a tmpdir so the tests are hermetic.
- **MCP `forceGate` warnings no longer silently dropped.** `ctx.log('warn', ...)`
  was a no-op in MCP mode; warnings are now captured and appended to the tool
  result text.

### Removed
- **`plugin/legacy/`** (the old `show-codebase` / `plugin-button` /
  `js-yaml.min.js`). The TypeScript rewrite fully replaces it.
- **Icon paths** from all three GMEdit plugins' `MenuItem` constructors (the
  `plugin/icons/` dir was never checked in; cosmetic only).
- **`mcp.ts`** no longer re-exports `InEvent` / `Citation` — both are already on
  the public barrel via `src/index.ts`.
- **`plugin-inline/inline.js` dead `editWithAI()` function** (264-363 lines).

### Docs
- **CHANGELOG.md** — this file.
- **CONTRIBUTING.md** — dev workflow, style/lint/test conventions, PR checklist.
- **SECURITY.md** — threat model, what we do and don't defend against, how to
  report a vulnerability.
- **test/README.md** — how the test harness works, what helpers exist, how to
  add a new test.
- **docs/plugin-troubleshooting.md** — common failure modes (binary not on PATH,
  node not on PATH, .cmd shim, child hangs, malformed lines) and how to read
  the protocol manually.
- **vscode/README.md** — the VS Code extension user guide (was previously
  only a brief mention in the top-level README).
- **docs/gmedit-plugin.md** — updated file table: removes `plugin/legacy/`,
  adds `plugin/child-process.js`.

### CI
- **`CODEOWNERS`** — security-critical paths (`src/tools/sandbox.ts`,
  `src/config.ts`, `src/agent.ts` approval gate) get a required reviewer.
- **`prettier --check`** is now in `npm run ci`.
- **`ci.yml` concurrency cancellation** — stale branch pushes don't burn runners.

## [0.1.0] — 2026-06-25 — Initial TypeScript rewrite

The Python `talk-codebase` package is replaced ground-up. Ground-up TypeScript
ESM rewrite of the agentic coding assistant. New: no Python, no pip, no
pickle, no LangChain. Landed across milestones M1–M7 (see the implementation
plan in `docs/superpowers/plans/2026-06-24-chatgml-implementation-plan.md`):

- **M1–M3**: foundation; config (deep-merge + secret resolution + untrusted-config
  hardening); index + local memory; OpenAI-compatible streaming LLM client;
  read-only tools; the NDJSON protocol; `serve`; the CLI/REPL.
- **M4**: real edit engine — unified-diff apply + the approval round-trip +
  realpath-validated sandboxed writes.
- **M5**: hippo **READ** adapter (retrieval/recall hybrid).
- **M6**: the GMEdit plugin (NDJSON-over-stdio) and the inline / explain companion
  plugins.

**461+ tests** at release, `npm run ci` green, ready for early adopters.
