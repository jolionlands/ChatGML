# ChatGML Agent API (NDJSON over stdio)

`chatgml serve <dir>` exposes the agent over **NDJSON** — one JSON object per line, terminated by
`\n`, UTF-8 — on **stdio**. This is the stable integration surface any editor (the GMEdit plugin, a
terminal front-end, a CI bot) speaks. `stdout` carries **protocol JSON only**; all diagnostics and
banners go to `stderr`.

## Spawning

```
chatgml serve /path/to/gamemaker/project
```

Configuration (chat + embeddings endpoints, scope, approval mode) resolves from flags, `CHATGML_*`
environment variables, and config files exactly as for the other subcommands. Secrets are read from
the environment via `env:NAME` references and are **never** echoed into the event stream.

## Framing

- One JSON object per line, `\n`-terminated.
- A trailing partial line is buffered until its newline arrives.
- Blank lines are ignored.
- A malformed inbound line produces one `error` event; the session continues.

## Handshake

On start the server writes a `status:ready` event followed immediately by a `tool_catalog` event:

```
{"type":"status","phase":"ready","protocolVersion":3}
{"type":"tool_catalog","tools":[{"name":"glob","description":"Find files in the project by glob pattern (e.g. \"scripts/**/*.gml\"). Returns repo-relative paths. Read-only; sandboxed to the project root.","kind":"read","autoApprove":false},{"name":"grep","description":"Search file contents for literal text or a regex across the project. Returns matching file:line entries (1-based) with optional context. Read-only; sandboxed.","kind":"read","autoApprove":false},{"name":"search_files","description":"Search project files by regex or literal pattern.","kind":"read","autoApprove":false},{"name":"read_file","description":"Read a file (or a 1-based line range) from the project. Returns the text plus a citation. Read-only; sandboxed to the project root.","kind":"read","autoApprove":false},{"name":"search_code","description":"Semantic + keyword search over the indexed codebase via the active memory provider. Returns the most relevant code chunks with citations.","kind":"read","autoApprove":false},{"name":"graph_neighbors","description":"Find code related to a symbol (same-file chunks, name references, and KG edges where available) via the active memory provider. Returns related chunks with citations.","kind":"read","autoApprove":false},{"name":"temporal_query","description":"Query the change history of files (e.g. \"what changed in obj_player since <time>\") via the active memory provider. Returns change events, newest first.","kind":"read","autoApprove":false},{"name":"apply_patch","description":"Propose an edit to a single file as a unified diff. APPROVAL-GATED and sandboxed to the project root: in gated mode the change is applied only after the user approves it.","kind":"gated","autoApprove":false},{"name":"search_replace","description":"Propose edits to a single file as exact SEARCH/REPLACE blocks. APPROVAL-GATED and sandboxed to the project root: changes are applied only after the user approves them.","kind":"gated","autoApprove":false},{"name":"execute_command","description":"Execute a shell command inside the project root. APPROVAL-GATED: the command is run only after the user approves it.","kind":"command","autoApprove":false}]}
```

## Inbound commands (client → server)

