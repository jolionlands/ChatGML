import { describe, it, expect } from 'vitest';
import { cosineSim, fuse } from '../../src/memory/fusion.js';

describe('cosineSim', () => {
  it('is 1 for identical, 0 for orthogonal, -1 for opposite', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0]);
    const c = new Float32Array([0, 1]);
    const d = new Float32Array([-1, 0]);
    expect(cosineSim(a, b)).toBeCloseTo(1, 6);
    expect(cosineSim(a, c)).toBeCloseTo(0, 6);
    expect(cosineSim(a, d)).toBeCloseTo(-1, 6);
  });
  it('returns 0 against a zero vector', () => {
    expect(cosineSim(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });
  it('throws on a length mismatch', () => {
    expect(() => cosineSim(new Float32Array([1]), new Float32Array([1, 2]))).toThrow();
  });
});

describe('fuse', () => {
  it('ranks an item strong in BOTH lists above one strong in only one (minmax)', () => {
    const vector = [
      { id: 'both', score: 1.0 },
      { id: 'vonly', score: 0.9 },
    ];
    const keyword = [
      { id: 'both', score: 5 },
      { id: 'konly', score: 4 },
    ];
    const out = fuse(vector, keyword);
    expect(out[0]!.id).toBe('both');
  });

  it('a single-element list produces no NaN', () => {
    const out = fuse([{ id: 'a', score: 7 }], []);
    expect(out).toHaveLength(1);
    expect(Number.isNaN(out[0]!.score)).toBe(false);
    expect(out[0]!.score).toBe(0.5); // minmax of a single item => 1, weighted 0.5
  });

  it('rrf is stable and respects k', () => {
    const v = [
      { id: 'a', score: 3 },
      { id: 'b', score: 2 },
      { id: 'c', score: 1 },
    ];
    const k = [
      { id: 'b', score: 9 },
      { id: 'a', score: 8 },
    ];
    const out = fuse(v, k, { method: 'rrf', k: 2 });
    expect(out).toHaveLength(2);
    // 'a' and 'b' both appear in both lists near the top.
    expect(out.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('respects k for minmax', () => {
    const v = [
      { id: 'a', score: 3 },
      { id: 'b', score: 2 },
      { id: 'c', score: 1 },
    ];
    expect(fuse(v, [], { k: 1 })).toHaveLength(1);
  });

  it('empty inputs produce an empty result', () => {
    expect(fuse([], [])).toEqual([]);
  });
});
