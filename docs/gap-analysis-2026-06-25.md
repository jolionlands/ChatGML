# ChatGML Dogfooding Gap Analysis — 2026-06-25

Branch `agentic-rewrite` (HEAD `9529764`). M1–M7 + fs-aware GML enrichment complete,
506 tests green, `npm run ci` GREEN. This report synthesizes the dogfooding findings
into one deduplicated, severity-ranked list and splits them into **fixable-now**
(clear bounded defects with a known fix) and **deferred / needs-decision**
(design, feature, or ambiguous-policy items).

All claims below were re-verified against the shipped `dist/` and the source on
`agentic-rewrite`; the live repros that were rerun are noted inline.

---

## Summary

- **Total distinct gaps:** 22 (after deduping the raw 32 findings — see "Dedup notes").
- **Fixable now:** 16 bounded defects with a clear fix.
- **Deferred / needs-decision:** 6 (relevance scoring, GM multi-collision resolution,
  embeddings-store identity, graph name-only ranking, ReDoS heuristic completeness,
  config-set targeting).
- **The single most consequential cluster** is *index-target validation + empty-index
  silence*: the most common real first run (typo a path, or point at a fresh
  GameMaker project that has no `.gml` yet) produces a green "success" that silently
  does the wrong thing.
- **Real-model retrieval quality was not assessed** — every search/graph repro ran
  against a stub embedder. See the final section.

### Dedup notes

The raw findings contained three descriptions of the **nonexistent-directory index**
defect (high), two of the **empty/zero-result index silence** (high/medium), and two
of the **index-a-file ENOTDIR** defect (low/medium). These are collapsed to one entry
each below. The "binary content embedded verbatim" finding is **real and distinct**
from the binary handling in `read_file`/`grep` (which both already NUL-sniff): the
*indexer* (`src/index/indexer.ts:146`) reads `utf8` with no sniff.

---

## What works (verified)

- `npm run ci` is green; 506 tests pass.
- **Sandbox** is robust for the canonical attacks: `read_file` cleanly rejects `../`,
  absolute, UNC, device, drive-relative, and ADS paths, and realpaths the deepest
  existing ancestor to defeat symlink escapes (`src/tools/sandbox.ts`). `read_file`
  and `grep` both NUL-sniff and skip binary files.
- **Incremental indexing** is correct: hash-first change detection, unchanged repo on
  a second pass = 0 embed calls, deleted files purged. Verified a fixed-port stub
  re-run reports all files `unchanged`.
- **GML enrichment** is fully graceful: any `.yyp`/parse/ref failure falls back to
  path-only meta and never throws; single-collision objects resolve `collisionWith`
  correctly; parent inheritance resolves via `parentObjectId`.
- **Config secret hygiene on the write path**: `config set` refuses a literal secret
  (exit 2) and the user-global file is the only thing ever written, so no raw key is
  written into a repo-tracked file by the tool itself.
- **`main()` exit-code contract**: 0 ok / 2 usage / 3 config / 1 other, never calls
  `process.exit`, fully unit-testable.

---

## Fixable-now gaps (with repro + fix)

### F1 — Indexing a non-existent directory "succeeds" (exit 0) and creates a stray store — HIGH
**Area:** index CLI / target validation. **Files:** `src/cli.ts:114` (`cmdIndex`),
`src/index/run-index.ts:23`, `src/index/indexer.ts:177`.
**Repro (rerun live, confirmed):**
```
node dist/cli.js --chat-base-url http://127.0.0.1:1/v1 --chat-model m \
  --embed-base-url http://127.0.0.1:1/v1 --embed-model e --scope s \
  index <path/that/does/not/exist>
# -> "indexed: 0 added, 0 modified, 0 unchanged, 0 deleted"  exit 0
# -> the path now EXISTS and contains a .chatgml/ store
```
The atomic manifest write does `mkdir -p` on `<root>/.chatgml`, which brings the
typo'd path into existence. A user who mistypes the project path gets a green
"success", an empty index, and a junk directory, with no signal anything was wrong.
**Fix:** in `cmdIndex` (or `runIndexCommand`), `fs.stat(root)` up front; if it does
not exist or is not a directory, write a clear error to stderr
(`index: <dir> is not an existing directory`) and return a non-zero exit
(EXIT_USAGE=2) **before** any store is created.

