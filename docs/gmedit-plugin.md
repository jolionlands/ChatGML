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
| `plugin/child-process.js` | shared process plumbing (binary resolution, env whitelist, Windows `.cmd` shim, spawn + NDJSON buffer + handshake gate + watchdog + cancel/end-stdin/kill cleanup) — used by the main plugin AND by both companion plugins via `require('../chatgml/child-process.js')` | `test/plugin/child-process.test.ts` (helpers) + `test/plugin/client.test.ts` (full spawn/handshake round-trip) |
| `plugin/client.js` | `NdjsonClient`: thin wrapper around `child-process.js` exposing the per-tool API (`sendUser`, `reindex`, `approve`, `sendApprovalPolicy`, …) | `test/plugin/client.test.ts` (fake serve) + `test/serve.spawn-integration.test.ts` (real core) |
| `plugin/panel.js` | `ChatPanel`: side-panel DOM rendered from `reducePluginState` | manual (DOM) + `glue-smoke` load test |
| `plugin/diff-view.js` | `EditProposalView`: render an `edit_proposal` diff + Approve/Reject buttons | `diffLineClass` unit-tested; layout manual |
| `plugin/config-bridge.js` | binary-path + scope Preferences; reads effective config via `chatgml config show` | manual + `glue-smoke` load test |
| `plugin/chatgml.js` | GMEdit lifecycle (`register`/`init`/`cleanup`), context menu, splitter side panel, `projectOpen` | manual (needs GMEdit/Electron) |

`plugin/package.json` (`{"type":"commonjs"}`) marks the `*.js` here as CommonJS so the Node-based
parity/unit tests can `require()` them despite the repo root being `type:module`. It is not shipped.

## Install

Shortest path from npm:

```bash
npm install -g chatgml
chatgml-gmedit-setup
```

Shortest path from a checkout:

```bash
npm ci
npm run build
npm run setup:gmedit
```

That links the main plugin plus `chatgml-inline` and `chatgml-explain` into GMEdit's plugin folder.
Add `--gmloop` (`npm run setup:gmedit -- --gmloop` from a checkout) to also link the optional
`chatgml-gmloop` plugin.

GMEdit plugin folders:

| OS | default folder |
|---|---|
| Windows | `%APPDATA%/AceGM/GMEdit/plugins` |
| macOS | `~/Library/Application Support/AceGM/GMEdit/plugins` |
| Linux | `$XDG_CONFIG_HOME/AceGM/GMEdit/plugins` or `~/.config/AceGM/GMEdit/plugins` |

Manual Windows equivalent:

```
cd %APPDATA%\AceGM\GMEdit\plugins
mklink /D "chatgml" "C:\Users\you\Development\ChatGML\plugin"
mklink /D "chatgml-inline" "C:\Users\you\Development\ChatGML\plugin-inline"
mklink /D "chatgml-explain" "C:\Users\you\Development\ChatGML\plugin-explain"
```

Manual macOS/Linux equivalent:

```bash
ln -s /path/to/ChatGML/plugin "$HOME/Library/Application Support/AceGM/GMEdit/plugins/chatgml"
ln -s /path/to/ChatGML/plugin-inline "$HOME/Library/Application Support/AceGM/GMEdit/plugins/chatgml-inline"
ln -s /path/to/ChatGML/plugin-explain "$HOME/Library/Application Support/AceGM/GMEdit/plugins/chatgml-explain"
```

On Linux, replace the target base with `${XDG_CONFIG_HOME:-$HOME/.config}/AceGM/GMEdit/plugins`.

Restart GMEdit. A **ChatGML** entry appears in the editor context menu; clicking it opens the side
panel. The plugin folder/`config.json` `name` is `chatgml` — keep them in sync.

## Resolving the `chatgml` core

`chatgml` is often **not on PATH**. The plugin resolves the executable in this order
(`resolveServeBinary`):

