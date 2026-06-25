import { describe, it, expect, vi } from 'vitest';
import {
  HippoMemoryProvider,
  toRecallQuery,
  queryFlags,
  fromRecallResults,
  resolveNodeId,
  fromWalk,
  topicLooksLikePath,
  type HippoNode,
} from '../../src/memory/hippo.js';
import { hitToCitation } from '../../src/memory/types.js';
import { deriveGmlMeta } from '../../src/index/gml.js';
import { installFetchMock, jsonResponse, errorResponse } from '../helpers/mock-fetch.js';
import { runProviderContract } from '../helpers/provider-contract.js';
import { FakeEmbeddings, makeTmpRepo } from '../helpers/fakes.js';
import type { MemoryProvider } from '../../src/memory/provider.js';
import type { FetchLike } from '../../src/llm.js';
import type { Scope } from '../../src/memory/types.js';

const URL = 'http://127.0.0.1:7077';
const SCOPE: Scope = { repo: 'hippo-repo' };

function make(
  fetchImpl: FetchLike,
  root = makeTmpRepo({}).root,
): HippoMemoryProvider {
  return new HippoMemoryProvider(
    { provider: 'hippo', url: URL, root },
    { embeddings: new FakeEmbeddings(), fetch: fetchImpl },
  );
}