### F2 — Indexing a *file* path leaks a raw `ENOTDIR: ... mkdir` error — MEDIUM
**Area:** index CLI / target validation. **Same call site as F1.**
**Repro:** `node dist/cli.js ... index "BLANK GAME.yyp"`
→ `error: ENOTDIR: not a directory, mkdir 'C:\...\BLANK GAME.yyp'` (exit 1).
The internal store-mkdir leaks as the user-facing message.
**Fix:** the same up-front `fs.stat` guard from F1 — if `root` is a file, error with
`index: <path> is a file, expected a directory` and a usage exit code.
*(F1 and F2 are one stat-the-root guard; implement together.)*

### F3 — Empty / zero-result index gives no signal (fresh GameMaker project indexes 0 files silently) — HIGH
**Area:** index UX / GameMaker domain. **File:** `src/cli.ts:120` (`cmdIndex`),
`IndexResult.scanned` exists but is never surfaced.
**Repro:** index a fresh GameMaker project (only `.yyp` + `.yy`, zero `.gml`), an
empty dir, or a dir of only `.py`/`.yaml`:
→ `indexed: 0 added, 0 modified, 0 unchanged, 0 deleted` (exit 0) — *identical* to
re-indexing an unchanged repo. `.yy`/`.yyp` are excluded by design; with no `.gml`
the store is empty and subsequent `chat`/`serve` retrieves from nothing (observed:
`serve` answered with `SOURCES:[]` yet emitted a confident answer).
**Fix:** in `cmdIndex`, when `result.scanned === 0` (or added+modified+unchanged === 0),
print a warning to stderr naming the indexed extensions and, when a `.yyp` is present
but no `.gml` was found, a GameMaker-specific hint. Include `result.scanned` in the
normal output line. Consider also: this is why `.py`/`.yaml` projects index nothing —
they are simply absent from `DEFAULT_INDEX_EXTENSIONS` (`src/index/files.ts:69`);
either document the indexed set or extend it.

### F4 — Chunker emits a zero-length chunk (and embeds it) when a >chunkSize line is followed by a trailing newline — HIGH
**Area:** chunking. **File:** `src/index/chunk.ts:37` (`chunkText`), `chunkFile`.
**Repro (rerun live, confirmed):**
```
node --input-type=module -e "import {chunkFile} from './dist/index/chunk.js'; \
  console.log(chunkFile('test.ts','a'.repeat(3000)+'\n').map(c=>[c.id,c.text.length]))"
# -> [ [ 'test.ts#1-1', 3000 ], [ 'test.ts#2-2', 0 ] ]
```
The `text.trim()===''` guard only covers whole-empty input; after a `>chunkSize`
line, forward-progress sets `start` onto the empty trailing line, which becomes its
own chunk. `chunkFile` gives it a real id and the sha256 of `''`
(`e3b0c44...`); `local` upsert then sends `input:['']` to `/v1/embeddings`.
**Fix:** drop raw chunks whose text is empty/whitespace-only — either in `chunkText`
(skip a final `{text:''}` window) or in `chunkFile` (filter `rc.text.trim()===''`).
Defensively also drop empty-string inputs in the embeddings/local upsert path so no
provider ever receives `input:''`.

### F5 — Huge/minified single-line files become one >200KB chunk that overflows real embedding token limits — MEDIUM
**Area:** chunking. **File:** `src/index/chunk.ts` (line-aware, never splits within a line).
**Repro:** a 200KB single-line minified `.json`/`.js`/`.css` produces exactly one
chunk of 200,009 chars → one embedding. Real OpenAI-compatible embedders cap ~8K
tokens (~32KB) and will truncate or 400 the request; even if accepted it is a useless
mega-vector. The code comment already admits "a single long line may exceed this" but
never bounds it.
**Fix:** add a hard character cap per chunk: when a single line exceeds `chunkSize`,
split it on a character boundary into `chunkSize`-sized pieces. Optionally
short-circuit files above a max-bytes threshold with a warning.

### F6 — Binary / NUL-byte content under an indexed extension is embedded verbatim (indexer has no binary sniff) — LOW
**Area:** indexing / file filtering. **File:** `src/index/indexer.ts:146`
(`fsp.readFile(file.absPath,'utf8')` — no sniff, unlike `read.ts`/`grep.ts`).
**Repro:** a `.txt`/`.json`/`.md`/`.gml` that actually contains NUL bytes is read as
utf8 and embedded; the stored chunk text contains ` `.
**Fix:** after reading, do the same cheap NUL-byte sniff already used by `read`/`grep`
(first ~8KB) and skip the file with a debug note. This also guards the
chunker/embedder against junk.

