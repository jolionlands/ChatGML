# ChatGML — Agentic Codebase Assistant (TypeScript rewrite)

**Date:** 2026-06-24
**Status:** Approved design, pending spec review → implementation plan
**Supersedes:** the Python/LangChain `talk_codebase` fork entirely

---

## 1. Vision

ChatGML becomes a **TypeScript coding agent** for a codebase (GameMaker-first, language-agnostic
underneath), integrated into the **GMEdit** IDE and a terminal. It *navigates and edits code with
tools* — modern agentic retrieval — rather than stuffing static top-k embedding chunks into one
prompt. It runs against **any OpenAI-compatible** tools-capable model, and its retrieval/memory is a
**pluggable layer** that can be the built-in local store or **hippo** (graph + temporal memory with
BM25 / Personalized-PageRank / HyDE reranking).

One core, two faces (CLI/TUI + GMEdit panel), over one documented agent API.

## 2. Goals / Non-goals

### Goals
- Replace the broken Python/LangChain tool **entirely** with fresh TypeScript. (Python removed from
  the working tree; it remains recoverable in git history and on the upstream public fork.)
- **Agentic** retrieval + editing via tools — not fixed top-k RAG.
- **Pluggable memory/knowledge layer**: built-in `local` backend *and* a working `hippo` adapter
  (code graph, temporal traversal, BM25+PPR+HyDE rerank, scoping).
- **Per-file edit/time history**, **cross-session persistent memory**, **multi-codebase scoping**.
- **Any OpenAI-compatible** backend; chat and embeddings endpoints **separately** configurable.
- Two faces over one core via a documented **NDJSON agent API** (the "coding tool integration API").
- **Tested** (vitest) and **secure** (no pickle deserialization, approval-gated edits, no key logging,
  edits sandboxed to project root).

### Non-goals (v1)
- Web UI; executing/running the GameMaker game; full `ink` TUI; a bundled local embedding model.
  (The embeddings + memory interfaces stay pluggable so these can drop in later.)

## 3. Why the rewrite (audit of the original)

The existing fork cannot run and is unsafe:
- **Dead imports:** LangChain `0.0.200` (`from langchain import FAISS`, `langchain.chat_models`,
  `langchain.llms.GPT4All`, `langchain.document_loaders`) — all removed/relocated in LangChain ≥0.1.
  `openai ^0.27` — the `openai.ChatCompletion` API was deleted in openai ≥1.0.
- **Broken packaging:** console script points at `talk_codebase.cli:main` which does not exist;
  imports are non-namespaced (`from llm import …`) so it only works as a loose script.
- **Security:** `FAISS.load_local` without `allow_dangerous_deserialization` → pickle RCE; API key
  echoed to stderr; plugin `git pull`s a hardcoded (wrong) repo URL.
- **Correctness:** `db.add_documents` after `FAISS.from_documents` double-inserts every vector;
  `is_ignored` re-opens the git repo per file (O(n)); `DEFAULT_CONFIG` duplicated and already drifted
  across `consts.py` / `yaml_config.py`; bare `except:` throughout; **zero tests**.

## 4. Architecture

```
ChatGML/
  src/
    config.ts          # unified config (flags > env > file > defaults), zod-validated
    llm.ts             # OpenAI-compatible chat + tool-calling, streaming (any base_url)
    agent.ts           # agent loop: model <-> tools <-> events, until done
    protocol.ts        # NDJSON agent API: turn/token/tool/diff/approval/answer events
    cli.ts             # commander: chat | index | serve | config
    index.ts           # public API (the integration surface)
    tools/
      glob.ts          # list/find files
      grep.ts          # literal/regex search
      read.ts          # read_file(path, lineRange)
      search.ts        # semantic/keyword search -> active memory provider
      graph.ts         # graph_neighbors / related_symbols -> provider
      temporal.ts      # temporal_query (time-traversal, file history) -> provider
      edit.ts          # apply_patch -> proposes a diff (approval-gated, sandboxed)
    index/
      files.ts         # walk + .gitignore + GML path -> {object,event} metadata
      chunk.ts         # line-aware overlapping chunks + content hashes
      embeddings.ts    # OpenAI-compatible /v1/embeddings (batched, pluggable)
    memory/
      provider.ts      # MemoryProvider interface (the seam)
      local.ts         # Float32 vectors + cosine + simple BM25 + changelog + JSON persistence
      hippo.ts         # adapter -> hippo MCP/HTTP: graph, temporal, PPR/HyDE rerank, scoping
  test/                # vitest, HTTP + hippo mocked; provider contract tests run on both backends
  plugin/              # modernized GMEdit panel (speaks NDJSON to `chatgml serve`)
  docs/                # this spec + API docs
```

**The core is `agent.ts` + the tools + the memory provider.** CLI, `serve`, and the plugin are thin
renderers over the same event stream.

## 5. Memory / knowledge layer (the heart of the overhaul)

Retrieval is an **interface**, not a fixed store. Backends are swappable; the agent's tools are
backend-agnostic.

### `MemoryProvider` interface (seam)
```ts
interface MemoryProvider {
  upsert(chunks: Chunk[], scope: Scope): Promise<void>;
  search(query: string, opts: { k: number; scope: Scope }): Promise<Hit[]>;   // semantic+keyword
  graphNeighbors(ref: SymbolRef, scope: Scope): Promise<Hit[]>;               // KG edges
  temporalQuery(q: TemporalQuery, scope: Scope): Promise<Hit[]>;              // time-traversal/history
  remember(note: SessionNote, scope: Scope): Promise<void>;                   // cross-session memory
  recall(query: string, scope: Scope): Promise<SessionNote[]>;
}
```