1. an explicit **absolute path** set in the plugin's *ChatGML binary path* Preference;
2. the **`CHATGML_BIN`** environment variable;
3. the bundled **`dist/cli.js`** (next to the plugin, or one level up in a repo checkout), run via the
   current `node` (`process.execPath`).
4. on Windows, the npm shim **`%APPDATA%/npm/chatgml.cmd`** if it exists.

If none resolve, the plugin surfaces a clear, actionable error rather than a silent dead child. For a
dev checkout, run `npm run build` so `dist/cli.js` exists, or `npm link` to put `chatgml` on PATH.

## Configuration

Endpoints, models, scope and approval mode resolve in the **core** from flags > `CHATGML_*` env >
config files > defaults — see [DEVELOPMENT.md](../DEVELOPMENT.md). The plugin keeps the command line
minimal: it spawns only `serve <projectDir>` plus an optional `--scope` (from the Preference). It
**never** passes `--chat-api-key` (a secret on the command line would show in process listings).
Secrets belong in the user-global config (`~/.config/chatgml/config.json`) as `env:NAME` references,
set via `chatgml config set chat.apiKey env:MY_KEY`.

Minimum working config:

```bash
chatgml config set chat.baseURL http://localhost:8080/v1
chatgml config set chat.model qwen2.5-coder
chatgml config set embed.model nomic-embed-text
chatgml config set scope mygame
```

The plugin settings panel can save `chat.model`, `chat.baseURL`, `embed.model`, `embed.baseURL`,
`chat.apiKey` env refs, mode, approval, scope, tier model/baseURL overrides, tool approval, and MCP
servers.

The plugin Preferences (under GMEdit *Preferences -> Plugins -> chatgml*) include:

- **ChatGML binary path** — optional absolute path to the core executable.
- **Scope** — optional `--scope` value.

The child is spawned with an explicit **minimal env** (`PATH` + `APPDATA`/`HOME`/`USERPROFILE`/
`SystemRoot`/`XDG_CONFIG_HOME` so the core can find its config + any `CHATGML_*` vars) — not the full
inherited Electron environment.

### Providers

ChatGML providers are OpenAI-compatible endpoints. The core does not need a provider plugin: a
provider is just `chat.baseURL`, `chat.model`, optional `chat.apiKey`, and an `embed.model`.

The GMEdit settings panel also reads a provider registry from these places and merges them:

- ChatGML-owned: `%APPDATA%/chatgml/providers.json` on Windows or `~/.config/chatgml/providers.json`
  on macOS/Linux.
- `~/.pi/agent/providers.json`
- opencode and crush provider configs, when present.

Use **Refresh providers** to load the registry, **Add provider** for a quick custom endpoint, and
**Export .env** to copy provider environment hints. Picking a provider row fills the model/base URL
fields; **Save & Restart** persists the actual ChatGML config.

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
| `status` `phase:ready` | enable Send + Reindex (handshake gate); pull effective config + resume last session |
| `status` (other) | status line shows the phase |
| `token` | append to the transcript region |
| `tool_call` | add a "running" activity row |
| `tool_result` | mark the activity row ok/error |
| `edit_proposal` | render the unified diff in `EditProposalView` |
| `approval_request` | show Approve/Reject buttons (wired to the proposal id) |
| `answer` | show the final answer + sources list |
| `turn_end` | appended to the per-project session file (a no-op on the visible panel state) |
| `error` | show a (non-fatal) error line; the session survives |

Approve/Reject send `{type:'approve'|'reject', id}` with the **same** deterministic id the core
minted (`matchApproval` correlates by id only, so two edits to the same path never alias). On
**approve**, if the touched file is the one currently open, the plugin reloads its Ace session from
disk and jumps the cursor to the first changed hunk line (opencode-style inline diff). On panel
close / GMEdit cleanup the plugin sends `cancel` then ends stdin (the core exits 0 cleanly), with
`child.kill()` as a backstop against an orphan.

