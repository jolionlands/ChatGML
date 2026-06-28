import { describe, it, expect, afterEach } from 'vitest';
import { makeTmpRepo } from '../helpers/fakes.js';
import { makeToolContext } from '../helpers/tool-context.js';
import { buildIgnoreFilter } from '../../src/index/files.js';
import { buildToolRegistry } from '../../src/tools/index.js';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('search_files tool alias', () => {
  it('is registered in the tool registry', () => {
    const registry = buildToolRegistry();
    expect(registry.has('search_files')).toBe(true);
  });

  it('delegates to grep and returns matches', async () => {
    const repo = makeTmpRepo({ 'objects/obj_player/Step_0.gml': 'hp -= 1;\n' });
    cleanup = repo.cleanup;
    const ignore = await buildIgnoreFilter(repo.root);
    const { ctx } = makeToolContext({ root: repo.root, ignore });
    const registry = buildToolRegistry();
    const tool = registry.get('search_files')!;
    const res = await tool.execute({ pattern: 'hp' }, ctx);
    expect(res.content).toContain('Step_0.gml');
  });
});
