# Tests

ChatGML has **778 tests** across 61 files, all running headlessly under vitest. Coverage
gates are **per-file** at 80% lines / 75% branches / 80% functions / 80% statements.

This file explains the harness, the helpers, and how to add a new test.

## Layout

```
test/
├── agent.*.test.ts          — agent loop, approval gate, serve surface, v2 features
├── cli.test.ts              — commander CLI (index/chat/serve/mcp/config)
├── config.test.ts           — config resolution + untrusted guards + secrets
├── llm.*.test.ts            — OpenAI-compatible chat client + SSE parser
├── protocol.test.ts         — NDJSON framing + InEventSchema
├── repl.test.ts             — chat REPL (EventRenderer + runChatRepl)
├── serve.*.test.ts          — NDJSON serve transport + edit round-trip
├── mcp.test.ts              — MCP server (JSON-RPC over stdio)
├── index/indexer.test.ts    — incremental re-index
├── memory/*.test.ts         — Local + hippo memory providers, BM25, fusion, persist
├── tools/*.test.ts          — one test file per tool + a registry test
├── plugin/                  — GMEdit plugin (CJS, parity-tested against src/plugin-runtime.ts)
├── helpers/                 — fake LLM, fake agent, fake embeddings, mock fetch, tool context
├── setup.ts                 — global beforeEach/afterEach: unmocked fetch throws; env snapshot
└── fixtures/                — exact-byte test fixtures
```

## The setup: `test/setup.ts`

Installed via `setupFiles: ['./test/setup.ts']` in `vitest.config.ts`. Runs before every test:

1. Snapshots `process.env` so `CHATGML_*` vars never leak between tests.
2. Installs `globalThis.fetch = () => { throw }` so any unmocked network call fails loudly.

After every test, restores both. Use `vi.stubGlobal('fetch', ...)` to inject a mock for
specific tests — `setup.ts` will clean up via `vi.unstubAllGlobals()`.

The `pool: 'forks'` config means each test file runs in its own process — globals like
`globalThis.fetch` don't leak across files.

## Helpers

### `test/helpers/fakes.ts`

- **`FakeEmbeddings`** — deterministic embeddings (`id = cfg.model`, dimension from a fixed
  vector keyed by string hash). Used wherever an `Embeddings` is required and a real
  embedder would be too slow / non-deterministic.
- **`makeTmpRepo(files)`** — creates a temp dir, writes the given files, returns
  `{ root, cleanup }`. Cleanup deletes the temp dir. Always use this for fs-touching tests;
  never hard-code paths.

### `test/helpers/fake-llm.ts`

- **`FakeLlm`** — a scripted `LlmLike` that returns a sequence of `ChatResult`s from a
  pre-canned list. Records every request for assertion (`llm.requests[0]` etc.).

### `test/helpers/fake-agent.ts`

- **`FakeAgent`** — a scripted `AgentLike` for tests that don't need the real agent loop
  (e.g. `serve` / `mcp` round-trip tests). Emits a sequence of `AgentEvent`s; `release()`
  settles gated approvals.

### `test/helpers/mock-fetch.ts`

- **`FetchRecorder`** — wraps a real-ish fetch; records every call.
- **`assertNoAuthLeak(events)`** — asserts no `Authorization: Bearer …` header appears in
  recorded events.

### `test/helpers/tool-context.ts`

- **`makeToolContext(opts)`** — builds a `ToolContext` for tool unit tests, with
  configurable `root`, `approval`, `toolApproval`, `requestApproval` mock, and `memory`.

### `test/helpers/provider-contract.ts`

- **`assertProviderContract(provider)`** — asserts every method of `MemoryProvider` exists
  with the right signature. Run against both `LocalMemoryProvider` and `HippoMemoryProvider`.

## How to add a new test

1. **Pick the file.** Each tool has its own `test/tools/<name>.test.ts`. The agent loop
   spans several files (split by concern: `agent.loop.test.ts` for the loop,
   `agent.approval.test.ts` for the gate, etc.). For a new area, create a sibling
   `test/<area>.test.ts`.

2. **Use the harness.** Always go through the helpers — never hard-code paths or
   constructors. Mark every file / dir you create with `mkdtempSync` + a matching
   `afterEach` cleanup.

3. **Be deterministic.** No real network (use `mock-fetch`). No real wall-clock
   beyond ~1–2s for handshake grace. No reliance on `process.env` outside the `setup.ts`
   snapshot/restore cycle.

4. **Cover the security-relevant edge.** A sandbox test should cover both the happy path
   AND a regression attempt. An approval-gate test should cover both auto and gated modes.

5. **Test at the right layer.** A `tools/edit.test.ts` test exercises the tool's
   `execute` method directly (with a `ToolContext` mock). An `agent.loop.test.ts` test
   exercises the loop end-to-end with a `FakeLlm` and an in-memory memory.

6. **Run `npm run ci` before pushing.** Coverage thresholds are per-file; if your new test
   brings down an existing file's coverage below the threshold, the build fails.

## Running subsets

```bash
# Run one file
npx vitest run test/tools/edit.test.ts

# Run one test by name pattern
npx vitest run test/tools/edit.test.ts -t "whole-file wipe"

# Run with coverage for one file (fast iteration)
npx vitest run --coverage test/tools/edit.test.ts
```

## Coverage thresholds

`vitest.config.ts` sets per-file thresholds (NOT aggregate — one well-tested file cannot
mask an untested one):

- **lines:** 80%
- **branches:** 75%
- **functions:** 80%
- **statements:** 80%

`src/index.ts` and `src/cli.ts` are **excluded** from coverage (documented in
`vitest.config.ts`) because they're pure-wiring / dispatch glue.

## Fixture: `test/fixtures/agent-api-transcript.ndjson`

An exact-byte NDJSON transcript of a full agent turn (ready → tokens → tool_call →
tool_result → answer). Used by `test/docs.conformance.test.ts` to deep-equal against the
worked example in `docs/agent-api.md`. **Any change to the wire protocol must update this
fixture AND the doc block in lockstep** — the conformance test enforces the match.

## Plugin parity

`plugin/state.js` is a hand-written CommonJS port of `src/plugin-runtime.ts`. The
`test/plugin/parity.test.ts` test asserts both stay byte-equivalent across all exported
functions. **Any change to `src/plugin-runtime.ts` must update `plugin/state.js` AND the
parity test fixtures.**