### F7 — The tool indexes its own project-local config `.chatgml.json` — LOW
**Area:** indexing / file filtering. **File:** `src/index/files.ts:25` (`EXCLUDE_DIRS`
excludes the `.chatgml/` dir but not the sibling `.chatgml.json`).
**Repro:** create `<dir>/.chatgml.json`, then index `<dir>` — the config file (a
`.json`) is walked and embedded as a chunk, polluting the retrieval corpus.
**Fix:** exclude `.chatgml.json` (and any other ChatGML-owned dotfiles) in
`walkFiles`, mirroring the `.chatgml/` directory exclusion.

### F8 — `read_file`/`glob` cite GML metadata WITHOUT the enrichment sidecar (collisionWith/parentObject missing exactly where the agent looks) — MEDIUM
**Area:** GML enrichment / tool consistency. **Files:** `src/tools/read.ts:13,93` and
`src/tools/glob.ts:13,60` import the path-only `deriveGmlMeta`, whereas
`search.ts`, `graph.ts`, `temporal.ts` use `gmlDeriverForRoot(ctx.root)`.
**Repro:** `read_file` an object collision event — `citation.gml` carries the raw GUID
(`collisionWithRaw`) but NOT the resolved `collisionWith`/`parentObject`, even though
`gml-enrich.json` exists. `read_file` is the most valuable place to surface "this
collision event targets obj_enemy", yet it is one of the two tools that skip it.
**Fix:** swap `deriveGmlMeta` → `gmlDeriverForRoot(ctx.root)` in `read.ts` and
`glob.ts` so every citation surface uses the enriched deriver consistently.

