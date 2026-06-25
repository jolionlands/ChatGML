import { describe, it, expect } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { hashVector, FakeEmbeddings, makeTmpRepo } from './fakes.js';

describe('fakes helper', () => {
  it('hashVector is deterministic and unit-normalized', () => {
    const a = hashVector('obj_player');
    const b = hashVector('obj_player');
    expect([...a]).toEqual([...b]);
    let norm = 0;
    for (const x of a) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
    // Different inputs -> different vectors.
    const c = hashVector('obj_enemy');
    expect([...a]).not.toEqual([...c]);
  });

  it('FakeEmbeddings is deterministic across instances and never fetches', async () => {
    const e1 = new FakeEmbeddings();
    const e2 = new FakeEmbeddings();
    const [v1] = await e1.embed(['hello']);
    const [v2] = await e2.embed(['hello']);
    expect([...v1!]).toEqual([...v2!]);
    expect(e1.dim).toBe(64);
  });

  it('makeTmpRepo creates files and cleans up', () => {
    const { root, cleanup } = makeTmpRepo(
      { 'objects/obj_player/Step_0.gml': 'hp -= 1;' },
      { gitignore: 'build/\n' },
    );
    expect(existsSync(`${root}/objects/obj_player/Step_0.gml`)).toBe(true);
    expect(existsSync(`${root}/.gitignore`)).toBe(true);
    // can write more files under root
    writeFileSync(`${root}/extra.txt`, 'x');
    cleanup();
    expect(existsSync(root)).toBe(false);
  });
});
