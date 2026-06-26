# ChatGML usage

A full CLI + configuration reference for the `chatgml` tool. Every command, flag, environment
variable, and config field below is exactly what the code accepts (see `src/cli.ts` and
`src/config.ts`).

For the editor/automation integration surface, see [agent-api.md](agent-api.md). For the GMEdit
plugin, see [gmedit-plugin.md](gmedit-plugin.md).

---

## Install

```bash
git clone https://github.com/jolionlands/ChatGML.git
cd ChatGML
npm ci
npm run build        # produces dist/; dist/cli.js is the `chatgml` bin
npm link             # optional: put `chatgml` on PATH
```

Without `npm link`, run the tool as `node dist/cli.js <command>` (or `npm run dev -- <command>` for
the TS source via `tsx`).

Requires **Node >= 24**.

---

## Command overview

```
chatgml <index|chat|serve|config> [dir] [options]
```

- `[dir]` is the project directory; it defaults to `.`.
- ChatGML never calls `process.exit` from its core; exit codes are:
  `0` ok, `2` usage error, `3` config error, `1` other.
- **Global options must come before the subcommand** (commander positional options). A global flag
  placed after the subcommand is an "unknown option" usage error (exit 2).

### Global options

| Flag | Config field | Notes |
|---|---|---|
| `--chat-base-url <url>` | `chat.baseURL` | OpenAI-compatible base, e.g. `http://localhost:8080/v1` |
| `--chat-api-key <key>` | `chat.apiKey` | a literal key; prefer the env/config `env:` form |
| `--chat-model <model>` | `chat.model` | required (flag/env/file) |
| `--embed-base-url <url>` | `embed.baseURL` | falls back to `chat.baseURL` |
| `--embed-api-key <key>` | `embed.apiKey` | falls back to `chat.apiKey` |
| `--embed-model <model>` | `embed.model` | required; **no** fallback to the chat model |
| `--scope <scope>` | `scope` | required; memory label, supports `repo::sub` |
| `--approval <mode>` | `approval` | `gated` (default) or `auto` |
| `--no-color` | — | disable ANSI color in the REPL |
| `--trust-project-config` | — | trust a per-project `.chatgml.json` for secret-endpoint/auto-approval |

---

## `chatgml index [dir]`

Builds or incrementally updates the local index for `dir`. Prints a one-line summary:

```
indexed: 56 scanned, 12 added, 3 modified, 40 unchanged, 1 deleted
```

(`(full rebuild: <reason>)` is appended when the whole index was rebuilt, stating WHY — e.g.
`embedding model changed (a -> b)` or `vector dimension changed (64 -> 32)`; a GameMaker `.yyp` is also
noted on its own line.) Indexing embeds chunks through the **embed lane**, so `embed.model` (and a
reachable embed endpoint) must be configured.

The store identity is keyed on the embedding **model** and the **vector dimension** — NOT on the embed
endpoint's host:port. Re-indexing the same model after a llama.cpp/ollama restart that lands on a new
ephemeral port therefore reuses the existing store and re-indexes incrementally (no needless full
re-embed). Only a genuinely different model name or a different vector dimension forces a full rebuild.

`dir` must be an **existing directory** — a missing path or a file is a usage error (exit 2) and no
store is created. When `0` files are scanned (a fresh project, an empty dir, or only non-indexed
extensions), a warning names the indexed extensions and, for a GameMaker project with no `.gml` yet, a
GameMaker-specific hint.

The index is stored under `<dir>/.chatgml/` (manifest + vectors + GM enrichment sidecar). Add
`/.chatgml/` to the project's `.gitignore` so the store is not committed.

**Indexed extensions:** `.gml .js .ts .json .md .txt .shader .vsh .fsh .html .css`. GameMaker
`.yy`/`.yyp` are read for enrichment but not embedded; binary files and `.chatgml.json` are skipped.

```bash
chatgml index .
chatgml --scope myproject index path/to/project
```

### GameMaker-aware enrichment (`.yy`/`.yyp`)

When the indexed directory is a **GameMaker project** (a `.yyp` exists at its root), indexing performs
a best-effort, fs-aware resolution pass over the project's `.yy`/`.yyp` files and enriches the
**citations** the agent returns for `.gml` object events:

- **Collision targets.** A collision event lives on disk as `objects/<Obj>/Collision_<token>.gml`,
  where `<token>` is a GUID (GameMaker 2.3+) or an object name (legacy) — _not_ a readable target. The
  authoritative targets are the `collisionObjectId` refs in the object's `.yy` `eventList`. ChatGML
  resolves the target and adds the **resolved target object name** to the citation
  (`gml.collisionWith`), while keeping the raw filename token in `gml.collisionWithRaw`.
  - **Multi-collision objects** (an object with several collision events) resolve **safely, without
    guessing.** A **name-encoded** file (`Collision_obj_wall.gml`) is matched against the object's
    collision-target names, so each event resolves to its **own distinct** target. A **single-collision**
    object resolves its lone target regardless of the filename token (the only possibility). A
    **GUID-encoded** file on a **multi-collision** object is _ambiguous_ — there is no name to match and
    ChatGML will not pick one of several — so it **stays path-only** (`collisionWithRaw` kept,
    `collisionWith` absent) rather than risk a wrong citation.
- **Parent inheritance.** If an object's `.yy` sets `parentObjectId`, every event citation for that
  object carries the resolved **parent object name** (`gml.parentObject`), so the agent sees the
  inheritance chain.

GameMaker `.yy`/`.yyp` files are JSON **with trailing commas**, which strict `JSON.parse` rejects;
ChatGML parses them with a dedicated tolerant parser (it never routes them through the strict store
reader). The whole pass is **best-effort**: with no `.yyp`, a parse failure, or an unknown reference,
ChatGML simply falls back to **path-only** GameMaker metadata and indexes normally — enrichment never
blocks indexing. When at least one event is enriched, the index summary appends
`; N GameMaker-enriched`.

```bash
# Point index at a real GameMaker project root (the folder containing <Project>.yyp):
chatgml --scope mygame index "/path/to/MyGame"
```

---

## `chatgml chat [dir]`

Starts an interactive REPL. The prompt is `chatgml> `. Type a request; the agent streams its
reasoning, runs tools, and proposes edits.

```bash
chatgml chat .
```

- Edits are **approval-gated** by default: ChatGML shows the diff and prompts
  `Apply edit to <path>? [y/N]`. Only `y` applies the edit; anything else rejects it.
- `--approval auto` applies edits without the per-edit prompt.
- `--no-color` (or `NO_COLOR` / `FORCE_COLOR` env) controls ANSI styling.

### Destructive-edit backstop in `auto` mode

`--approval auto` skips the per-edit prompt — **except for high-risk, destructive edits, which are
always sent through approval even in auto mode.** This caps the blast radius of a prompt-injection that
coerces the model into proposing a destructive `apply_patch`: the dangerous edit still waits for a
human, while ordinary small edits auto-apply untouched. An edit is treated as **high-risk** when, judged
purely from the unified diff vs the target file:

- it is a **whole-file wipe** (removes the entire file and adds nothing back), or
- it is a **whole-file rewrite** (removes the whole file and rewrites it with ≥ 20 new lines), or
- it is a **mass deletion** (net removes more than **50 lines**), or
- it **deletes more than 50%** of the file.

For these, `auto` falls back to the gated path (you are prompted / a `serve` client gets an
`approval_request`) and **nothing is written until you approve**. A small, additive, in-place diff is
not high-risk and still auto-applies. Gated mode (the default) is unchanged — it always prompts.

---

## `chatgml serve [dir]`

Exposes the agent over **NDJSON on stdio** — one JSON object per line on stdout, diagnostics on
stderr. This is what editors (the GMEdit plugin) and automation speak.

```bash
chatgml serve /path/to/project
```

The full protocol (handshake, inbound commands, outbound events, correlation, a minimal Node
consumer) is documented in [agent-api.md](agent-api.md). Note the same positional-options rule:
global flags precede `serve`.

---

## `chatgml config show [dir]`

Prints the **resolved** config as JSON with secrets redacted (`***`), followed by the config files
that were searched (project file first, then user-global):

```bash
chatgml config show .
```

```json
{
  "chat": { "baseURL": "http://localhost:8080/v1", "model": "qwen2.5-coder", "temperature": 0.2, "apiKey": "***" },
  "embed": { "baseURL": "http://localhost:8080/v1", "model": "nomic-embed-text", "batchSize": 64 },
  "memory": { "provider": "local" },
  "scope": "myproject",
  "approval": "gated",
  "index": { "chunkSize": 1500, "chunkOverlap": 200, "root": "." }
}
```

---

## `chatgml config set <field> <value>`

