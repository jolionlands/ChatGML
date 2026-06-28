import { describe, it, expect } from 'vitest';
import { scopeKey, makeScope, hitToCitation } from '../../src/memory/types.js';
import type { Hit } from '../../src/memory/types.js';
import { deriveGmlMeta } from '../../src/index/gml.js';

describe('scopeKey / makeScope', () => {
  it('round-trips a bare repo', () => {
    expect(scopeKey({ repo: 'r' })).toBe('r');
    expect(makeScope('r')).toEqual({ repo: 'r' });
  });
  it('round-trips a sub-scope via ::', () => {
    expect(scopeKey({ repo: 'a', sub: 'b' })).toBe('a::b');
    expect(makeScope('a::b')).toEqual({ repo: 'a', sub: 'b' });
  });
  it('splits only on the first ::', () => {
    expect(makeScope('a::b::c')).toEqual({ repo: 'a', sub: 'b::c' });
  });
});

describe('hitToCitation', () => {
  it('is total: copies path/lines/symbol and derives gml for a .gml path', () => {
    const hit: Hit = {
      chunkId: 'c1',
      path: 'objects/obj_player/Step_0.gml',
      text: 'hp -= 1;',
      score: 0.9,
      source: 'fused',
      startLine: 1,
      endLine: 2,
      symbol: { name: 'foo', path: 'objects/obj_player/Step_0.gml' },
    };
    const c = hitToCitation(hit, 'local', deriveGmlMeta);
    expect(c.path).toBe('objects/obj_player/Step_0.gml');
    expect(c.snippet).toBe('hp -= 1;');
    expect(c.score).toBe(0.9);
    expect(c.provider).toBe('local'); // from the arg, not hit.source
    expect(c.startLine).toBe(1);
    expect(c.endLine).toBe(2);
    expect(c.symbol?.name).toBe('foo');
    expect(c.gml).toMatchObject({ kind: 'event', eventType: 'Step' });
  });

  it('a pathless hit produces a citation without a path or gml', () => {
    const hit: Hit = {
      chunkId: 'hippo:node:5',
      text: 'a memory node',
      score: 0.5,
      source: 'hippo',
    };
    const c = hitToCitation(hit, 'hippo', deriveGmlMeta);
    expect(c.path).toBeUndefined();
    expect(c.gml).toBeUndefined();
    expect(c.provider).toBe('hippo');
    expect(c.snippet).toBe('a memory node');
  });

  it('provider comes from the identity arg, not the hit source (graph hit stays hippo)', () => {
    const hit: Hit = { chunkId: 'x', path: 'a.txt', text: 't', score: 1, source: 'graph' };
    expect(hitToCitation(hit, 'hippo', deriveGmlMeta).provider).toBe('hippo');
  });
});
