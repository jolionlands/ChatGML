import { describe, it, expect } from 'vitest';
import { makeToolContext } from '../helpers/tool-context.js';
import { searchTool } from '../../src/tools/search.js';
import { graphTool } from '../../src/tools/graph.js';
import { temporalTool } from '../../src/tools/temporal.js';
import type { MemoryProvider } from '../../src/memory/provider.js';
import type { Hit } from '../../src/memory/types.js';

function fakeProvider(over: Partial<MemoryProvider>): MemoryProvider {
  return {
    id: 'local',
    capabilities: new Set(['upsert', 'search', 'graph', 'temporal', 'remember', 'recall']),
    async upsert() {},
    async search() {
      return [];
    },
    async graphNeighbors() {
      return [];
    },
    async temporalQuery() {
      return [];
    },
    async remember() {},
    async recall() {
      return [];
    },
    ...over,
  };
}

const GML_HIT: Hit = {
  chunkId: 'objects/obj_player/Step_0.gml#1-2',
  path: 'objects/obj_player/Step_0.gml',
  text: 'hp -= 1;',
  score: 0.9,
  source: 'fused',
  startLine: 1,
  endLine: 2,
};

describe('search_code tool', () => {
  it('passes k + scope and maps Hits to Citations with gml meta on .gml', async () => {
    let seen: { query: string; k: number; scope: unknown } | null = null;
    const memory = fakeProvider({
      async search(query, opts) {
        seen = { query, k: opts.k, scope: opts.scope };
        return [GML_HIT];
      },
    });
    const { ctx } = makeToolContext({ root: '/r', memory, scope: { repo: 'game' } });
    const res = await searchTool.execute({ query: 'player damage', k: 5 }, ctx);
    expect(seen).toEqual({ query: 'player damage', k: 5, scope: { repo: 'game' } });
    expect(res.citations).toHaveLength(1);
    expect(res.citations?.[0]?.path).toBe('objects/obj_player/Step_0.gml');
    expect(res.citations?.[0]?.provider).toBe('local');
    expect(res.citations?.[0]?.gml?.kind).toBe('event');
    expect(res.content).toContain('search result');
  });

  it('defaults k to 8', async () => {
    let k = -1;
    const memory = fakeProvider({
      async search(_q, opts) {
        k = opts.k;
        return [];
      },
    });
    const { ctx } = makeToolContext({ root: '/r', memory });
    await searchTool.execute({ query: 'x' }, ctx);
    expect(k).toBe(8);
  });

  it('surfaces a throwing provider as provider_error (no leak)', async () => {
    const memory = fakeProvider({
      async search() {
        throw new Error('internal boom');
      },
    });
    const { ctx } = makeToolContext({ root: '/r', memory });
    await expect(searchTool.execute({ query: 'x' }, ctx)).rejects.toMatchObject({
      name: 'ToolError',
      code: 'provider_error',
    });
  });
});

describe('graph_neighbors tool', () => {
  it('forwards the symbol ref and maps hits', async () => {
    let ref: unknown = null;
    const memory = fakeProvider({
      async graphNeighbors(r) {
        ref = r;
        return [{ ...GML_HIT, source: 'graph' }];
      },
    });
    const { ctx } = makeToolContext({ root: '/r', memory });
    const res = await graphTool.execute(
      { name: 'apply_dmg', path: 'scripts/scr_dmg/scr_dmg.gml', kind: 'function' },
      ctx,
    );
    expect(ref).toEqual({ name: 'apply_dmg', path: 'scripts/scr_dmg/scr_dmg.gml', kind: 'function' });
    expect(res.citations).toHaveLength(1);
  });

  it('provider throw -> provider_error', async () => {
    const memory = fakeProvider({
      async graphNeighbors() {
        throw new Error('x');
      },
    });
    const { ctx } = makeToolContext({ root: '/r', memory });
    await expect(graphTool.execute({ name: 'a' }, ctx)).rejects.toMatchObject({
      code: 'provider_error',
    });
  });
});

describe('temporal_query tool', () => {
  it('builds the TemporalQuery and maps temporal hits', async () => {
    let q: unknown = null;
    const memory = fakeProvider({
      async temporalQuery(query) {
        q = query;
        return [
          {
            chunkId: 'temporal:a.gml@1',
            path: 'a.gml',
            text: 'modified a.gml',
            score: 1,
            source: 'temporal',
          },
        ];
      },
    });
    const { ctx } = makeToolContext({ root: '/r', memory });
    const res = await temporalTool.execute(
      { path: 'a.gml', kind: 'changed-since', since: 1000, limit: 5 },
      ctx,
    );
    expect(q).toEqual({ kind: 'changed-since', path: 'a.gml', since: 1000, limit: 5 });
    expect(res.content).toContain('temporal result');
    expect(res.citations?.[0]?.path).toBe('a.gml');
  });

  it('defaults kind to history', async () => {
    let kind = '';
    const memory = fakeProvider({
      async temporalQuery(query) {
        kind = query.kind;
        return [];
      },
    });
    const { ctx } = makeToolContext({ root: '/r', memory });
    await temporalTool.execute({}, ctx);
    expect(kind).toBe('history');
  });

  it('provider throw -> provider_error', async () => {
    const memory = fakeProvider({
      async temporalQuery() {
        throw new Error('x');
      },
    });
    const { ctx } = makeToolContext({ root: '/r', memory });
    await expect(temporalTool.execute({}, ctx)).rejects.toMatchObject({ code: 'provider_error' });
  });
});
