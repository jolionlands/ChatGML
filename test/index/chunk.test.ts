import { describe, it, expect } from 'vitest';
import {
  hashContent,
  chunkText,
  chunkFile,
  detectFunctionBoundaries,
} from '../../src/index/chunk.js';

describe('hashContent', () => {
  it('is stable across calls', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'));
  });
  it('is sensitive to a single-byte change', () => {
    expect(hashContent('hello')).not.toBe(hashContent('hellp'));
    expect(hashContent('a')).not.toBe(hashContent('a '));
  });
  it('returns a 64-char hex sha256', () => {
    expect(hashContent('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('chunkText', () => {
  it('empty/whitespace input yields zero chunks', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n  \n')).toEqual([]);
  });

  it('short input yields exactly one chunk spanning all lines', () => {
    const chunks = chunkText('line1\nline2\nline3', { chunkSize: 1000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(3);
    expect(chunks[0]!.text).toBe('line1\nline2\nline3');
  });

  it('splits on line boundaries with repeated overlap lines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n'); // each ~3 chars
    const chunks = chunkText(lines, { chunkSize: 9, chunkOverlap: 6 });
    expect(chunks.length).toBeGreaterThan(1);
    // Consecutive chunks overlap: the end lines of chunk N reappear at the start of chunk N+1.
    for (let i = 0; i + 1 < chunks.length; i++) {
      const a = chunks[i]!;
      const b = chunks[i + 1]!;
      expect(b.startLine).toBeLessThanOrEqual(a.endLine);
    }
  });

  it('overlap lines are byte-identical between consecutive chunks', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho';
    const chunks = chunkText(text, { chunkSize: 12, chunkOverlap: 6 });
    const allLines = text.split('\n');
    for (const c of chunks) {
      expect(c.text).toBe(allLines.slice(c.startLine - 1, c.endLine).join('\n'));
    }
  });

  it('always makes forward progress even when a single line exceeds chunkSize', () => {
    const text = 'x'.repeat(100) + '\n' + 'y'.repeat(100);
    const chunks = chunkText(text, { chunkSize: 10, chunkOverlap: 5 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[chunks.length - 1]!.endLine).toBe(2);
  });
});

describe('detectFunctionBoundaries', () => {
  it('finds top-level function declarations', () => {
    const text = ['function foo(a) {', '  return a;', '}', 'function bar() {}'].join('\n');
    const fns = detectFunctionBoundaries(text);
    expect(fns).toEqual([
      { name: 'foo', line: 1 },
      { name: 'bar', line: 4 },
    ]);
  });
  it('ignores non-declarations', () => {
    expect(detectFunctionBoundaries('var f = function() {}')).toEqual([]);
  });
});

describe('chunkFile', () => {
  it('produces stable ids of the form path#start-end', () => {
    const a = chunkFile('a.gml', 'one\ntwo\nthree', { chunkSize: 1000 });
    const b = chunkFile('a.gml', 'one\ntwo\nthree', { chunkSize: 1000 });
    expect(a[0]!.id).toBe('a.gml#1-3');
    expect(a).toEqual(b);
  });

  it('attaches per-function symbol refs for multi-function gml scripts', () => {
    const text = [
      'function clampHealth(v) {',
      '  return clamp(v, 0, 100);',
      '}',
      '',
      'function resetHealth() {',
      '  return 100;',
      '}',
    ].join('\n');
    const chunks = chunkFile('scripts/scr_util/scr_util.gml', text, {
      chunkSize: 40,
      chunkOverlap: 0,
    });
    const symbols = chunks.flatMap((c) => (c.symbol ? [c.symbol.name] : []));
    expect(symbols).toContain('clampHealth');
    expect(symbols).toContain('resetHealth');
    for (const c of chunks) {
      if (c.symbol) expect(c.symbol.kind).toBe('function');
    }
  });

  it('carries the content hash per chunk', () => {
    const chunks = chunkFile('a.gml', 'hello world', { chunkSize: 1000 });
    expect(chunks[0]!.contentHash).toBe(hashContent('hello world'));
  });

  it('NEVER emits a zero-length chunk for a >chunkSize line + trailing newline — F4', () => {
    // The classic repro: a line longer than chunkSize followed by a trailing newline used to add a
    // trailing `path#2-2` chunk of length 0 (which got embedded as input:['']).
    const chunks = chunkFile('test.ts', 'a'.repeat(3000) + '\n', { chunkSize: 1500 });
    for (const c of chunks) {
      expect(c.text.trim()).not.toBe('');
      expect(c.text.length).toBeGreaterThan(0);
    }
    // No chunk hashes the empty string (sha256('') = e3b0c442...).
    expect(chunks.map((c) => c.contentHash)).not.toContain(hashContent(''));
  });

  it('hard-caps a single oversize line into <=chunkSize character pieces with UNIQUE ids — F5', () => {
    const oneLine = 'x'.repeat(200_000); // a minified single-line file
    const chunks = chunkFile('min.js', oneLine, { chunkSize: 1500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1500);
    }
    // Reassembling the pieces reproduces the original line (no data lost).
    expect(chunks.map((c) => c.text).join('')).toBe(oneLine);
    // Every chunk id is DISTINCT — otherwise the id-keyed store would drop all but the last piece.
    const ids = chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('min.js#1-1~0');
  });
});
