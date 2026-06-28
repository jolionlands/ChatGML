# ChatGML for VS Code

A co-shipped **GameMaker-aware VS Code extension** lives in `vscode/`. It mounts a
**ChatGML** view in the activity bar and spawns the same `chatgml serve` core over the v2
NDJSON protocol as the GMEdit plugin — no second copy of the protocol logic.

The extension reuses the core's verified `plugin/state.js` for the reducer, binary resolver,
slash parser, editor-context builder, and resume-message builder, so it cannot drift from
the GMEdit plugin.

## Install

From this checkout (the manifest points at the adjacent core, so no global install is
required):

```bash
cd vscode
npm install
npm run build   # emits vscode/dist/extension.js
```

Then launch with **Extension Development Host** (`F5` in VS Code with the `vscode/` folder
open). Set `chatgml.binaryPath` if `chatgml` isn't on PATH:

```json
{
  "chatgml.binaryPath": "C:\\path\\to\\chatgml.cmd"
}
```

Set the *memory scope* per-workspace:

```json
{
  "chatgml.scope": "my-game"
}
```

Or per-command in the chat input (`/scope my-game`).

## Features

- **ChatGML activity-bar view** with a chat transcript, an activity feed, and a tool catalog.
- **Slash commands**: `/clear`, `/reindex`, `/resume`, `/scope`, `/model`, `/approval`, `/help`.
- **Editor-context awareness**: every message carries the open file / selection / cursor line.
- **Quick-config chips** (scope / model / approval) populated from `chatgml config show`.
- **Per-project resumable sessions** (auto-replayed via a `resume` command on next start).
- **Inline diff on approve**: the open file is reloaded from disk and the cursor jumps to the
  changed hunk. **Ask About Selection** is bound in the editor context menu.

## Slash commands

| Command | Effect |
|---|---|
| `/clear` | Drop the in-memory history. |
| `/reindex` | Re-run `chatgml index <dir>` in the background. |
| `/resume` | Replay the persisted NDJSON session transcript. |
| `/scope <v>` | Persist the memory scope (re-spawns the core). |
| `/model <v>` | Set `chat.model` in the user-global config (re-spawns). |
| `/approval gated\|auto` | Set `approval` in the user-global config (re-spawns). |
| `/help` | Show the slash-command help in the chat. |

Slash parsing is **the same** `state.js#parseSlashCommand` used by the GMEdit plugin.

## Editor context

The extension attaches the editor's `openFile`, `selection`, and `cursorLine` to every
`user` message via `state.js#buildEditorContext`. The agent sees:

```
Currently open file: objects/obj_player/Step_0.gml (cursor at line 12)

Selected code:
```gml
hp -= dmg;
```

---

how do I add a damage type check here?
```

The system prompt's "untrusted content" clause covers tool output but editor context is
**trusted** (it's the user's own view, not an external feed).

## Approve / Reject

For gated edits, the chat view shows an inline diff block with **Approve** / **Reject**
buttons. On approve:

1. The extension writes `{type:'approve', id}` to the core's stdin.
2. The core's `ApprovalGate` resolves; the tool writes atomically inside the sandbox
   (`safeWriteFileInRoot` in `src/tools/sandbox.ts`).
3. The extension reloads the open document from disk and jumps the cursor to the first `@@`
   hunk's `+line`.

Rejection is a no-op (no write).

## Resumable sessions

Every turn, the core emits a `turn_end` event with the original user text + finalized
assistant text + sources + editor context. The extension persists this to a per-project
NDJSON file keyed by `sha1(projectDir)`. On next start, the extension sends a `resume`
command with the seeded messages so the conversation continues.

## Build artifacts

```
vscode/
├── package.json              # VS Code extension manifest
├── src/
│   ├── extension.ts          # activation, view, command palette
│   ├── ndjson-client.ts      # the spawn + frame + handshake loop
│   └── webview.ts            # the activity-bar view
└── dist/                     # build output (gitignored)
    ├── extension.js
    ├── ndjson-client.js
    └── webview.js
```

The extension **reuses** the core's verified `dist/cli.js` and `plugin/state.js` — no
second copy of the protocol logic.

## Configuration

| Setting | Type | Default | Effect |
|---|---|---|---|
| `chatgml.binaryPath` | string | `''` | Absolute path to the `chatgml` executable. Empty = resolve via `CHATGML_BIN` / `dist/cli.js` ladder. |
| `chatgml.scope` | string | repo basename | The memory scope label (`repo` or `repo::sub`). |
| `chatgml.autoResume` | boolean | `true` | Auto-replay the persisted session on next start. |

## Compatibility

- VS Code **1.85+** (uses `vscode.window.createWebviewPanel` + custom Editor insets).
- Coexists with any installed GML grammar extension (we do not register the `gml`
  language id; the extension is editor-agnostic about syntax highlighting).

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Chat view shows "spawn failed" | `chatgml` not on PATH and no Preference | `npm run build` in repo root or set `chatgml.binaryPath` |
| `error: missing required config field 'chat.baseURL'` | user-global config incomplete | `chatgml config set chat.baseURL https://...` |
| Approve silently fails | core died (check Output → ChatGML) | Restart the core via the activity-bar refresh button |
| History not resuming | `chatgml.autoResume: false` or the persisted session was deleted | Re-enable or re-run a turn |

## See also

- [Top-level README](../README.md) — feature overview, install, security model.
- [docs/agent-api.md](../docs/agent-api.md) — the wire protocol the extension speaks.
- [docs/gmedit-plugin.md](../docs/gmedit-plugin.md) — the sibling GMEdit plugin (same
  protocol, different host).
