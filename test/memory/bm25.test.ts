import { describe, it, expect } from 'vitest';
import { Bm25Index, tokenize } from '../../src/memory/bm25.js';

describe('tokenize', () => {
  it('splits camelCase and snake_case and punctuation', () => {
    expect(tokenize('playerHealth')).toEqual(['player', 'health']);
    expect(tokenize('player_health')).toEqual(['player', 'health']);
    expect(tokenize('hp -= dmg;')).toEqual(['hp', 'dmg']);
  });
  it('splits letter/digit boundaries', () => {
    expect(tokenize('Step0')).toEqual(['step', '0']);
    expect(tokenize('obj2player')).toEqual(['obj', '2', 'player']);
  });
});

describe('Bm25Index', () => {
  it('ranks a matching document above a non-matching one', () => {
    const idx = new Bm25Index();
    idx.add('d1', 'the player loses health when damaged');
    idx.add('d2', 'render the user interface buttons');
    const res = idx.search('player health');
    expect(res[0]!.id).toBe('d1');
  });

  it('re-adding the same id replaces it (no double tf)', () => {
    const idx = new Bm25Index();
    idx.add('d1', 'alpha alpha alpha');
    const first = idx.search('alpha')[0]!.score;
    idx.add('d1', 'alpha alpha alpha'); // idempotent replace
    expect(idx.size).toBe(1);
    expect(idx.search('alpha')[0]!.score).toBeCloseTo(first, 10);
  });

  it('remove drops a document', () => {
    const idx = new Bm25Index();
    idx.add('d1', 'unique token zebra');
    idx.add('d2', 'other words');
    idx.remove('d1');
    expect(idx.size).toBe(1);
    expect(idx.search('zebra')).toEqual([]);
  });

  it('has a deterministic id tie-break on equal scores', () => {
    const idx = new Bm25Index();
    idx.add('b', 'token');
    idx.add('a', 'token');
    const res = idx.search('token');
    expect(res.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('respects k', () => {
    const idx = new Bm25Index();
    for (let i = 0; i < 5; i++) idx.add(`d${i}`, 'common term');
    expect(idx.search('common', 2)).toHaveLength(2);
  });

  it('round-trips through JSON', () => {
    const idx = new Bm25Index();
    idx.add('d1', 'player health system');
    idx.add('d2', 'enemy attack logic');
    const restored = Bm25Index.fromJSON(idx.toJSON());
    expect(restored.size).toBe(2);
    expect(restored.search('player')[0]!.id).toBe('d1');
    expect(restored.search('player')[0]!.score).toBeCloseTo(idx.search('player')[0]!.score, 10);
  });

  it('empty index returns no results', () => {
    expect(new Bm25Index().search('anything')).toEqual([]);
  });
});
