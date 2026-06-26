import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeTmpRepo } from '../helpers/fakes.js';
import { makeToolContext } from '../helpers/tool-context.js';
import { buildIgnoreFilter } from '../../src/index/files.js';
import { grepTool } from '../../src/tools/grep.js';
import { ToolError } from '../../src/tool-error.js';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

const FILES = {
  'objects/obj_player/Step_0.gml': 'hp -= 1;\nif (hp <= 0) instance_destroy();\n',
  'objects/obj_enemy/Step_0.gml': 'x += 2;\nhp = clamp(hp, 0, 100);\n',
  'scripts/scr_dmg/scr_dmg.gml': 'function apply_dmg(amount) {\n  hp -= amount;\n}\n',
};

describe('grep tool', () => {
  it('finds a literal match with 1-based line numbers', async () => {
    const repo = makeTmpRepo(FILES);
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });
    const res = await grepTool.execute({ pattern: 'instance_destroy' }, ctx);
    expect(res.content).toContain('objects/obj_player/Step_0.gml:2:');
  });

  it('finds a regex match', async () => {
    const repo = makeTmpRepo(FILES);
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });
    const res = await grepTool.execute({ pattern: 'hp\\s*-=\\s*\\w+', regex: true }, ctx);
    expect(res.content).toContain('Step_0.gml');
    expect(res.content).toContain('scr_dmg.gml');
  });

  it('treats pattern as literal when regex flag is off', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'cost = a.b;\n' });
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });
    // "a.b" as a literal should match "a.b" but the dot is escaped, so "axb" must NOT match.
    const repo2 = makeTmpRepo({ 'a.gml': 'axb\n' });
    const ignore2 = await buildIgnoreFilter(repo2.root);
    const { ctx: ctx2 } = makeToolContext({ root: repo2.root, ignore: ignore2 });
    const res2 = await grepTool.execute({ pattern: 'a.b' }, ctx2);
    expect(res2.content).toBe('no matches');
    repo2.cleanup();
    const res = await grepTool.execute({ pattern: 'a.b' }, ctx);
    expect(res.content).toContain('a.gml:1:');
  });

  it('honors contextLines', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'line1\nTARGET\nline3\n' });
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });
    const res = await grepTool.execute({ pattern: 'TARGET', contextLines: 1 }, ctx);
    expect(res.content).toContain('a.gml-1- line1');
    expect(res.content).toContain('a.gml:2: TARGET');
    expect(res.content).toContain('a.gml-3- line3');
  });

  it('truncates at maxMatches', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'x\nx\nx\nx\n' });
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });
    const res = await grepTool.execute({ pattern: 'x', maxMatches: 2 }, ctx);
    expect(res.content).toContain('2 match(es) (truncated)');
  });

  it('skips binary files', async () => {
    const repo = makeTmpRepo({ 'text.gml': 'findme\n' });
    cleanup = repo.cleanup;
    writeFileSync(path.join(repo.root, 'blob.gml'), Buffer.from([0x66, 0x00, 0x66, 0x69]));
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });
    const res = await grepTool.execute({ pattern: 'f', regex: true }, ctx);
    expect(res.content).toContain('text.gml');
    expect(res.content).not.toContain('blob.gml');
  });

  it('rejects a nested-quantifier ReDoS pattern as bad_args BEFORE running', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'aaaa\n' });
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });
    await expect(grepTool.execute({ pattern: '(a+)+$', regex: true }, ctx)).rejects.toMatchObject({
      name: 'ToolError',
      code: 'bad_args',
    });
  });

  describe('ReDoS heuristic completeness (D5)', () => {
    async function ctxFor(): Promise<import('../helpers/tool-context.js').FakeCtx> {
      const repo = makeTmpRepo({ 'a.gml': 'aaaaaaaaaaaaX\n' });
      cleanup = repo.cleanup;
      const ignore = await buildIgnoreFilter(repo.root);
      return makeToolContext({ root: repo.root, ignore });
    }

    // Each of these previously slipped past the old heuristic; all must now be bad_args.
    const catastrophic = [
      '(.*a){25}', // large bounded repetition of a group with an inner unbounded quantifier
      '(.*X){5,}', // group with inner unbounded quantifier, unbounded outer repeat
      '(a+)*', // group inner + outer unbounded
      '(a*)+', // group inner + outer unbounded
      'a*a*', // adjacent unbounded quantifiers, same atom
      '.*.*', // adjacent unbounded quantifiers, '.' overlaps everything
      'a*a*a*X$', // chained adjacent unbounded quantifiers
      '\\w+\\w+', // adjacent unbounded quantifiers over overlapping classes
    ];
    for (const pattern of catastrophic) {
      it(`rejects catastrophic shape ${pattern}`, async () => {
        const { ctx } = await ctxFor();
        await expect(grepTool.execute({ pattern, regex: true }, ctx)).rejects.toMatchObject({
          name: 'ToolError',
          code: 'bad_args',
        });
      });
    }

    // Legitimate regexes (single quantifier, or disjoint adjacent classes) must STILL be allowed.
    const legitimate = ['function\\s+\\w+', 'foo.*bar', 'hp\\s*-=\\s*\\w+', '\\s+\\w+', 'a+b+'];
    for (const pattern of legitimate) {
      it(`allows legitimate regex ${pattern}`, async () => {
        const { ctx } = await ctxFor();
        // Must not throw bad_args for the shape (a "no matches" result is fine).
        const res = await grepTool.execute({ pattern, regex: true }, ctx);
        expect(typeof res.content).toBe('string');
      });
    }

    it('a normal search still works after the strengthened guard', async () => {
      const repo = makeTmpRepo({ 'scr.gml': 'function apply_dmg(amount) {\n  hp -= amount;\n}\n' });
      cleanup = repo.cleanup;
      const ignore = await buildIgnoreFilter(repo.root);
      const { ctx } = makeToolContext({ root: repo.root, ignore });
      const res = await grepTool.execute({ pattern: 'function\\s+\\w+', regex: true }, ctx);
      expect(res.content).toContain('scr.gml:1:');
    });
  });

  it('rejects an over-length pattern via schema (bad_args at registry layer)', () => {
    const tooLong = 'a'.repeat(513);
    expect(grepTool.schema.safeParse({ pattern: tooLong }).success).toBe(false);
  });

  it('restricts to a glob filter', async () => {
    const repo = makeTmpRepo(FILES);
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });
    const res = await grepTool.execute({ pattern: 'hp', glob: 'scripts/**/*.gml' }, ctx);
    expect(res.content).toContain('scr_dmg.gml');
    expect(res.content).not.toContain('obj_player');
  });

  it('throws ToolError aborted when the signal is already aborted', async () => {
    const repo = makeTmpRepo(FILES);
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const ac = new AbortController();
    ac.abort();
    const { ctx } = makeToolContext({ root: repo.root, ignore, signal: ac.signal });
    await expect(grepTool.execute({ pattern: 'hp' }, ctx)).rejects.toBeInstanceOf(ToolError);
  });
});
