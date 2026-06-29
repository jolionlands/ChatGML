// test/plugin/fuzzy.test.ts — covers the dependency-free fuzzy matcher used by the @file
// autocomplete. Pins both the CJS plugin port (plugin/fuzzy.js) and (where applicable) any future
// ESM re-export. Tests focus on: ordering (best match first), limit cap, no-match handling,
// case-insensitivity, and the special "every char in order" fallback.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const f = require('../../plugin/fuzzy.js') as {
  score: (c: string, q: string) => number | null;
  filter: (cands: string[], q: string, limit?: number) => string[];
};

describe('plugin/fuzzy.js — score()', () => {
  it('returns a low score for a prefix match (best)', () => {
    const s = f.score('scripts/player.gml', 'scripts');
    expect(s).not.toBeNull();
    expect(s!).toBeLessThan(50);
  });

  it('returns a higher score for a mid-string substring match than for a prefix', () => {
    const prefix = f.score('scripts/player.gml', 'scripts')!;
    const mid = f.score('my_scripts/player.gml', 'scripts')!;
    expect(prefix).toBeLessThan(mid);
  });

  it('falls back to char-fuzzy scoring when there is no substring match', () => {
    // 's' 'c' 'r' 'i' 'p' 't' all appear in order in "SxCxRxIxPxT" but NOT as a substring.
    const s = f.score('SxCxRxIxPxT', 'script');
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThan(999);
  });

  it('returns null for no match', () => {
    expect(f.score('player.gml', 'zzzzz')).toBeNull();
  });

  it('is case-insensitive', () => {
    const a = f.score('PlayerGML', 'playergml');
    const b = f.score('PlayerGML', 'PLAYERGML');
    expect(a).toBe(b);
    expect(a).not.toBeNull();
    // And a hard non-match in any case still returns null.
    expect(f.score('PlayerGML', 'zzz')).toBeNull();
    expect(f.score('PlayerGML', 'ZZZ')).toBeNull();
  });

  it('returns 1 (best neutral) for an empty query', () => {
    expect(f.score('anything', '')).toBe(1);
  });
});

describe('plugin/fuzzy.js — filter()', () => {
  const FILES = [
    'scripts/player/player_step.gml',
    'scripts/player/player_draw.gml',
    'scripts/enemy/enemy_step.gml',
    'scripts/utils/array_helpers.gml',
    'objects/obj_player.yy',
    'objects/obj_enemy.yy',
    'sprites/spr_player_idle.png',
    'rooms/rm_main.room.gmx',
    'README.md',
  ];

  it('returns the top-N most-relevant matches ordered by score', () => {
    const r = f.filter(FILES, 'player', 4);
    expect(r.length).toBe(4);
    // Every result should contain 'player' (case-insensitive)
    for (const f of r) expect(f.toLowerCase()).toContain('player');
    // Top result is the earliest-indexed match (the scripts/player/ paths have 'player'
    // at position 8, the objects/ paths have it at position 9; scripts win).
    expect(r[0]).toBe('scripts/player/player_step.gml');
  });

  it('respects the limit cap', () => {
    const r = f.filter(FILES, 's', 3);
    expect(r.length).toBe(3);
  });

  it('returns an empty array when nothing matches', () => {
    expect(f.filter(FILES, 'zzzzz')).toEqual([]);
  });

  it('returns up to `limit` items when query is empty (initial state)', () => {
    const r = f.filter(FILES, '', 5);
    expect(r.length).toBe(5);
    expect(r[0]).toBe(FILES[0]);
  });

  it('is stable and deterministic for the same input', () => {
    const a = f.filter(FILES, 'player', 8);
    const b = f.filter(FILES, 'player', 8);
    expect(a).toEqual(b);
  });
});
