import { describe, it, expect } from 'vitest';
import { SseParser, DONE, assembleToolCalls, LlmError } from '../src/llm.js';

describe('SseParser', () => {
  it('parses a single data line', () => {
    const p = new SseParser();
    const out = p.push('data: {"a":1}\n');
    expect(out).toEqual([{ a: 1 }]);
  });

  it('reassembles a JSON object split mid-payload across chunks', () => {
    const p = new SseParser();
    const out1 = p.push('data: {"choices":[{"de');
    expect(out1).toEqual([]); // incomplete line buffered
    const out2 = p.push('lta":{"content":"hi"}}]}\n');
    expect(out2).toEqual([{ choices: [{ delta: { content: 'hi' } }] }]);
  });

  it('handles \\r\\n line endings and keep-alive blanks', () => {
    const p = new SseParser();
    const out = p.push('\r\n: keep-alive comment\r\ndata: {"x":2}\r\n\r\n');
    expect(out).toEqual([{ x: 2 }]);
  });

  it('emits the DONE sentinel for [DONE]', () => {
    const p = new SseParser();
    const out = p.push('data: [DONE]\n');
    expect(out).toEqual([DONE]);
  });

  it('handles multiple events in one chunk', () => {
    const p = new SseParser();
    const out = p.push('data: {"n":1}\ndata: {"n":2}\n');
    expect(out).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('flush returns a buffered trailing payload', () => {
    const p = new SseParser();
    expect(p.push('data: {"n":9}')).toEqual([]); // no newline yet
    expect(p.flush()).toEqual([{ n: 9 }]);
  });

  it('throws LlmError(parse) on malformed JSON payload', () => {
    const p = new SseParser();
    expect(() => p.push('data: {not json}\n')).toThrow(LlmError);
  });
});

describe('assembleToolCalls', () => {
  it('assembles interleaved-by-index fragments', () => {
    const calls = assembleToolCalls([
      { index: 0, id: 'call_a', name: 'glob' },
      { index: 0, argsFragment: '{"pat' },
      { index: 1, id: 'call_b', name: 'grep' },
      { index: 0, argsFragment: 'tern":"*.gml"}' },
      { index: 1, argsFragment: '{"q":"x"}' },
    ]);
    expect(calls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*.gml"}' } },
      { id: 'call_b', type: 'function', function: { name: 'grep', arguments: '{"q":"x"}' } },
    ]);
  });

  it('returns [] for no tool deltas', () => {
    expect(assembleToolCalls([])).toEqual([]);
  });

  it('keeps the first-seen id/name sticky', () => {
    const calls = assembleToolCalls([
      { index: 0, id: 'first', name: 'a' },
      { index: 0, id: 'second', name: 'b', argsFragment: '{}' },
    ]);
    expect(calls[0]!.id).toBe('first');
    expect(calls[0]!.function.name).toBe('a');
  });

  it('synthesizes an id when none provided', () => {
    const calls = assembleToolCalls([{ index: 2, name: 'x', argsFragment: '{}' }]);
    expect(calls[0]!.id).toBe('call_2');
  });
});
