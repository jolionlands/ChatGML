# ChatGML TypeScript Rewrite — FINAL Hardened Implementation Plan

**Date:** 2026-06-24
**Repo:** `C:/Users/kalli/Development/ChatGML`
**Branch:** `agentic-rewrite`
**Status:** Final — every audit blocker/critical/high is resolved or explicitly addressed inline (see [Audit Resolutions](#audit-resolutions)).

> Subagent note: the default cwd is **not** the repo. In PowerShell run
> `Set-Location -LiteralPath 'C:/Users/kalli/Development/ChatGML'` first (it persists),
> or use the Bash tool with absolute paths and `git -C C:/Users/kalli/Development/ChatGML`.
> All code uses forward slashes. TypeScript ESM, `module`/`moduleResolution` = `NodeNext`, `strict`.

---

## 1. Overview

ChatGML is being rewritten from a Python/LangChain/FAISS tool into a **TypeScript ESM** codebase that exposes a GameMaker-aware coding agent over three surfaces: a CLI (`chatgml chat|index|serve|config`), an NDJSON-over-stdio protocol (for the GMEdit plugin and any editor), and a pluggable retrieval/memory layer. The backend is **any OpenAI-compatible endpoint**, with **chat and embeddings configured separately** (each has its own `baseURL` + `apiKey` + `model`).

Design pillars:

- **Single type vocabulary.** Every shared type is declared **exactly once**. Wire/agent/tool/cross-cut types live in `src/types.ts`; retrieval domain types live in `src/memory/types.ts` and **re-export** (type-only) from `src/types.ts` rather than redeclaring. This kills the cross-lens drift (3 `Scope` shapes, 2 `Tool` contracts, `Citation` vs `Source`, 2 `AgentEvent` unions, `Embeddings` vs `Embedder`, 3 `MemoryProvider` copies).
- **No `node-fetch`/`undici`.** Node 25 ships stable global `fetch`, `Request`, `Response`, `Headers`, `ReadableStream`, `TextDecoderStream`, `AbortController`, async-iterable `Response.body`. Verified present on 25.9.0 with no experimental warning. The SSE streaming path and `AbortSignal` honoring use only these.
- **No pickle / no eval / no native deser.** Persistence is JSON + base64-encoded `Float32Array`. Config is zod-validated. Tool args go through `safeParse`. Provider selection uses dynamic `import()` of **static** paths only.
- **TDD with vitest.** HTTP is mocked via `vi.stubGlobal('fetch')`. `pool: 'forks'` gives process-per-file isolation for the shared global `fetch` and `process.env`. Secrets are never logged (redact + sentinel-based leak assertions). FS writes are sandboxed to the project root through one chokepoint.
- **Python tree is never deleted.** `talk_codebase/`, `poetry.lock`, `setup.py`, `pyproject.toml`, `yaml_config.py`, `config.yaml`, `talk_codebase_config.yaml` all stay (recoverable history). `python-publish.yml` is **neutralized** to `workflow_dispatch`-only, not removed.

The **buildable v1** is M1→M3:

- **M1 — Foundation:** scaffold, the single shared-type file, config with deep-merge + secret resolution + untrusted-config hardening, test seams.
- **M2 — Index + Memory:** chunker, GameMaker metadata, ignore filter, embeddings (separate lane), local JSON memory provider, incremental manifest, provider contract harness.
- **M3 — Agent + Tools + CLI:** OpenAI-compatible streaming LLM client, NDJSON protocol, read-only tools (glob/grep/read/search/graph/temporal) + a gated `apply_patch` STUB, agent loop, NDJSON `serve`, CLI + REPL, CI, `docs/agent-api.md`.

**Later (separately milestoned, not in v1):**

- **M4 — Edit tool real engine** (unified-diff apply + approval round-trip, realpath-validated write).
- **M5 — Hippo adapter** (re-scoped to hippo's real capabilities; see [§7](#7-memory-provider-seam--hippo-realism)).
- **M6 — GMEdit plugin** (modernize the existing `show-codebase` plugin to NDJSON-over-stdio).
- **M7 — Docs + polish.**

---

## 2. Audit Resolutions

Every blocker/critical/high from the audit is resolved below; mediums/lows are folded into the relevant task. This section is the authoritative diff against the master plan.

### Buildability & dependencies

- **[critical] zod-to-json-schema vs zod 4 → empty schemas.** **DROP `zod-to-json-schema`.** Pin `zod@^3.25` (`^3.25.76`, the line whose `._def` internals `zod-to-json-schema` introspects) **and** keep zod-to-json-schema — **OR** pin `zod@^4` and use native `z.toJSONSchema`. **Decision: pin `zod@^3.25.76` and `zod-to-json-schema@^3.24.6`.** Rationale: zod 3.25 is stable, the `z.ZodType<A>` typings in the shared types are zod-3 shaped, and zod-to-json-schema 3.x produces correct `{type:'object',properties,required,additionalProperties:false}` against it (verified). `toOpenAiToolSpecs` strips `$schema` and forces `additionalProperties:false`. (If a future maintainer migrates to zod 4, swap to native `z.toJSONSchema` and drop the dep in the same PR.) **Every dep below is pinned.**
- **[high] tsconfig `@types/node` / Buffer / node:crypto under TS 6.** Pin **`typescript@~5.7`** (`5.7.3`) for predictable strict-flag behavior; do **not** ride `6.0.x`. Add `"lib": ["ES2023"]` and `"types": ["node"]` to `tsconfig.json` so `Buffer`/`node:crypto` resolve.
- **[high] M1 `tsc` on empty src impossible (TS18003).** **Reworded gate:** M1 does **not** run tsc over an empty `src/`. The first typecheck happens **after `src/types.ts` exists**. The scaffold step verifies `npm ci` installs clean and `tsconfig.json` parses (`tsc --showConfig` exits 0), not `tsc --noEmit` over nothing.
- **[high] oxlint warnings don't fail CI.** The `lint` script is **`oxlint --max-warnings 0`** (also `--deny-warnings` acceptable). Verified: default oxlint exits 0 on warnings; `--max-warnings 0` makes it exit 1.
- **[medium] `exactOptionalPropertyTypes` ergonomic tax.** **Decision: keep it OFF for v1.** `strict` + `noUncheckedIndexedAccess` give the safety that matters; `exactOptionalPropertyTypes` would force conditional-spread on every `Usage`/`AgentEvent`/`Citation` construction (TS2375). Documented in `DEVELOPMENT.md`. (`verbatimModuleSyntax`, `isolatedModules`, `noUncheckedIndexedAccess` stay ON.)
- **[medium] unpinned deps pulling majors.** All `npmDeps` carry exact-ish carets; lockfile committed. See [§5](#5-npm-dependencies-pinned).
- **[low] engines floor.** `node>=24` is a project choice (all deps allow `>=22.12`); documented as such.
- **[low] global fetch claim.** Confirmed correct; M7 CI keeps the "no node-fetch/undici" dep-tree assertion.
- **[low] NodeNext `.js` extension caught at typecheck.** **Corrected rationale:** `tsc --noEmit` under NodeNext flags missing extensions as **TS2835** at typecheck. The `node dist/cli.js --version` CI smoke is belt-and-suspenders, not the sole guard.

### Interface consistency

- **[critical] `MemoryConfig` declared twice + `createMemoryProvider` cfg drift.** **`MemoryConfig` is a discriminated union declared ONCE in `src/types.ts`.** `src/config.ts` imports it (does not redeclare). `src/memory/provider.ts` imports it (does not redeclare). The provider input is a single named type `MemoryProviderInput = MemoryConfig & { root: string }` declared once in `src/memory/provider.ts`; `createMemoryProvider(input, deps)` takes exactly that. The discriminated union makes the `never`-branch real, so the exhaustiveness test is meaningful.
- **[critical] `AgentLike` can't deliver approve/reject/cancel into an in-flight run.** **`AgentLike` gets an explicit control surface:** `run(userCmd, signal): AsyncIterable<AgentEvent>` for `user`/`reindex` **plus** `resolveApproval(id, approved): void` and `cancel(): void`. `serve.ts` maps `approve`/`reject` → `resolveApproval`, `cancel` → `cancel`, and only `user`/`reindex` → `run`. The `ApprovalGate` is held by the agent and shared with `AgentLike`. **Open question #5 is resolved: one async-iterable per `user`/`reindex` command; approve/reject/cancel are out-of-band control calls, NOT new runs.**
- **[high] `ToolContext.requestApproval` vs `ApprovalGate.request` shape mismatch.** **Unify on one `ApprovalRequest` interface declared once in `src/types.ts`:** `{ id: string; kind: 'edit'; path: string; diff: string }`. Both `ToolContext.requestApproval(req: ApprovalRequest)` and `ApprovalGate.request(req: ApprovalRequest)` use it. `agent.ts` mints the `id` (`sha1(path + '\0' + diff)`) and uses the **same id** for `edit_proposal` and `approval_request`, so `resolveApproval(id)` correlates end-to-end.
- **[high] `Tool.execute` return type unconstrained but agent needs `ToolResult`.** **Drop the `R` type parameter:** `execute(args, ctx): Promise<ToolResult>`. `ToolDef<A> { schema: ZodType<A>; execute(args: A, ctx): Promise<ToolResult> }`, `Tool = ToolDef<unknown>`, `ToolRegistry = ReadonlyMap<string, Tool>`. `dispatchTool` reads `result.content`/`result.citations` with no cast. All tools return `ToolResult`.
- **[medium] `Hit` → `Citation` lossy mapping has no owner.** **One pure `hitToCitation(hit: Hit, provider: 'local'|'hippo'): Citation`** co-located in `src/memory/types.ts`. `Hit.text → Citation.snippet`; `Citation.provider` comes from **provider identity** (passed in), NOT `Hit.source`; `path/startLine/endLine/score/symbol` copy through; `gml = deriveGmlMeta(hit.path)`. Used by `search.ts`, `graph.ts`, `temporal.ts`, **and** agent answer assembly. A test asserts the mapping is total.
- **[medium] `config.scope: string` vs `Scope` object.** **Single conversion point:** `cli.ts`/agent wiring calls `makeScope(config.scope)`. `config.scope` may contain a `::` sub-scope matching `scopeKey`'s `${repo}::${sub}` format; `makeScope` splits on the first `::`. String↔Scope only ever happens via `makeScope`/`scopeKey`.
- **[medium] 3-file type cycle safety.** **Move `ToolError` and `defineTool` OUT of `src/types.ts`** into `src/tool-error.ts` (runtime-only). `src/types.ts` becomes **pure types** (erased at runtime) → it cannot participate in a runtime require cycle. `src/memory/types.ts` re-exports with `export type { Scope, Citation, SymbolRef }`. All edges into types are `import type`. A runtime import-order test imports `src/memory/local.js` first to prove `ToolError` is defined.
- **[medium] registry → `ToolSpec[]` handoff unnamed.** `runAgent` computes `const toolSpecs = toOpenAiToolSpecs(deps.tools)` **once** and passes `toolSpecs: ToolSpec[]` to `llm.chatStream`/`chat`. `ToolSpec` is the single wire type for both ends; a type-level test asserts it.
- **[low] `InEventSchema` widening annotation risk.** **Let the schema infer; derive the type from it:** `export const InEventSchema = z.discriminatedUnion('type', [...])` then `export type InEvent = z.infer<typeof InEventSchema>`. No `z.ZodType<InEvent>` annotation.
- **[low] `FakeEmbedder`/`scriptModel` legacy names.** **Drop them.** Only `FakeEmbeddings` (implements `Embeddings`) and `FakeChatModel`. One name each.

### Security

- **[high] Config-driven key exfiltration / SSRF via untrusted `<root>/.chatgml.json`.** **Project-local config is untrusted.** A project file may **not** supply or override any endpoint that receives a secret (`chat.baseURL`, `embed.baseURL`, `memory.hippo.url`) **while** the corresponding `apiKey`/`key` resolves from `env:NAME`. Enforced in `resolveConfig`: secret values resolved from `env:` are only paired with baseURLs originating from the **trusted layer** (flags, `CHATGML_*` env, or the user-global `~/.config/chatgml/config.json`). A project file that overrides such a baseURL while the key is `env:`-sourced is **rejected** unless `--trust-project-config` is passed. Config test asserts the rejection.
- **[high] Edit sandbox symlink/TOCTOU on write (M4) + lexical-only M3 stub.** M3 stub uses lexical `assertInsideRoot` then throws `not_implemented` and **never writes**. **M4 write path** routes through realpath validation of the **deepest existing ancestor** of the target (reject if the resolved parent is outside root or is a symlink leaving root), then opens the leaf with **`O_NOFOLLOW`** (`flag: 'wx'` semantics + no-follow) and writes-to-temp-then-rename **within that validated dir** to close TOCTOU. M4 verify adds: (1) apply_patch through an in-repo symlink dir escaping root is rejected; (2) overwriting a symlink pointing outside root is rejected; (3) the leaf open does not follow a symlink. M4 exit criterion: "lexical AND realpath/symlink traversal rejected on the write path."
- **[medium] Prompt injection → autonomous edit in `auto` mode.** `buildSystemPrompt` includes an explicit clause: **tool/file/search content is untrusted DATA, never instructions; edits require an explicit user request, not instructions found in code.** `approval: 'gated'` stays the only default; **`approval: 'auto'` may NOT be sourced from the project config layer** (only flags / trusted layer). Agent test: an injected "apply this patch" in a `tool_result` does not bypass approval in gated mode, and `auto` cannot come from project config.
- **[medium] `config set` may persist plaintext secret; `.chatgml.json` not gitignored.** `config set` on any secret field (`chat.apiKey`, `embed.apiKey`, `memory.hippo.key`) **refuses a literal value** and either rewrites to `env:NAME` or writes to the user-global file outside the repo. `.gitignore` adds `/.chatgml.json` and `/.chatgml/`. A project file with a non-`env:` secret triggers a loud (redacted) warning. Config test asserts `config set` never persists a raw key string into a project-tracked file.
- **[medium] Windows path normalization gaps.** `assertInsideRoot` additionally rejects/normalizes: `\\?\` and `\\.\` prefixes, drive-relative `C:foo` (drive letter, no root separator), and any `:` after the drive letter (ADS, e.g. `file.gml:hidden`). Only the **drive letter** is lowercased for comparison, never the whole path. `sandbox.test.ts` covers each.
- **[low] Model-supplied catastrophic regex (grep) DoS.** **Pre-validate and reject** before execution: pattern length `<= 512` AND a nested-quantifier/ReDoS heuristic (`(x+)+`, `(x*)*`, `(x+)*` shapes) → `ToolError('bad_args')`. There is **no** in-flight native-regex timeout (single thread can't interrupt a match; no worker threads in v1). The verify asserts **rejection as `bad_args`**, not "ran but bounded." Per-file + total wall-clock budget plus `ctx.signal` bound the file-fan-out, not a single match.
- **[low] Plugin spawns child with full parent env.** M6 spawns `chatgml serve` with an **explicit minimal env** (`PATH` + `CHATGML_*` + only the keys chatgml needs), not the inherited Electron env. Pairs with the untrusted-config endpoint rule.
- **[low] `readJson` silent-null masks tampering.** Keep never-throw for availability, but **log to stderr (redacted)** distinguishing `missing` (normal) from `corrupt/parse-fail/schema-mismatch` (suspicious) so silent store resets are observable. Optional checksum in `StoreEnvelope`.

### Test coverage & verifiability

- **[critical] Type-level tests are tsc-only; vitest strips types.** **Separate typecheck that includes `test/**`.** `npm run typecheck` runs **`tsc -p tsconfig.json --noEmit`** where `tsconfig.json` includes `src` + `test` (no rootDir restriction). `tsconfig.build.json` (src-only, emits) is used only by `npm run build`. M1 exit adds: a deliberately-broken `@ts-expect-error` in a throwaway type test makes `npm run typecheck` exit non-zero (one-time manual proof the gate is live).
- **[high] Coverage thresholds are global-aggregate.** **Set `coverage.thresholds.perFile: true`** so each included file independently clears `lines 80 / branches 75 / functions 80 / statements 80`. Pure-wiring entrypoints (`src/index.ts` barrel, `src/cli.ts`, `bin/`) are on the **exclude** list deliberately (per-file would be impractical for glue). The dynamic-import switch in `provider.ts` and indexer glue are written to be testable; if a line is genuinely unreachable it's excluded with an inline `/* v8 ignore next */` and a comment.
- **[high → re-scoped] GML collision-event fixture realism.** **`deriveGmlMeta` is pure/path-only** and for collision events sets **`collisionWithRaw`** = the raw token from the filename (a GUID on GMS2.3+, a name on legacy). It does **NOT** claim a resolved object name. Name resolution (GUID→object name) is an **fs-aware** pass in the indexer that reads `<obj>.yy` + the `.yyp` resource map — **deferred to M-later** (out of v1). v1 test asserts `Collision_<guid>.gml` → `collisionWithRaw: '<guid>'` (realistic fixture), and `Collision_obj_b.gml` (legacy) → `collisionWithRaw: 'obj_b'`. No production code resolves names from the path alone.
- **[high] `.yy`/`.yyp` parsing — trailing commas.** v1 is **path-only**; `deriveGmlMeta` classifies `.yy`/`.yyp` as `other` and never reads them. `readJson`/`persist.ts` stay **strict JSON** (store envelope only). When `.yy` reading lands (M-later, for collision/parent resolution), a dedicated **`parseYy(text)`** helper strips trailing commas (or uses a permissive parser); `.yy` never routes through strict `readJson`. v1 doc explicitly states object↔event/parent/collision relationships are NOT resolved.
- **[high] REPL TTY tests.** **Split:** (1) `EventRenderer.render` tested fully against an in-memory `Writable` with scripted events (exact-transcript assertion lives here). (2) `runChatRepl` loop tested via an **injected readline-like abstraction** (async line source + output `Writable` + abort hook) — driven by pushed lines and a manually-fired abort, NOT a TTY; asserts approve/reject dispatch + exit codes against a `FakeAgent`. (3) "SIGINT aborts but promise pending" is a **manual smoke note**, not an automated vitest assertion.
- **[medium] serve cancel test racy.** `FakeAgent` exposes a **test-controlled `release()` gate** between an early token and the answer. Test: send `user`, await first token, send `cancel`, assert the run's `AbortSignal` fired and no further events emitted before release. Deterministic.
- **[medium] `assertNoAuthLeak` strength.** Use a distinctive sentinel `sk-SENTINEL-DEADBEEF` for every test key. Spy on `console.{log,info,warn,error,debug}` **and** `process.stdout.write` **and** `process.stderr.write`; assert the sentinel appears in none. Stringify the **full** thrown error including `.cause` and `.stack`. For `redact`, assert `JSON.stringify(redactedConfig)` excludes the sentinel entirely. These surfaces are named in the `mock-fetch.ts` helper spec.
- **[medium] indexer mtime granularity.** Change detection is driven by **`hashContent` (sha256) as the source of truth**; `mtimeMs`+size is only a fast-path hint to skip re-hashing. Indexer verify adds: "content change with identical mtime is still re-embedded (hash wins)."
- **[medium] symlink test needs privilege on Windows.** `sandbox.test.ts` attempts `fs.symlink` in try/catch; on `EPERM`/`EACCES` it `it.skip`s with a logged reason (never silently passes). **CI matrix adds `ubuntu-latest`** for at least one leg so the symlink-escape branch is genuinely exercised. Sandbox verify: "symlink-escape branch exercised on at least one CI OS."
- **[medium] grep ReDoS assertion.** Pinned to the verifiable contract: grep **rejects** over-length / nested-quantifier patterns as `bad_args` **before** execution (assert with a normal-sized input). No claim of timing-out an in-flight match. In-flight regex interruption is explicitly **out of scope** for v1.
- **[medium] provider-contract negative control has no home.** Export both `runProviderContract(name, factory)` **and** `assertContractFails(factory)` (runs the suite programmatically, asserts it throws/fails). `test/helpers/provider-contract.test.ts` GREEN-asserts `assertContractFails(dropUpsertStub)` and `assertContractFails(doubleInsertStub)`. The negative control never pollutes CI red.
- **[low] plugin panel/diff DOM only manual.** Extract approval-correlation + event→state transitions into pure functions (`reducePluginState(event, state)`, `matchApproval(approval_request, pendingProposals)`) and unit-test those headless; only pixel layout is manual. M6 verify updated.
- **[low] docs transcript drift.** The worked transcript is a real fixture file `test/fixtures/agent-api-transcript.ndjson`; `serve.test.ts` asserts against it AND a doc-lint test parses the fenced NDJSON block out of `agent-api.md` and deep-equals it to the fixture. "docs match fixture" is now green/red.
- **[low] plugin name `show-codebase` not `design`.** Corrected: M6 renames **`show-codebase` → `chatgml`** (config.json `name`, script filenames, plugin dir). Confirm the GMEdit loader keys off the folder/config name before renaming.
- **[low] provider never-branch double-claim.** Provider verify states the runtime never-branch is tested by calling `createMemoryProvider({provider:'bogus'} as any, ...)` and asserting a typed throw; the compile-time exhaustiveness is a separate `@ts-expect-error` case. They verify different things.

### GameMaker / GMEdit domain

- **[critical] collision events** — see [high] resolution above (`collisionWithRaw`, fs-aware resolution deferred).
- **[high] `.yy`/`.yyp` trailing commas** — see resolution above (`parseYy` later; v1 path-only; strict `readJson` untouched).
- **[high] plugin binary on PATH.** M6 `NdjsonClient` resolves the binary in order: (1) configured absolute path, (2) `CHATGML_BIN` env, (3) PATH fallback — and on win32 the PATH fallback resolves the **absolute** path to the `.cmd`/`.exe` itself (probe `%APPDATA%/npm/chatgml.cmd`) and spawns that with `shell:false`. Test covers "binary not on PATH → clear actionable error."
- **[medium] GMEdit project dir.** `projectDir = e.project.dir` (the directory), explicitly **not** `e.project.path` (the `.yyp` file). Launch is disabled / shows "Open a project first" when no project is open.
- **[medium] GML event-number table accuracy.** `GML_EVENT_TABLE` is built from GMEdit's **own** authoritative eventType/eventNum→label map (lifted), including Draw `67` (Draw End), `68`/`69` (Draw GUI Begin/End); the async `Other_*` subrange is verified against that table. Unknown numbers → `displayName: 'Draw (event N)'` rather than dropped. Fixtures lock Draw `0/64/66/67/68/69/72/73` + async `Other_*`.
- **[medium] GML resource taxonomy.** `deriveGmlMeta` recognizes room creation code (`rooms/<room>/RoomCreationCode.gml`) and per-instance creation code (`InstanceCreationCode_<guid>.gml`) as their own meta kinds. Scripts stay file-level `script` meta; `chunk.ts` detects top-level `function NAME(` boundaries so 2.3 multi-function scripts get symbol-level citations. Fixtures added for RoomCreationCode + InstanceCreationCode.
- **[low] GMEdit runtime feasibility** — confirmed (Electron/NW.js + Node integration; symlink into `%APPDATA%/AceGM/GMEdit/plugins`). Caveat resolved: `NdjsonClient` feeds **raw** stdout chunks into `NdjsonDecoder.push()` (no per-chunk `.trim()`), uses streaming UTF-8 decode so multibyte splits aren't corrupted, and routes `child.stderr` to log only.
- **[low] GM noise excludes.** Concrete fallback `EXCLUDE_DIRS`/extensions: node-style dirs + GameMaker output (`*.yyz`, `datafiles/` binaries, build/tmp dirs), plus `vector_store/` (legacy ChatGML store) and `.chatgml/`. A files.test.ts fixture shaped like a GM project asserts resource dirs walked, build/datafiles noise skipped.

### Hippo integration realism (M5 re-scope)

- **[critical] hippo has NO HTTP write route.** hippo `serve.zig` exposes only read/GET routes + `POST /api/recall` + `POST /api/config`. `store`/`ingest`/`fs_history` are CLI/MCP-only. **Decision: in v1, hippo is a READ provider over HTTP** (`search`/`graphNeighbors` only). `upsert`/`remember` are **no-ops on the hippo path with a local shadow** (the local provider's notes/changelog back `remember`/`recall`/`temporalQuery` even when `memory.provider=hippo`, i.e. a hybrid). `runProviderContract` is parameterized with a **capability set**; the hippo case asserts only the read capabilities. Open question #2 is **promoted to a resolved decision**, not deferred.
- **[critical] hippo temporal has no HTTP route / wrong subsystem.** `temporalQuery` on the hippo path is served by the **local changelog** (hybrid), not hippo. Documented capability gap; `temporalQuery` is an **optional** contract capability.
- **[critical] hippo has no scope/profile.** Multi-repo isolation = **one `hippo serve` per repo on a distinct `--dir`/port**; `config.memory.hippo.url` is per-scope and `createMemoryProvider` keys the URL by scope. "profile" is abandoned (doesn't exist). Read-side cross-scope filtering is best-effort topic-substring only and documented as lossy. Open question #3 resolved as "separate `--dir` stores."
- **[high] recall has no `path` field.** Only set `Citation.path` when the node kind is `code_file`/`code_symbol` **and** the topic parses as a repo-relative path (validate). For other kinds set `snippet`/`score`/`provider:'hippo'` and leave `path` undefined. **`Citation.path` is therefore optional** (already optional on `Hit`; made optional on `Citation` too — see types). Memory recall (non-file) routes through `recall()`/`SessionNote`, not `search()`/`Hit`. Never fabricate file paths from arbitrary topics.
- **[high] rerank flags are a no-op on POST /api/recall.** The adapter uses **`GET /api/recall`** (query-param) so `ppr/hyde/rerank/spread` take effect; URL-encode the query and mind length limits. Document that `hyde=true`/`rerank=true` incur server-side LLM latency (hippo's own chat lane). Test asserts GET-with-flags is used and POST-with-ppr is **not**.
- **[medium] graphNeighbors via /api/walk.** Feasible. Two-step: `recall(ref.name)` → resolve to a numeric node id (prefer a `code_symbol`/`code_file` hit whose topic exactly matches `ref.path`/`ref.name`; bail to `[]` if ambiguous) → `GET /api/walk?from=<id>&depth=2`. Map to `Hit{source:'graph', text: topic}`; document that `walk` returns no content/path (optional second `/api/node/{id}` fetch if full text wanted). Ambiguous-name test added.
- **[medium] transport decision.** v1 hippo transport = **HTTP for read only**. Writes/temporal are local-shadowed. No MCP/CLI spawn in v1. `runProviderContract('hippo', ..., {capabilities})` asserts only what HTTP read supports.
- **[high] hippo HTTP is unauthenticated localhost.** `memory.hippo.key` is **dropped as required/meaningful** (kept optional for a future authenticated proxy). `connect()` pings `GET /api/stats`, asserts `{ok:true}`, sends no auth. The adapter **never** calls `POST /api/config`. Risk register corrected: hippo is trusted local loopback (127.0.0.1), stated in docs.
- **[low] recall not chunk-addressable.** hippo hits use `Hit.chunkId = 'hippo:node:' + id`; `startLine`/`endLine` undefined (already optional). `search.ts`/read flows tolerate citations without line ranges; `docs/agent-api.md` notes granularity differs by provider.

---

## 3. Full File Tree

```
package.json
package-lock.json                         # committed lockfile
tsconfig.json                             # src + test, no emit (typecheck gate)
tsconfig.build.json                       # extends, rootDir src, excludes test, emits
vitest.config.ts
.oxlintrc.json
.prettierrc
.prettierignore
.nvmrc                                    # 25
.gitignore                                # EXTEND (add /node_modules /dist /coverage /.chatgml/ /.chatgml.json *.tsbuildinfo)
DEVELOPMENT.md                            # EXTEND (NodeNext .js-extension convention; exactOptionalPropertyTypes OFF rationale)

bin/
  chatgml.mjs                             # shebang shim -> src/cli main()

src/
  types.ts                                # THE single shared type vocabulary (PURE TYPES, no runtime)
  tool-error.ts                           # runtime ToolError class + defineTool (moved out of types.ts to break runtime cycle)
  config.ts                               # ONE DEFAULTS, resolveConfig, untrusted-project-config guard, redact, resolveSecret
  index.ts                                # public barrel re-exports
  llm.ts                                  # OpenAI-compatible chat over global fetch; SSE parser; tool-call assembly
  agent.ts                               # runAgent loop, ApprovalGate, buildSystemPrompt, AgentLike adapter
  protocol.ts                            # NDJSON framing; InEventSchema; NdjsonDecoder class; encodeEvent
  serve.ts                               # NDJSON stdio transport over AgentLike
  cli.ts                                 # commander program, subcommands, CliDeps injection, main(argv)
  cli/
    repl.ts                              # EventRenderer + runChatRepl (injected line source)
    theme.ts                             # supportsColor, styles, Spinner, diffLine
  index/
    files.ts                             # buildIgnoreFilter (built ONCE), walkFiles, EXCLUDE_DIRS, gml re-export
    chunk.ts                             # hashContent, chunkText, chunkFile, function-boundary detection
    gml.ts                               # GML_EVENT_TABLE (GMEdit-authoritative), deriveGmlMeta (pure, collisionWithRaw)
    embeddings.ts                        # Embeddings iface; FakeEmbeddings; OpenAIEmbeddings (separate embed lane)
    indexer.ts                           # incremental driver + manifest (hash-first, mtime hint)
  memory/
    types.ts                             # Chunk/Hit/TemporalQuery/TemporalChange/SessionNote; scopeKey/makeScope; hitToCitation; type re-exports
    provider.ts                          # MemoryProvider iface; MemoryProviderInput; createMemoryProvider (dynamic import)
    persist.ts                           # f32<->base64, writeJsonAtomic, readJson (redacted suspicious-warning)
    bm25.ts                              # Bm25Index, code-aware tokenize
    fusion.ts                            # cosineSim, fuse (minmax|rrf)
    local.ts                             # LocalMemoryProvider (JSON store, idempotent upsert)
    hippo.ts                             # HippoMemoryProvider (READ over HTTP GET; local-shadow writes/temporal)   [M5]
  tools/
    types.ts                             # re-exports ToolDef/ToolContext/ApprovalRequest/ToolError/OpenAiToolSpec/defineTool/ToolRegistry + IgnoreFilter
    sandbox.ts                           # assertInsideRoot/resolveInsideRoot (Windows-hardened), SandboxError, toPosix
    glob.ts
    grep.ts                              # ReDoS pre-reject, no child_process
    read.ts
    search.ts
    graph.ts
    temporal.ts
    edit.ts                              # M3 STUB (gated, never writes); M4 real applyUnifiedDiff
    reindex.ts                           # wraps indexer for the agent
    index.ts                             # buildToolRegistry, toOpenAiToolSpecs (zod-to-json-schema), dispatchTool

test/
  setup.ts                               # env snapshot/restore; default fetch stub THROWS
  fixtures/
    agent-api-transcript.ndjson          # shared by serve.test.ts AND agent-api.md doc-lint
  helpers/
    mock-fetch.ts                        # installFetchMock, FetchRecorder, assertNoAuthLeak (sentinel + all surfaces), sse/json/openai responders
    fakes.ts                             # hashVector, FakeEmbeddings, FakeChatModel, makeTmpRepo
    provider-contract.ts                 # runProviderContract(name,factory,{capabilities}) + assertContractFails
    fake-agent.ts                        # FakeAgent with release() gate (serve + cli tests)
    fake-line-source.ts                  # injected readline-like abstraction for repl tests
  types.test.ts
  config.test.ts
  llm.sse.test.ts
  llm.client.test.ts
  protocol.test.ts
  agent.approval.test.ts
  agent.loop.test.ts
  serve.test.ts
  theme.test.ts
  repl.test.ts
  cli.test.ts
  index.barrel.test.ts
  docs.conformance.test.ts               # parses agent-api.md NDJSON block, deep-equals fixture
  runtime-cycle.test.ts                  # imports memory/local.js first; ToolError defined
  index/
    chunk.test.ts
    files.test.ts
    gml.test.ts
    embeddings.test.ts
    indexer.test.ts
  memory/
    types.test.ts
    persist.test.ts
    bm25.test.ts
    fusion.test.ts
    local.test.ts
    hippo.test.ts                        [M5]
    provider.test.ts
  helpers/
    provider-contract.test.ts            # green-asserts assertContractFails(badStubs)
  tools/
    types.test.ts
    sandbox.test.ts
    glob.test.ts
    grep.test.ts
    read.test.ts
    search-graph-temporal.test.ts
    edit.test.ts
    registry.test.ts

.github/workflows/
  ci.yml                                 # matrix: os [windows-latest, ubuntu-latest] x node [24.x, 25.x]
  python-publish.yml                     # NEUTRALIZE to workflow_dispatch only (DO NOT delete)

docs/
  agent-api.md                           # stable NDJSON integration contract (transcript references the fixture)

plugin/                                  # M6 (design-spec authored in M3; impl in M6)
  README.md                              # design + class signatures + event->UI table
  config.json                            # rename show-codebase -> chatgml (M6)
  client.js                              # NdjsonClient (spawn chatgml serve; binary resolution; raw-chunk decode)
  panel.js                               # ChatPanel
  diff-view.js                           # EditProposalView (approve/reject by id)
  config-bridge.js                       # binary path + scope in Preferences
  state.js                               # reducePluginState / matchApproval (pure, unit-tested)

# UNTOUCHED (Python tree — recoverable, never deleted):
talk_codebase/  poetry.lock  setup.py  pyproject.toml  yaml_config.py  config.yaml
talk_codebase_config.yaml  requirements.txt  README.md (rewritten in M7)
plugin/show-codebase.js  plugin/plugin-button.js  plugin/js-yaml.min.js  plugin/style.css  (until M6 renames/replaces)
```

---

## 4. Shared Types (defined exactly once)

### `src/types.ts` — pure types only (no runtime, no zod, no imports except `import type`)

```ts
// src/types.ts — THE single shared type vocabulary. Pure types only (erased at runtime).
import type { ZodType } from 'zod';
import type { GmlMeta } from './index/gml.js';
import type { MemoryProvider } from './memory/provider.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

// OpenAI wire shape; arguments is a JSON STRING (the agent parses it).
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string; // required when role === 'tool'
  name?: string;
}

// What we send in request.tools[].
export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export type OpenAiToolSpec = ToolSpec;

// ONE canonical Scope (the memory lens's {repoId} is renamed to {repo}).
export interface Scope {
  repo: string;
  sub?: string;
}

// Canonical home (avoids a memory<->types cycle); re-exported (type-only) from src/memory/types.ts.
export interface SymbolRef {
  name: string;
  path: string;
  kind?: 'function' | 'class' | 'method' | 'struct' | 'enum' | 'object' | 'event';
}

// THE single source-ref type (frontends' Source merged in). `path` is OPTIONAL because
// hippo memory nodes have no file path (audit: hippo recall has no path field).
export interface Citation {
  path?: string;
  startLine?: number;
  endLine?: number;
  snippet?: string;
  score?: number;
  provider?: 'local' | 'hippo';
  symbol?: SymbolRef;
  gml?: GmlMeta;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

// THE single outbound NDJSON union.
export type AgentEvent =
  | { type: 'status'; phase: 'ready' | 'thinking' | 'indexing' | 'idle' | 'done' | 'cancelled'; detail?: string; protocolVersion?: number }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; content: string; citations?: Citation[] }
  | { type: 'edit_proposal'; id: string; path: string; diff: string }
  | { type: 'approval_request'; id: string; kind: 'edit'; path: string }
  | { type: 'answer'; text: string; sources: Citation[]; usage?: Usage }
  | { type: 'error'; message: string; code?: string };

// ONE approval request shape used by BOTH ToolContext and ApprovalGate.
export interface ApprovalRequest {
  id: string;
  kind: 'edit';
  path: string;
  diff: string;
}

// ToolErrorCode is a type (the ToolError CLASS lives in src/tool-error.ts to keep this file runtime-free).
export type ToolErrorCode =
  | 'sandbox_escape' | 'not_found' | 'too_large' | 'binary'
  | 'bad_args' | 'not_implemented' | 'provider_error' | 'aborted';

export interface ToolResult {
  content: string;
  citations?: Citation[];
  isError?: boolean;
}

export interface ToolContext {
  readonly root: string;
  readonly scope: Scope;
  readonly memory: MemoryProvider;
  readonly approval: 'gated' | 'auto';
  readonly ignore: IgnoreFilter;
  readonly signal: AbortSignal;
  emit(event: AgentEvent): void;
  requestApproval(req: ApprovalRequest): Promise<boolean>;
  log(level: 'debug' | 'info' | 'warn', msg: string, meta?: Record<string, unknown>): void;
}

// The ONE tool contract. execute ALWAYS returns ToolResult (no generic R).
export interface ToolDef<A> {
  readonly name: string;
  readonly description: string;
  readonly schema: ZodType<A>;
  readonly kind: 'read' | 'gated';
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}
export type Tool = ToolDef<unknown>;
export type ToolRegistry = ReadonlyMap<string, Tool>;

// IgnoreFilter is co-located in src/index/files.ts; re-declared as a type here to avoid a runtime edge.
export interface IgnoreFilter {
  ignores(repoRelPosixPath: string): boolean;
}

// ---- Config types (single home; src/config.ts imports these, does not redeclare) ----
export interface ChatLane {
  baseURL: string;
  apiKey?: string;
  model: string;
  temperature: number;
  maxTokens?: number;
}
export interface EmbedLane {
  baseURL: string;
  apiKey?: string;
  model: string;
  batchSize: number;
}
// ONE discriminated union for memory config (audit: declared exactly once, here).
export type MemoryConfig =
  | { provider: 'local' }
  | { provider: 'hippo'; url: string; key?: string };

export interface Config {
  chat: ChatLane;
  embed: EmbedLane;
  memory: MemoryConfig;
  scope: string; // converted to Scope via makeScope at the wiring seam
  approval: 'gated' | 'auto';
  index: { chunkSize: number; chunkOverlap: number; root: string };
}
```

### `src/tool-error.ts` — runtime helpers moved out of `types.ts`

```ts
// src/tool-error.ts — runtime-only (a class + a function), so src/types.ts stays purely erasable.
import type { ToolDef, ToolErrorCode } from './types.js';

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

// Identity helper that preserves the literal type of a tool definition.
export function defineTool<A>(def: ToolDef<A>): ToolDef<A> {
  return def;
}
```

### `src/index/gml.ts` — GmlMeta (imported type-only by types.ts)

```ts
// src/index/gml.ts (type portion). Discriminated union; built from GMEdit's authoritative event table.
export type GmlEventType =
  | 'Create' | 'Destroy' | 'Cleanup' | 'Step' | 'Alarm' | 'Draw'
  | 'Collision' | 'Mouse' | 'Key' | 'Other' | 'Async' | 'Gesture';

export type GmlMeta =
  | GmlEventMeta
  | GmlScriptMeta
  | GmlShaderMeta
  | GmlRoomCreationMeta
  | GmlInstanceCreationMeta
  | GmlOtherResourceMeta;

export interface GmlEventMeta {
  kind: 'event';
  resource: 'object';
  object: string;
  eventType: GmlEventType;
  eventNumber: number;
  collisionWithRaw?: string; // raw token (GUID on GMS2.3+, name on legacy); NOT a resolved object name
  displayName: string;
}
export interface GmlScriptMeta { kind: 'script'; resource: 'script'; script: string; }
export interface GmlShaderMeta { kind: 'shader'; resource: 'shader'; shader: string; stage: 'vertex' | 'fragment' | 'unknown'; }
export interface GmlRoomCreationMeta { kind: 'room_creation'; resource: 'room'; room: string; }
export interface GmlInstanceCreationMeta { kind: 'instance_creation'; resource: 'room'; room: string; instanceGuid: string; }
export interface GmlOtherResourceMeta { kind: 'other'; resource: 'room' | 'sequence' | 'timeline' | 'note' | 'unknown'; name: string; }
```

### `src/memory/types.ts` — retrieval domain (re-exports, never redeclares)

```ts
// src/memory/types.ts
export type { Scope, Citation, SymbolRef } from '../types.js'; // type-only re-export
import type { Scope, Citation, SymbolRef } from '../types.js';
import type { GmlMeta } from '../index/gml.js';

export type EmbedVector = Float32Array;

export interface Chunk {
  id: string; // `${path}#${startLine}-${endLine}`
  path: string;
  text: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  symbol?: SymbolRef;
  lang?: string;
  vector?: Float32Array;
}

export interface Hit {
  chunkId: string;
  path?: string; // optional: hippo memory nodes have no path
  text: string;
  score: number;
  source: 'vector' | 'keyword' | 'fused' | 'graph' | 'temporal' | 'hippo';
  startLine?: number;
  endLine?: number;
  symbol?: SymbolRef;
  extra?: Record<string, unknown>;
}

export interface TemporalQuery {
  path?: string;
  symbol?: SymbolRef;
  since?: number;
  until?: number;
  kind: 'history' | 'changed-since' | 'at-time';
  limit?: number;
}

export interface TemporalChange {
  path: string;
  contentHash: string;
  previousHash?: string;
  timestamp: number;
  changeKind: 'added' | 'modified' | 'unchanged' | 'deleted';
}

export interface SessionNote {
  id: string;
  text: string;
  topic?: string;
  createdAt: number;
  tags?: string[];
  importance?: number;
}

export function scopeKey(scope: Scope): string {
  return scope.sub ? `${scope.repo}::${scope.sub}` : scope.repo;
}
export function makeScope(raw: string): Scope {
  const i = raw.indexOf('::');
  return i === -1 ? { repo: raw } : { repo: raw.slice(0, i), sub: raw.slice(i + 2) };
}

// THE single Hit->Citation mapping. provider comes from provider identity, NOT Hit.source.
// gml is filled by the caller-provided deriveGmlMeta to avoid an import cycle into index/.
export function hitToCitation(
  hit: Hit,
  provider: 'local' | 'hippo',
  deriveGmlMeta: (p: string) => GmlMeta | undefined,
): Citation {
  const c: Citation = { snippet: hit.text, score: hit.score, provider };
  if (hit.path !== undefined) {
    c.path = hit.path;
    const gml = deriveGmlMeta(hit.path);
    if (gml) c.gml = gml;
  }
  if (hit.startLine !== undefined) c.startLine = hit.startLine;
  if (hit.endLine !== undefined) c.endLine = hit.endLine;
  if (hit.symbol !== undefined) c.symbol = hit.symbol;
  return c;
}
```

### `src/index/embeddings.ts` — single `Embeddings` interface

```ts
export interface Embeddings {
  readonly dim: number;
  readonly id: string; // e.g. `${baseURLHost}:${model}` — persisted to detect stale stores
  embed(texts: string[]): Promise<Float32Array[]>;
}
export interface EmbeddingsConfig {
  baseURL: string;
  apiKey?: string;
  model: string;
  dim?: number;
  batchSize?: number; // default 64
}
```

### `src/memory/provider.ts` — single `MemoryProvider` seam

```ts
import type { Config } from '../types.js';
import type { Embeddings } from '../index/embeddings.js';
import type { Chunk, Hit, SymbolRef, TemporalQuery, SessionNote } from './types.js';
import type { Scope } from '../types.js';

export interface MemoryProvider {
  readonly id: 'local' | 'hippo';
  readonly capabilities: ReadonlySet<'upsert' | 'search' | 'graph' | 'temporal' | 'remember' | 'recall'>;
  upsert(chunks: Chunk[], scope: Scope): Promise<void>;
  search(query: string, opts: { k: number; scope: Scope }): Promise<Hit[]>;
  graphNeighbors(ref: SymbolRef, scope: Scope): Promise<Hit[]>;
  temporalQuery(q: TemporalQuery, scope: Scope): Promise<Hit[]>;
  remember(note: SessionNote, scope: Scope): Promise<void>;
  recall(query: string, scope: Scope): Promise<SessionNote[]>;
  close?(): Promise<void>;
}

export interface MemoryDeps { embeddings: Embeddings; }
// audit: provider input declared ONCE; root is explicit, not an ad-hoc intersection at the call site.
export type MemoryProviderInput = Config['memory'] & { root: string };

export function createMemoryProvider(cfg: MemoryProviderInput, deps: MemoryDeps): Promise<MemoryProvider>;
```

### `src/llm.ts` — client surface

```ts
import type { ChatMessage, ToolSpec, Usage, ChatLane } from './types.js';

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}
export type StreamDelta =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; index: number; id?: string; name?: string; argsFragment?: string }
  | { kind: 'finish'; reason: string; usage?: Usage };
export interface ChatResult { message: ChatMessage; finishReason: string; usage?: Usage; }

export class LlmClient {
  constructor(lane: ChatLane);
  chat(req: ChatRequest): Promise<ChatResult>;
  chatStream(req: ChatRequest): AsyncGenerator<StreamDelta, ChatResult, void>;
}
export class LlmError extends Error {
  status?: number;
  code: 'http' | 'network' | 'parse' | 'aborted' | 'config';
  body?: string; // truncated 2KB, key-scrubbed
}
```

### `src/agent.ts` — agent + approval + serve seam

```ts
import type { AgentEvent, ChatMessage, Citation, Config, ToolRegistry, ApprovalRequest } from './types.js';
import type { LlmClient } from './llm.js';
import type { MemoryProvider } from './memory/provider.js';
import type { InEvent } from './protocol.js';

export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<boolean>;
  resolve(id: string, approved: boolean): void;
}
export function createApprovalGate(opts: { autoApprove: boolean; emit(e: AgentEvent): void }): ApprovalGate;

export interface AgentDeps {
  llm: LlmClient;
  tools: ToolRegistry;
  config: Config;
  memory: MemoryProvider;
  emit(event: AgentEvent): void;
  approvals: ApprovalGate;
  signal?: AbortSignal;
}
export interface AgentOptions { history?: ChatMessage[]; maxSteps?: number; systemPrompt?: string; }
export const DEFAULT_MAX_STEPS = 16;

export function runAgent(
  userText: string, deps: AgentDeps, opts?: AgentOptions,
): Promise<{ message: ChatMessage; history: ChatMessage[]; sources: Citation[] }>;
export function buildSystemPrompt(config: Config): string;

// serve seam: control-surfaced so approve/reject/cancel reach the in-flight run.
export interface AgentLike {
  run(command: InEvent, signal: AbortSignal): AsyncIterable<AgentEvent>; // user | reindex only
  resolveApproval(id: string, approved: boolean): void;
  cancel(): void;
}
export function createAgentLike(deps: Omit<AgentDeps, 'emit' | 'signal'> & { config: Config }): AgentLike;
```

### `src/protocol.ts` — NDJSON codec

```ts
import { z } from 'zod';
import type { AgentEvent } from './types.js';

export const PROTOCOL_VERSION = 1 as const;

export const InEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), text: z.string() }),
  z.object({ type: z.literal('approve'), id: z.string() }),
  z.object({ type: z.literal('reject'), id: z.string() }),
  z.object({ type: z.literal('reindex') }),
  z.object({ type: z.literal('cancel') }),
]);
export type InEvent = z.infer<typeof InEventSchema>;
export type ClientCommand = InEvent;
export const ClientCommandSchema = InEventSchema;

