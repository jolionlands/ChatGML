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

On start the server writes exactly one `status:ready` event:

```
{"type":"status","phase":"ready","protocolVersion":1}
```

## Inbound commands (client → server)

| command | shape | server action |
|---|---|---|
| user | `{"type":"user","text":"…"}` | start a run; stream its events |
| reindex | `{"type":"reindex"}` | incrementally refresh the index (`status:indexing` … `status:done`) |
| approve | `{"type":"approve","id":"…"}` | approve a pending gated edit (out-of-band; settles the in-flight gate) |
| reject | `{"type":"reject","id":"…"}` | reject a pending gated edit |
| cancel | `{"type":"cancel"}` | abort the in-flight run |

`approve`/`reject`/`cancel` are **out-of-band control calls**, not new runs. There is one
async-iterable of events per `user`/`reindex` command.

## Outbound events (server → client)

| event | shape | meaning |
|---|---|---|
| status | `{"type":"status","phase":…}` | lifecycle: `ready\|thinking\|indexing\|idle\|done\|cancelled` |
| token | `{"type":"token","text":"…"}` | streamed assistant text delta |
| tool_call | `{"type":"tool_call","id","name","args"}` | a tool is about to run (`args` already parsed) |
| tool_result | `{"type":"tool_result","id","name","ok","content","citations?"}` | tool finished (`ok:false` on a tool error) |
| edit_proposal | `{"type":"edit_proposal","id","path","diff"}` | a gated edit's unified diff |
| approval_request | `{"type":"approval_request","id","kind":"edit","path"}` | client must reply approve/reject with this id |
| answer | `{"type":"answer","text","sources","usage?"}` | final answer + citations |
| error | `{"type":"error","message","code?"}` | recoverable error; the session survives |

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
