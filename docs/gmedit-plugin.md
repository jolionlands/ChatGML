# ChatGML GMEdit Plugin

The GMEdit plugin (in `plugin/`) is a thin **Electron-renderer glue** that spawns the ChatGML core
as a child process and talks the [NDJSON-over-stdio protocol](./agent-api.md). It modernizes the old
`show-codebase` plugin: there is **no** Python venv, **no** `git pull`, **no** `talk-codebase.git`
clone, **no** YAML config, and **no** `…END` / `RECREATE_VECTOR_STORE` text protocol. It speaks
`chatgml serve <projectDir>` and renders the streaming agent events.

## Architecture (why it's split this way)

The core compiles to **ESM** (`package.json` `"type":"module"`, `dist/cli.js` is ESM). The plugin
runs as **CommonJS** in GMEdit's Electron renderer (Node integration on, scripts injected as plain
`<script>` tags by `config.json`). `require()`-ing the ESM core throws `ERR_REQUIRE_ESM`, so the
plugin **cannot import the core** — the only clean bridge is to **spawn the core as a separate child
process** and speak NDJSON over its stdio. That is exactly what `src/serve.ts` exists for.

All protocol/framing/state logic is **pure and headless-tested** in `src/plugin-runtime.ts` and
copied (verbatim, parity-tested) into `plugin/state.js`. The DOM glue is intentionally thin.

| file | role | tested |
|---|---|---|
| `plugin/config.json` | plugin manifest: `name: "chatgml"`, scripts in load order, `style.css` | — |
| `plugin/state.js` | pure logic (NDJSON buffer, `buildServeArgv`, `resolveServeBinary`, `reducePluginState`, `matchApproval`, `isReadyHandshake`) — a CommonJS port of `src/plugin-runtime.ts` | `test/plugin/runtime.test.ts` (TS source) + `test/plugin/parity.test.ts` (JS↔TS parity) |
| `plugin/client.js` | `NdjsonClient`: resolve the binary, `spawn(…, {shell:false, env:minimal})`, raw-chunk decode, send commands, gate on the handshake | `test/plugin/client.test.ts` (fake serve) + `test/serve.spawn-integration.test.ts` (real core) |
| `plugin/panel.js` | `ChatPanel`: side-panel DOM rendered from `reducePluginState` | manual (DOM) + `glue-smoke` load test |
| `plugin/diff-view.js` | `EditProposalView`: render an `edit_proposal` diff + Approve/Reject buttons | `diffLineClass` unit-tested; layout manual |
| `plugin/config-bridge.js` | binary-path + scope Preferences; reads effective config via `chatgml config show` | manual + `glue-smoke` load test |
| `plugin/chatgml.js` | GMEdit lifecycle (`register`/`init`/`cleanup`), context menu, splitter side panel, `projectOpen` | manual (needs GMEdit/Electron) |
| `plugin/legacy/` | the old `show-codebase.js` / `plugin-button.js` / `js-yaml.min.js`, kept for reference | n/a |

`plugin/package.json` (`{"type":"commonjs"}`) marks the `*.js` here as CommonJS so the Node-based
parity/unit tests can `require()` them despite the repo root being `type:module`. It is not shipped.

## Install

The plugin lives in `%APPDATA%/AceGM/GMEdit/plugins/<name>/`. Symlink the repo's `plugin/` dir there
(Windows; run an elevated shell):

```
cd %APPDATA%\AceGM\GMEdit\plugins
mklink /D "chatgml" "C:\Users\you\Development\ChatGML\plugin"
```

(On macOS/Linux GMEdit: `ln -s /path/to/ChatGML/plugin ~/.config/AceGM/GMEdit/plugins/chatgml`.)

Restart GMEdit. A **ChatGML** entry appears in the editor context menu; clicking it opens the side
panel. The plugin folder/`config.json` `name` is `chatgml` — keep them in sync.

## Resolving the `chatgml` core

`chatgml` is often **not on PATH**. The plugin resolves the executable in this order
(`resolveServeBinary`):