### `local` backend (built-in, zero external services)
- Vectors (Float32) + cosine top-k + a simple BM25 keyword index; fusion rerank of the two.
- **Changelog/temporal:** records per-file content hashes + timestamps on each index, so
  `temporalQuery` can answer "what changed in `obj_player` since X".
- **Cross-session memory:** session notes persisted to a local JSON/SQLite namespace, recalled by scope.
- **Scope:** every record tagged with a `scope` (repo id + optional sub-scope) → multi-codebase filter.
- Persistence under `<root>/.chatgml/`. No pickle — plain typed arrays + JSON.

### `hippo` backend (adapter over your existing memory store)
Maps the same interface onto hippo's MCP/HTTP API, adopting wholesale:
- **Knowledge graph:** hippo `code_file` / `code_symbol` nodes + edges (the "Obsidian graph" idea).
- **Rerank:** hippo BM25 + Personalized-PageRank + HyDE fusion.
- **Temporal:** hippo's temporal vector layer for file/edit history + time traversal.
- **Scoping:** hippo scope/profile model for multi-codebase + cross-session long-term memory.
- Config: `HIPPO_URL` / `HIPPO_KEY` + scope; creds via env only.

**Feature → mechanism map:** time-tracking → `temporalQuery`; Obsidian-style links → `graphNeighbors`;
reranking → provider fusion (BM25+PPR+HyDE in hippo); scoping/multi-repo → `Scope`; cross-session →
`remember`/`recall`.

## 6. Agent loop & tools

`agent.ts` runs a tool-calling loop against the chat model: user message → model emits tool calls →
tools execute → results fed back → repeat until the model returns a final answer (with citations).
Tools available to the model:

| Tool | Purpose |
|------|---------|
| `glob` | find files by pattern |
| `grep` | literal/regex search |
| `read_file` | read a path / line range |
| `search_code` | semantic+keyword search via active provider |
| `graph_neighbors` / `related_symbols` | KG traversal via provider |
| `temporal_query` | time-traversal / file history via provider |
| `apply_patch` (edit) | propose a diff — **approval-gated**, **sandboxed to project root** |
| `reindex` | refresh the index incrementally |

## 7. The agent API (integration surface)

`chatgml serve <dir>` exposes the agent over **NDJSON** (one JSON object per line) on stdio — the
documented surface any editor speaks. Replaces the original brittle `…END` / `RECREATE_VECTOR_STORE`
sentinel protocol.

- **in:** `{type:"user", text}` · `{type:"approve"|"reject", id}` · `{type:"reindex"}`
- **out:** `{type:"token", text}` · `{type:"tool_call", name, args}` · `{type:"tool_result", …}` ·
  `{type:"edit_proposal", id, path, diff}` · `{type:"answer", sources}` · `{type:"status"|"error"}`

The same event stream powers the CLI/TUI renderer and the GMEdit panel.

## 8. Config

Single source of truth; resolution order **flag > env (`CHATGML_*`) > `~/.config/chatgml/config.json`
or per-project `.chatgml.json` > defaults**; validated with zod.

```jsonc
{
  "chat":  { "baseURL": "...", "apiKey": "env:...", "model": "..." },
  "embed": { "baseURL": "...", "apiKey": "env:...", "model": "..." },   // may differ from chat lane
  "memory": { "provider": "local" | "hippo",
              "hippo": { "url": "...", "key": "env:HIPPO_KEY", "scope": "repo-id" } },
  "scope": "repo-id",
  "approval": "gated" | "auto"   // default: gated
}
```

## 9. Security

- **No pickle anywhere** — vectors are typed arrays + JSON, so the FAISS-RCE class is gone by
  construction.
- **Edits approval-gated by default** (`apply_patch` proposes a diff; CLI prompt / panel Approve-Reject
  button); edits **sandboxed to the project root** (path traversal rejected).
- API key / hippo key from env or secure config only — **never logged**.
- No arbitrary `git pull` from the plugin.

## 10. GMEdit plugin (modernized)

Keeps the side-panel UX (Launch/Kill, Send, Regenerate) but: spawns `chatgml serve <projectDir>`;
speaks **NDJSON**; streams tokens live; renders `tool_call` activity and `edit_proposal` **diffs with
Approve/Reject**; reads the unified config; fixes the hardcoded wrong-repo bug.

## 11. Testing (vitest, HTTP + hippo mocked)

Unit: chunking, local store cosine/BM25 fusion, config resolution, NDJSON framing, gitignore filtering,
GML path metadata, edit sandbox + approval gating. Agent: loop with a mocked LLM + fake tools.
**Provider contract tests** run against both `local` and a mock `hippo` to prove interface parity.

## 12. Implementation phasing (for the plan)

- **P0** Scaffold: package.json (ESM, TS, vitest, commander, zod, undici), tsconfig, CI; remove Python.
- **P1** config + llm client + files/chunk/embeddings + `local` store + `index` command.
- **P2** agent loop + read-only tools (glob/grep/read/search) + CLI `chat` (read-only agent).
- **P3** edit tool: `apply_patch` + approval gating + sandbox.
- **P4** NDJSON `serve` protocol + MemoryProvider interface + local temporal/session/scope.
- **P5** `hippo` adapter (graph/temporal/rerank/scope) + provider contract tests.
- **P6** GMEdit plugin modernization against `serve`.
- **P7** docs (API + README) + polish.

## 13. Out of scope / future

Local embedding model (transformers.js), web UI, running the game, full `ink` TUI, auto-apply edit
mode hardening. Interfaces (`embeddings`, `MemoryProvider`) are designed so these slot in without core
changes.
