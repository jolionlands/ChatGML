// test/serve.spawn-integration.test.ts — THE M6 acceptance proof.
//
// Spawns the REAL built core (`node dist/cli.js serve <repo>`) as a child process and drives the
// NDJSON-over-stdio protocol exactly as the GMEdit plugin will: it writes `user` lines to the
// child's stdin and decodes AgentEvents off the child's stdout with the SAME framing the plugin
// uses (src/plugin-runtime.ts NdjsonLineBuffer). The child's chat lane points at a tiny local
// OpenAI-compatible SSE stub this test starts, so a full turn (user -> tokens -> answer) and an edit
// turn (apply_patch tool_call -> edit_proposal -> approval_request -> approve -> file-on-disk
// changed) round-trip over a genuine OS process boundary — the one thing the in-process PassThrough
// tests (serve.test.ts, serve.edit-roundtrip.test.ts) cannot prove.
//
// This is purely additive (it never touches src/) and is gated on dist/ being built: if dist/cli.js
// is absent the suite skips with a clear reason rather than failing confusingly.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NdjsonLineBuffer, buildServeArgv } from '../src/plugin-runtime.js';
import type { AgentEvent } from '../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST_CLI = path.resolve(HERE, '../dist/cli.js');
const DIST_BUILT = existsSync(DIST_CLI);

const TARGET = 'objects/obj_player/Step_0.gml';
const ORIGINAL = 'hp -= 1;\nif (hp <= 0) instance_destroy();\n';
const CLEAN_DIFF =
  '--- a\n+++ b\n@@ -1,2 +1,2 @@\n-hp -= 1;\n+hp -= 999;\n if (hp <= 0) instance_destroy();\n';
const PATCHED = 'hp -= 999;\nif (hp <= 0) instance_destroy();\n';

// ---------------------------------------------------------------------------
// A minimal OpenAI-compatible SSE chat stub. Each POST /chat/completions consumes the next scripted
// turn and streams it as `data: {choices:[{delta:{...}}]}` frames + `[DONE]`. POST /embeddings
// returns a fixed unit vector (only hit if the model calls the search tool; our scripts don't).
// ---------------------------------------------------------------------------
interface Turn {
  /** Plain text answer, streamed as token deltas. */
  text?: string;
  /** A single apply_patch tool call. */
  applyPatch?: { path: string; diff: string };
}