export function encodeEvent(e: AgentEvent): string; // JSON.stringify(e) + '\n'
export class NdjsonDecoder {
  push(chunk: string | Buffer): unknown[]; // buffers trailing partial across calls; skips blank lines
  flush(): unknown[];
}
export function writeEvent(out: NodeJS.WritableStream, e: AgentEvent): void;
export function isAgentEvent(x: unknown): x is AgentEvent;
export class ProtocolError extends Error {
  constructor(message: string, readonly line: string);
}
```

### `src/tools/sandbox.ts` + `src/index/files.ts` — sandbox & ignore

```ts
// src/tools/sandbox.ts
export function assertInsideRoot(root: string, candidate: string): string; // lexical, fs-free; Windows-hardened
export function resolveInsideRoot(root: string, candidate: string): Promise<string>; // realpath + re-check
export function isInsideRoot(root: string, absPath: string): boolean;
export function toPosix(p: string): string;
export class SandboxError extends Error {
  constructor(readonly candidate: string, readonly reason: 'escape' | 'absolute' | 'unc' | 'symlink-escape' | 'device' | 'drive-relative' | 'ads');
}

// src/index/files.ts
export interface IgnoreFilter { ignores(repoRelPosixPath: string): boolean; }
export function buildIgnoreFilter(root: string): Promise<IgnoreFilter>; // reads all .gitignore ONCE
export function walkFiles(root: string, isIgnored: (rel: string) => boolean): AsyncIterable<{ absPath: string; relPath: string }>;
export const EXCLUDE_DIRS: readonly string[]; // node_modules,.git,build,dist,vector_store,.chatgml + GM noise
```

### `src/config.ts` — config surface (types imported from `types.ts`)

```ts
import type { Config, ChatLane, EmbedLane, MemoryConfig } from './types.js';
export type { Config, ChatLane, EmbedLane, MemoryConfig };

