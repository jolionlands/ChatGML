# ChatGML Codebase Map

Last checked: 2026-06-29.

## What this repo is

ChatGML is a GameMaker-first coding agent. The reusable core lives in `src/`, the GMEdit plugin lives
in `plugin/`, and the VS Code extension lives in `vscode/`. Both editor integrations spawn the same
core process with `chatgml serve <projectDir>` and speak the same NDJSON protocol.

## Top-level layout

| Path | Purpose |
|---|---|
| `src/` | TypeScript core: CLI, config, agent loop, tools, indexing, memory, MCP, and NDJSON serve mode. |
| `plugin/` | GMEdit plugin: CommonJS/Electron renderer UI and process bridge. |
| `vscode/` | VS Code extension: activity-bar webview plus NDJSON client. |
| `plugin-inline/`, `plugin-explain/` | Small companion GMEdit plugins that reuse the main plugin process bridge. |
| `test/` | Vitest coverage for core, tools, protocol, memory, plugin runtime, and VS Code wire shapes. |
| `docs/` | Protocol, plugin, usage, troubleshooting, and planning notes. |
| `bin/chatgml.mjs` | Published executable shim. |

## Core flow

1. `bin/chatgml.mjs` starts the compiled CLI.
2. `src/cli.ts` parses commands and loads config from `src/config.ts`.
3. `src/serve.ts` runs the long-lived NDJSON server used by editor plugins.
4. `src/agent.ts` drives the agent loop.
5. Tool calls route through `src/tools/index.ts` into focused tools such as read, grep, edit,
   search/replace, exec, graph, temporal, MCP, and checkpoint.
6. Index and memory helpers in `src/index/` and `src/memory/` provide GameMaker-aware retrieval.

## Editor integrations

### GMEdit

`plugin/chatgml.js` owns GMEdit lifecycle and project/editor context. `plugin/client.js` and
`plugin/child-process.js` spawn the core and decode NDJSON. `plugin/state.js` is the CommonJS copy of
the pure runtime state logic. `plugin/panel.js`, `plugin/diff-view.js`, and `plugin/style.css` render
the side panel.

### VS Code

`vscode/src/extension.ts` registers the activity-bar view, commands, session persistence, slash
commands, config updates, editor context, and approve/reject behavior. `vscode/src/ndjson-client.ts`
spawns the core. `vscode/src/webview.ts` is intentionally presentational.

The VS Code extension reuses `plugin/state.js` directly so slash parsing, binary resolution, editor
context shaping, and reducer behavior do not drift from GMEdit.

## Protocol

The editor clients send NDJSON commands such as `user`, `resume`, `clear`, `approve`, `reject`, and
`reindex`. The core emits `status`, `token`, `tool_call`, `tool_result`, `edit_proposal`,
`approval_request`, `answer`, `turn_end`, and `error`. The canonical reference is
`docs/agent-api.md`.

## Current VS Code feature status

Already present:

- Activity-bar chat view.
- Spawn/restart of `chatgml serve`.
- Editor context with open file, selection, and cursor line.
- Slash commands: `/clear`, `/reindex`, `/resume`, `/scope`, `/model`, `/approval`, `/help`.
- Config chips for scope/model/approval.
- Per-project session resume.
- Gated edit approval/rejection.
- Inline reload and jump after approving an edit to the open file.
- Prompt shortcuts in the webview for review, explain, fix, and commands.

Not present yet:

- Native VS Code chat participant API integration.
- Terminal-style live command panes.
- Checkpoint browser UI.
- Multi-file diff review with VS Code's native diff editor.
- Background task list across sessions.
- Marketplace packaging polish beyond the current manifest.

## Lazy next steps

1. Use VS Code's native `vscode.diff` command for proposed edits instead of building a second diff
   viewer.
2. Add a checkpoint/undo button only after the core exposes enough checkpoint state in the webview.
3. Package only after the activity-bar flow has one real manual test in Extension Development Host.