| command | shape | server action |
|---|---|---|
| user | `{"type":"user","text":"…","context?":{…}}` | start a run; stream its events. `context` (optional) carries editor context for editor-integrated clients — see [Editor context](#editor-context). |
| reindex | `{"type":"reindex"}` | incrementally refresh the index (`status:indexing` … `status:done`) |
| approve | `{"type":"approve","id":"…"}` | approve a pending gated edit (out-of-band; settles the in-flight gate) |
| reject | `{"type":"reject","id":"…"}` | reject a pending gated edit |
| cancel | `{"type":"cancel"}` | abort the in-flight run |
| resume | `{"type":"resume","messages":[…]}` | seed the in-memory conversation history (out-of-band; never starts a run). `messages` is a list of plain `{role,content}` user/assistant pairs to replay as prior turns. Tool/system messages are dropped. |
| clear | `{"type":"clear"}` | drop the in-memory conversation history (out-of-band; the `/clear` slash command) |

`approve`/`reject`/`cancel`/`resume`/`clear` are **out-of-band control calls**, not new runs. There
is one async-iterable of events per `user`/`reindex` command.

## Outbound events (server → client)

| event | shape | meaning |
|---|---|---|
| status | `{"type":"status","phase":…}` | lifecycle: `ready\|thinking\|streaming\|indexing\|idle\|done\|cancelled` |
| token | `{"type":"token","text":"…"}` | streamed assistant text delta |
| tool_call | `{"type":"tool_call","id","name","args"}` | a tool is about to run (`args` already parsed) |
| tool_result | `{"type":"tool_result","id","name","ok","content","citations?"}` | tool finished (`ok:false` on a tool error) |
| edit_proposal | `{"type":"edit_proposal","id","path","diff"}` | a gated edit's unified diff |
| approval_request | `{"type":"approval_request","id","kind":"edit","path"}` | client must reply approve/reject with this id |
| answer | `{"type":"answer","text","sources","usage?"}` | final answer + citations |
| turn_end | `{"type":"turn_end","userText","assistantText","sources","context?"}` | a **persistence side-channel**: emitted ONCE after the terminal `answer`/`error` of a `user` turn, carrying the original user text, finalized assistant text, the turn's citations, and the editor context attached to the request. A client that wants to resume a conversation after a restart persists these records and replays them via a `resume` command. It does NOT change running/answer/phase state (the `answer`/`error` event already finalized those). |
| error | `{"type":"error","message","code?"}` | recoverable error; the session survives |

## Editor context

A `user` command may carry an optional `context` object describing what the human is currently
looking at in an editor-integrated client (e.g. the GMEdit plugin):

```json
{"type":"user","text":"what does this step do?","context":{"openFile":"objects/obj_player/Step_0.gml","cursorLine":3,"selection":"hp -= 1;"}}
```

The server prepends a clearly-framed DATA block (open file, cursor line, selected code) to the
user's own text before forwarding it to the model, so the agent knows the active file/selection
without the user re-stating it. Empty/whitespace-only selections and a context object with no
usable fields are dropped (the message is then the bare user text — v1 behavior). All v1 fields
remain optional; a bare `{type:"user",text}` still validates.

## Multi-turn history and resume

The core keeps conversation history across turns **within one serve session**. A client that wants
to **resume** a prior conversation after a restart (e.g. GMEdit was closed and reopened) persists
the `turn_end` records to a per-project session file and, on the next `chatgml serve` start, sends
one `resume` command seeding the history:

```json
{"type":"resume","messages":[{"role":"user","content":"fix the step event"},{"role":"assistant","content":"Proposed an edit…"}]}
```

The `messages` are replayed as prior turns only — the core never executes them. Only `user` and
`assistant` roles are kept; tool/system messages are dropped (tool exchanges are flattened by the
persisting client into the assistant's final text). A `/clear` from the client (the `clear`
command) drops the in-memory history in the same session.

## Turn termination

**Every turn terminates with exactly one of `{answer, error}`.** A client that drives a `user` run
can wait for a single terminal event and never hang:

- The **success** path ends with one `answer` (its sources/usage attached).
- Every **non-answer** exit ends with exactly one terminal `error`:
  - `code:"http"` (and other LlmError codes) — the model/transport failed mid-turn.
  - `code:"max_steps"` — the loop hit `maxSteps` without a final answer.
  - `code:"aborted"` — the run was cancelled (`cancel` command or a disconnect).
  - `code:"stuck_tool"` — the model repeated the SAME failing tool call (name + canonical args)
    3 times in a row; the loop stops instead of burning every remaining step on it.

On cancel, a non-terminal `status:cancelled` may be emitted for the UI, but it is **never** the
terminator — the terminal `error{code:"aborted"}` is, and nothing follows it. No turn ends on a bare
`status`.

## Slow-upstream idle heartbeat

ChatGML streams over the platform global `fetch` (Node 25 / undici). On some platforms (notably
**Windows ARM64**) undici **batches a slow upstream's HTTP body chunks**, so a slow model can stall the
token read for seconds with no incremental `token` events — the deltas then arrive in a burst. ChatGML's
loop is correct (it emits a `token` for every delta it reads); the buffering is in the transport beneath
it.

To keep a client from mistaking a buffered stall for a hung turn, the streaming turn runs a **timer-based
idle watchdog**, independent of the blocked read. After **`IDLE_MS` (default 5000ms)** with no new token
it emits a non-terminal heartbeat:

```
{"type":"status","phase":"streaming"}
```

at most once per `IDLE_MS`. The watchdog is **reset on every token** and **stopped when the turn ends or
is aborted**, so it **never fires on a normal fast stream** — only during a real idle gap. A
`status:streaming` is **not** a terminator (the turn still ends on exactly one `{answer, error}`); a
client should treat it purely as a keep-alive ("still working").

The period is tunable via the **`CHATGML_IDLE_MS`** environment variable (ms; `<=0` disables the
watchdog) for a known-slow upstream. The `AbortSignal` from a `cancel`/disconnect still aborts the
underlying fetch promptly — the heartbeat does not interfere with cancellation.

## Correlation

The `id` in `edit_proposal`, `approval_request`, and the client's `approve`/`reject` is the **same**
deterministic id minted by the agent (`sha1(path + '\0' + diff)`). `approve`/`reject` settle the
pending approval gate. A disconnect or `cancel` settles all pending approvals as **rejected** (no
hung turn).

In **M3**, `apply_patch` is an approval-gated **stub**: it validates and sandboxes the target but
returns a `not_implemented` `tool_result` and never writes. Real edit application + the approval
round-trip land in M4.

Citation granularity differs by provider: the `local` provider returns file paths with line ranges;
a graph/memory node from `hippo` may carry a snippet + score without a path or line range.

## Worked transcript

```
{"type":"status","phase":"ready","protocolVersion":3}
{"type":"tool_catalog","tools":[{"name":"glob","description":"Find files in the project by glob pattern (e.g. \"scripts/**/*.gml\"). Returns repo-relative paths. Read-only; sandboxed to the project root.","kind":"read","autoApprove":false},{"name":"grep","description":"Search file contents for literal text or a regex across the project. Returns matching file:line entries (1-based) with optional context. Read-only; sandboxed.","kind":"read","autoApprove":false},{"name":"search_files","description":"Search project files by regex or literal pattern.","kind":"read","autoApprove":false},{"name":"read_file","description":"Read a file (or a 1-based line range) from the project. Returns the text plus a citation. Read-only; sandboxed to the project root.","kind":"read","autoApprove":false},{"name":"search_code","description":"Semantic + keyword search over the indexed codebase via the active memory provider. Returns the most relevant code chunks with citations.","kind":"read","autoApprove":false},{"name":"graph_neighbors","description":"Find code related to a symbol (same-file chunks, name references, and KG edges where available) via the active memory provider. Returns related chunks with citations.","kind":"read","autoApprove":false},{"name":"temporal_query","description":"Query the change history of files (e.g. \"what changed in obj_player since <time>\") via the active memory provider. Returns change events, newest first.","kind":"read","autoApprove":false},{"name":"apply_patch","description":"Propose an edit to a single file as a unified diff. APPROVAL-GATED and sandboxed to the project root: in gated mode the change is applied only after the user approves it.","kind":"gated","autoApprove":false},{"name":"search_replace","description":"Propose edits to a single file as exact SEARCH/REPLACE blocks. APPROVAL-GATED and sandboxed to the project root: changes are applied only after the user approves them.","kind":"gated","autoApprove":false},{"name":"execute_command","description":"Execute a shell command inside the project root. APPROVAL-GATED: the command is run only after the user approves it.","kind":"command","autoApprove":false}]}
{"type":"status","phase":"thinking"}
{"type":"tool_call","id":"t1","name":"glob","args":{"pattern":"objects/**/*.gml"}}
{"type":"tool_result","id":"t1","name":"glob","ok":true,"content":"3 files"}
{"type":"token","text":"I'll update the "}
{"type":"token","text":"Step event."}
{"type":"edit_proposal","id":"e9a1","path":"objects/obj_player/Step_0.gml","diff":"--- a\n+++ b\n@@ -1 +1 @@\n-hp -= 1;\n+hp -= dmg;\n"}
{"type":"approval_request","id":"e9a1","kind":"edit","path":"objects/obj_player/Step_0.gml"}
{"type":"answer","text":"Proposed an edit to the player Step event.","sources":[{"path":"objects/obj_player/Step_0.gml","provider":"local"}]}
{"type":"turn_end","userText":"update the player Step event","assistantText":"Proposed an edit to the player Step event.","sources":[{"path":"objects/obj_player/Step_0.gml","provider":"local"}]}
```

After this, the client replies `{"type":"approve","id":"e9a1"}`. In M3 the gated stub responds with a
`tool_result` carrying `not_implemented`; in M4 the file is written atomically inside the sandbox.

## Secrets

API keys never appear in any event. Error events carry a short, key-scrubbed message referencing the
status/endpoint, never a body containing a token.

## Minimal Node consumer

```js
import { spawn } from 'node:child_process';

const child = spawn('chatgml', ['serve', projectDir], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim() === '') continue;
    const event = JSON.parse(line);
    if (event.type === 'token') process.stdout.write(event.text);
    if (event.type === 'answer') console.log('\nsources:', event.sources);
    if (event.type === 'approval_request') {
      child.stdin.write(JSON.stringify({ type: 'approve', id: event.id }) + '\n');
    }
  }
});

child.stdin.write(JSON.stringify({ type: 'user', text: 'What does obj_player do on Step?' }) + '\n');
```
