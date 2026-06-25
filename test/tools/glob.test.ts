import { describe, it, expect, afterEach } from 'vitest';
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
});
