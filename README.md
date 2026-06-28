# ChatGML

[![CI](https://github.com/jolionlands/ChatGML/actions/workflows/ci.yml/badge.svg)](https://github.com/jolionlands/ChatGML/actions/workflows/ci.yml)

**ChatGML is a TypeScript agentic coding assistant for your codebase.** It navigates and edits
your project through tools (glob, grep, read, semantic search, graph/temporal recall) over **any
OpenAI-compatible endpoint** — a local `llama-server`, an OpenAI-style gateway like
[pylon](#point-it-at-an-endpoint), or the OpenAI API itself. It is **GameMaker-first** (understands
GML files, objects, and events, and ships a [GMEdit plugin](#gmedit-plugin)) but works on any
repository.

Chat and embeddings are configured as **separate lanes** (independent `baseURL` / `apiKey` /
`model`), so you can embed locally and chat against a bigger model, or vice versa. Retrieval/memory
is **pluggable**: a local on-disk vector store by default, or a read-hybrid [hippo](#memory-backends)
backend.

This is a ground-up TypeScript ESM rewrite of the old Python `talk-codebase` tool. It is a different
program: no Python, no pip, no pickle, no LangChain.

---

## Quickstart

Shortest path from clone to a working chat (assumes a local OpenAI-compatible server on
`http://localhost:8080/v1`):

```bash
git clone https://github.com/jolionlands/ChatGML.git
cd ChatGML
npm ci
npm run build
npm link            # puts `chatgml` on PATH (or use `node dist/cli.js …`)

# Point both lanes at your local server and name a chat + embed model and a scope.
export CHATGML_CHAT_BASE_URL=http://localhost:8080/v1
export CHATGML_CHAT_MODEL=qwen2.5-coder
export CHATGML_EMBED_BASE_URL=http://localhost:8080/v1
export CHATGML_EMBED_MODEL=nomic-embed-text
export CHATGML_SCOPE=myproject

# Index the repo, then chat.
chatgml index .
chatgml chat .
```

`chat` opens an interactive REPL (`chatgml> `). Edits are **approval-gated**: the agent shows a diff
and asks before writing.

See [docs/usage.md](docs/usage.md) for the full command/flag/env/config reference.

---

## Install

Requirements:

- **Node.js >= 24** (uses the stable global `fetch`/streaming; no `node-fetch`/`undici`).
- **npm** (for the build).
- Access to an **OpenAI-compatible** chat endpoint and an embeddings endpoint.

```bash
git clone https://github.com/jolionlands/ChatGML.git
cd ChatGML
npm ci
npm run build       # compiles TS -> dist/ (dist/cli.js is the `chatgml` bin)
```

Then either `npm link` to put `chatgml` on your PATH, or invoke it directly as
`node dist/cli.js <command>`.

---

## Configure

ChatGML resolves config from four layers, **highest precedence first**:

1. **CLI flags** (`--chat-base-url`, `--chat-model`, …)
2. **`CHATGML_*` environment variables**
3. **config files** — the per-project `<root>/.chatgml.json` (UNTRUSTED) then the user-global
   `~/.config/chatgml/config.json` (trusted)
4. **built-in defaults**

### Two lanes

Chat and embeddings are configured **separately**. The embed lane falls back to the chat lane's
`baseURL`/`apiKey`, but **never** the model — `embed.model` is always required.

Required fields (or ChatGML exits with a config error, code 3):

- `chat.baseURL`, `chat.model`
- `embed.model`
- `scope` (a label for this codebase's memory, e.g. `myproject`; supports a `repo::sub` form)
- `memory.hippo.url` (only when `memory.provider` is `hippo`)

### Environment variables

| Variable | Maps to |
|---|---|
| `CHATGML_CHAT_BASE_URL` | `chat.baseURL` |
| `CHATGML_CHAT_API_KEY` | `chat.apiKey` |
| `CHATGML_CHAT_MODEL` | `chat.model` |
| `CHATGML_EMBED_BASE_URL` | `embed.baseURL` |
| `CHATGML_EMBED_API_KEY` | `embed.apiKey` |
| `CHATGML_EMBED_MODEL` | `embed.model` |
| `CHATGML_SCOPE` | `scope` |
| `CHATGML_APPROVAL` | `approval` (`gated` \| `auto`) |

### Config file

The user-global file `~/.config/chatgml/config.json` (honoring `XDG_CONFIG_HOME`) is the trusted,
durable place for settings. Example:

```json
{
  "chat": { "baseURL": "http://localhost:8080/v1", "model": "qwen2.5-coder", "apiKey": "env:OPENAI_API_KEY" },
  "embed": { "model": "nomic-embed-text" },
  "memory": { "provider": "local" },
  "scope": "myproject",
  "approval": "gated"
}
```

Set fields durably with `chatgml config set <field> <value>` (writes the user-global file only).

### Secrets are env references, never literals

Secret fields (`chat.apiKey`, `embed.apiKey`, `memory.hippo.key`) must be written as an
**`env:NAME` reference**, never a literal key. ChatGML refuses to persist a literal secret to disk:

```bash
chatgml config set chat.apiKey env:OPENAI_API_KEY    # OK — resolves from $OPENAI_API_KEY at runtime
chatgml config set chat.apiKey sk-abc123             # REFUSED (exit 2)
```

Keys are **never logged** and are redacted (`***`) in `chatgml config show`.

---

## CLI usage

```
chatgml <index|chat|serve|config> [dir] [options]
```

`[dir]` defaults to `.` (the current directory). Global options apply to every subcommand and, when
combined with positional subcommands, **must precede the subcommand**.

| Command | What it does |
|---|---|
| `chatgml index [dir]` | Build or incrementally update the local index. |
| `chatgml chat [dir]` | Start an interactive chat REPL. |
| `chatgml serve [dir]` | Expose the agent over NDJSON-on-stdio (for the GMEdit plugin / VS Code extension). |
| `chatgml mcp [dir]` | Run the MCP server over stdio — for agent IDEs (Cline, Cursor, Claude Code, Copilot Chat). |
| `chatgml config show [dir]` | Print the resolved config (secrets redacted) + the files searched. |
| `chatgml config set <field> <value>` | Persist one field to the user-global config (refuses literal secrets). |

Global options:

```
--chat-base-url <url>     --embed-base-url <url>
--chat-api-key <key>      --embed-api-key <key>
--chat-model <model>      --embed-model <model>
--scope <scope>           --approval <gated|auto>
--no-color                --trust-project-config
```

Examples:

```bash
# Index, pointing the chat + embed lanes at a local server via flags.
chatgml --chat-base-url http://localhost:8080/v1 --chat-model qwen2.5-coder \
        --embed-base-url http://localhost:8080/v1 --embed-model nomic-embed-text \
        --scope myproject index .

# Chat in auto-approve mode (skips the per-edit prompt).
chatgml --approval auto chat .

# Serve the agent for an editor.
chatgml serve /path/to/gamemaker/project
```

More detail and copy-pasteable recipes live in [docs/usage.md](docs/usage.md).

---

## GMEdit plugin

ChatGML ships a GMEdit plugin (in `plugin/`) that spawns the core as a child process and renders the
streaming agent events in a side panel — chat, tool activity, and approve/reject for gated edits.
See **[docs/gmedit-plugin.md](docs/gmedit-plugin.md)** for install and architecture.

## MCP server (the leverage route — use ChatGML from Cline, Cursor, Claude Code, Copilot Chat, …)

ChatGML exposes its **GML-aware tool registry** as an **MCP server** over stdio, so ANY MCP-speaking
agent IDE can use ChatGML's GML-aware code-graph retrieval (semantic search, graph neighbors,
temporal history) and sandboxed edits. The agent IDE owns the chat/diff approval UX; ChatGML owns
the GameMaker-aware index + retrieval.

```bash
# Index the repo once (builds the local vector store ChatGML's tools search):
chatgml index .

# Run the MCP server over stdio:
chatgml mcp .
```

MCP tools exposed: `glob`, `grep`, `read_file`, `search_code` (GML-aware semantic + keyword search
with collision-event enrichment), `graph_neighbors`, `temporal_query`, and `apply_patch` (sandboxed,
auto-applies — the agent IDE's own diff UX is the human gate).

### Install in agent IDEs

**Cline** (the live successor to Roo Code — Roo was shut down 2026-05-15; Cline is its origin):
`cline_mcp_settings.json`:
```json
{
  "mcpServers": {
    "chatgml": {
      "command": "chatgml",
      "args": ["mcp", "/path/to/your/gamemaker/project"],
      "env": { "CHATGML_SCOPE": "mygame" }
    }
  }
}
```

**Cursor**: Settings → MCP → Add new MCP Server:
```json
{ "mcpServers": { "chatgml": { "command": "chatgml", "args": ["mcp", "${workspaceFolder}"] } } }
```

**Claude Code** (`~/.claude.json` or `.claude/settings.json`):
```json
{ "mcpServers": { "chatgml": { "command": "chatgml", "args": ["mcp", "/path/to/project"] } } }
```

**Copilot Chat / VS Code** (with the Continue/Cline MCP host or GitHub's native MCP support):
`settings.json`:
```json
{ "chatgml.mcp": { "command": "chatgml", "args": ["mcp", "${workspaceFolder}"] } }
```

The config (endpoints, models, scope) resolves exactly as for the CLI — flags, `CHATGML_*` env, the
user-global config file, defaults. **Index once** with `chatgml index .` so `search_code` has a
vector store to query; without an index, the retrieval tools return empty but `glob`/`grep`/`read_file`
still work.

> **Why MCP?** Roo Code and Continue were both shut down in 2026; Cline (Roo's origin) is live, and
> the MCP standard means ChatGML's GML-aware retrieval works in ANY of them — past, present, or
> future — without betting on any single extension. (Your shop already builds the `zmcp` Zig MCP
> family; this is the TypeScript-native ChatGML counterpart.)

## Additional GMEdit plugins

Beyond the main ChatGML side panel (`plugin/`), ChatGML ships two focused companion plugins that
bring the ChatGML agent into the Ace editor itself. Both are installed by symlinking their dirs into
`%APPDATA%/AceGM/GMEdit/plugins/` (same as the main plugin):

### chatgml-inline (`plugin-inline/`)

**Inline AI edits** — the opencode-style inline editing experience:
1. Select code in the Ace editor.
2. Right-click → **Edit with AI** → type an instruction ("add error handling", "rename hp to
   health", "extract into a function").
3. ChatGML spawns `chatgml serve` as a one-shot child process, receives the selection + instruction
   + editor context (open file, cursor), and proposes a unified diff.
4. An **inline overlay** shows the diff with **Accept** / **Reject** buttons.
5. On Accept, the edit is written to disk, the Ace session is reloaded, and the cursor jumps to the
   change. On Reject, nothing is written.

### chatgml-explain (`plugin-explain/`)

**Inline explanations** — right-click → **Explain this** → ChatGML spawns a one-shot child process
with the current selection (or the whole file if nothing is selected) + editor context and renders the
explanation in an inline overlay. Useful for understanding unfamiliar GameMaker patterns, collision
events, or inherited logic without leaving the editor.

### Install all three plugins

```
cd %APPDATA%\AceGM\GMEdit\plugins
mklink /D "chatgml" "C:\Users\you\Development\ChatGML\plugin"
mklink /D "chatgml-inline" "C:\Users\you\Development\ChatGML\plugin-inline"
mklink /D "chatgml-explain" "C:\Users\you\Development\ChatGML\plugin-explain"
```

Restart GMEdit. The main **ChatGML** entry + **Edit with AI** + **Explain this** all appear in the
editor context menu. The companion plugins borrow the verified protocol logic from the main chatgml
plugin's `state.js` (no second copy — guaranteed parity).

## VS Code extension

A co-shipped **GameMaker-aware VS Code extension** lives in `vscode/`. It mounts a **ChatGML** view
in the activity bar and spawns the same `chatgml serve` core over the v2 NDJSON protocol (no second
copy of the protocol logic — it `require()`s the core's verified `plugin/state.js` for the reducer,
binary resolver, slash parser, editor-context builder, and resume-message builder, so it cannot drift
from the GMEdit plugin). Features match the GMEdit plugin:

- Editor-context awareness: every message carries the open file / selection / cursor line.
- Slash commands: `/clear`, `/reindex`, `/resume`, `/scope`, `/model`, `/approval`, `/help`.
- Quick-config chips (scope / model / approval) from `chatgml config show`.
- Per-project resumable sessions (auto-replayed via a `resume` command on the next start).
- Inline diff on approve: the open file is reloaded from disk and the cursor jumps to the changed
  hunk. **Ask About Selection** is bound in the editor context menu.

Build the extension (it reuses the core's built `dist/cli.js` and `plugin/state.js`):

```bash
cd vscode
npm install
npm run build        # emits vscode/dist/extension.js
```

To run it from this checkout, use the **Extension Development Host** (F5 in VS Code with the `vscode/`
folder open) — the manifest points at the adjacent core, so no global install is required. Set
`chatgml.binaryPath` if `chatgml` isn't on PATH. Coexists with any installed GML grammar extension
(it does not register the `gml` language id).

---

## Memory backends

Retrieval is pluggable via `memory.provider`:

- **`local`** (default) — an on-disk JSON vector store built by `chatgml index`. No external service;
  your code never leaves your machine (beyond the embeddings/chat endpoints you point at). Citations
  carry file paths with line ranges.
- **`hippo`** — a **read-hybrid** adapter over a running [hippo](https://github.com/jolionlands)
  memory service (`memory.hippo.url`, optional `memory.hippo.key` as an `env:NAME` ref). Used for
  retrieval/recall; graph/memory hits may carry a snippet + score without a file path.

---

## Security model

- **Approval-gated, sandboxed edits.** The default `approval` mode is `gated`: the agent emits a
  unified diff and an approval request, and **nothing is written until you approve**. All file writes
  are confined to the project root through a single sandbox chokepoint (lexical + realpath/symlink
  checks). `approval: 'auto'` exists but **can never be sourced from the untrusted project config**.
- **Untrusted project config.** A per-project `.chatgml.json` may not override a secret-bearing
  endpoint (`chat.baseURL` / `embed.baseURL` / `memory.hippo.url`) while the matching key resolves
  from an `env:` reference, unless you pass `--trust-project-config`. This blocks key-exfiltration /
  SSRF via a checked-in config.
- **No pickle / no eval.** Persistence is JSON + base64 `Float32Array`; config is zod-validated;
  tool args go through `safeParse`. Nothing is deserialized into code.
- **Keys are never logged** and are redacted everywhere they would otherwise print.

---

## Status

**v1 — milestones M1–M6 complete** (461 tests green; `npm run ci` green):

- **M1–M3** — foundation, config (deep-merge + secret resolution + untrusted-config hardening),
  index + local memory, OpenAI-compatible streaming LLM client, read-only tools, the NDJSON
  protocol, `serve`, and the CLI/REPL.
- **M4** — real edit engine: unified-diff apply + the approval round-trip, realpath-validated
  sandboxed writes.
- **M5** — hippo **READ** adapter (retrieval/recall hybrid).
- **M6** — the GMEdit plugin (NDJSON-over-stdio).

The GMEdit plugin's **visual UX** (DOM/side panel/diff view inside a real GMEdit/Electron install)
cannot run in CI and **needs manual verification**; all protocol/framing/transport logic is covered
by headless tests.

---

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md). Common scripts:

```bash
npm run ci          # typecheck + lint + build + coverage
npm run typecheck
npm test            # vitest
npm run build
```

---

## License

See the repository for license details.