export const DEFAULTS: {
  chat: { temperature: 0.2 };
  embed: { batchSize: 64 };
  memory: { provider: 'local' };
  approval: 'gated';
  index: { chunkSize: 1500; chunkOverlap: 200 };
}; // the ONE defaults object

export class ConfigError extends Error {} // messages reference field PATHS, never values

export function resolveConfig(args: {
  root: string;
  flags: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  cwdConfigPath?: string;
  trustProjectConfig?: boolean; // --trust-project-config
}): Config;
export function loadConfigFile(root: string): { value: unknown; path: string; trusted: boolean } | null;
export function configFilePaths(root: string): string[];
export function redact(config: Config): unknown; // masks apiKey/key
export function resolveSecret(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined; // env:NAME
```

---

## 5. npm Dependencies (pinned)

Runtime:

| package | version | purpose |
|---|---|---|
| `zod` | `^3.25.76` | schema validation; tool-arg parsing; config parse. **Stays on 3.x** so `zod-to-json-schema` introspection works. |
| `commander` | `^14.0.1` | CLI. (14 satisfies node>=24; avoids commander 15 churn.) |
| `ignore` | `^7.0.5` | `.gitignore` matching. |
| `fast-glob` | `^3.3.3` | glob tool + walking. |
| `zod-to-json-schema` | `^3.24.6` | tool param JSON Schema (paired with zod 3.x; strip `$schema`). |
| `diff` | `^7.0.0` | unified-diff apply (M4 only; pinned now). |

Dev:

| package | version | purpose |
|---|---|---|
| `typescript` | `~5.7.3` | compiler. **Pinned off 6.x** for predictable strict flags. |
| `@types/node` | `^24.7.0` | node typings (matched to engines floor). |
| `vitest` | `^3.2.4` | test runner (3.x: stable coverage thresholds API; `perFile` supported). |
| `@vitest/coverage-v8` | `^3.2.4` | coverage. |
| `tsx` | `^4.20.3` | `npm run dev` (run TS directly). |
| `oxlint` | `^1.0.0` | lint (`--max-warnings 0`). |
| `prettier` | `^3.4.2` | format. |

**No** `node-fetch`, `undici`, `openai`, `langchain`, `faiss`, `fire`, `js-yaml`. M7 CI asserts their absence. Commit `package-lock.json`.

`package.json` scripts:

```json
{
  "type": "module",
  "engines": { "node": ">=24" },
  "bin": { "chatgml": "dist/cli.js" },
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "coverage": "vitest run --coverage",
    "lint": "oxlint --max-warnings 0 .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "dev": "tsx src/cli.ts",
    "ci": "npm run typecheck && npm run lint && npm run build && npm run coverage"
  }
}
```

`tsconfig.json` key fields: `module/moduleResolution: "NodeNext"`, `target: "ES2023"`, `lib: ["ES2023"]`, `types: ["node"]`, `strict: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`, `isolatedModules: true`, **`exactOptionalPropertyTypes: false`**, `declaration: true`, `incremental: true`, `outDir: "dist"`, `include: ["src", "test"]`, `noEmit: true`. `tsconfig.build.json` extends it with `rootDir: "src"`, `include: ["src"]`, `noEmit: false`, `exclude: ["test"]`.

---

## 6. NDJSON Protocol Spec

**Framing.** One JSON object per line, terminated by `\n`, UTF-8. **stdout carries protocol JSON only**; all diagnostics/banners go to **stderr**. `serve.test.ts` asserts the output stream contains nothing but valid JSON lines.

**Handshake.** On start, the server writes exactly one `status` event first:
`{"type":"status","phase":"ready","protocolVersion":1}`.

**Inbound — `ClientCommand` / `InEvent`** (validated by `InEventSchema`; invalid → server emits an `error` event and continues, never crashes):

| command | shape | server action |
|---|---|---|
| user | `{type:'user', text}` | start a fresh `AbortController`, iterate `agent.run({type:'user',text}, signal)`, stream every event |
| reindex | `{type:'reindex'}` | iterate `agent.run({type:'reindex'}, signal)` (emits `status:indexing` … `status:done`) |
| approve | `{type:'approve', id}` | `agent.resolveApproval(id, true)` — out-of-band, resolves the in-flight gate (NOT a new run) |
| reject | `{type:'reject', id}` | `agent.resolveApproval(id, false)` |
| cancel | `{type:'cancel'}` | `agent.cancel()` — aborts the in-flight run's signal |

**Outbound — `AgentEvent`** (the single union in `src/types.ts`):

| event | shape | meaning |
|---|---|---|
| status | `{type:'status', phase, detail?, protocolVersion?}` | lifecycle: `ready\|thinking\|indexing\|idle\|done\|cancelled` |
| token | `{type:'token', text}` | streamed assistant text delta |
| tool_call | `{type:'tool_call', id, name, args}` | a tool is about to run (`args` = parsed JSON) |
| tool_result | `{type:'tool_result', id, name, ok, content, citations?}` | tool finished (`ok:false` on `ToolError`) |
| edit_proposal | `{type:'edit_proposal', id, path, diff}` | a gated edit's diff (id correlates with approval) |
| approval_request | `{type:'approval_request', id, kind:'edit', path}` | client must reply `approve`/`reject` with this id |
| answer | `{type:'answer', text, sources, usage?}` | final assistant answer + citations |
| error | `{type:'error', message, code?}` | recoverable error; session survives |

**Correlation.** The `id` in `edit_proposal`, `approval_request`, and the client's `approve`/`reject` is the **same** `sha1(path + '\0' + diff)` minted by the agent. `resolveApproval(id)` settles the pending `ApprovalGate`. A disconnect or `cancel` settles all pending approvals as **rejected** (no hung turn).

**Worked transcript** (kept in `test/fixtures/agent-api-transcript.ndjson`; doc-lint asserts `agent-api.md` matches it):

```
{"type":"status","phase":"ready","protocolVersion":1}
{"type":"status","phase":"thinking"}
{"type":"tool_call","id":"t1","name":"glob","args":{"pattern":"objects/**/*.gml"}}
{"type":"tool_result","id":"t1","name":"glob","ok":true,"content":"3 files"}
{"type":"token","text":"I'll update the "}
{"type":"token","text":"Step event."}
{"type":"edit_proposal","id":"e9a1","path":"objects/obj_player/Step_0.gml","diff":"--- a\n+++ b\n@@ -1 +1 @@\n-hp -= 1;\n+hp -= dmg;\n"}
{"type":"approval_request","id":"e9a1","kind":"edit","path":"objects/obj_player/Step_0.gml"}
{"type":"answer","text":"Proposed an edit to the player Step event.","sources":[{"path":"objects/obj_player/Step_0.gml","provider":"local"}]}
```

(After this fixture, the client replies `{"type":"approve","id":"e9a1"}`; in M3 the stub responds with a `tool_result` `not_implemented`, in M4 the file is written.)

**Errors.** A malformed inbound line → one `error` event, loop continues. An `LlmError` mid-turn → one `error` event, the session survives.

---

## 7. Memory Provider Seam & Hippo Realism

`createMemoryProvider(input, deps)` switches on `input.provider` with **dynamic `import('./local.js')` / `import('./hippo.js')`** (selecting one never loads the other). Both implement `MemoryProvider` and advertise a `capabilities` set.

**LocalMemoryProvider (v1, M2).** JSON store under `<root>/.chatgml/` per `scopeKey`: `vectors.json` (`base64`-`Float32`), `bm25.json`, `changelog.json`, `notes.json`. `upsert` is **idempotent on `(scope, chunkId)`**. `search` = embed query → cosine + bm25 → `fuse` → `Hit[]`. `graphNeighbors` = heuristic same-file + name-reference (`source:'graph'`, documented best-effort). `temporalQuery` filters the changelog. `remember`/`recall` = BM25 over notes. Persists `embeddings.id` + `dim`; on open, mismatch → stale → rebuild empty. Capabilities: all six.

**HippoMemoryProvider (M5, READ-only over HTTP).** Per audit, hippo's HTTP API is read + `POST /api/recall` + `POST /api/config` only; writes/temporal/scope are CLI/MCP-only and there is no auth (127.0.0.1 trusted loopback). Therefore:

- `connect()` pings `GET /api/stats`, asserts `{ok:true}`, sends no auth, never calls `POST /api/config`.
- `search` → **`GET /api/recall`** (query-param, URL-encoded) with `ppr/hyde/rerank/spread` flags chosen by query heuristic (POST is avoided — its `ppr` is a no-op). Map results with `hitToCitation(_, 'hippo', deriveGmlMeta)`; set `Citation.path` only for `code_file`/`code_symbol` nodes whose topic parses as a repo-relative path. `Hit.chunkId = 'hippo:node:' + id`; no line ranges.
- `graphNeighbors` → `recall(ref.name)` → resolve a numeric node id (exact-topic match or bail to `[]`) → `GET /api/walk?from=<id>&depth=2`. `source:'graph'`, `text = topic`.
- `temporalQuery`, `upsert`, `remember`/`recall` → **local-shadowed** (a co-resident `LocalMemoryProvider` over `<root>/.chatgml/` backs writes/notes/changelog). Capabilities advertised: `search`, `graph` (hippo) + `temporal`, `remember`, `recall`, `upsert` (local shadow).
- Multi-repo isolation = one `hippo serve` per repo on a distinct `url`/`--dir`; `config.memory.hippo.url` is per-scope. No "profile" concept.

**Contract test.** `runProviderContract(name, factory, { capabilities })` runs only the asserted capabilities. Local asserts all; hippo asserts the read set against a scripted `fetch` mock (GET-with-flags used, POST-with-ppr not used, `{ok:false}` → typed error, key absent from all logged/thrown strings).

---

## 8. Security Model

1. **Secrets never logged.** `resolveSecret` resolves `env:NAME` → `process.env`. `redact()` masks `apiKey`/`key` in any logged `Config`. `LlmError`/`EmbeddingError` store only a **truncated, key-scrubbed** body referencing status + endpoint. `ConfigError` messages reference field **paths**, never values. Tests use the sentinel `sk-SENTINEL-DEADBEEF` and assert it appears in **none** of: `console.*`, `process.stdout.write`, `process.stderr.write`, thrown `.message`/`.cause`/`.stack`, `JSON.stringify(redact(config))`.
2. **Untrusted project config.** `<root>/.chatgml.json` may not supply/override a secret-bearing endpoint (`chat.baseURL`, `embed.baseURL`, `memory.hippo.url`) while the matching key resolves from `env:` — rejected unless `--trust-project-config`. `approval:'auto'` may not be sourced from the project layer. `config set` on a secret field refuses a literal value (rewrites to `env:NAME` or writes the user-global file). `.chatgml.json` is gitignored.
3. **FS sandbox (one chokepoint).** Every fs tool routes through `sandbox.ts`. `assertInsideRoot` (lexical) rejects `../`-escape, absolute-outside, UNC `//server`, `\\?\`/`\\.\` device prefixes, drive-relative `C:foo`, and ADS `:` after the drive letter; only the drive letter is lowercased for comparison. `read` and the M4 write path additionally use `resolveInsideRoot` (realpath of the deepest existing ancestor + re-check) and `O_NOFOLLOW` at the leaf to defeat symlink + TOCTOU escapes. The symlink-escape branch runs on `ubuntu-latest` in CI.
4. **Prompt-injection.** `buildSystemPrompt` declares tool/file content untrusted data, not instructions; edits require explicit user intent. `approval:'gated'` is the default and is the sole edit guard; `auto` requires an explicit flag/trusted-layer opt-in. The only privileged action (`apply_patch`) is gated.
5. **No deserialization RCE.** base64-`Float32` + JSON (zod-validated config; `safeParse` tool args); dynamic `import()` of static paths only; no eval/pickle/native deser. `readJson` never throws but logs (redacted, to stderr) when a store is corrupt vs missing.
6. **DoS bounds.** grep pre-rejects over-length/nested-quantifier patterns (`bad_args`); glob `limit` 500 (cap 5000); per-file + total time budgets and `ctx.signal` bound fan-out; `read` size cap 1MB.
7. **Child-process env (M6).** The plugin spawns `chatgml serve` with an explicit minimal env (`PATH` + `CHATGML_*` + needed keys), `shell:false`, an absolutely-resolved binary path on win32.

