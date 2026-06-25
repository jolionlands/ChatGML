import { describe, it, expect } from 'vitest';
import {
  buildToolRegistry,
  toOpenAiToolSpecs,
  dispatchTool,
} from '../../src/tools/index.js';
import { makeToolContext } from '../helpers/tool-context.js';
import { makeTmpRepo } from '../helpers/fakes.js';
import { buildIgnoreFilter } from '../../src/index/files.js';

describe('buildToolRegistry', () => {
  it('includes the gated apply_patch by default', () => {
    const reg = buildToolRegistry();
    expect(reg.has('apply_patch')).toBe(true);
    expect(reg.has('glob')).toBe(true);
    expect(reg.has('grep')).toBe(true);
    expect(reg.has('read_file')).toBe(true);
    expect(reg.has('search_code')).toBe(true);
    expect(reg.has('graph_neighbors')).toBe(true);
    expect(reg.has('temporal_query')).toBe(true);
  });

  it('omits apply_patch when readOnly', () => {
    const reg = buildToolRegistry({ readOnly: true });
    expect(reg.has('apply_patch')).toBe(false);
    expect(reg.has('glob')).toBe(true);
  });
});

describe('toOpenAiToolSpecs', () => {
  it('produces non-empty JSON Schemas with additionalProperties:false and matching names', () => {
    const reg = buildToolRegistry();
    const specs = toOpenAiToolSpecs(reg);
    const names = specs.map((s) => s.function.name).sort();
    expect(names).toEqual(
      [
        'apply_patch',
        'glob',
        'grep',
        'graph_neighbors',
        'read_file',
        'search_code',
        'temporal_query',
      ].sort(),
    );
    for (const s of specs) {
      const params = s.function.parameters as Record<string, unknown>;
      expect(params['type']).toBe('object');
      expect(params['additionalProperties']).toBe(false);
      expect(params['$schema']).toBeUndefined();
      // properties must be a populated object (proves zod3 + zod-to-json-schema produced a schema)
      expect(Object.keys(params['properties'] as Record<string, unknown>).length).toBeGreaterThan(0);
    }
    const glob = specs.find((s) => s.function.name === 'glob')!;
    const gp = glob.function.parameters as { required?: string[] };
    expect(gp.required).toContain('pattern');
  });
});

describe('dispatchTool', () => {
  it('runs a known tool and returns ok:true with content', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'x\n' });
    try {
      const ignore = await buildIgnoreFilter(repo.root);
      const { ctx } = makeToolContext({ root: repo.root, ignore });
      const reg = buildToolRegistry();
      const res = await dispatchTool(reg, 'glob', JSON.stringify({ pattern: '**/*.gml' }), ctx);
      expect(res.ok).toBe(true);
      expect(res.content).toContain('a.gml');
    } finally {
      repo.cleanup();
    }
  });

  it('returns ok:false bad_args for an unknown tool', async () => {
    const { ctx } = makeToolContext({ root: '/r' });
    const res = await dispatchTool(buildToolRegistry(), 'nope', '{}', ctx);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('bad_args');
  });

  it('returns ok:false bad_args for malformed JSON args', async () => {
    const { ctx } = makeToolContext({ root: '/r' });
    const res = await dispatchTool(buildToolRegistry(), 'glob', '{not json', ctx);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('bad_args');
  });

  it('returns ok:false bad_args for schema-invalid args', async () => {
    const { ctx } = makeToolContext({ root: '/r' });
    const res = await dispatchTool(buildToolRegistry(), 'glob', JSON.stringify({ limit: 5 }), ctx);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('bad_args'); // missing required pattern
  });

  it('returns ok:false aborted when the signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const { ctx } = makeToolContext({ root: '/r', signal: ac.signal });
    const res = await dispatchTool(buildToolRegistry(), 'glob', '{"pattern":"*"}', ctx);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('aborted');
  });

  it('catches a thrown ToolError into an ok:false envelope preserving the code', async () => {
    const { ctx } = makeToolContext({ root: '/proj/root' });
    const res = await dispatchTool(
      buildToolRegistry(),
      'apply_patch',
      JSON.stringify({ path: 'a.gml', diff: 'x' }),
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('not_implemented');
  });
});
