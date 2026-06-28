import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { runServe, type Transport } from '../src/serve.js';
import { NdjsonDecoder } from '../src/protocol.js';
import { FakeAgent } from './helpers/fake-agent.js';
import type { AgentEvent, Config } from '../src/types.js';
import { buildToolRegistry } from '../src/tools/index.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fakeConfig(approval: 'gated' | 'auto'): Config {
  return {
    chat: { baseURL: 'http://x', model: 'm', temperature: 0.2 },
    embed: { baseURL: 'http://x', model: 'e', batchSize: 64 },
    memory: { provider: 'local' },
    scope: 'game',
    mode: 'code',
    approval,
    index: { chunkSize: 1500, chunkOverlap: 200, root: '/r' },
    search: {},
  };
}

/** Collect every parsed outbound event from the output stream. */
function makeTransport(): {
  transport: Transport;
  input: PassThrough;
  outEvents: AgentEvent[];
  rawOut: string[];
  diag: string[];
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const outEvents: AgentEvent[] = [];
  const rawOut: string[] = [];
  const diag: string[] = [];
  const decoder = new NdjsonDecoder();
  output.on('data', (chunk: Buffer) => {
    rawOut.push(chunk.toString('utf8'));
    for (const v of decoder.push(chunk)) outEvents.push(v as AgentEvent);
  });
  diagnostics.on('data', (c: Buffer) => diag.push(c.toString('utf8')));
  return { transport: { input, output, diagnostics }, input, outEvents, rawOut, diag };
}