Persists a single field to the **user-global** config file
(`~/.config/chatgml/config.json`, honoring `XDG_CONFIG_HOME`). It never touches a repo-tracked file.

Settable fields:

```
chat.baseURL        chat.apiKey      chat.model     chat.temperature   chat.maxTokens
embed.baseURL       embed.apiKey     embed.model    embed.batchSize
memory.provider     memory.hippo.url memory.hippo.key
scope               approval
index.chunkSize     index.chunkOverlap  index.root
search.minScore
```

Secret fields (`chat.apiKey`, `embed.apiKey`, `memory.hippo.key`) accept only an **`env:NAME`**
reference; a literal value is refused (exit 2):

```bash
chatgml config set chat.baseURL http://localhost:8080/v1
chatgml config set chat.model qwen2.5-coder
chatgml config set embed.model nomic-embed-text
chatgml config set scope myproject
chatgml config set chat.apiKey env:OPENAI_API_KEY     # OK
chatgml config set chat.apiKey sk-abc123              # REFUSED
```

---

## Configuration in depth

### Resolution order

Highest precedence first, deep-merged per key:

1. CLI flags
2. `CHATGML_*` environment variables
3. config files — `<root>/.chatgml.json` (untrusted) then `~/.config/chatgml/config.json` (trusted)
4. defaults

### Defaults

| Field | Default |
|---|---|
| `chat.temperature` | `0.2` |
| `embed.batchSize` | `64` |
| `memory.provider` | `local` |
| `approval` | `gated` |
| `index.chunkSize` | `1500` |
| `index.chunkOverlap` | `200` |
| `index.root` | `dir` |
| `search.minScore` | _(unset — no relevance floor)_ |

### Required fields

ChatGML raises a config error (exit 3) if any of these is missing after merging:

- `chat.baseURL`
- `chat.model`
- `embed.model`
- `scope`
- `memory.hippo.url` (only when `memory.provider` is `hippo`)

### Environment variables

| Variable | Field |
|---|---|
| `CHATGML_CHAT_BASE_URL` | `chat.baseURL` |
| `CHATGML_CHAT_API_KEY` | `chat.apiKey` |
| `CHATGML_CHAT_MODEL` | `chat.model` |
| `CHATGML_EMBED_BASE_URL` | `embed.baseURL` |
| `CHATGML_EMBED_API_KEY` | `embed.apiKey` |
| `CHATGML_EMBED_MODEL` | `embed.model` |
| `CHATGML_SCOPE` | `scope` |
| `CHATGML_APPROVAL` | `approval` (`gated` \| `auto`) |
| `CHATGML_SEARCH_MIN_SCORE` | `search.minScore` (absolute cosine floor, `0`..`1`) |
| `CHATGML_IDLE_MS` | slow-upstream idle-heartbeat period in ms (default `5000`; see agent-api.md) |
| `XDG_CONFIG_HOME` | base for the user-global config dir |
| `NO_COLOR` / `FORCE_COLOR` | REPL color |

### The two lanes

`chat` and `embed` are independent. The embed lane inherits the chat lane's `baseURL` and `apiKey`
when its own are unset, but **never** the model. This lets you, for example, chat against a large
hosted model while embedding with a small local one.

### Search relevance floor (`search.minScore`)

`search.minScore` is an **opt-in absolute floor** on the **semantic (cosine) similarity** of
`search_code` hits. It is the **raw cosine** of the L2-normalized query and chunk embeddings (range
≈ `[0, 1]`; `1.0` is an exact semantic match), checked **before** fusion — _not_ the min-max-normalized
fused score, whose top hit is always `~1.0` and therefore carries no cross-query meaning and makes a
poor threshold. When a floor is set, any hit whose cosine is **below** it is dropped; if that empties
the set, `search_code` returns **no results** (an honest "nothing is relevant enough") rather than a
misleading top-_k_. Surviving hits keep their fused ranking for order.

- **Default: off.** Unset across all layers ⇒ no floor ⇒ behavior is exactly as before.
- **It is an _absolute_ threshold — tune it against your _real_ embedder.** Different embedding models
  put "relevant" at different cosine values; a value learned on one embedder does not transfer. Start
  **conservative** (a low floor, or off) and raise it only after observing real scores. A typical
  useful range against a modern sentence/code embedder is roughly **`0.2`–`0.4`**; this is a starting
  point, not a guarantee. Setting it too high silently hides good results.