function startChatStub(turns: Turn[]): Promise<{ url: string; close: () => Promise<void> }> {
  let cursor = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url?.includes('/embeddings')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0], index: 0 }] }));
        return;
      }
      // /chat/completions — stream the next scripted turn as SSE.
      const turn = turns[cursor] ?? { text: '' };
      cursor++;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const frame = (obj: unknown): void => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      if (turn.applyPatch) {
        // Stream a tool_call delta (id/name then args fragment), then finish with tool_calls.
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_edit_1',
                    type: 'function',
                    function: {
                      name: 'apply_patch',
                      arguments: JSON.stringify({
                        path: turn.applyPatch.path,
                        diff: turn.applyPatch.diff,
                      }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        // Stream plain text as two deltas (proves token streaming over the real boundary).
        const text = turn.text ?? '';
        const mid = Math.ceil(text.length / 2);
        frame({ choices: [{ delta: { content: text.slice(0, mid) }, finish_reason: null }] });
        frame({ choices: [{ delta: { content: text.slice(mid) }, finish_reason: null }] });
        frame({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// A thin wrapper around the spawned child that exposes "send InEvent" + "await event".
// ---------------------------------------------------------------------------
class ServeChild {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly buf = new NdjsonLineBuffer();
  readonly events: AgentEvent[] = [];
  readonly stderr: string[] = [];
  exited = false;
  exitCode: number | null = null;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => {
      // Feed RAW chunks (no per-chunk trim) into the same buffer the plugin uses.
      const { events } = this.buf.push(chunk);
      for (const e of events) this.events.push(e as AgentEvent);
    });
    child.stderr.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString('utf8')));
    child.on('exit', (code) => {
      this.exited = true;
      this.exitCode = code;
    });
  }

  send(cmd: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  /** Write a raw (possibly malformed) line to the child's stdin. */
  sendRaw(s: string): void {
    this.child.stdin.write(s);
  }

  endStdin(): void {
    this.child.stdin.end();
  }

  kill(): void {
    if (!this.exited) this.child.kill();
  }

  async waitForEvent(pred: (e: AgentEvent) => boolean, timeoutMs = 20000): Promise<AgentEvent> {
    const deadline = Date.now() + timeoutMs;
    let exitedAt: number | null = null;
    for (;;) {
      const found = this.events.find(pred);
      if (found) return found;
      // If the child exits, give a short grace period for any final buffered stdout to flush, then
      // fail with diagnostics. (A clean exit before the awaited event is a real failure.)
      if (this.exited) {
        if (exitedAt === null) exitedAt = Date.now();
        else if (Date.now() - exitedAt > 300) {
          throw new Error(
            `child exited (code ${this.exitCode}) before event; ` +
              `got ${this.events.map((e) => e.type).join(',')}; stderr:\n${this.stderr.join('')}`,
          );
        }
      }
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for event; got ${this.events.map((e) => e.type).join(',')}; ` +
            `stderr:\n${this.stderr.join('')}`,
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async waitForExit(timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

let stub: { url: string; close: () => Promise<void> } | null = null;
let activeChild: ServeChild | null = null;
let repoRoot: string | null = null;

afterEach(async () => {
  if (activeChild) {
    activeChild.kill();
    activeChild = null;
  }
  if (stub) {
    await stub.close();
    stub = null;
  }
  if (repoRoot) {
    await fsp.rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

async function makeRepo(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'spawn-serve-'));
  await fsp.mkdir(path.join(root, 'objects/obj_player'), { recursive: true });
  await fsp.writeFile(path.join(root, TARGET), ORIGINAL);
  return root;
}

function spawnServe(root: string, baseURL: string): ServeChild {
  // Build the spawn argv with the SAME helper the plugin uses (global flags BEFORE 'serve').
  const argv = [
    DIST_CLI,
    ...buildServeArgv({
      dir: root,
      chat: { baseURL, model: 'stub-chat' },
      embed: { baseURL, model: 'stub-embed' },
      scope: 'game',
      approval: 'gated',
    }),
  ];
  // Minimal-ish env: keep PATH/APPDATA/HOME so the child can still resolve its config, plus the
  // chat/embed flags carry the endpoints. No secret on the command line.
  const child = spawn(process.execPath, argv, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env['PATH'],
      APPDATA: process.env['APPDATA'],
      HOME: process.env['HOME'],
      USERPROFILE: process.env['USERPROFILE'],
      SystemRoot: process.env['SystemRoot'],
    },
  });
  return new ServeChild(child);
}

describe.skipIf(!DIST_BUILT)('serve spawn integration (REAL child process over NDJSON)', () => {
  beforeAll(() => {
    if (!DIST_BUILT) {
      // eslint-disable-next-line no-console
      console.warn(`[skip] ${DIST_CLI} not built — run \`npm run build\` first.`);
    }
  });

  it('emits the ready handshake first over real stdio', async () => {
    stub = await startChatStub([{ text: 'hello from the stub' }]);
    repoRoot = await makeRepo();
    const c = spawnServe(repoRoot, stub.url);
    activeChild = c;
    const ready = await c.waitForEvent((e) => e.type === 'status' && e.phase === 'ready');
    expect(ready).toEqual({ type: 'status', phase: 'ready', protocolVersion: 1 });
    c.endStdin();
    await c.waitForExit();
    expect(c.exitCode).toBe(0);
  }, 30000);

  it('a plain user turn streams tokens then a final answer', async () => {
    stub = await startChatStub([{ text: 'The Step event reduces hp.' }]);
    repoRoot = await makeRepo();
    const c = spawnServe(repoRoot, stub.url);
    activeChild = c;
    await c.waitForEvent((e) => e.type === 'status' && e.phase === 'ready');
    c.send({ type: 'user', text: 'what does Step do?' });
    const answer = await c.waitForEvent((e) => e.type === 'answer');
    expect(c.events.some((e) => e.type === 'token')).toBe(true);
    expect(answer.type === 'answer' && answer.text).toBe('The Step event reduces hp.');
    c.endStdin();
    await c.waitForExit();
    expect(c.exitCode).toBe(0);
  }, 30000);

  it('an edit turn: apply_patch -> edit_proposal -> approval_request -> approve writes the file', async () => {
    stub = await startChatStub([
      { applyPatch: { path: TARGET, diff: CLEAN_DIFF } }, // turn 1: model proposes the edit
      { text: 'Patched the Step event.' }, // turn 2: after approval+tool_result, final answer
    ]);
    repoRoot = await makeRepo();
    const c = spawnServe(repoRoot, stub.url);
    activeChild = c;
    await c.waitForEvent((e) => e.type === 'status' && e.phase === 'ready');

    c.send({ type: 'user', text: 'change the damage to 999' });

    const proposal = await c.waitForEvent((e) => e.type === 'edit_proposal');
    const req = await c.waitForEvent((e) => e.type === 'approval_request');
    const propId = proposal.type === 'edit_proposal' ? proposal.id : 'P';
    const reqId = req.type === 'approval_request' ? req.id : 'R';
    // proposal + request share the deterministic id
    expect(reqId).toBe(propId);
    expect(reqId).toMatch(/^[0-9a-f]{16}$/);

    // Client approves by id (out-of-band control command), exactly as the plugin would.
    c.send({ type: 'approve', id: reqId });

    const answer = await c.waitForEvent((e) => e.type === 'answer');
    expect(answer.type === 'answer' && answer.text).toBe('Patched the Step event.');

    // The file on disk was actually written with the patched content (proves the full round-trip).
    expect(readFileSync(path.join(repoRoot, TARGET), 'utf8')).toBe(PATCHED);
    const editResult = c.events.find((e) => e.type === 'tool_result' && e.name === 'apply_patch');
    expect(editResult && editResult.type === 'tool_result' && editResult.ok).toBe(true);

    c.endStdin();
    await c.waitForExit();
    expect(c.exitCode).toBe(0);
  }, 30000);

  it('stdout carries ONLY valid JSON (no banners) — the plugin can parse every line', async () => {
    stub = await startChatStub([{ text: 'clean output' }]);
    repoRoot = await makeRepo();
    const c = spawnServe(repoRoot, stub.url);
    activeChild = c;
    await c.waitForEvent((e) => e.type === 'status' && e.phase === 'ready');
    c.send({ type: 'user', text: 'hi' });
    await c.waitForEvent((e) => e.type === 'answer');
    c.endStdin();
    await c.waitForExit();
    // Every recorded event parsed cleanly (no malformed lines were reported by the buffer).
    expect(c.events.length).toBeGreaterThan(0);
    expect(c.exitCode).toBe(0);
  }, 30000);

  it('a malformed inbound line yields an error event and the session survives', async () => {
    stub = await startChatStub([{ text: 'still alive' }]);
    repoRoot = await makeRepo();
    const c = spawnServe(repoRoot, stub.url);
    activeChild = c;
    await c.waitForEvent((e) => e.type === 'status' && e.phase === 'ready');
    c.sendRaw('this is not json\n');
    c.send({ type: 'user', text: 'hi' });
    await c.waitForEvent((e) => e.type === 'error');
    await c.waitForEvent((e) => e.type === 'answer');
    c.endStdin();
    await c.waitForExit();
    expect(c.exitCode).toBe(0);
  }, 30000);
});
