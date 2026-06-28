import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  InEventSchema,
  encodeEvent,
  parseInEvent,
  NdjsonDecoder,
  ProtocolError,
  writeEvent,
  isAgentEvent,
  type InEvent,
} from '../src/protocol.js';
import type { AgentEvent } from '../src/types.js';
import { Writable } from 'node:stream';

describe('protocol framing', () => {
  it('encodeEvent produces a single \\n-terminated line', () => {
    const e: AgentEvent = { type: 'token', text: 'hi' };
    const line = encodeEvent(e);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1).includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual(e);
  });

  it('round-trips every AgentEvent variant through encode + decode', () => {
    const events: AgentEvent[] = [
      { type: 'status', phase: 'ready', protocolVersion: PROTOCOL_VERSION },
      { type: 'token', text: 'partial' },
      { type: 'tool_call', id: 't1', name: 'glob', args: { pattern: '**/*.gml' } },
      { type: 'tool_result', id: 't1', name: 'glob', ok: true, content: '3 files' },
      { type: 'edit_proposal', id: 'e1', path: 'a.gml', diff: '--- a\n+++ b\n' },
      { type: 'approval_request', id: 'e1', kind: 'edit', path: 'a.gml' },
      {
        type: 'answer',
        text: 'done',
        sources: [{ path: 'a.gml', provider: 'local' }],
      },
      { type: 'error', message: 'oops', code: 'bad' },
    ];
    const decoder = new NdjsonDecoder();
    const wire = events.map(encodeEvent).join('');
    const parsed = decoder.push(wire);
    expect(parsed).toEqual(events);
  });

  it('decoder reassembles a 3-chunk mid-JSON split', () => {
    const e: AgentEvent = { type: 'token', text: 'reassembled' };
    const line = encodeEvent(e);
    const a = line.slice(0, 5);
    const b = line.slice(5, 12);
    const c = line.slice(12);
    const decoder = new NdjsonDecoder();
    expect(decoder.push(a)).toEqual([]);
    expect(decoder.push(b)).toEqual([]);
    expect(decoder.push(c)).toEqual([e]);
  });

  it('decoder handles multiple objects per chunk and skips blank lines', () => {
    const decoder = new NdjsonDecoder();
    const out = decoder.push('{"type":"reindex"}\n\n   \n{"type":"cancel"}\n');
    expect(out).toEqual([{ type: 'reindex' }, { type: 'cancel' }]);
  });

  it('flush of an incomplete JSON line throws ProtocolError', () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push('{"type":"user",')).toEqual([]);
    expect(() => decoder.flush()).toThrow(ProtocolError);
  });

  it('flush of an empty buffer returns []', () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.flush()).toEqual([]);
  });

  it('flush parses a complete buffered line lacking a newline', () => {
    const decoder = new NdjsonDecoder();
    decoder.push('{"type":"user","text":"hi"}');
    expect(decoder.flush()).toEqual([{ type: 'user', text: 'hi' }]);
  });

  it('accepts a Buffer chunk', () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push(Buffer.from('{"type":"reindex"}\n', 'utf8'))).toEqual([
      { type: 'reindex' },
    ]);
  });

  it('malformed JSON line throws ProtocolError and the loop can continue', () => {
    const decoder = new NdjsonDecoder();
    expect(() => decoder.push('not json\n')).toThrow(ProtocolError);
    // subsequent valid input still parses (buffer past the bad line was consumed)
    expect(decoder.push('{"type":"cancel"}\n')).toEqual([{ type: 'cancel' }]);
  });
});

describe('parseInEvent + InEventSchema', () => {
  it('parses each valid command shape', () => {
    const cases: InEvent[] = [
      { type: 'user', text: 'hello' },
      { type: 'approve', id: 'x' },
      { type: 'reject', id: 'y' },
      { type: 'reindex' },
      { type: 'cancel' },
    ];
    for (const c of cases) expect(parseInEvent(JSON.stringify(c))).toEqual(c);
  });

  it('round-trips a user command with context.mentions', () => {
    const ev: InEvent = {
      type: 'user',
      text: 'fix this',
      context: {
        openFile: 'obj_player/Step_0.gml',
        mentions: [
          { type: 'file', target: 'scripts/AI.gml', content: 'x = 1;' },
          { type: 'folder', target: 'objects/', content: 'obj_player/\nobj_enemy/' },
          { type: 'problems', target: 'problems', label: '3 errors', content: 'Type mismatch' },
          { type: 'terminal', target: 'recent output', content: 'Build OK' },
          { type: 'url', target: 'https://example.com', content: 'docs' },
          { type: 'image', target: 'paste.png', label: 'screenshot' },
        ],
      },
    };
    expect(parseInEvent(JSON.stringify(ev))).toEqual(ev);
  });

  it('round-trips a user command with taskId', () => {
    const ev: InEvent = { type: 'user', text: 'hello', taskId: 'task-abc-123' };
    expect(parseInEvent(JSON.stringify(ev))).toEqual(ev);
  });

  it('rejects a taskId longer than 64 chars', () => {
    expect(() =>
      parseInEvent(JSON.stringify({ type: 'user', text: 'hello', taskId: 'x'.repeat(65) })),
    ).toThrow(ProtocolError);
  });

  it('rejects a user command missing text', () => {
    expect(() => parseInEvent('{"type":"user"}')).toThrow(ProtocolError);
  });

  it('rejects an unknown command type', () => {
    expect(() => parseInEvent('{"type":"frobnicate"}')).toThrow(ProtocolError);
  });

  it('rejects non-JSON', () => {
    expect(() => parseInEvent('garbage')).toThrow(ProtocolError);
  });

  it('InEventSchema.safeParse rejects wrong id type', () => {
    expect(InEventSchema.safeParse({ type: 'approve', id: 5 }).success).toBe(false);
  });
});

describe('writeEvent + isAgentEvent', () => {
  it('writeEvent writes an NDJSON line to a stream', () => {
    const chunks: string[] = [];
    const out = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    writeEvent(out, { type: 'status', phase: 'done' });
    expect(chunks.join('')).toBe('{"type":"status","phase":"done"}\n');
  });

  it('isAgentEvent is true for a round-tripped event and false otherwise', () => {
    expect(isAgentEvent({ type: 'token', text: 'x' })).toBe(true);
    expect(isAgentEvent({ type: 'user', text: 'x' })).toBe(false);
    expect(isAgentEvent(null)).toBe(false);
    expect(isAgentEvent('token')).toBe(false);
    expect(isAgentEvent({})).toBe(false);
  });
});
