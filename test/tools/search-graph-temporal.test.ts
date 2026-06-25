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

  it('forwards a per-call minScore arg to the provider (D1)', async () => {
    let seenMin: number | undefined = -1;
    const memory = fakeProvider({
      async search(_q, opts) {
        seenMin = opts.minScore;
        return [];
      },
    });
    const { ctx } = makeToolContext({ root: '/r', memory });
    await searchTool.execute({ query: 'x', minScore: 0.3 }, ctx);
    expect(seenMin).toBe(0.3);
  });

  it('falls back to the config-level searchMinScore when no arg is given (D1)', async () => {
    let seenMin: number | undefined = -1;
    const memory = fakeProvider({
      async search(_q, opts) {
        seenMin = opts.minScore;
        return [];
      },
    });
    // ctx.searchMinScore comes from config.search.minScore at the agent wiring seam.
    const { ctx } = makeToolContext({ root: '/r', memory, searchMinScore: 0.25 });
    await searchTool.execute({ query: 'x' }, ctx);
    expect(seenMin).toBe(0.25);
  });

  it('a per-call minScore arg overrides the config floor (D1)', async () => {
    let seenMin: number | undefined = -1;
    const memory = fakeProvider({
      async search(_q, opts) {
        seenMin = opts.minScore;
        return [];
      },
    });
    const { ctx } = makeToolContext({ root: '/r', memory, searchMinScore: 0.25 });
    await searchTool.execute({ query: 'x', minScore: 0.7 }, ctx);
    expect(seenMin).toBe(0.7);
  });

  it('passes minScore: undefined (no floor) when neither arg nor config sets it (D1)', async () => {
    let called = false;
    let seenMin: number | undefined = 0.5;
    const memory = fakeProvider({
      async search(_q, opts) {
        called = true;
        seenMin = opts.minScore;
        return [];
      },
    });
    const { ctx } = makeToolContext({ root: '/r', memory });
    await searchTool.execute({ query: 'x' }, ctx);
    expect(called).toBe(true);
    expect(seenMin).toBeUndefined();
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
  it('builds the TemporalQuery and maps temporal hits (F12: changedAt, not score)', async () => {
    let q: unknown = null;
    const TS = 1782422357447; // a 2026 epoch ms
    const memory = fakeProvider({
      async temporalQuery(query) {
        q = query;
        return [
          {
            chunkId: 'temporal:a.gml@1',
            path: 'a.gml',
            text: 'modified a.gml',
            score: TS, // local provider sets score = timestamp
            source: 'temporal',
            extra: { changeKind: 'modified', contentHash: 'h', timestamp: TS },
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
    // Dedicated formatter: ISO date + change kind, NOT "score 1782422357447.000".
    expect(res.content).toContain('change event(s)');
    expect(res.content).toContain('modified');
    expect(res.content).not.toContain('score 1782422357447');
    const c = res.citations?.[0];
    expect(c?.path).toBe('a.gml');
    // The epoch is surfaced in changedAt/changeKind and NEVER leaked into the 0..1 relevance score.
    expect(c?.changedAt).toBe(TS);
    expect(c?.changeKind).toBe('modified');
    expect(c?.score).toBeUndefined();
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

  it('formats a hit with NO extra/path defensively (unknown time/kind/loc) — F12', async () => {
    const memory = fakeProvider({
      async temporalQuery() {
        // A degenerate hit: no `extra`, a non-finite score, and no path.
        return [{ chunkId: 'temporal:?', text: 'x', score: NaN, source: 'temporal' }];
      },
    });
    // No path arg either -> exercises the optional `args.path` branch.
    const { ctx } = makeToolContext({ root: '/r', memory });
    const res = await temporalTool.execute({}, ctx);
    expect(res.content).toContain('unknown time');
    expect(res.content).toContain('changed'); // changeKind fallback
    expect(res.content).toContain('(unknown)'); // path fallback
    // Defensive citation: no changedAt (NaN dropped), no changeKind, no score.
    const c = res.citations?.[0];
    expect(c?.changedAt).toBeUndefined();
    expect(c?.changeKind).toBeUndefined();
    expect(c?.score).toBeUndefined();
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
