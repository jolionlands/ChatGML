// src/memory/hippo.ts — STUB adapter for the hippo graph/temporal memory store.  [implemented in M5]
//
// This is a deliberate skeleton: it satisfies MemoryProvider and compiles, but every method is a
// clearly-marked TODO. The real adapter (M5) is READ-only over hippo's HTTP API (`GET /api/recall`,
// `GET /api/walk`, `GET /api/stats`) with writes/temporal local-shadowed by a co-resident
// LocalMemoryProvider — see the plan §7. Do NOT flesh this out before M5.
//
// Config: the hippo URL comes from `input.url` (resolved config) but falls back to the HIPPO_URL env
// var; an optional key falls back to HIPPO_KEY. hippo's HTTP is unauthenticated localhost in v1, so
// the key is kept only for a future authenticated proxy and is NEVER logged.
import type { MemoryProvider, MemoryProviderInput, MemoryDeps } from './provider.js';
import type { Embeddings } from '../index/embeddings.js';
import type { Scope, Chunk, Hit, TemporalQuery, SessionNote, SymbolRef } from './types.js';

function notImplemented(method: string): Error {
  return new Error(`HippoMemoryProvider.${method} is not implemented yet (lands in M5)`);
}

export class HippoMemoryProvider implements MemoryProvider {
  readonly id = 'hippo' as const;
  // M5 will advertise the read set served over HTTP plus the local-shadowed write/temporal set.
  readonly capabilities = new Set([
    'search',
    'graph',
    'temporal',
    'remember',
    'recall',
    'upsert',
  ] as const);

  private readonly url: string;
  private readonly key: string | undefined;
  private readonly embeddings: Embeddings;

  constructor(input: MemoryProviderInput, deps: MemoryDeps) {
    // input is narrowed to the hippo variant by createMemoryProvider's switch.
    const hippoInput = input as Extract<MemoryProviderInput, { provider: 'hippo' }>;
    this.url = hippoInput.url ?? process.env['HIPPO_URL'] ?? 'http://127.0.0.1:7077';
    this.key = hippoInput.key ?? process.env['HIPPO_KEY'];
    this.embeddings = deps.embeddings;
    void this.url; // reserved: M5 HTTP base for /api/recall, /api/walk, /api/stats
    void this.embeddings; // reserved: M5 may embed queries for HyDE
    void this.key; // reserved: M5 authenticated-proxy support; never logged
  }

  /**
   * TODO(M5): ping `GET ${url}/api/stats`, assert `{ok:true}`, send no auth. Throw fail-fast if down.
   */
  async connect(): Promise<void> {
    throw notImplemented('connect');
  }

  /**
   * TODO(M5): writes have NO hippo HTTP route. Route through a co-resident LocalMemoryProvider
   * (local shadow) so upsert/changelog still work when provider=hippo.
   */
  async upsert(_chunks: Chunk[], _scope: Scope): Promise<void> {
    throw notImplemented('upsert');
  }

  /**
   * TODO(M5): `GET ${url}/api/recall?q=...&ppr=&hyde=&rerank=&spread=` (GET so the rerank flags take
   * effect; POST's ppr is a no-op). Map via `hitToCitation(_, 'hippo', deriveGmlMeta)`. Set
   * `Citation.path` only for code_file/code_symbol nodes whose topic parses as a repo-relative path.
   * `Hit.chunkId = 'hippo:node:' + id`; no line ranges.
   */
  async search(_query: string, _opts: { k: number; scope: Scope }): Promise<Hit[]> {
    throw notImplemented('search');
  }

  /**
   * TODO(M5): `recall(ref.name)` -> resolve a numeric node id (exact-topic match, else bail to [])
   * -> `GET ${url}/api/walk?from=<id>&depth=2`. source:'graph', text = node topic.
   */
  async graphNeighbors(_ref: SymbolRef, _scope: Scope): Promise<Hit[]> {
    throw notImplemented('graphNeighbors');
  }

  /** TODO(M5): hippo has no temporal HTTP route -> serve from the local-shadow changelog. */
  async temporalQuery(_q: TemporalQuery, _scope: Scope): Promise<Hit[]> {
    throw notImplemented('temporalQuery');
  }

  /** TODO(M5): local-shadowed (no hippo HTTP write route). */
  async remember(_note: SessionNote, _scope: Scope): Promise<void> {
    throw notImplemented('remember');
  }

  /** TODO(M5): local-shadowed notes recall (hippo recall is for graph nodes, not session notes). */
  async recall(_query: string, _scope: Scope): Promise<SessionNote[]> {
    throw notImplemented('recall');
  }
}