---

## 9. Testing & Mocking Strategy

- **Runner.** vitest, `globals: false`, `pool: 'forks'` (process-per-file → isolates the shared global `fetch` and `process.env`). `restoreMocks/unstubGlobals/unstubEnvs: true`, `testTimeout: 10000`.
- **Two typechecks.** `npm run typecheck` compiles `src` **and** `test` (catches `expectTypeOf`/`@ts-expect-error` — vitest strips types and would green-pass a wrong type-test). `npm run build` uses the src-only `tsconfig.build.json`. M1 proves the gate is live by breaking a throwaway `@ts-expect-error` once.
- **Coverage.** v8, `thresholds.perFile: true` at lines/functions/statements 80, branches 75, over `src/**` **excluding** `src/index.ts`, `src/cli.ts`, `bin/`. Genuinely-unreachable lines get `/* v8 ignore */` with a reason. CI uploads coverage on the 25.x leg.
- **HTTP mocking.** `test/setup.ts` installs a default `globalThis.fetch` stub that **throws** so any unmocked network call fails loudly. `installFetchMock` (`vi.stubGlobal('fetch')`) routes by URL and records calls; `FetchRecorder.assertNoAuthLeak(sentinel)` checks all surfaces listed in §8. `sseResponse` builds a **real web `ReadableStream`** of `data: {..}\n\n` + `[DONE]`, splittable across enqueues, so the SSE buffering path is genuinely exercised.
- **Fakes.** `FakeEmbeddings` (sha256-seeded, L2-normalized, default dim 64, offline, never fetches), `FakeChatModel` (replays scripted assistant turns + tool calls), `makeTmpRepo(files,{gitignore})` under `os.tmpdir`, `FakeAgent` (with a `release()` gate for the deterministic serve-cancel test), `fake-line-source` (injected readline abstraction for REPL).
- **Provider contract.** `runProviderContract` + `assertContractFails`; the negative control (drop-upserts, double-insert) is GREEN-asserted in `provider-contract.test.ts`, never CI-red.
- **GameMaker realism.** GML fixtures use realistic filenames (`Collision_<guid>.gml`, `RoomCreationCode.gml`, `InstanceCreationCode_<guid>.gml`); the event table is locked by `displayName` fixtures lifted from GMEdit's map.
- **Docs conformance.** `docs.conformance.test.ts` deep-equals the NDJSON block in `agent-api.md` against the shared fixture.