### F9 — `glob` with a `..` pattern that resolves back into root crashes with opaque `provider_error` instead of a clean sandbox rejection — HIGH
**Area:** tools/glob. **File:** `src/tools/glob.ts:52-53`.
**Repro (rerun live, confirmed):** against a root whose dir name is `gmproj`,
`glob({pattern:'../gmproj/objects/**/*.gml'})` (or `'../src/**/*.ts'` against `src`)
→ `ok=false code=provider_error 'tool glob failed'`. fast-glob returns
`'../gmproj/objects/...'` (the `..` lands back inside root because the dir name is in
the pattern); `isInsideRoot()` lexically passes it; then `ctx.ignore.ignores(rel)`
THROWS `path should be a 'path.relative()'d string, but got "../gmproj/..."` and the
throw is swallowed into the generic message. Contrast `read_file`, which gives a clean
`sandbox_escape`. (Inconsistent: `glob({pattern:'../*'})` instead silently returns "no
files matched".)
**Fix:** in `glob.ts`, before calling `ctx.ignore.ignores(rel)`, normalize/skip any
match whose POSIX form starts with `../` or is absolute (treat as outside-root), or
wrap `ignore.ignores` in try/catch treating a throw as out-of-sandbox → skip. This
returns clean filtered results instead of `provider_error`.

### F10 — `read_file` cannot read a windowed line range of any file >1MB — MEDIUM
**Area:** tools/read. **File:** `src/tools/read.ts:57` (`stat.size > MAX_BYTES`
checked on full file size BEFORE any line-window slicing).
**Repro:** `read_file({path:'HUGE.md', startLine:1, endLine:3})` on a 1.44MB file →
`too_large 'file exceeds 1048576 bytes'`. Large logs / generated GML / big JSON
resource files are entirely unreadable even when the agent wants only a small window.
**Fix:** when `startLine`/`endLine` are provided, stream the file (line-by-line or a
window-bounded byte budget) and cap only the RETURNED slice, not the whole file.

### F11 — Inconsistent file-size caps: `read_file` 1MB vs `grep` 2MB (greppable-but-unreadable dead-end) — MEDIUM
**Area:** tools/read+grep. **Files:** `src/tools/read.ts:15` (`MAX_BYTES=1MB`),
`src/tools/grep.ts:18` (`MAX_FILE_BYTES=2MB`) — confirmed.
**Repro:** on a 1.44MB file, `grep` cites `HUGE.md:1` but a follow-up `read_file` of
that exact path fails `too_large` — the agent gets a citation it cannot open.
**Fix:** unify the cap (share a single `MAX_FILE_BYTES` constant), or make `read`'s
cap apply only to whole-file reads while allowing windowed reads above it (folds into
F10).

### F12 — `temporal_query` citations put a raw epoch-ms timestamp in `Citation.score` — MEDIUM
**Area:** memory/citations. **Files:** `src/tools/temporal.ts:46`,
`src/memory/types.ts` (`hitToCitation` copies `hit.score` verbatim; temporal sets
`hit.score = e.timestamp`).
**Repro:** a temporal citation = `{score: 1782422357447 (epoch ms), startLine:
undefined, endLine: undefined}`. The same `Citation.score` field is 0.5 for search
hits and 1 for graph hits — three incompatible meanings. A frontend sorting/
thresholding `answer.sources` by score will mis-rank temporal entries (a 2026
timestamp dwarfs every 0–1 relevance score), and `formatHits` even prints
`(score 1782422357447.000)` to the model.
**Fix:** do not reuse `Citation.score` for a timestamp. Surface the timestamp in a
dedicated field (e.g. `changedAt`) or omit score for temporal hits, and give temporal
a dedicated formatter (ISO date + change kind) instead of printing the epoch as a
"score".

### F13 — `--approval <invalid>` is silently ignored (falls back to `gated`), unlike `config set approval` which errors — MEDIUM
**Area:** CLI / flags / security UX. **Files:** `src/cli.ts:274` (option has no
`.choices()`), `layerFromFlags` in `src/config.ts` (accepts only literal
`'gated'|'auto'`, drops anything else).
**Repro:** `node dist/cli.js --approval BOGUS ... config show .` → exit 0, no stderr,
config shows `approval: 'gated'`. `--approval Auto`/`--approval gate` typos silently
downgrade to gated for a security-relevant flag. Contrast `config set approval bogus`
which correctly errors (exit 3).
**Fix:** add `.choices(['gated','auto'])` on the `--approval` option (or validate in
`layerFromFlags`) so an unrecognized value is a usage error (exit 2).

### F14 — A literal plaintext secret in a project `.chatgml.json` is accepted with no warning — MEDIUM
**Area:** config / security UX. **File:** `src/config.ts:340`
(`void fileTouched; // reserved for future redacted diagnostics` — the planned warning
was never implemented).
**Repro:** put `chat.apiKey: "sk-LITERAL..."` in `<dir>/.chatgml.json`, then
`config show <dir>` → exit 0, no stderr warning. The key is consumed (redacted in
display, good) but the on-disk repo-tracked file holds the raw key. `config set`
refuses literal secrets, but a hand-written/committed literal in the untrusted project
file passes through silently. The implementation plan explicitly called for "a loud
(redacted) warning" here.
**Fix:** when the loaded layer is the untrusted project file and any secret field
(`chat.apiKey`/`embed.apiKey`/`memory.hippo.key`) resolves to a non-`env:` literal,
emit a loud redacted warning to stderr nudging the user to `env:NAME` +
gitignore `.chatgml.json`.

### F15 — `chat` REPL prints the model's answer TWICE (streamed tokens, then the full answer re-rendered) — MEDIUM
**Area:** CLI / chat REPL. **File:** `src/cli/repl.ts:43-45` (token event writes live,
sets `streaming=true`) and `:65-67` (answer event writes `event.text` again in green).
**Repro:** run `chatgml chat <dir>` against any streaming model; the streamed text and
the same full text are both printed. With a real streaming model the whole reply is
duplicated on screen.
**Fix:** in `EventRenderer`, when tokens were streamed for the turn (`this.streaming`
was true and no tool_call interrupted), suppress re-printing `event.text` in the
`answer` case — only `endStream()` + `renderSources()`. Keep the answer event intact
for the serve protocol.

### F16 — Usage errors are printed TWICE to stderr — LOW
**Area:** CLI / error output. **Files:** commander (`exitOverride`) writes its own
error, then `src/cli.ts:355` writes `e.message` again.
**Repro (rerun live, confirmed):** `node dist/cli.js frobnicate` → two identical
`error: unknown command 'frobnicate'` lines (exit 2 is correct).
**Fix:** configure the program with `.configureOutput` to suppress commander's own
`writeErr` for handled `CommanderError`s, OR in `main()`'s catch skip writing the
message for codes commander already printed
(`commander.unknownCommand`/`unknownOption`/`excessArguments`). Print exactly once.

### Smaller fixable-now items (LOW, batchable)

- **F17 — `read_file` silently clamps an out-of-range line window to the last line**
  (`src/tools/read.ts:80-82`). `read_file({startLine:9000, endLine:9100})` on a
  15-line file returns just line 15 with `startLine:15` and no signal the range was
  beyond EOF. **Fix:** return `bad_args` (`startLine N exceeds file length M`) or note
  the clamp in the content/citation.
- **F18 — Config-validation errors are vague.** An unknown top-level key reports
  `bad field '(root)'` (the offending key name is never surfaced — `src/config.ts:180`
  uses the empty zod issue path), and enum failures (`approval`, `memory.provider`)
  never list the allowed values (`src/config.ts:616`). **Fix:** surface
  `result.error.issues[0].keys` for `unrecognized_keys`, and include the allowed set
  in the enum message.
- **F19 — Global flags only work BEFORE the subcommand; the error and `--help` do not
  reveal the fix.** `index . --scope foo` → `unknown option '--scope'` (the globals
  are on the program with `enablePositionalOptions()`). It IS in `docs/usage.md` but
  not in `--help` (globals also lack descriptions). **Fix:** make the error actionable
  and add the "global options must precede the subcommand" note + per-option
  descriptions to `--help`.
- **F20 — `config set --help` does not list the valid `<field>` names or the
  secret-only-`env:` rule** (`src/cli.ts:317-324`). **Fix:** extend the command
  description/epilog listing the ~17 settable fields grouped by lane and the
  `env:NAME`-only secret rule.
- **F21 — `chatgml index` never adds `/.chatgml/` to the indexed project's
  `.gitignore` (nor warns).** Users commit a ~370KB `vectors.json` store into a
  tracked repo. The plan intended this gitignore entry, but it only landed in the
  ChatGML repo itself, not in indexed projects. **Fix:** on first index, idempotently
  append `/.chatgml/` to the project `.gitignore` and tell the user (or at minimum
  print a one-line hint) and document the store location in `docs/usage.md`.
- **F22 — Indexing a GameMaker project gives no confirmation it was recognized unless
  enrichment resolved a field** (`src/cli.ts:119` — the GM suffix only appears when
  `gmEnriched > 0`). A real `.yyp` with no collision/parent events shows just
  `indexed: 2 added, ...`. **Fix:** when `findYypOnDisk` succeeds, always note the
  detected project (`GameMaker project detected (<name>.yyp); N .gml, M enriched`),
  even when `gmEnriched` is 0. *(Folds naturally into F3's output rework.)*
- **F23 — The CLI version is hard-coded in `src/cli.ts:266` (`.version('0.1.0')`)
  separately from `package.json`** — no user-visible bug today, but they can drift.
  **Fix:** read the version from the bundled `package.json` at build/runtime.

---

## Deferred / needs-decision gaps

### D1 — `search_code` has no relevance floor; minmax fusion always normalizes the top hit to ~max — MEDIUM (design)
**File:** `src/memory/fusion.ts:42-45,82-85` (confirmed: `minmaxNormalize` maps the
best item to 1.0 regardless of ABSOLUTE similarity; "all-equal scores map to 1").
A gibberish query returns confident-looking results indistinguishable from a real
match — the fused score has no cross-query meaning and there is no threshold to drop
irrelevant hits. **Why deferred:** the right floor value, and whether to surface "low
confidence", is a design choice; tested with a stub embedder, so a real model would
separate scores better, but the structural "no absolute floor" issue remains.
**Direction:** retain the raw cosine/BM25 max alongside the normalized fused score and
apply (or expose) a configurable absolute cosine floor; drop or flag hits below it.

### D2 — Multi-collision GameMaker objects never resolve `collisionWith` (GUID-named collision events stay path-only) — MEDIUM (design)
**File:** `src/index/gm-resolver.ts:130-138` (confirmed: `resolveCollisionTarget`
returns `undefined` for a multi-target object addressed by an unmappable GUID token;
this is even unit-tested). GameMaker 2.3+ ALWAYS names collision `.gml` files by GUID,
and modern `.yy`/`.yyp` use `{name,path}` refs with no GUIDs to cross-reference — so in
practice EVERY multi-collision object loses its collision-target enrichment even though
the `.yy` lists the targets in order. **Why deferred:** resolving it safely is a design
choice (guessing risks wrong citations). **Directions:** (a) attach the full target
list (`collisionCandidates`) so the citation says "collides one of: obj_enemy,
obj_wall"; or (b) map collision `.gml` files to targets by their stable on-disk order
against the `eventList` collision entries (GameMaker writes them deterministically). At
minimum, surface that the object is a multi-collision object.

### D3 — Embeddings-store identity is `host:port:model`, so a changed/ephemeral port forces a full re-embed — LOW (design)
**File:** `src/index/embeddings.ts` (`embeddings.id = '${host}:${model}'`),
`src/index/indexer.ts:78` (an `embeddingsId` mismatch forces a full rebuild).
Re-running index against the same model on a different port (common when llama.cpp/
ollama restarts) re-embeds the whole codebase, and the "(full rebuild)" banner gives
no reason. **Why deferred:** keying on model (and dim) vs host:port is a correctness/
stability trade-off. **Direction:** key the manifest on the embedding MODEL (and maybe
dim), or add a stable per-store fingerprint; at minimum print WHY a full rebuild was
triggered (`embeddings id changed A -> B`).

### D4 — `graph_neighbors` name-only mode returns weak, uniform-score neighbors for common tokens — LOW (heuristic)
**File:** `src/tools/graph.ts` / local backend. `graph_neighbors({name:'hp'})` returns
every chunk at uniform 0.5 (the local backend has no real symbol graph: same-file OR
text-mentions-name). Documented as best-effort; with a path it is much better (single
correct hit, score 1.0). **Why deferred:** needs a ranking heuristic/design decision.
**Direction:** require name length ≥3 for mention matching, rank by mention count /
proximity to a definition, and/or nudge the tool description to recommend passing a
path.

### D5 — ReDoS guard misses common pathological shapes like `(.*a){N}` and `a*a*a*X$` — LOW (heuristic)
**File:** `src/tools/grep.ts:35-39` (confirmed: `isReDoSShape` only flags a quantified
group immediately followed by an outer quantifier; `(.*a){15}` and
`a*a*a*a*a*a*a*a*X$` are accepted). Realistic blast radius is limited (model supplies
the pattern, 512-char cap, per-line matching), and there is no in-flight regex timeout
("single thread can't interrupt a match"). **Why deferred:** completing the heuristic
is open-ended; the proper fix (worker with wall-clock kill) is an architectural change.
**Direction:** extend `isReDoSShape` to flag counted repetition of a group containing
an unbounded quantifier and adjacent unbounded quantifiers over overlapping classes,
or run matching on a worker with a wall-clock kill.

### D6 — `config set` ignores the project dir and always writes the global user config — LOW (design/ergonomics)
**File:** `src/cli.ts:317-324` / `setUserGlobalConfigField`. `config set
index.chunkSize 800` writes `~/.config/chatgml/config.json` with no `[dir]`/`--local`
option, so a user tuning chunkSize for one GameMaker project unknowingly changes it
globally. (This is intentional — the global file is the trusted layer, and never
writing a repo-tracked file is a deliberate secret-hygiene property.) **Why deferred:**
adding a project-local write target intersects with the trusted/untrusted layering and
the secret-hygiene guarantee — it is a policy decision, not a bug. **Direction:** add an
optional `[dir]`/`--local` that writes `<dir>/.chatgml.json` (refusing secrets there),
and/or print the destination path more prominently; at minimum document that
`config set` is global-only.

---

## Real-model quality NOT assessed — needs a user endpoint

Every retrieval/graph/search repro in this dogfooding pass ran against a **stub
embedder** and stub chat model. That means the following were exercised structurally
but **NOT** for real-world quality, and cannot be until ChatGML is pointed at a real
OpenAI-compatible chat + embedding endpoint (`--chat-base-url` / `--embed-base-url`
with a working model and key):

- **Embedding retrieval quality** — whether `search_code` actually surfaces the right
  GML for a natural-language question (the stub makes all scores degenerate; D1's
  "no absolute floor" is provable structurally but its practical impact needs a real
  embedder).
- **End-to-end chat/serve answer quality** — whether the agent uses tools well, cites
  correctly, and answers GameMaker questions usefully. The double-render (F15) and the
  confident-answer-with-`SOURCES:[]` behavior (F3) were seen with the stub; their
  real-model behavior should be re-checked.
- **Token-limit behavior of the chunker (F5)** against a real embedder that enforces an
  ~8K-token cap — the stub accepts the 200KB mega-chunk; a real endpoint will truncate
  or 400.
- **Multi-turn agent loop quality** over a real model (tool selection, stop behavior,
  approval flow).

**Recommendation:** before declaring the dogfooding sign-off complete, run one pass
against a real chat + embedding endpoint over the BLANK GAME (or a richer GameMaker
project) and re-evaluate D1, F3, F5, and F15 with real outputs.
