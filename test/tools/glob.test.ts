import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { makeTmpRepo } from '../helpers/fakes.js';
import { makeToolContext } from '../helpers/tool-context.js';
import { buildIgnoreFilter } from '../../src/index/files.js';
import { globTool } from '../../src/tools/glob.js';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

const FILES = {
  'objects/obj_player/Step_0.gml': 'hp -= 1;',
  'objects/obj_player/Create_0.gml': 'hp = 100;',
  'scripts/scr_util/scr_util.gml': 'function scr_util() {}',
  'notes/todo.txt': 'todo',
  'build/output.gml': 'generated',
};

describe('glob tool', () => {
  it('finds **/*.gml and annotates GML events; excludes build/', async () => {
    const repo = makeTmpRepo(FILES);
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });

    const res = await globTool.execute({ pattern: '**/*.gml' }, ctx);
    expect(res.content).toContain('objects/obj_player/Step_0.gml');
    expect(res.content).toContain('objects/obj_player/Create_0.gml');
    expect(res.content).toContain('scripts/scr_util/scr_util.gml');
    // build/ is in EXCLUDE_DIRS
    expect(res.content).not.toContain('build/output.gml');
    // GML event annotation present
    expect(res.content).toMatch(/Step_0\.gml\s+\[Step\]/);
  });

  it('respects a more specific pattern', async () => {
    const repo = makeTmpRepo(FILES);
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });
    const res = await globTool.execute({ pattern: 'scripts/**/*.gml' }, ctx);
    expect(res.content).toContain('scripts/scr_util/scr_util.gml');
    expect(res.content).not.toContain('objects/');
  });

  it('honors .gitignore via the IgnoreFilter', async () => {
    const repo = makeTmpRepo(FILES, { gitignore: 'scr_util.gml\n' });
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });
    const res = await globTool.execute({ pattern: '**/*.gml' }, ctx);
    expect(res.content).not.toContain('scr_util.gml');
    expect(res.content).toContain('Step_0.gml');
  });

  it('truncates at limit', async () => {
    const repo = makeTmpRepo(FILES);
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });
    const res = await globTool.execute({ pattern: '**/*.gml', limit: 1 }, ctx);
    expect(res.content).toContain('1 file(s) (truncated)');
  });

  it('returns "no files matched" when nothing matches', async () => {
    const repo = makeTmpRepo(FILES);
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });
    const res = await globTool.execute({ pattern: '**/*.nonexistent' }, ctx);
    expect(res.content).toBe('no files matched');
  });

  it('a ".." pattern that resolves back into root does NOT crash with provider_error — F9', async () => {
    const repo = makeTmpRepo(FILES);
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });
    // fast-glob returns `../<basename>/objects/...` (the `..` lands back inside root because the dir
    // name is in the pattern). The `ignore` lib used to THROW on the non-relative path, swallowed into
    // a generic provider_error. It must now cleanly skip out-of-sandbox matches instead.
    const base = path.basename(repo.root);
    const res = await globTool.execute({ pattern: `../${base}/objects/**/*.gml` }, ctx);
    // No throw; the `../`-leading matches are treated as out-of-sandbox and filtered to nothing.
    expect(res.content).toBe('no files matched');
  });

  it('a plain "../*" escape pattern returns no files (never throws) — F9', async () => {
    const repo = makeTmpRepo(FILES);
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });
    const res = await globTool.execute({ pattern: '../*' }, ctx);
    expect(res.content).toBe('no files matched');
  });
});