- **Where to set it** (flags > env > config; per-call wins over config):
  - Config file / `config set`: `search.minScore` (validated to `0`..`1`).
  - Env: `CHATGML_SEARCH_MIN_SCORE`.
  - CLI: `--min-score <n>` (a global flag — must precede the subcommand).
  - Per call: the `search_code` tool's `minScore` argument **overrides** the configured floor for that
    one search.
- **Local provider only.** The floor is a raw-cosine operation; the `hippo` backend has no cosine
  surface and ignores `minScore`.

```bash
# Conservative absolute floor for one project (tune against your embedder):
chatgml config set search.minScore 0.25
```

### Secrets

- Write secret fields as `env:NAME` references in env/config; the value is resolved from
  `process.env[NAME]` at runtime.
- `chatgml config set` refuses to persist a literal secret to disk.
- Secrets are never logged and are redacted in `config show`.

### Untrusted project config

`<root>/.chatgml.json` is **untrusted**. It may not:

- set `approval: "auto"`, or
- override a secret-bearing endpoint (`chat.baseURL` / `embed.baseURL` / `memory.hippo.url`) while
  the matching key resolves from an `env:` reference.

Either is rejected unless you pass `--trust-project-config`. Keep raw keys in the user-global file
(outside any repo) and reference them with `env:`.

---

## Point it at an endpoint

ChatGML talks to **any OpenAI-compatible** chat + embeddings endpoint.

### Local `llama-server`

```bash
export CHATGML_CHAT_BASE_URL=http://localhost:8080/v1
export CHATGML_CHAT_MODEL=qwen2.5-coder
export CHATGML_EMBED_BASE_URL=http://localhost:8080/v1
export CHATGML_EMBED_MODEL=nomic-embed-text
export CHATGML_SCOPE=myproject
chatgml index . && chatgml chat .
```

### A gateway (e.g. pylon) with a key

```bash
export OPENAI_API_KEY=...          # the gateway key, kept in the env
chatgml config set chat.baseURL http://gateway.local:8088/v1
chatgml config set chat.model qwen2.5-coder
chatgml config set chat.apiKey env:OPENAI_API_KEY
chatgml config set embed.model nomic-embed-text
chatgml config set scope myproject
chatgml chat .
```

### OpenAI

```bash
export OPENAI_API_KEY=sk-...
chatgml --chat-base-url https://api.openai.com/v1 --chat-api-key env:OPENAI_API_KEY \
        --chat-model gpt-4o-mini \
        --embed-base-url https://api.openai.com/v1 --embed-model text-embedding-3-small \
        --scope myproject chat .
```

(For OpenAI specifically the simplest durable setup is the `config set` form above so the key stays
an `env:` reference rather than a flag.)

---

## Memory backends

### `local` (default)

An on-disk JSON vector store built by `chatgml index`. Citations carry file paths with line ranges.

### `hippo` (read-hybrid)

Point retrieval at a running hippo service:

```bash
chatgml config set memory.provider hippo
chatgml config set memory.hippo.url http://hippo.local:PORT
chatgml config set memory.hippo.key env:HIPPO_KEY     # optional
```

`memory.hippo.url` is required when the provider is `hippo`. Hippo hits may carry a snippet + score
without a file path.

---

## Safety notes

### grep ReDoS guard

The `grep` tool runs the model-supplied regex on a single thread with no in-flight timeout (a single
thread cannot interrupt a running match). To prevent catastrophic backtracking it (1) caps the pattern
length, (2) **pre-rejects** patterns whose SHAPE is prone to exponential/polynomial blowup —
nested unbounded quantifiers (`(a+)+`, `(.*X){n,}`), large bounded repetition of such a group
(`(.*a){25}`), and adjacent unbounded quantifiers over overlapping classes (`a*a*`, `.*.*`, `\w+\w+`) —
returning `bad_args`, and (3) enforces a hard **per-file scan-work cap** so even a pattern the
heuristic missed cannot run unbounded on a large file. The shape check is a deliberately conservative
**HEURISTIC, not a guarantee** — legitimate regexes like `function\s+\w+` or `foo.*bar` are still
allowed. The future-proof fix is to run matching on a **worker thread with a wall-clock kill** so any
runaway match is interrupted regardless of shape; the scan-work cap is the interim backstop.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | other error |
| `2` | usage error (bad flag, literal secret to `config set`, no subcommand) |
| `3` | config error (missing/invalid config field) |