1. an explicit **absolute path** set in the plugin's *ChatGML binary path* Preference;
2. the **`CHATGML_BIN`** environment variable;
3. on Windows, the npm shim **`%APPDATA%/npm/chatgml.cmd`** if it exists;
4. the bundled **`dist/cli.js`** (next to the plugin, or one level up in a repo checkout), run via the
   current `node` (`process.execPath`).

If none resolve, the plugin surfaces a clear, actionable error rather than a silent dead child. For a
dev checkout, run `npm run build` so `dist/cli.js` exists, or `npm link` to put `chatgml` on PATH.

## Configuration

Endpoints, models, scope and approval mode resolve in the **core** from flags > `CHATGML_*` env >
config files > defaults — see [DEVELOPMENT.md](../DEVELOPMENT.md). The plugin keeps the command line
minimal: it spawns only `serve <projectDir>` plus an optional `--scope` (from the Preference). It
**never** passes `--chat-api-key` (a secret on the command line would show in process listings).
Secrets belong in the user-global config (`~/.config/chatgml/config.json`) as `env:NAME` references,
set via `chatgml config set chat.apiKey env:MY_KEY`.

The plugin's two Preferences (under GMEdit *Preferences → Plugins → chatgml*):

- **ChatGML binary path** — optional absolute path to the core executable.
- **Scope** — optional `--scope` value.

The child is spawned with an explicit **minimal env** (`PATH` + `APPDATA`/`HOME`/`USERPROFILE`/
`SystemRoot`/`XDG_CONFIG_HOME` so the core can find its config + any `CHATGML_*` vars) — not the full
inherited Electron environment.

## Spawn argv ordering (important)

The core uses commander positional options, so **global flags must precede the `serve`
subcommand**: `buildServeArgv` always emits `[<globalFlags…>, 'serve', <dir>]`. A flag placed after
`serve` exits 2 (`unknown option`); a missing required config field exits 3 (`missing required
config field`). The plugin's `NdjsonClient` resolves these to an in-IDE error rather than a silent
dead child.

## Project directory

`projectDir = e.project.dir` (the on-disk directory GMEdit opened) — **not** `e.project.path` (the
`.yyp` file). Launch/Send is disabled until a project is open.

## Event → UI mapping

The plugin reduces the [AgentEvent](./agent-api.md#outbound-events-server--client) stream via
`reducePluginState` and renders it:

| event | UI effect |
|---|---|
| `status` `phase:ready` | enable Send + Reindex (handshake gate) |
| `status` (other) | status line shows the phase |
| `token` | append to the transcript region |
| `tool_call` | add a "running" activity row |
| `tool_result` | mark the activity row ok/error |
| `edit_proposal` | render the unified diff in `EditProposalView` |
| `approval_request` | show Approve/Reject buttons (wired to the proposal id) |
| `answer` | show the final answer + sources list |
| `error` | show a (non-fatal) error line; the session survives |

Approve/Reject send `{type:'approve'|'reject', id}` with the **same** deterministic id the core
minted (`matchApproval` correlates by id only, so two edits to the same path never alias). On panel
close / GMEdit cleanup the plugin sends `cancel` then ends stdin (the core exits 0 cleanly), with
`child.kill()` as a backstop against an orphan.

## What cannot be tested here

GMEdit/Electron cannot run in CI, so the DOM/IDE glue (`panel.js`, `diff-view.js` layout, context
menu, splitter, `preferencesBuilt`) is verified **manually** in a real GMEdit install. Everything
else — NDJSON framing, argv building, binary resolution, the event→state reducer, approval
correlation, and the **full plugin↔core transport** — is proven headlessly:
`test/serve.spawn-integration.test.ts` spawns the **real** `node dist/cli.js serve <repo>` against a
local OpenAI-compatible SSE stub and drives a complete `user → tokens → answer` turn **and** an
`apply_patch → edit_proposal → approval_request → approve → file-on-disk-changed` round-trip over a
genuine OS process boundary, decoding stdout with the same `NdjsonLineBuffer` the plugin uses.