describe('runServe', () => {
  it('ready handshake includes the configured mode', async () => {
    const agent = new FakeAgent({
      after: [{ type: 'answer', text: 'done', sources: [] }],
    });
    const { transport, input, outEvents } = makeTransport();
    const config = fakeConfig('gated');
    config.mode = 'ask';
    const serve = runServe(agent, { transport, config });
    input.write('{"type":"user","text":"hello"}\n');
    await new Promise((r) => setTimeout(r, 10));
    agent.release();
    await new Promise((r) => setTimeout(r, 10));
    input.end();
    await serve;
    expect(outEvents[0]).toEqual({
      type: 'status',
      phase: 'ready',
      protocolVersion: 3,
      mode: 'ask',
    });
  });

  it('writes the ready handshake first, then streams a user run, then EOF ends', async () => {
    const agent = new FakeAgent({
      after: [
        { type: 'token', text: 'hi' },
        { type: 'answer', text: 'done', sources: [{ path: 'a.gml', provider: 'local' }] },
      ],
    });
    const { transport, input, outEvents } = makeTransport();
    const config = fakeConfig('gated');
    const serve = runServe(agent, { transport, config });
    input.write('{"type":"user","text":"hello"}\n');
    // allow the run to start, then release the gated answer
    await new Promise((r) => setTimeout(r, 10));
    agent.release();
    await new Promise((r) => setTimeout(r, 10));
    input.end();
    await serve;

    expect(outEvents[0]).toEqual({
      type: 'status',
      phase: 'ready',
      protocolVersion: 3,
      mode: 'code',
    });
    const catalog = outEvents.find((e) => e.type === 'tool_catalog');
    expect(catalog).toBeDefined();
    expect(catalog && catalog.type === 'tool_catalog' && catalog.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['read_file', 'execute_command', 'search_replace']),
    );
    if (catalog && catalog.type === 'tool_catalog') {
      for (const tool of catalog.tools) {
        if (tool.kind === 'read') {
          expect(tool.autoApprove).toBe(true);
        } else {
          expect(tool.autoApprove).toBe(false);
        }
      }
    }
    const types = outEvents.map((e) => e.type);
    expect(types).toContain('token');
    expect(types).toContain('answer');
  });

  it('tool_catalog is filtered by the active mode — ask mode omits gated + command tools', async () => {
    const agent = new FakeAgent({ after: [{ type: 'answer', text: 'done', sources: [] }] });
    const { transport, input, outEvents } = makeTransport();
    const config: Config = { ...fakeConfig('gated'), mode: 'ask' };
    const serve = runServe(agent, { transport, config });
    input.write('{"type":"user","text":"hi"}\n');
    await new Promise((r) => setTimeout(r, 10));
    agent.release();
    await new Promise((r) => setTimeout(r, 10));
    input.end();
    await serve;
    const catalog = outEvents.find((e) => e.type === 'tool_catalog');
    expect(catalog).toBeDefined();
    if (catalog && catalog.type === 'tool_catalog') {
      const names = catalog.tools.map((t) => t.name);
      // Read tools still advertised.
      expect(names).toContain('read_file');
      expect(names).toContain('grep');
      // Gated + command tools are filtered out of the catalog in ask mode.
      expect(names).not.toContain('apply_patch');
      expect(names).not.toContain('search_replace');
      expect(names).not.toContain('execute_command');
      for (const tool of catalog.tools) {
        expect(tool.kind).toBe('read');
      }
    }
  });

  it('output stream contains ONLY valid JSON lines (no banners)', async () => {
    const agent = new FakeAgent({ after: [{ type: 'answer', text: 'x', sources: [] }] });
    const { transport, input, rawOut } = makeTransport();
    const serve = runServe(agent, { transport });
    input.write('{"type":"user","text":"hi"}\n');
    await new Promise((r) => setTimeout(r, 10));
    agent.release();
    await new Promise((r) => setTimeout(r, 10));
    input.end();
    await serve;
    const lines = rawOut
      .join('')
      .split('\n')
      .filter((l) => l.trim() !== '');
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('malformed inbound line emits a single error event and the loop survives', async () => {
    const agent = new FakeAgent({ after: [{ type: 'answer', text: 'ok', sources: [] }] });
    const { transport, input, outEvents } = makeTransport();
    const serve = runServe(agent, { transport });
    input.write('this is not json\n');
    input.write('{"type":"user","text":"hi"}\n');
    await new Promise((r) => setTimeout(r, 10));
    agent.release();
    await new Promise((r) => setTimeout(r, 10));
    input.end();
    await serve;
    expect(outEvents.some((e) => e.type === 'error')).toBe(true);
    expect(outEvents.some((e) => e.type === 'answer')).toBe(true);
  });

  it('approve/reject are forwarded to resolveApproval out-of-band', async () => {
    const agent = new FakeAgent({ after: [{ type: 'answer', text: 'x', sources: [] }] });
    const { transport, input } = makeTransport();
    const serve = runServe(agent, { transport });
    input.write('{"type":"approve","id":"e1"}\n');
    input.write('{"type":"reject","id":"e2"}\n');
    await new Promise((r) => setTimeout(r, 10));
    input.end();
    await serve;
    expect(agent.approvals).toEqual([
      { id: 'e1', approved: true },
      { id: 'e2', approved: false },
    ]);
  });

  it('cancel aborts a long run deterministically (release gate)', async () => {
    const agent = new FakeAgent({
      before: [{ type: 'token', text: 'start' }],
      after: [{ type: 'answer', text: 'should-not-happen', sources: [] }],
    });
    const { transport, input, outEvents } = makeTransport();
    const serve = runServe(agent, { transport });
    input.write('{"type":"user","text":"long task"}\n');
    // wait for the early token to arrive
    await new Promise((r) => setTimeout(r, 15));
    expect(outEvents.some((e) => e.type === 'token' && e.text === 'start')).toBe(true);
    // cancel BEFORE releasing the gated answer
    input.write('{"type":"cancel"}\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(agent.cancelled).toBe(true);
    // now release: the run sees its signal aborted and yields cancelled, never the answer
    agent.release();
    await new Promise((r) => setTimeout(r, 10));
    input.end();
    await serve;
    expect(agent.lastSignalAborted).toBe(true);
    expect(outEvents.some((e) => e.type === 'answer')).toBe(false);
    expect(outEvents.some((e) => e.type === 'status' && e.phase === 'cancelled')).toBe(true);
  });

  it('reindex run streams status events', async () => {
    const agent = new FakeAgent({
      after: [
        { type: 'status', phase: 'indexing' },
        { type: 'status', phase: 'done' },
      ],
    });
    const { transport, input, outEvents } = makeTransport();
    const serve = runServe(agent, { transport });
    input.write('{"type":"reindex"}\n');
    await new Promise((r) => setTimeout(r, 10));
    agent.release();
    await new Promise((r) => setTimeout(r, 10));
    input.end();
    await serve;
    expect(outEvents.some((e) => e.type === 'status' && e.phase === 'indexing')).toBe(true);
  });

  it('processes a trailing line that lacks a final newline (EOF flush)', async () => {
    // Non-gated agent (events in `before`) so the run completes during the EOF-flush activeRun await,
    // before the disconnect cancel matters.
    const agent = new FakeAgent({ before: [{ type: 'answer', text: 'flushed', sources: [] }] });
    const { transport, input, outEvents } = makeTransport();
    const serve = runServe(agent, { transport });
    input.write('{"type":"user","text":"hi"}'); // NO trailing newline -> only handled on EOF flush
    await new Promise((r) => setTimeout(r, 10));
    input.end(); // EOF flushes the trailing line, starts + completes the run
    await serve;
    expect(outEvents.some((e) => e.type === 'answer' && e.text === 'flushed')).toBe(true);
  });

  it('emits an error for a malformed trailing line on EOF', async () => {
    const agent = new FakeAgent({ after: [{ type: 'answer', text: 'x', sources: [] }] });
    const { transport, input, outEvents } = makeTransport();
    const serve = runServe(agent, { transport });
    input.write('this-is-not-json-and-no-newline');
    await new Promise((r) => setTimeout(r, 5));
    input.end();
    await serve;
    expect(outEvents.some((e) => e.type === 'error')).toBe(true);
  });

  it('a cancel with no active run does not throw and is forwarded', async () => {
    const agent = new FakeAgent();
    const { transport, input, outEvents } = makeTransport();
    const serve = runServe(agent, { transport });
    input.write('{"type":"cancel"}\n');
    await new Promise((r) => setTimeout(r, 5));
    input.end();
    await serve;
    expect(agent.cancelled).toBe(true);
    expect(outEvents.some((e) => e.type === 'error')).toBe(false);
  });

  it('a valid JSON line that fails the command schema emits a protocol error', async () => {
    const agent = new FakeAgent();
    const { transport, input, outEvents } = makeTransport();
    const serve = runServe(agent, { transport });
    // valid JSON, but not a valid command (missing required text on user)
    input.write('{"type":"user"}\n');
    await new Promise((r) => setTimeout(r, 5));
    input.end();
    await serve;
    const err = outEvents.find((e) => e.type === 'error');
    expect(err && err.type === 'error' && err.code).toBe('protocol');
  });

  it('emits an error event if the agent run throws', async () => {
    const agent = new FakeAgent();
    // An AgentLike whose run() yields a stream that rejects on the first pull (the agent threw
    // before emitting anything). Expressed as an explicit async-iterable so it has no empty
    // generator body.
    agent.run = () => ({
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        return {
          next: () => Promise.reject(new Error('run blew up')),
        };
      },
    });
    const { transport, input, outEvents } = makeTransport();
    const serve = runServe(agent, { transport });
    input.write('{"type":"user","text":"hi"}\n');
    await new Promise((r) => setTimeout(r, 10));
    input.end();
    await serve;
    expect(outEvents.some((e) => e.type === 'error' && e.message.includes('run blew up'))).toBe(
      true,
    );
  });

  it('handles a Buffer-mode input stream', async () => {
    const agent = new FakeAgent({ after: [{ type: 'answer', text: 'buf', sources: [] }] });
    const { transport, input, outEvents } = makeTransport();
    const serve = runServe(agent, { transport });
    input.write(Buffer.from('{"type":"user","text":"hi"}\n', 'utf8'));
    await new Promise((r) => setTimeout(r, 10));
    agent.release();
    await new Promise((r) => setTimeout(r, 5));
    input.end();
    await serve;
    expect(outEvents.some((e) => e.type === 'answer' && e.text === 'buf')).toBe(true);
  });

  it('matches the documented transcript fixture for a representative run', async () => {
    const fixturePath = path.join(HERE, 'fixtures', 'agent-api-transcript.ndjson');
    const fixtureText = readFileSync(fixturePath, 'utf8');
    const fixtureEvents = fixtureText
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as AgentEvent);

    // Replay every fixture event AFTER the handshake (ready + tool_catalog).
    const afterHandshake = fixtureEvents.slice(2);
    const agent = new FakeAgent({ after: afterHandshake });
    const { transport, input, outEvents } = makeTransport();
    const serve = runServe(agent, { transport });
    input.write('{"type":"user","text":"update the player Step event"}\n');
    await new Promise((r) => setTimeout(r, 10));
    agent.release();
    await new Promise((r) => setTimeout(r, 10));
    input.end();
    await serve;
    expect(outEvents).toEqual(fixtureEvents);
  });

  it('replies to a ping with a matching pong', async () => {
    const agent = new FakeAgent();
    const { transport, input, outEvents } = makeTransport();
    const serve = runServe(agent, { transport });
    input.write('{"type":"ping","id":"x"}\n');
    await new Promise((r) => setTimeout(r, 5));
    input.end();
    await serve;
    expect(outEvents.some((e) => e.type === 'pong' && e.id === 'x')).toBe(true);
  });

  it('routes undo command to agent.undo and emits an answer event', async () => {
    const agent = new FakeAgent();
    const { transport, input, outEvents } = makeTransport();
    const serve = runServe(agent, { transport });
    input.write('{"type":"undo","checkpointId":"cp-1"}\n');
    await new Promise((r) => setTimeout(r, 10));
    input.end();
    await serve;
    expect(outEvents.some((e) => e.type === 'answer' && e.text === 'undo cp-1')).toBe(true);
  });

  it('re-emits the tool catalog on list_tools', async () => {
    const agent = new FakeAgent();
    const { transport, input, outEvents } = makeTransport();
    const serve = runServe(agent, { transport });
    input.write('{"type":"list_tools"}\n');
    await new Promise((r) => setTimeout(r, 5));
    input.end();
    await serve;
    const catalogs = outEvents.filter((e) => e.type === 'tool_catalog');
    expect(catalogs.length).toBe(2);
    const expectedNames = [...buildToolRegistry({ readOnly: false }).values()].map((t) => t.name);
    for (const c of catalogs) {
      expect(c.type === 'tool_catalog' && c.tools.map((t) => t.name)).toEqual(expectedNames);
    }
  });
});