---

## 10. Milestones & Ordered Tasks

Each task lists **files**, **tests**, and **exit criteria**. Every module is TDD (test first, then implement to green).

### M1 — Foundation (scaffold + shared types + config)

**Exit criteria:** `npm ci` installs clean; `tsc --showConfig` parses; `src/types.ts` declares every shared type exactly once (`Scope={repo,sub?}`, one `AgentEvent`, one `Citation` with optional `path`, one `ToolDef<A>` returning `ToolResult`, one `MemoryConfig` discriminated union); `ToolError`/`defineTool` live in `src/tool-error.ts` (types stays runtime-free); `npm run typecheck` compiles `src`+`test` green **and** a deliberately-broken `@ts-expect-error` makes it exit non-zero (one-time manual proof); config precedence flag>env>file>default with deep per-key merge, `env:NAME` secret resolution, redact, untrusted-project-config rejection; exactly one `DEFAULTS` export; fetch mock + fakes self-tested. Python tree untouched.

| # | task | files | tests | exit |
|---|---|---|---|---|
| 1.1 | Scaffold: `package.json` (type:module, engines node>=24, bin, exports, scripts), `tsconfig.json` (NodeNext+strict, `lib:["ES2023"]`, `types:["node"]`, exactOptionalPropertyTypes **off**, include src+test, noEmit), `tsconfig.build.json` (rootDir src, emits, excludes test), `.nvmrc`, extend `.gitignore`. Add `src/` alongside Python; do **not** delete Python. | package.json, tsconfig.json, tsconfig.build.json, .nvmrc, .gitignore | — | `npm ci` clean; `npx tsc -p tsconfig.json --showConfig` exits 0; `.gitignore` ignores `/.chatgml/`, `/.chatgml.json`, dist, coverage, node_modules, *.tsbuildinfo |
| 1.2 | `vitest.config.ts` (forks, perFile coverage 80/75, include src/** exclude index.ts+cli.ts+bin, restore/unstub all, timeout 10000) + `test/setup.ts` (env snapshot/restore; default fetch stub THROWS). | vitest.config.ts, test/setup.ts | trivial passing test | `vitest run` reports the trivial test passes; `npm run coverage` emits `coverage/`; an unmocked `fetch()` throws |
| 1.3 | Test seam helpers. | test/helpers/mock-fetch.ts, test/helpers/fakes.ts | self-tests inside each helper file's test | `installFetchMock` records a routed call; `sseResponse` round-trips chunks split mid-JSON; `hashVector` deterministic + unit-norm; `makeTmpRepo` creates+cleans; `assertNoAuthLeak` checks all §8 surfaces |
| 1.4 | `src/types.ts` (pure types) + `src/tool-error.ts` (ToolError + defineTool). | src/types.ts, src/tool-error.ts | test/types.test.ts | `expectTypeOf<AgentEvent>` exhaustively narrows by `type`; `role:'tool'` requires `tool_call_id` (`@ts-expect-error`); `MemoryConfig` discriminated; `npm run typecheck` green |
| 1.5 | `src/config.ts`: one `DEFAULTS`, `resolveConfig` deep-merge + `env:NAME` + untrusted-project-config guard + `--trust-project-config`, `loadConfigFile` (`<root>/.chatgml.json` then `~/.config/chatgml/config.json`), `redact`, `resolveSecret`, `ConfigError`. No `process.exit`. | src/config.ts | test/config.test.ts | flag>env>file>default per layer; `env:NAME` resolves; deep-merge keeps file's `chat.baseURL` when only `chat.model` overridden; missing `chat.baseURL` → `ConfigError` with a path, no key; `redact` excludes sentinel; approval defaults `gated`; **project file overriding `chat.baseURL` while key is `env:` is rejected without `--trust-project-config`**; `approval:'auto'` from project layer rejected; exactly one defaults export |

### M2 — Index + Memory (local provider, incremental)

**Exit criteria:** `LocalMemoryProvider` passes `runProviderContract` (offline, FakeEmbeddings, all capabilities); re-upsert idempotent; persistence pure JSON + base64-Float32 (no pickle/eval); incremental manifest (unchanged repo = 0 embed calls; edited file re-embedded alone; **content change with identical mtime still re-embedded — hash wins**; embedModel switch = full rebuild; deleted file purged + changelog); ignore filter built once; embeddings hit the separate embed lane with no key leak; GML metadata correct incl. `collisionWithRaw`, RoomCreationCode, InstanceCreationCode, GMEdit-accurate event table; `hitToCitation` total; negative provider-contract red-tested green.

| # | task | files | tests | exit |
|---|---|---|---|---|
| 2.1 | `src/index/chunk.ts`: `hashContent` (sha256), `chunkText` (line-aware overlap), `chunkFile` (stable ids), top-level `function NAME(` boundary detection for 2.3 scripts. | src/index/chunk.ts | test/index/chunk.test.ts | overlap lines repeat exactly; stable ids; empty→0, short→1; `hashContent` stable + 1-byte-sensitive; multi-function script yields per-function symbol boundaries |
| 2.2 | `src/memory/types.ts`: Chunk/Hit(path optional)/TemporalQuery/TemporalChange/SessionNote; `scopeKey`/`makeScope`; `hitToCitation`; type-only re-exports. | src/memory/types.ts | test/memory/types.test.ts | `scopeKey` round-trips; `makeScope('a::b')`→`{repo:'a',sub:'b'}`; `hitToCitation` total (no path → no Citation.path, provider from arg not source); no type cycle (tsc green) |
| 2.3 | `src/index/gml.ts`: GMEdit-authoritative `GML_EVENT_TABLE` (Draw 0/64/66/67/68/69/72/73, verified async Other_*), `deriveGmlMeta` pure (collisionWithRaw raw token; RoomCreationCode; InstanceCreationCode; scripts; shaders). | src/index/gml.ts | test/index/gml.test.ts | `Step_0`→Step 0; `Alarm_3`; `Collision_<guid>`→`collisionWithRaw:'<guid>'`; legacy `Collision_obj_b`→`'obj_b'`; `Other_10`→User Event 0; Draw 64/67/68/69 labels; `RoomCreationCode.gml`→room_creation; `InstanceCreationCode_<guid>`→instance_creation; `datafiles/readme.txt`→undefined |
| 2.4 | `src/index/files.ts`: `buildIgnoreFilter` (reads all .gitignore ONCE), `EXCLUDE_DIRS` (node + GM noise: `*.yyz`, datafiles, build/tmp, vector_store, .chatgml), `walkFiles` (symlink/loop safe). | src/index/files.ts | test/index/files.test.ts | `.gitignore 'build/'+'*.log'` honored, `src/a.gml` not; no-gitignore fallback; matcher built once (readFile spy == #gitignore files); GM-shaped fixture: resource dirs walked, datafiles/build skipped |
| 2.5 | `src/index/embeddings.ts`: `Embeddings` iface; `FakeEmbeddings` first; `OpenAIEmbeddings` (batched POST `${baseURL}/embeddings`, separate embed lane, Bearer iff apiKey, L2-normalize, preserve order, typed `EmbeddingError`). | src/index/embeddings.ts | test/index/embeddings.test.ts | Fake deterministic across instances, unit-norm, never fetches; OpenAI batches > batchSize, preserves order, hits `embed.baseURL` with `embed.model`+key, 500 → error with no key leak (sentinel) |
| 2.6 | `src/memory/persist.ts`: `f32ToBase64`/`base64ToF32` (bit-exact), `writeJsonAtomic`, `readJson` (null on missing/corrupt/schema-mismatch; redacted stderr warning distinguishing corrupt vs missing), `StoreEnvelope`. | src/memory/persist.ts | test/memory/persist.test.ts | base64 bit-exact incl NaN/Inf/-0; atomic write leaves no `.tmp`; readJson null on missing/corrupt/wrong-schema; corrupt logs a suspicious (redacted) warning; concurrent write+read never partial |
| 2.7 | `src/memory/bm25.ts` (code-aware tokenize, idempotent add/remove, k1=1.2 b=0.75, deterministic tie-break, to/fromJSON) + `src/memory/fusion.ts` (`cosineSim` dot, `fuse` minmax/rrf with zero guards). | src/memory/bm25.ts, src/memory/fusion.ts | test/memory/bm25.test.ts, test/memory/fusion.test.ts | tokenize splits camel/snake/punct; re-add no double tf; remove drops; cosine 1/0/-1, mismatch throws; fuse ranks both-strong above one-strong; single-element no NaN; rrf stable; respects k |
| 2.8 | `src/memory/provider.ts`: `MemoryProvider` iface (+ `capabilities`), `MemoryProviderInput` (declared once), `createMemoryProvider` (dynamic import switch). | src/memory/provider.ts | test/memory/provider.test.ts | local factory returns LocalProvider passing quick upsert/search; unknown provider is a compile error (`@ts-expect-error`) AND runtime throws for `{provider:'bogus'} as any` |
| 2.9 | `src/memory/local.ts`: `LocalMemoryProvider` over `<root>/.chatgml/` per scopeKey; idempotent upsert; cosine+bm25→fuse; graph heuristic; changelog temporal; notes remember/recall; stale-store rebuild on embeddings id/dim mismatch. | src/memory/local.ts | test/memory/local.test.ts | upsert→search returns chunk; re-upsert same id → count unchanged; two scopes isolated; changelog added→modified→unchanged; temporalQuery newest-first; remember/recall round-trip; survives reopen; corrupt vectors.json → rebuild empty |
| 2.10 | `src/index/indexer.ts` + `src/tools/reindex.ts`: manifest `<root>/.chatgml/manifest.json` (hash-first, mtime+size hint); skip unchanged; re-chunk/embed changed only; purge deleted + changelog; embedModel mismatch → full rebuild. | src/index/indexer.ts, src/tools/reindex.ts | test/index/indexer.test.ts | 2nd index of unchanged repo = 0 embed calls (spy); single edited file re-embedded alone; **content change with identical mtime still re-embedded**; embedModel switch forces rebuild; deleted file purged + changelog |
| 2.11 | `test/helpers/provider-contract.ts`: `runProviderContract(name,factory,{capabilities})` + `assertContractFails`. | test/helpers/provider-contract.ts, test/helpers/provider-contract.test.ts | provider-contract.test.ts | harness green against LocalProvider; `assertContractFails(dropUpsertStub)` and `assertContractFails(doubleInsertStub)` are GREEN (not CI-red) |

### M3 — Agent + Tools + CLI (the buildable v1)

**Exit criteria:** `chatgml index <dir>` builds the local index; `chatgml chat <dir>` runs a streaming read-only agent (glob/grep/read/search/graph/temporal) with citations and an approval-gated `apply_patch` STUB (never writes); `chatgml serve <dir>` speaks NDJSON (ready handshake, stdout protocol-only, malformed input survives, cancel aborts deterministically, approve/reject forwarded via `resolveApproval`); `chatgml config show` redacts keys (sentinel never appears); agent loop has a `maxSteps` guard, tool round-trips append `role:'tool'` matching `tool_call_id`, `LlmError` keeps the session alive; SSE parser handles mid-JSON splits + tool-call assembly by index; sandbox rejects `../`/absolute/UNC/device/drive-relative/ADS/symlink-escape (symlink leg on ubuntu); `node dist/cli.js --version` works; `npm run ci` green (typecheck incl test/ + lint + build + perFile coverage) on `[windows-latest, ubuntu-latest] x [24.x, 25.x]`; `docs/agent-api.md` transcript matches the fixture (doc-lint). No `node-fetch/undici/openai/langchain/faiss/fire` in deps. `python-publish.yml` neutralized.

| # | task | files | tests | exit |
|---|---|---|---|---|
| 3.1 | `src/llm.ts`: `parseSse` (line-buffered, strips `data:`, `[DONE]`, `\r\n`, mid-JSON splits, keep-alive blanks); per-chunk normalizer→`StreamDelta`; `assembleToolCalls` (key by index, first-seen id/name, args left as JSON string); `LlmClient.chat`/`chatStream`; `LlmError` (truncated, scrubbed body). | src/llm.ts | test/llm.sse.test.ts, test/llm.client.test.ts | SSE mid-JSON split across chunks, `\r\n`, `[DONE]`, keep-alive; `assembleToolCalls` interleaved-by-index correct, text-only→[]; stream text+finish; tool_calls round-trip; Auth iff apiKey; slash normalized; 503→`LlmError` http body redacted; abort→aborted; non-stream maps |
| 3.2 | `src/protocol.ts`: `PROTOCOL_VERSION`, `InEventSchema` (infer type), `encodeEvent`, `NdjsonDecoder` class (buffers partials, skips blanks, malformed → `ProtocolError`), `writeEvent`, `isAgentEvent`. | src/protocol.ts | test/protocol.test.ts | `encodeEvent` single `\n`-terminated line; decoder reassembles 3-chunk split + multiple-per-chunk + blank skip; malformed → `ProtocolError`, loop continues; `InEventSchema` rejects missing `text`/unknown `type`; `flush` trailing; `isAgentEvent` true round-trip |
| 3.3 | `src/tools/types.ts` (re-exports from types.ts + tool-error.ts + IgnoreFilter) + `src/tools/sandbox.ts` (Windows-hardened `assertInsideRoot`, `resolveInsideRoot` realpath, `SandboxError`, `toPosix`). | src/tools/types.ts, src/tools/sandbox.ts | test/tools/types.test.ts, test/tools/sandbox.test.ts | `defineTool` preserves name/kind; `ToolError` carries code+meta; accept nested/`./objects/...`; reject `../outside`/absolute `C:/Windows`/UNC/`\\?\`/`\\.\`/`C:foo`/`file.gml:hidden`; symlink-escape rejected (ubuntu leg; win32 `it.skip` on EPERM with reason); `assertInsideRoot` accepts new file under root; drive letter lowercased only |
| 3.4 | `src/tools/glob.ts` + `grep.ts` + `read.ts` (read-only, through sandbox + ignore + `deriveGmlMeta`; grep pre-rejects ReDoS/over-length, no child_process; read 1MB cap, binary sniff, 1-based window). | src/tools/glob.ts, src/tools/grep.ts, src/tools/read.ts | test/tools/glob.test.ts, grep.test.ts, read.test.ts | glob `**/*.gml` returns gml meta, ignored excluded/included, limit truncates, no out-of-root; grep literal+regex 1-based, binary skipped, maxMatches truncates, contextLines, **nested-quantifier/over-length pattern → `bad_args` before run**; read full+range+clamp, too_large, binary, `../`→sandbox_escape, endLine<startLine→bad_args |
| 3.5 | `src/tools/search.ts` + `graph.ts` + `temporal.ts` (thin adapters over `ctx.memory`; map via `hitToCitation`; provider throw → `provider_error`). | src/tools/search.ts, graph.ts, temporal.ts | test/tools/search-graph-temporal.test.ts | correct k/scope passed; Hit→result mapping incl gml on `.gml`; throwing provider → `provider_error`, no escape |
| 3.6 | `src/tools/edit.ts` (M3 STUB: `assertInsideRoot` then throw `not_implemented`, never writes; stable id `sha1(path\0diff)`) + `src/tools/index.ts` (`buildToolRegistry`, `toOpenAiToolSpecs` via zod-to-json-schema strip `$schema`+`additionalProperties:false`, `dispatchTool` safeParse→bad_args, signal→aborted, try/catch→`{ok}` envelope). | src/tools/edit.ts, src/tools/index.ts | test/tools/edit.test.ts, test/tools/registry.test.ts | edit kind gated; `../`→sandbox_escape; valid→not_implemented AND `fs.writeFile` NEVER called (spy); empty diff→bad_args; stable id; no-edit registry excludes apply_patch; `toOpenAiToolSpecs` emits `additionalProperties:false` + names match (verifies zod3+zod-to-json-schema produces non-empty schema); unknown→bad_args; malformed args→bad_args; abort→aborted; throwing tool caught `ok:false` |
| 3.7 | `src/agent.ts`: `createApprovalGate` (request emits edit_proposal+approval_request, stores pending, `resolve(id,bool)`; autoApprove sync; abort rejects pending); `buildSystemPrompt` (tools, approval policy, scope/root, cite-files, **untrusted-content clause**); `runAgent` loop (≤maxSteps, stream tokens, dispatch tools, append `role:'tool'`, recover from bad tool calls, `LlmError`→error event); `createAgentLike` (control surface). | src/agent.ts | test/agent.approval.test.ts, test/agent.loop.test.ts | gated stays pending until resolve; autoApprove sync true + emits edit_proposal; unknown-id no-op; abort settles rejected; `buildSystemPrompt` lists tools + approval mode + untrusted-content clause; no-tool→token+answer history; one tool round-trip role:'tool' matching id; two parallel tool_calls appended; unknown tool→error result continues; invalid JSON args→error result; maxSteps→error max_steps; LlmError→error event returns; **injected "apply this patch" in gated mode does not bypass approval** |
| 3.8 | `src/serve.ts`: `Transport`, `createStdioTransport`, `runServe(agent,opts)` (NdjsonDecoder over input; write `ready` first; validate `InEventSchema`; user/reindex→`run`; approve/reject→`resolveApproval`; cancel→`cancel`; stdout protocol-only; diagnostics→stderr; backpressure; EOF flush). | src/serve.ts | test/serve.test.ts | ready status first; user line→token..answer ordered valid JSON; malformed inbound→error event, loop survives; **cancel aborts long run deterministically (FakeAgent `release()` gate)**; approve forwarded via `resolveApproval`; EOF resolves; ONLY JSON on output; no stderr on output stream; sequence deep-equals `test/fixtures/agent-api-transcript.ndjson` |
| 3.9 | `src/cli/theme.ts` (supportsColor, styles, Spinner, diffLine) + `src/cli/repl.ts` (`EventRenderer` against a Writable; `runChatRepl` over an **injected line source**; pendingApproval y→approve else reject; exit/Ctrl-D→0; SIGINT aborts turn, REPL alive). | src/cli/theme.ts, src/cli/repl.ts | test/theme.test.ts, test/repl.test.ts | supportsColor true {isTTY}/false NO_COLOR/!tty, FORCE_COLOR overrides; styles(false) identity; diffLine classifies; **renderer exact transcript (color:false)**; color:true snapshot has SGR; approval y→approve n→reject (FakeAgent captures); exit→0; error renders+continues; (SIGINT abort = manual smoke note, not asserted) |
| 3.10 | `src/cli.ts` + `bin/chatgml.mjs` + `src/index.ts` barrel: commander program (global opts incl `--chat-base-url/--embed-base-url/...` `--approval` `--no-color` `--trust-project-config`), subcommands index/chat/serve/config (config show REDACTED, config set refuses literal secret), `CliDeps` injection, `main(argv)` returning exit codes (0/2 usage/3 config/1 other). | src/cli.ts, bin/chatgml.mjs, src/index.ts | test/cli.test.ts, test/index.barrel.test.ts | `chat .`→runChatRepl, `serve .`→runServe, `index .`→runIndex; `config show` redacted (sentinel never appears); `config set chat.apiKey sk-...`→refused/rewritten to env:; unknown→exit 2; `--no-color`→color:false; `--approval auto` reaches factory; `main` returns 0 ok / 3 on config throw; barrel smoke imports; `node dist/cli.js --version` after build |
| 3.11 | Quality/CI gate: `.github/workflows/ci.yml` (matrix os [windows-latest, ubuntu-latest] x node [24.x,25.x]; concurrency cancel; permissions contents:read; npm ci→typecheck→lint→build→coverage; upload coverage on 25.x), `.oxlintrc.json`, `.prettierrc`/`.prettierignore`. **Neutralize `python-publish.yml` to `workflow_dispatch` only.** Extend `DEVELOPMENT.md` (NodeNext `.js` convention; exactOptionalPropertyTypes off rationale). | .github/workflows/ci.yml, .oxlintrc.json, .prettierrc, .prettierignore, .github/workflows/python-publish.yml, DEVELOPMENT.md | (CI itself) | valid YAML; `npm run ci` green locally end-to-end; lint flags an intentional unused var (`--max-warnings 0` → exit 1); python-publish no longer triggers on push/PR; `node dist/cli.js --version` smoke in CI catches a missing-.js-extension import; symlink-escape branch exercised on ubuntu leg |
| 3.12 | `docs/agent-api.md` (spawn `chatgml serve <dir>`, framing, handshake, command/event catalogs, worked transcript referencing the fixture, approval+cancel semantics, secrets-never-in-events, minimal Node consumer) + `test/fixtures/agent-api-transcript.ndjson` + `test/docs.conformance.test.ts`. **END OF v1.** | docs/agent-api.md, test/fixtures/agent-api-transcript.ndjson, test/docs.conformance.test.ts | docs.conformance.test.ts, runtime-cycle.test.ts | doc-lint deep-equals the fenced NDJSON block to the fixture; `runtime-cycle.test.ts` imports `memory/local.js` first and proves `ToolError` is defined (no TDZ cycle) |

### M4 (later) — Edit tool real engine + approval round-trip

**Exit criteria:** `apply_patch` applies a unified diff **atomically inside the sandbox** only after approve; reject and gated-without-approval never write (`fs.writeFile` not called); `auto` mode writes; `approval_request`↔`approve` correlated by id end-to-end through serve and REPL; **lexical AND realpath/symlink traversal rejected on the write path** (O_NOFOLLOW leaf, deepest-existing-ancestor realpath check, TOCTOU window closed).

| task | files | tests |
|---|---|---|
| `src/tools/edit.ts` real `applyUnifiedDiff` via `diff`; wire gated round-trip (request→serve/REPL forward→`resolveApproval`→on approve write atomically inside sandbox, on reject no-op); auto-apply only when `config.approval==='auto'`; write path realpath-validates ancestor + `O_NOFOLLOW`. | src/tools/edit.ts | test/tools/edit.test.ts extended: approve writes exact diff result inside root; reject leaves file untouched (writeFile not called); gated default never auto-applies; auto writes; **apply_patch through an in-repo symlink dir escaping root rejected; overwriting a symlink leaving root rejected; leaf open does not follow symlink**; round-trip id correlates |

### M5 (later) — Hippo adapter (READ over HTTP, hybrid writes/temporal local-shadowed)

**Exit criteria:** `HippoMemoryProvider` passes `runProviderContract('hippo', ..., {capabilities})` for its read set (scripted fetch mock); wire mapping centralized in pure fns (`toRecallQuery/fromRecallResults/fromWalk`); `connect()` fail-fast on `/api/stats` down; no auth sent; `POST /api/config` never called; **`GET /api/recall` used with `ppr/hyde/rerank` flags, `POST` with ppr NOT used**; `Citation.path` set only for code nodes with path-shaped topics; `hippo:node:` chunkIds; writes/temporal local-shadowed; multi-repo via per-scope URL; `createMemoryProvider` switches local↔hippo via dynamic import; any hippo key absent from all logged/thrown strings.

| task | files | tests |
|---|---|---|
| `src/memory/hippo.ts` per §7 (HTTP read + local shadow). | src/memory/hippo.ts | test/memory/hippo.test.ts (stubbed fetch): recall→Hit[] with correct path only for code nodes, right GET flags per query class; `connect` throws on `/api/stats` 503; graphNeighbors recall-then-walk + ambiguous-name→[]; `{ok:false}`→typed error; `runProviderContract('hippo', {capabilities:read})` green |

### M6 (later) — GMEdit plugin modernization

**Exit criteria:** plugin spawns `chatgml serve <projectDir>` (`projectDir = e.project.dir`, not `.yyp`; binary resolved by config→`CHATGML_BIN`→absolute PATH `.cmd`/`.exe`; `shell:false`; minimal env); streams tokens into a read-only region; renders `tool_call` activity + `edit_proposal` diffs with Approve/Reject wired to `approve`/`reject` by id; NO python venv, NO git pull, NO `...END`/`RECREATE_VECTOR_STORE`; reads unified config; **approval-correlation + event→state reducer unit-tested headless** (`reducePluginState`, `matchApproval`); only visual layout manual; Launch disabled when no project open. Rename **`show-codebase` → `chatgml`**.

| task | files | tests |
|---|---|---|
| `plugin/client.js` (`NdjsonClient`: binary resolution, `spawn(...,{shell:false,env:minimal})`, raw-chunk `NdjsonDecoder.push` no `.trim()`, streaming UTF-8 decode, stderr→log), `plugin/panel.js` (`ChatPanel`), `plugin/diff-view.js` (`EditProposalView`), `plugin/config-bridge.js` (binary path + scope in Preferences), `plugin/state.js` (pure `reducePluginState`/`matchApproval`), rename `plugin/config.json` name→`chatgml`. | plugin/client.js, panel.js, diff-view.js, config-bridge.js, state.js, config.json | Node test: `NdjsonClient` against a fake `chatgml serve` script echoing scripted events — spawn args contain NO git/python; send/recv round-trips; binary-not-on-PATH→clear error; `state.js` reducer + `matchApproval` unit-tested against scripted AgentEvents; panel/diff visual layout manual |

### M7 (later) — Docs + polish

**Exit criteria:** README reflects TS install + JSON config (YAML→JSON migration documented, no js-yaml dep); coverage thresholds finalized; dep tree confirmed free of `node-fetch/undici/langchain/openai/faiss/fire/js-yaml`; Python tree confirmed recoverable (never deleted); `python-publish.yml` stays neutralized; `npm run ci` green.

| task | files |
|---|---|
| README rewrite (TS install, config JSON migration from YAML, CLI usage), migration notes (`.chatgml.json` supersedes YAML; no js-yaml), ratchet coverage if started informational, finalize lint rules, dep-tree assertion script. | README.md, docs migration notes |

---

## 11. Risk Register (carried + resolved)

| risk | mitigation |
|---|---|
| Cross-lens type drift | `src/types.ts` is the single home, built first; `memory/types.ts` re-exports type-only; `expectTypeOf`/`@ts-expect-error` compiled by the test-inclusive `typecheck`; exactly one `DEFAULTS` and one `MemoryConfig` enforced by tests. |
| `SymbolRef`/`GmlMeta` placement cycle | `SymbolRef` lives in `types.ts`, re-exported from `memory/types.ts`; `GmlMeta` in `gml.ts`, imported type-only by `types.ts`; `ToolError`/`defineTool` moved to `tool-error.ts` so `types.ts` is runtime-free → no require cycle (proven by `runtime-cycle.test.ts`). |
| Shared global `fetch`/`process.env` leakage | `pool:'forks'` + restore/unstub all + throwing default fetch stub; real web `ReadableStream` in `sseResponse`. |
| NodeNext `.js` extensions | caught at `typecheck` (TS2835); documented; `node dist/cli.js --version` CI smoke as backstop. |
| Streaming tool_call shape variance | `assembleToolCalls` keys by index, first-seen id/name sticky, never parses fragments; `chat()` non-stream fallback; fixtures for fragmented + single-chunk. |
| Secret leakage | `redact`/`resolveSecret`; truncated scrubbed error bodies; ConfigError paths-only; sentinel + multi-surface `assertNoAuthLeak`. **Plus** untrusted-project-config endpoint guard and `config set` literal-secret refusal. |
| stdout pollution in serve | stdout = protocol JSON only; diagnostics→stderr; asserted in `serve.test.ts`. |
| Approval state divergence | gating lives only in `agent.ts`; serve/REPL are pipes forwarding by id via `resolveApproval`; abort settles pending as rejected. |
| Coverage gate blocking scaffold | wiring entrypoints excluded; `perFile` on logic modules; ratchet from informational on the scaffold PR. |
| Plugin scope creep | M6 is design-spec only during v1; impl deferred; headless reducer tests for correlation logic. |
| Whole-store atomic rewrite O(n) | write once per upsert batch; base64-Float32 compact; `persist.ts` isolated as the swap point for SQLite/incremental later. |
| Config format migration | JSON only, no js-yaml; documented in M7; `config path` prints resolved file. |
| Never delete anything | Python tree + `python-publish.yml` kept; the latter neutralized to `workflow_dispatch`. |
| Hippo capability mismatch | M5 re-scoped to HTTP read; writes/temporal local-shadowed; `runProviderContract` capability-parameterized; transport decision fixed (no MCP/CLI spawn in v1). |

---

## 12. Resolved Open Questions

1. **Embed lane fallback** — `embed` has its own block; if omitted, it falls back to `chat`'s `baseURL`/`apiKey` but **requires its own `model`** (a separate `embed.model` is mandatory). Enforced in `ConfigSchema`; covered by `config.test.ts`.
2. **Hippo writes** — **resolved:** no HTTP write route exists; hippo is READ-only in v1; writes local-shadowed.
3. **Hippo scope isolation** — **resolved:** separate `--dir` stores, per-scope URL; no profile concept.
4. **approve/reject/cancel modeling** — **resolved:** out-of-band control calls (`resolveApproval`/`cancel`), correlated by id; NOT new runs.
5. **AgentLike shape** — **resolved:** `run` per `user`/`reindex` command + explicit `resolveApproval`/`cancel` control surface.

---

## 13. Execution Notes

- Work on `agentic-rewrite`; commit per task (test → impl → green → commit).
- After M3, `npm run ci` must be green on all four matrix legs before declaring v1.
- Never delete the Python tree; keep `python-publish.yml` neutralized.
- This plan file is committed standalone in the first commit; implementation commits follow per task.