### Editor context awareness (opencode-style)

Every `user` message the panel sends carries an optional `context` object (see
[docs/agent-api.md → Editor context](./agent-api.md#editor-context)) built from the active Ace
session by the glue:

- `openFile` — the repo-relative path of the currently open file;
- `cursorLine` — the cursor's 1-based line;
- `selection` — the selected text in the editor (empty/whitespace selections are dropped).

The core prepends a clearly-framed DATA block to the user's text so the agent knows what you're
pointing at without re-stating it. A second context-menu entry, **Ask about selection**, opens the
panel and sends a primed message with the current selection (or, if nothing is selected, "explain
this file") with the editor context attached.

### Slash commands

Typing a line that starts with `/` in the chat input is interpreted as a **client-side command**,
not sent to the agent (`plugin/state.js#parseSlashCommand`):

| command | action |
|---|---|
| `/clear` | send a `clear` control command (drops the core's in-memory history) AND clear the saved session file |
| `/reindex` | send a `reindex` command (rebuild the code index) |
| `/resume` | reload the last saved session for this project and send a `resume` command seeding the core's history |
| `/scope <name>` | set the plugin Scope preference and restart the core (`--scope` is a serve-argv flag) |
| `/model <id>` | run `chatgml config set chat.model <id>` then restart the core |
| `/approval gated\|auto` | run `chatgml config set approval <mode>` then restart the core |
| `/help` | show the command list in the panel |

Unknown/empty slash commands show a hint instead of sending.

### Quick-config row

On `status:ready` the glue runs `chatgml config show <projectDir>` and renders the resolved (and
secret-redacted) `scope` / `chat.model` / `approval` as chips at the top of the panel — a read-only
snapshot so you never have to leave GMEdit to see what the core is configured with. `/model` and
`/approval` edit these durably in the user-global config; `/scope` edits the plugin preference
(scope is a serve-argv flag, not a config field).

### Resumable conversation history

The glue keeps one NDJSON file per project under `plugin/chatgml-sessions/<hash>.ndjson` and
appends every `turn_end` record to it (capped to the most recent 50 turns). On the next `chatgml
serve` start (e.g. after GMEdit is closed and reopened) the glue reads that file, converts the
turns into `{role,content}` pairs via `turnEndToMessages`, and sends a single `resume` control
command seeding the core's in-memory history — so multi-turn context survives the restart. `/clear`
wipes both the in-memory history and the persisted file.

### GameMaker-aware citations

When the open project is a GameMaker project (a `.yyp` at the project root), the `answer`/`tool_result`
**sources** carry GameMaker metadata under `citation.gml`. For object events the core resolves the
project's `.yy`/`.yyp` at index time and adds the **resolved collision target** (`gml.collisionWith`,
the authoritative `eventList[].collisionObjectId`, alongside the raw filename token in
`gml.collisionWithRaw`) and the object's **parent** (`gml.parentObject`, from `parentObjectId`). This
is best-effort: with no `.yyp` or an unresolvable reference the citation stays path-only
(`gml.collisionWithRaw` only). See [usage.md](./usage.md#gamemaker-aware-enrichment-yyyyp).

## What cannot be tested here

GMEdit/Electron cannot run in CI, so the DOM/IDE glue (`panel.js`, `diff-view.js` layout, context
menu, splitter, `preferencesBuilt`) is verified **manually** in a real GMEdit install. Everything
else — NDJSON framing, argv building, binary resolution, the event→state reducer, approval
correlation, and the **full plugin↔core transport** — is proven headlessly:
`test/serve.spawn-integration.test.ts` spawns the **real** `node dist/cli.js serve <repo>` against a
local OpenAI-compatible SSE stub and drives a complete `user → tokens → answer` turn **and** an
`apply_patch → edit_proposal → approval_request → approve → file-on-disk-changed` round-trip over a
genuine OS process boundary, decoding stdout with the same `NdjsonLineBuffer` the plugin uses.