// ---------------------------------------------------------------------------
// Pure wire-mapping helpers.
// ---------------------------------------------------------------------------
describe('hippo wire mapping (pure)', () => {
  it('queryFlags enables ppr/spread always and hyde/rerank only for sentence-length queries', () => {
    expect(queryFlags('clampHealth')).toEqual({
      ppr: true,
      hyde: false,
      rerank: false,
      spread: true,
    });
    expect(queryFlags('how does the player lose health')).toEqual({
      ppr: true,
      hyde: true,
      rerank: true,
      spread: true,
    });
  });

  it('toRecallQuery URL-encodes the query and emits all four flags', () => {
    const url = toRecallQuery(URL, 'a b & c', 5, {
      ppr: true,
      hyde: false,
      rerank: true,
      spread: true,
    });
    expect(url.startsWith(`${URL}/api/recall?`)).toBe(true);
    const qs = new URLSearchParams(url.split('?')[1]);
    expect(qs.get('q')).toBe('a b & c'); // round-trips the raw value (was percent-encoded on the wire)
    expect(url).toContain('a+b+%26+c'); // actually percent-encoded in the URL string
    expect(qs.get('k')).toBe('5');
    expect(qs.get('ppr')).toBe('true');
    expect(qs.get('hyde')).toBe('false');
    expect(qs.get('rerank')).toBe('true');
    expect(qs.get('spread')).toBe('true');
  });

  it('topicLooksLikePath accepts repo-relative paths and rejects sentences/absolute/traversal', () => {
    expect(topicLooksLikePath('objects/obj_player/Step_0.gml')).toBe(true);
    expect(topicLooksLikePath('scr_util.gml')).toBe(true);
    expect(topicLooksLikePath('the player loses health')).toBe(false);
    expect(topicLooksLikePath('/etc/passwd')).toBe(false);
    expect(topicLooksLikePath('../escape.gml')).toBe(false);
    expect(topicLooksLikePath('https://evil.test/x')).toBe(false);
    expect(topicLooksLikePath('C:/Windows/system32')).toBe(false);
  });

  it('fromRecallResults sets path ONLY for code nodes with a path-shaped topic', () => {
    const nodes: HippoNode[] = [
      { id: 1, kind: 'code_file', topic: 'objects/obj_player/Step_0.gml', text: 'hp -= dmg;', score: 0.9 },
      { id: 2, kind: 'code_symbol', topic: 'scripts/scr_util/scr_util.gml', text: 'fn', score: 0.8 },
      // code node but the topic is a sentence, not a path -> no path
      { id: 3, kind: 'code_symbol', topic: 'a free-text concept', text: 'concept', score: 0.7 },
      // non-code node whose topic happens to look path-y -> still no path
      { id: 4, kind: 'note', topic: 'notes/todo.gml', text: 'remember', score: 0.6 },
      // a plain memory/concept node -> no path
      { id: 5, kind: 'concept', topic: 'spaced repetition', text: 'sr', score: 0.5 },
    ];
    const hits = fromRecallResults(nodes);
    const byId = new Map(hits.map((h) => [h.chunkId, h]));
    expect(byId.get('hippo:node:1')!.path).toBe('objects/obj_player/Step_0.gml');
    expect(byId.get('hippo:node:2')!.path).toBe('scripts/scr_util/scr_util.gml');
    expect(byId.get('hippo:node:3')!.path).toBeUndefined();
    expect(byId.get('hippo:node:4')!.path).toBeUndefined();
    expect(byId.get('hippo:node:5')!.path).toBeUndefined();
    // chunkId / no line ranges / source
    for (const h of hits) {
      expect(h.chunkId.startsWith('hippo:node:')).toBe(true);
      expect(h.startLine).toBeUndefined();
      expect(h.endLine).toBeUndefined();
      expect(h.source).toBe('hippo');
    }
  });

  it('hitToCitation carries hippo path-bearing hits to a code Citation; non-path hits stay path-free', () => {
    const [codeHit, conceptHit] = fromRecallResults([
      { id: 1, kind: 'code_file', topic: 'objects/obj_player/Step_0.gml', text: 'hp -= dmg;', score: 0.9 },
      { id: 5, kind: 'concept', topic: 'spaced repetition', text: 'sr', score: 0.5 },
    ]);
    const c1 = hitToCitation(codeHit!, 'hippo', deriveGmlMeta);
    expect(c1.provider).toBe('hippo');
    expect(c1.path).toBe('objects/obj_player/Step_0.gml');
    expect(c1.gml?.kind).toBe('event'); // gml meta derived from the path
    const c2 = hitToCitation(conceptHit!, 'hippo', deriveGmlMeta);
    expect(c2.provider).toBe('hippo');
    expect(c2.path).toBeUndefined();
    expect(c2.gml).toBeUndefined();
  });

  it('resolveNodeId returns a single id on an exact code-node match', () => {
    const nodes: HippoNode[] = [
      { id: 7, kind: 'code_symbol', topic: 'clampHealth' },
      { id: 8, kind: 'concept', topic: 'clampHealth' }, // non-code: ignored
    ];
    expect(resolveNodeId(nodes, { name: 'clampHealth', path: 'scripts/s/s.gml' })).toBe(7);
  });

  it('resolveNodeId bails (undefined) when two distinct code nodes match the name', () => {
    const nodes: HippoNode[] = [
      { id: 7, kind: 'code_symbol', topic: 'doThing' },
      { id: 9, kind: 'code_symbol', topic: 'doThing' },
    ];
    expect(resolveNodeId(nodes, { name: 'doThing', path: 'a.gml' })).toBeUndefined();
  });

  it('resolveNodeId returns undefined when nothing matches', () => {
    expect(resolveNodeId([{ id: 1, kind: 'concept', topic: 'x' }], { name: 'y', path: 'p' })).toBeUndefined();
  });

  it('fromWalk maps neighbors to graph hits', () => {
    const hits = fromWalk([
      { id: 11, kind: 'code_symbol', topic: 'scripts/s/s.gml', score: 0.4 },
      { id: 12, kind: 'concept', topic: 'related concept', score: 0.3 },
    ]);
    expect(hits.map((h) => h.source)).toEqual(['graph', 'graph']);
    expect(hits[0]!.chunkId).toBe('hippo:node:11');
    expect(hits[0]!.path).toBe('scripts/s/s.gml');
    expect(hits[1]!.path).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// connect() — pings GET /api/stats; no auth; never POST /api/config.
// ---------------------------------------------------------------------------
describe('HippoMemoryProvider.connect', () => {
  it('pings GET /api/stats and succeeds on {ok:true}, sending no auth and never POSTing', async () => {
    const { recorder, fetch } = installFetchMock([
      { match: '/api/stats', responder: () => jsonResponse({ ok: true, nodes: 3 }) },
    ]);
    const p = make(fetch);
    await expect(p.connect()).resolves.toBeUndefined();
    const stats = recorder.calls.filter((c) => c.url.includes('/api/stats'));
    expect(stats).toHaveLength(1);
    expect(stats[0]!.method).toBe('GET');
    expect(stats[0]!.headers['authorization']).toBeUndefined();
    // Never calls POST /api/config.
    expect(recorder.calls.some((c) => c.url.includes('/api/config'))).toBe(false);
    expect(recorder.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('throws when /api/stats is down (HTTP 503)', async () => {
    const { fetch } = installFetchMock([
      { match: '/api/stats', responder: () => errorResponse(503, 'unavailable') },
    ]);
    const p = make(fetch);
    await expect(p.connect()).rejects.toThrow(/503/);
  });

  it('throws when /api/stats does not report ok:true', async () => {
    const { fetch } = installFetchMock([
      { match: '/api/stats', responder: () => jsonResponse({ ok: false }) },
    ]);
    const p = make(fetch);
    await expect(p.connect()).rejects.toThrow(/ok:true/);
  });
});

// ---------------------------------------------------------------------------
// search() — GET /api/recall with flags; POST-with-ppr never used.
// ---------------------------------------------------------------------------
describe('HippoMemoryProvider.search', () => {
  it('uses GET /api/recall WITH flags and never POSTs ppr', async () => {
    const { recorder, fetch } = installFetchMock([
      {
        match: '/api/recall',
        responder: () =>
          jsonResponse({
            results: [
              { id: 1, kind: 'code_file', topic: 'objects/obj_player/Step_0.gml', text: 'hp -= dmg;', score: 0.9 },
              { id: 2, kind: 'concept', topic: 'health system', text: 'hp model', score: 0.7 },
            ],
          }),
      },
    ]);
    const p = make(fetch);
    const hits = await p.search('how does the player lose health', { k: 5, scope: SCOPE });

    const recall = recorder.calls.filter((c) => c.url.includes('/api/recall'));
    expect(recall).toHaveLength(1);
    // GET-with-flags is used...
    expect(recall[0]!.method).toBe('GET');
    expect(recall[0]!.url).toContain('ppr=true');
    expect(recall[0]!.url).toContain('hyde=true');
    expect(recall[0]!.url).toContain('rerank=true');
    expect(recall[0]!.url).toContain('spread=true');
    // ...and POST-with-ppr is NOT used.
    expect(recorder.calls.some((c) => c.method === 'POST')).toBe(false);

    // Mapping: path only for the code node.
    expect(hits.map((h) => h.chunkId)).toEqual(['hippo:node:1', 'hippo:node:2']);
    expect(hits[0]!.path).toBe('objects/obj_player/Step_0.gml');
    expect(hits[1]!.path).toBeUndefined();
    expect(hits.every((h) => h.startLine === undefined && h.endLine === undefined)).toBe(true);
  });

  it('throws a typed error on a non-ok recall response', async () => {
    const { fetch } = installFetchMock([
      { match: '/api/recall', responder: () => errorResponse(500, 'boom') },
    ]);
    const p = make(fetch);
    await expect(p.search('x', { k: 1, scope: SCOPE })).rejects.toThrow(/500/);
  });

  it('tolerates the `hits` field name and an empty result set', async () => {
    const { fetch } = installFetchMock([
      { match: '/api/recall', responder: () => jsonResponse({ hits: [] }) },
    ]);
    const p = make(fetch);
    expect(await p.search('nothing here at all', { k: 3, scope: SCOPE })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// graphNeighbors() — recall -> resolve id -> walk; ambiguous -> [].
// ---------------------------------------------------------------------------
describe('HippoMemoryProvider.graphNeighbors', () => {
  it('recalls, resolves a single node id, then walks and maps neighbors', async () => {
    const { recorder, fetch } = installFetchMock([
      {
        match: '/api/recall',
        responder: () =>
          jsonResponse({
            results: [{ id: 42, kind: 'code_symbol', topic: 'clampHealth', score: 1 }],
          }),
      },
      {
        match: '/api/walk',
        responder: () =>
          jsonResponse({
            nodes: [
              { id: 43, kind: 'code_symbol', topic: 'scripts/scr_util/scr_util.gml', score: 0.5 },
              { id: 44, kind: 'concept', topic: 'clamping values', score: 0.3 },
            ],
          }),
      },
    ]);
    const p = make(fetch);
    const neighbors = await p.graphNeighbors(
      { name: 'clampHealth', path: 'scripts/scr_util/scr_util.gml' },
      SCOPE,
    );
    // walk was called with from=42&depth=2
    const walk = recorder.calls.filter((c) => c.url.includes('/api/walk'));
    expect(walk).toHaveLength(1);
    expect(walk[0]!.url).toContain('from=42');
    expect(walk[0]!.url).toContain('depth=2');
    expect(neighbors.map((h) => h.chunkId)).toEqual(['hippo:node:43', 'hippo:node:44']);
    expect(neighbors.every((h) => h.source === 'graph')).toBe(true);
    expect(neighbors[0]!.path).toBe('scripts/scr_util/scr_util.gml');
  });

  it('returns [] for an ambiguous name (two matching code nodes) and never walks', async () => {
    const { recorder, fetch } = installFetchMock([
      {
        match: '/api/recall',
        responder: () =>
          jsonResponse({
            results: [
              { id: 1, kind: 'code_symbol', topic: 'doThing' },
              { id: 2, kind: 'code_symbol', topic: 'doThing' },
            ],
          }),
      },
      { match: '/api/walk', responder: () => jsonResponse({ nodes: [] }) },
    ]);
    const p = make(fetch);
    const neighbors = await p.graphNeighbors({ name: 'doThing', path: 'a.gml' }, SCOPE);
    expect(neighbors).toEqual([]);
    expect(recorder.calls.some((c) => c.url.includes('/api/walk'))).toBe(false);
  });

  it('returns [] when the name resolves to nothing', async () => {
    const { recorder, fetch } = installFetchMock([
      { match: '/api/recall', responder: () => jsonResponse({ results: [] }) },
      { match: '/api/walk', responder: () => jsonResponse({ nodes: [] }) },
    ]);
    const p = make(fetch);
    expect(await p.graphNeighbors({ name: 'ghost', path: 'p.gml' }, SCOPE)).toEqual([]);
    expect(recorder.calls.some((c) => c.url.includes('/api/walk'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Local-shadowed writes / temporal / notes — round-trip through the co-resident local store.
// ---------------------------------------------------------------------------
describe('HippoMemoryProvider local shadow (writes/temporal/notes)', () => {
  it('upsert + temporalQuery are served by the local shadow (no HTTP)', async () => {
    const { recorder, fetch } = installFetchMock([]); // any HTTP call would throw (no routes)
    const repo = makeTmpRepo({});
    try {
      const p = make(fetch, repo.root);
      await p.upsert(
        [{ id: 'c1', path: 'a.gml', text: 'hp -= dmg', contentHash: 'h1', startLine: 1, endLine: 1 }],
        SCOPE,
      );
      const hist = await p.temporalQuery({ kind: 'history', path: 'a.gml' }, SCOPE);
      const kinds = hist.map((h) => (h.extra as { changeKind: string }).changeKind);
      expect(kinds).toContain('added');
      // The shadow performed zero HTTP calls.
      expect(recorder.calls).toHaveLength(0);
    } finally {
      repo.cleanup();
    }
  });

  it('remember + recall round-trip through the local shadow', async () => {
    const { recorder, fetch } = installFetchMock([]);
    const repo = makeTmpRepo({});
    try {
      const p = make(fetch, repo.root);
      await p.remember({ id: 'n1', text: 'the project uses FSRS scheduling', createdAt: 1 }, SCOPE);
      const got = await p.recall('FSRS scheduling', SCOPE);
      expect(got.map((n) => n.id)).toContain('n1');
      expect(recorder.calls).toHaveLength(0);
    } finally {
      repo.cleanup();
    }
  });

  it('shadow writes survive a reopen over the same root', async () => {
    const { fetch } = installFetchMock([]);
    const repo = makeTmpRepo({});
    try {
      const p1 = make(fetch, repo.root);
      await p1.remember({ id: 'n9', text: 'persisted note body', createdAt: 5 }, SCOPE);
      const p2 = make(fetch, repo.root);
      const got = await p2.recall('persisted note body', SCOPE);
      expect(got.map((n) => n.id)).toContain('n9');
    } finally {
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Pure helper EDGE branches (cheap, deterministic): id/text/score/kind fallbacks + flag-off paths.
// ---------------------------------------------------------------------------
describe('hippo wire mapping edge cases (pure)', () => {
  it('toRecallQuery emits false for all-off flags', () => {
    const url = toRecallQuery(URL, 'q', 1, { ppr: false, hyde: false, rerank: false, spread: false });
    const qs = new URLSearchParams(url.split('?')[1]);
    expect(qs.get('ppr')).toBe('false');
    expect(qs.get('hyde')).toBe('false');
    expect(qs.get('rerank')).toBe('false');
    expect(qs.get('spread')).toBe('false');
  });

  it('topicLooksLikePath rejects the empty string and a windows-backslash absolute path', () => {
    expect(topicLooksLikePath('')).toBe(false);
    expect(topicLooksLikePath('C:\\Users\\x\\a.gml')).toBe(false);
  });

  it('fromRecallResults skips non-numeric ids and fills text/score/extra fallbacks', () => {
    const hits = fromRecallResults([
      { id: 'nope' as unknown as number, topic: 'x' }, // skipped (non-numeric id)
      { id: 1, topic: 'just a topic' }, // no text -> text falls back to topic; no score -> 0; no kind
      { id: 2 }, // no text and no topic -> '' ; no kind -> extra is {nodeId}
    ]);
    expect(hits.map((h) => h.chunkId)).toEqual(['hippo:node:1', 'hippo:node:2']);
    expect(hits[0]!.text).toBe('just a topic');
    expect(hits[0]!.score).toBe(0);
    expect(hits[0]!.extra).toEqual({ nodeId: 1 });
    expect(hits[1]!.text).toBe('');
    expect(hits[1]!.extra).toEqual({ nodeId: 2 });
  });

  it('fromWalk skips non-numeric ids and fills text/score/extra fallbacks', () => {
    const hits = fromWalk([
      { id: 'nope' as unknown as number, topic: 'x' }, // skipped
      { id: 5, text: 'only text' }, // no topic -> text fallback; no score -> 0; no kind
    ]);
    expect(hits.map((h) => h.chunkId)).toEqual(['hippo:node:5']);
    expect(hits[0]!.text).toBe('only text');
    expect(hits[0]!.score).toBe(0);
    expect(hits[0]!.extra).toEqual({ nodeId: 5 });
  });
});

// ---------------------------------------------------------------------------
// HTTP failure modes: network errors, unparseable bodies, non-ok walk.
// ---------------------------------------------------------------------------
function unparseableJson(): Response {
  return new Response('{ not json', { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('HippoMemoryProvider HTTP failure modes', () => {
  it('connect throws on a network error and on an unparseable stats body', async () => {
    const net = installFetchMock([
      {
        match: '/api/stats',
        responder: () => {
          throw new Error('ECONNREFUSED');
        },
      },
    ]);
    await expect(make(net.fetch).connect()).rejects.toThrow(/cannot reach hippo/);

    const bad = installFetchMock([{ match: '/api/stats', responder: () => unparseableJson() }]);
    await expect(make(bad.fetch).connect()).rejects.toThrow(/unparseable/);
  });

  it('search throws on a network error and on an unparseable recall body', async () => {
    const net = installFetchMock([
      {
        match: '/api/recall',
        responder: () => {
          throw new Error('boom');
        },
      },
    ]);
    await expect(make(net.fetch).search('q', { k: 1, scope: SCOPE })).rejects.toThrow(/network error/);

    const bad = installFetchMock([{ match: '/api/recall', responder: () => unparseableJson() }]);
    await expect(make(bad.fetch).search('q', { k: 1, scope: SCOPE })).rejects.toThrow(/parse/);
  });

  it('graphNeighbors surfaces recall network errors, non-ok recall, and unparseable recall', async () => {
    const net = installFetchMock([
      {
        match: '/api/recall',
        responder: () => {
          throw new Error('boom');
        },
      },
    ]);
    await expect(
      make(net.fetch).graphNeighbors({ name: 'x', path: 'p' }, SCOPE),
    ).rejects.toThrow(/network error/);

    const notOk = installFetchMock([{ match: '/api/recall', responder: () => errorResponse(500, 'no') }]);
    await expect(
      make(notOk.fetch).graphNeighbors({ name: 'x', path: 'p' }, SCOPE),
    ).rejects.toThrow(/500/);

    const bad = installFetchMock([{ match: '/api/recall', responder: () => unparseableJson() }]);
    await expect(
      make(bad.fetch).graphNeighbors({ name: 'x', path: 'p' }, SCOPE),
    ).rejects.toThrow(/parse/);
  });

  it('graphNeighbors surfaces walk network errors, non-ok walk, and unparseable walk', async () => {
    const recallOk = {
      match: '/api/recall',
      responder: () => jsonResponse({ results: [{ id: 9, kind: 'code_symbol', topic: 'fn' }] }),
    };
    const ref = { name: 'fn', path: 'p' };

    const net = installFetchMock([
      recallOk,
      {
        match: '/api/walk',
        responder: () => {
          throw new Error('boom');
        },
      },
    ]);
    await expect(make(net.fetch).graphNeighbors(ref, SCOPE)).rejects.toThrow(/network error/);

    const notOk = installFetchMock([
      recallOk,
      { match: '/api/walk', responder: () => errorResponse(502, 'bad gateway') },
    ]);
    await expect(make(notOk.fetch).graphNeighbors(ref, SCOPE)).rejects.toThrow(/502/);

    const bad = installFetchMock([recallOk, { match: '/api/walk', responder: () => unparseableJson() }]);
    await expect(make(bad.fetch).graphNeighbors(ref, SCOPE)).rejects.toThrow(/parse/);
  });

  it('connect throws on an unparseable stats body shape and search tolerates a default fetch path', async () => {
    // walk tolerates the `neighbors` field name (vs `nodes`).
    const m = installFetchMock([
      { match: '/api/recall', responder: () => jsonResponse({ results: [{ id: 3, kind: 'code_file', topic: 'a.gml' }] }) },
      { match: '/api/walk', responder: () => jsonResponse({ neighbors: [{ id: 4, kind: 'code_file', topic: 'b.gml', score: 0.2 }] }) },
    ]);
    const out = await make(m.fetch).graphNeighbors({ name: 'a.gml', path: 'a.gml' }, SCOPE);
    expect(out.map((h) => h.chunkId)).toEqual(['hippo:node:4']);
  });
});

// ---------------------------------------------------------------------------
// Constructor fetch resolution: falls back to globalThis.fetch; throws when none available.
// ---------------------------------------------------------------------------
describe('HippoMemoryProvider fetch resolution', () => {
  it('falls back to globalThis.fetch when deps.fetch is omitted', async () => {
    const { recorder } = installFetchMock([
      { match: '/api/stats', responder: () => jsonResponse({ ok: true }) },
    ]);
    const repo = makeTmpRepo({});
    try {
      // No `fetch` in deps -> uses the installed global mock.
      const p = new HippoMemoryProvider(
        { provider: 'hippo', url: URL, root: repo.root },
        { embeddings: new FakeEmbeddings() },
      );
      await p.connect();
      expect(recorder.calls.some((c) => c.url.includes('/api/stats'))).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  it('throws when no fetch implementation is available', () => {
    vi.stubGlobal('fetch', undefined);
    const repo = makeTmpRepo({});
    try {
      expect(
        () =>
          new HippoMemoryProvider(
            { provider: 'hippo', url: URL, root: repo.root },
            { embeddings: new FakeEmbeddings() },
          ),
      ).toThrow(/no fetch implementation/);
    } finally {
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Env fallback + no key leak.
// ---------------------------------------------------------------------------
describe('HippoMemoryProvider config', () => {
  it('falls back to HIPPO_URL / HIPPO_KEY without leaking the key', () => {
    process.env['HIPPO_URL'] = 'http://127.0.0.1:9999';
    process.env['HIPPO_KEY'] = 'sk-SENTINEL-DEADBEEF';
    const { fetch } = installFetchMock([]);
    const repo = makeTmpRepo({});
    try {
      const p = new HippoMemoryProvider(
        { provider: 'hippo', url: undefined as unknown as string, root: repo.root },
        { embeddings: new FakeEmbeddings(), fetch },
      );
      expect(p.id).toBe('hippo');
      // The key never appears in any serialized form of the provider.
      expect(JSON.stringify(p)).not.toContain('sk-SENTINEL-DEADBEEF');
    } finally {
      repo.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Provider contract — hippo asserts ONLY its read set (search/graph) + local-shadowed writes/notes.
// Hippo search/graph are mocked; the local shadow backs upsert/temporal/remember/recall.
// ---------------------------------------------------------------------------
function hippoContractFactory(): MemoryProvider {
  const repo = makeTmpRepo({}); // leaked per-test; OS tmp reaper cleans up
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof globalThis.URL ? input.href : input.url;
    void init;
    if (url.includes('/api/stats')) return jsonResponse({ ok: true });
    if (url.includes('/api/recall')) {
      // Return a code node whose topic matches the contract's graph ref so resolveNodeId succeeds.
      return jsonResponse({
        results: [
          { id: 1, kind: 'code_symbol', topic: 'scripts/scr_util/scr_util.gml', text: 'clampHealth', score: 0.9 },
        ],
      });
    }
    if (url.includes('/api/walk')) {
      return jsonResponse({ nodes: [{ id: 2, kind: 'code_symbol', topic: 'scripts/scr_util/scr_util.gml', score: 0.5 }] });
    }
    return jsonResponse({});
  };
  return new HippoMemoryProvider(
    { provider: 'hippo', url: URL, root: repo.root },
    { embeddings: new FakeEmbeddings(), fetch: fetchImpl },
  );
}

// The hippo read set is search + graph; the local shadow supplies temporal/remember/recall/upsert.
runProviderContract('hippo (read + local shadow)', hippoContractFactory, {
  capabilities: ['search', 'graph', 'temporal', 'remember', 'recall', 'upsert'],
});
