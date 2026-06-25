// test/serve.edit-roundtrip.test.ts — M4 end-to-end approval round-trip through the REAL stack.
//
// Wires the genuine createAgentLike (agent loop + ApprovalGate + control surface) into runServe, then
// drives the NDJSON protocol exactly as a client would: a `user` command makes the model call
// apply_patch, the server emits edit_proposal + approval_request, the client replies with `approve`
// (or `reject`) by id, and we assert the file on disk is written ONLY on approve. This proves the
// wiring the M4 plan requires: "the tool actually applies on approve" through serve.resolveApproval.
import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { runServe, type Transport } from '../src/serve.js';
import { createAgentLike } from '../src/agent.js';
import type { AgentLike } from '../src/agent.js';
import { NdjsonDecoder } from '../src/protocol.js';
import { buildToolRegistry } from '../src/tools/index.js';
import { buildIgnoreFilter } from '../src/index/files.js';
import { LocalMemoryProvider } from '../src/memory/local.js';
import { FakeLlm } from './helpers/fake-llm.js';
import { FakeEmbeddings } from './helpers/fakes.js';
import type { AgentEvent, Config } from '../src/types.js';

const ORIGINAL = 'hp -= 1;\nif (hp <= 0) instance_destroy();\n';
const CLEAN_DIFF =
  '--- a\n+++ b\n@@ -1,2 +1,2 @@\n-hp -= 1;\n+hp -= 999;\n if (hp <= 0) instance_destroy();\n';
const PATCHED = 'hp -= 999;\nif (hp <= 0) instance_destroy();\n';
const TARGET = 'objects/obj_player/Step_0.gml';

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

async function makeRepo(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'serve-edit-'));
  await fsp.mkdir(path.join(root, 'objects/obj_player'), { recursive: true });
  await fsp.writeFile(path.join(root, TARGET), ORIGINAL);
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

function cfg(root: string): Config {
  return {
    chat: { baseURL: 'http://x', model: 'm', temperature: 0.2 },
    embed: { baseURL: 'http://x', model: 'e', batchSize: 64 },
    memory: { provider: 'local' },
    scope: 'game',
    approval: 'gated',
    index: { chunkSize: 1500, chunkOverlap: 200, root },
    search: {},
  };
}

function makeTransport(): { transport: Transport; input: PassThrough; outEvents: AgentEvent[] } {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const outEvents: AgentEvent[] = [];
  const decoder = new NdjsonDecoder();
  output.on('data', (chunk: Buffer) => {
    for (const v of decoder.push(chunk)) outEvents.push(v as AgentEvent);
  });
  diagnostics.on('data', () => {});
  return { transport: { input, output, diagnostics }, input, outEvents };
}

async function buildAgentLike(root: string): Promise<AgentLike> {
  const ignore = await buildIgnoreFilter(root);
  const memory = new LocalMemoryProvider(
    { provider: 'local', root },
    { embeddings: new FakeEmbeddings() },
  );
  const llm = new FakeLlm([
    { toolCalls: [{ id: 'e1', name: 'apply_patch', arguments: JSON.stringify({ path: TARGET, diff: CLEAN_DIFF }) }] },
    { tokens: ['Done.'] },
  ]);
  return createAgentLike({ llm, tools: buildToolRegistry(), config: cfg(root), memory, ignore });
}

/** Wait (bounded) until predicate is true, polling the event loop. */
async function until(pred: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) await new Promise((r) => setTimeout(r, 0));
}

describe('serve M4 edit approval round-trip (real agent + gate + serve)', () => {
  it('APPROVE: user -> apply_patch -> approval_request -> approve writes the patched file', async () => {
    const root = await makeRepo();
    const agent = await buildAgentLike(root);
    const { transport, input, outEvents } = makeTransport();
    const serve = runServe(agent, { transport });

    input.write(`${JSON.stringify({ type: 'user', text: 'fix the step event' })}\n`);

    // Wait for the approval_request, then approve by its id (out-of-band, like a real client).
    await until(() => outEvents.some((e) => e.type === 'approval_request'));
    const req = outEvents.find((e) => e.type === 'approval_request');
    expect(req && req.type === 'approval_request').toBe(true);
    const id = req && req.type === 'approval_request' ? req.id : '';
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    // proposal + request share the id
    const prop = outEvents.find((e) => e.type === 'edit_proposal');
    expect(prop && prop.type === 'edit_proposal' && prop.id).toBe(id);

    input.write(`${JSON.stringify({ type: 'approve', id })}\n`);
    await until(() => outEvents.some((e) => e.type === 'answer'));
    input.end();
    await serve;

    // The file was written with the patched content.
    expect(readFileSync(path.join(root, TARGET), 'utf8')).toBe(PATCHED);
    const editResult = outEvents.find((e) => e.type === 'tool_result' && e.name === 'apply_patch');
    expect(editResult && editResult.type === 'tool_result' && editResult.ok).toBe(true);
  });

  it('REJECT: replying reject leaves the file untouched (no write)', async () => {
    const root = await makeRepo();
    const agent = await buildAgentLike(root);
    const { transport, input, outEvents } = makeTransport();
    const serve = runServe(agent, { transport });

    input.write(`${JSON.stringify({ type: 'user', text: 'fix the step event' })}\n`);
    await until(() => outEvents.some((e) => e.type === 'approval_request'));
    const req = outEvents.find((e) => e.type === 'approval_request');
    const id = req && req.type === 'approval_request' ? req.id : '';

    input.write(`${JSON.stringify({ type: 'reject', id })}\n`);
    await until(() => outEvents.some((e) => e.type === 'answer'));
    input.end();
    await serve;

    // Untouched.
    expect(readFileSync(path.join(root, TARGET), 'utf8')).toBe(ORIGINAL);
    const editResult = outEvents.find((e) => e.type === 'tool_result' && e.name === 'apply_patch');
    expect(editResult && editResult.type === 'tool_result' && /not approved/i.test(editResult.content)).toBe(true);
  });
});
