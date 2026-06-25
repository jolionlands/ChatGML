// src/memory/hippo.ts — the hippo memory adapter (M5).
//
// hippo's HTTP API is READ-only over GET routes + `POST /api/recall` + `POST /api/config`; there is no
// HTTP write route and no auth (it is a trusted 127.0.0.1 loopback). Therefore this provider is a
// HYBRID:
//   - search / graphNeighbors  -> hippo over HTTP (GET so ppr/hyde/rerank/spread flags take effect;
//                                  POST /api/recall's ppr is a no-op so we never use it).
//   - upsert / temporalQuery / remember / recall -> LOCAL-SHADOWED via a co-resident
//                                  LocalMemoryProvider over `<root>/.chatgml/` (hippo has no HTTP
//                                  write/temporal route), so the hybrid still satisfies the FULL
//                                  MemoryProvider interface.
//
// `connect()` pings `GET ${url}/api/stats`, asserts `{ok:true}`, sends NO auth, and NEVER calls
// `POST /api/config`. `memory.hippo.key` is optional/non-required (kept only for a future
// authenticated proxy) and is NEVER logged. See the implementation plan §7 + §2 (Hippo realism).
//
// Wire mapping lives in pure functions (toRecallQuery / fromRecallResults / resolveNodeId / fromWalk)
// so the HTTP shape is unit-testable without a live server.
import type { MemoryProvider, MemoryProviderInput, MemoryDeps } from './provider.js';
import type { Embeddings } from '../index/embeddings.js';
import type { FetchLike } from '../llm.js';
import type { Scope, Chunk, Hit, TemporalQuery, SessionNote, SymbolRef } from './types.js';
import { LocalMemoryProvider } from './local.js';

const DEFAULT_URL = 'http://127.0.0.1:7077';

/** A raw recall result row as returned by hippo's `/api/recall`. Fields are best-effort/optional. */
export interface HippoNode {
  id: number;
  topic?: string;
  /** Body text. hippo's `/api/recall` rows expose this under `content`; `text` kept as a tolerated alias. */
  content?: string;
  text?: string;
  score?: number;
  kind?: string; // e.g. 'code_file' | 'code_symbol' | 'note' | 'concept' | ...
}

interface RecallResponse {
  results?: HippoNode[];
  hits?: HippoNode[]; // tolerate either field name
}

interface WalkResponse {
  walk?: HippoNode[]; // hippo's real neighbor-array key (GET /api/walk -> {"ok":true,...,"walk":[...]})
  nodes?: HippoNode[]; // tolerated aliases
  neighbors?: HippoNode[];
}

interface StatsResponse {
  ok?: boolean;
}

/** Flags that change hippo's recall ranking. Chosen per query class (see queryFlags). */
export interface RecallFlags {
  ppr: boolean; // personalized PageRank over the graph
  hyde: boolean; // hypothetical-document expansion (server-side LLM latency)
  rerank: boolean; // cross-encoder rerank (server-side LLM latency)
  spread: boolean; // activation spread to neighbors
}

/**
 * Pick recall flags from the query. PPR + spread are cheap graph ops we always enable; hyde/rerank
 * incur hippo's own chat-lane latency so we only enable them for longer natural-language queries
 * (a short symbol-ish lookup gets a fast exact recall). Pure + deterministic.
 */
export function queryFlags(query: string): RecallFlags {
  const wordCount = query.trim().split(/\s+/).filter(Boolean).length;
  const heavy = wordCount >= 4; // a real sentence, not a symbol name
  return { ppr: true, hyde: heavy, rerank: heavy, spread: true };
}

/** Build a `GET /api/recall` URL with URL-encoded query + flags. Pure. */
export function toRecallQuery(baseURL: string, query: string, k: number, flags: RecallFlags): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('query', query); // hippo GET /api/recall reads param `query` (serve.zig parseQueryParam "query")
  params.set('k', String(k));
  params.set('ppr', flags.ppr ? 'true' : 'false');
  params.set('hyde', flags.hyde ? 'true' : 'false');
  params.set('rerank', flags.rerank ? 'true' : 'false');
  params.set('spread', flags.spread ? 'true' : 'false');
  return `${trimmed}/api/recall?${params.toString()}`;
}

/**
 * A repo-relative-path heuristic: the topic looks like a path inside the repo (has a `/` or a file
 * extension, is not absolute, has no traversal, no scheme). Used to decide whether a code node's
 * topic may become a `Citation.path`. Pure.
 */
export function topicLooksLikePath(topic: string): boolean {
  if (topic === '') return false;
  if (/^[a-zA-Z]+:\/\//.test(topic)) return false; // url scheme
  if (topic.startsWith('/') || /^[A-Za-z]:[\\/]/.test(topic)) return false; // absolute
  if (topic.includes('..')) return false; // traversal
  if (/\s/.test(topic)) return false; // a sentence, not a path
  const looksPathy = topic.includes('/') || /\.[A-Za-z0-9]+$/.test(topic);
  return looksPathy;
}

/** True when a hippo node represents a code file/symbol (the only kinds that may carry a path). */
function isCodeNode(node: HippoNode): boolean {
  return node.kind === 'code_file' || node.kind === 'code_symbol';
}

/**
 * Map hippo recall results to Hit[]. `path` is set ONLY when the node is a code_file/code_symbol AND
 * its topic parses as a repo-relative path (never fabricate file paths from arbitrary topics).
 * `chunkId = 'hippo:node:' + id`; line ranges are undefined (hippo recall is not chunk-addressable).
 * Pure.
 */
export function fromRecallResults(nodes: HippoNode[]): Hit[] {
  const out: Hit[] = [];
  for (const node of nodes) {
    if (typeof node.id !== 'number') continue;
    const text = node.content ?? node.text ?? node.topic ?? '';
    const hit: Hit = {
      chunkId: `hippo:node:${node.id}`,
      text,
      score: typeof node.score === 'number' ? node.score : 0,
      source: 'hippo',
    };
    if (node.kind !== undefined) hit.extra = { kind: node.kind, nodeId: node.id };
    else hit.extra = { nodeId: node.id };
    if (isCodeNode(node) && node.topic !== undefined && topicLooksLikePath(node.topic)) {
      hit.path = node.topic;
    }
    out.push(hit);
  }
  return out;
}

/**
 * Resolve a SymbolRef to a single numeric hippo node id from recall results. Prefers a
 * code_symbol/code_file node whose topic exactly matches `ref.path` or `ref.name`. Returns undefined
 * when there is no unambiguous match (zero matches OR two+ distinct code-node ids match) — the caller
 * then bails to `[]` rather than walking an arbitrary node. Pure.
 */
export function resolveNodeId(nodes: HippoNode[], ref: SymbolRef): number | undefined {
  const matches = nodes.filter(
    (n) =>
      typeof n.id === 'number' &&
      isCodeNode(n) &&
      (n.topic === ref.path || n.topic === ref.name),
  );
  const ids = [...new Set(matches.map((n) => n.id))];
  return ids.length === 1 ? ids[0] : undefined;
}

/** Map hippo `/api/walk` neighbor nodes to graph Hit[] (source:'graph', text = topic). Pure. */
export function fromWalk(nodes: HippoNode[]): Hit[] {
  const out: Hit[] = [];
  for (const node of nodes) {
    if (typeof node.id !== 'number') continue;
    const text = node.topic ?? node.text ?? '';
    const hit: Hit = {
      chunkId: `hippo:node:${node.id}`,
      text,
      score: typeof node.score === 'number' ? node.score : 0,
      source: 'graph',
    };
    if (node.kind !== undefined) hit.extra = { kind: node.kind, nodeId: node.id };
    else hit.extra = { nodeId: node.id };
    if (isCodeNode(node) && node.topic !== undefined && topicLooksLikePath(node.topic)) {
      hit.path = node.topic;
    }
    out.push(hit);
  }
  return out;
}

/** Thrown when hippo's HTTP read API fails. The key is NEVER included in the message. */
export class HippoError extends Error {
  readonly status?: number;
  constructor(message: string, opts?: { status?: number }) {
    super(message);
    this.name = 'HippoError';
    if (opts?.status !== undefined) this.status = opts.status;
  }
}

export class HippoMemoryProvider implements MemoryProvider {
  readonly id = 'hippo' as const;
  // search + graph are served by hippo over HTTP; temporal/remember/recall/upsert are local-shadowed,
  // so the hybrid advertises (and honors) the FULL capability set.
  readonly capabilities = new Set([
    'search',
    'graph',
    'temporal',
    'remember',
    'recall',
    'upsert',
  ] as const);

  private readonly url: string;
  // A true JS private field (#key) so the optional key is NEVER an enumerable own property — it can
  // never leak through `JSON.stringify(provider)` / a structured log. Kept only for a future
  // authenticated proxy; currently unused.
  readonly #key: string | undefined;
  private readonly embeddings: Embeddings;
  private readonly fetchImpl: FetchLike;
  /** Local shadow backing writes/temporal/notes (hippo has no HTTP write/temporal route). */
  private readonly shadow: LocalMemoryProvider;

  constructor(input: MemoryProviderInput, deps: MemoryDeps & { fetch?: FetchLike }) {
    const hippoInput = input as Extract<MemoryProviderInput, { provider: 'hippo' }>;
    this.url = hippoInput.url ?? process.env['HIPPO_URL'] ?? DEFAULT_URL;
    this.#key = hippoInput.key ?? process.env['HIPPO_KEY']; // optional; never logged
    this.embeddings = deps.embeddings;
    const f = deps.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new HippoError('no fetch implementation available');
    this.fetchImpl = f;
    // The local shadow lives under the same root so a hippo-backed scope still has a writable side.
    this.shadow = new LocalMemoryProvider(input, deps);
    void this.embeddings; // reserved: future HyDE query embedding on the client side
    void this.#key; // reserved: future authenticated proxy; never logged
  }

  // --- hippo HTTP read -----------------------------------------------------

  /**
   * Ping `GET ${url}/api/stats` and assert `{ok:true}`. Sends NO auth header and NEVER calls
   * `POST /api/config`. Fail-fast (throws HippoError) when hippo is down or unhealthy.
   */
  async connect(): Promise<void> {
    const url = `${this.url.replace(/\/+$/, '')}/api/stats`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'GET' });
    } catch {
      throw new HippoError('cannot reach hippo /api/stats');
    }
    if (!res.ok) {
      throw new HippoError(`hippo /api/stats returned HTTP ${res.status}`, { status: res.status });
    }
    let json: StatsResponse;
    try {
      json = (await res.json()) as StatsResponse;
    } catch {
      throw new HippoError('hippo /api/stats returned an unparseable body');
    }
    if (json.ok !== true) {
      throw new HippoError('hippo /api/stats did not report ok:true');
    }
  }

  /**
   * Search hippo via `GET /api/recall` (query-param) with ppr/hyde/rerank/spread flags so they take
   * effect (POST /api/recall's ppr is a no-op, so POST is never used). Maps results to Hit[];
   * `Citation.path` is later set only for code nodes with path-shaped topics (see fromRecallResults).
   */
  async search(query: string, opts: { k: number; scope: Scope }): Promise<Hit[]> {
    void opts.scope; // hippo isolation is per-url (one serve per repo); scope is informational here
    const flags = queryFlags(query);
    const url = toRecallQuery(this.url, query, opts.k, flags);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'GET' });
    } catch {
      throw new HippoError('network error contacting hippo /api/recall');
    }
    if (!res.ok) {
      throw new HippoError(`hippo /api/recall returned HTTP ${res.status}`, { status: res.status });
    }
    let json: RecallResponse;
    try {
      json = (await res.json()) as RecallResponse;
    } catch {
      throw new HippoError('failed to parse hippo /api/recall response');
    }
    const nodes = json.results ?? json.hits ?? [];
    return fromRecallResults(nodes);
  }

  /**
   * Graph neighbors: recall `ref.name` to resolve a numeric node id (exact code-node topic match;
   * ambiguous/none -> []) then `GET /api/walk?from=<id>&depth=2`. Maps neighbors to graph Hits.
   */
  async graphNeighbors(ref: SymbolRef, scope: Scope): Promise<Hit[]> {
    void scope;
    const flags = queryFlags(ref.name);
    const recallUrl = toRecallQuery(this.url, ref.name, 10, flags);
    let recallRes: Response;
    try {
      recallRes = await this.fetchImpl(recallUrl, { method: 'GET' });
    } catch {
      throw new HippoError('network error contacting hippo /api/recall');
    }
    if (!recallRes.ok) {
      throw new HippoError(`hippo /api/recall returned HTTP ${recallRes.status}`, {
        status: recallRes.status,
      });
    }
    let recallJson: RecallResponse;
    try {
      recallJson = (await recallRes.json()) as RecallResponse;
    } catch {
      throw new HippoError('failed to parse hippo /api/recall response');
    }
    const nodes = recallJson.results ?? recallJson.hits ?? [];
    const id = resolveNodeId(nodes, ref);
    if (id === undefined) return []; // ambiguous or unresolved -> do not walk an arbitrary node

    const walkUrl = `${this.url.replace(/\/+$/, '')}/api/walk?from=${encodeURIComponent(
      String(id),
    )}&depth=2`;
    let walkRes: Response;
    try {
      walkRes = await this.fetchImpl(walkUrl, { method: 'GET' });
    } catch {
      throw new HippoError('network error contacting hippo /api/walk');
    }
    if (!walkRes.ok) {
      throw new HippoError(`hippo /api/walk returned HTTP ${walkRes.status}`, {
        status: walkRes.status,
      });
    }
    let walkJson: WalkResponse;
    try {
      walkJson = (await walkRes.json()) as WalkResponse;
    } catch {
      throw new HippoError('failed to parse hippo /api/walk response');
    }
    const neighbors = walkJson.walk ?? walkJson.nodes ?? walkJson.neighbors ?? [];
    return fromWalk(neighbors);
  }

  // --- local-shadowed writes / temporal / notes ----------------------------

  /** Local-shadowed: hippo has no HTTP write route, so upsert goes to the co-resident local store. */
  async upsert(chunks: Chunk[], scope: Scope): Promise<void> {
    return this.shadow.upsert(chunks, scope);
  }

  /** Local-shadowed: hippo has no temporal HTTP route, so temporal queries hit the local changelog. */
  async temporalQuery(q: TemporalQuery, scope: Scope): Promise<Hit[]> {
    return this.shadow.temporalQuery(q, scope);
  }

  /** Local-shadowed: session notes live in the local store (hippo recall is for graph nodes). */
  async remember(note: SessionNote, scope: Scope): Promise<void> {
    return this.shadow.remember(note, scope);
  }

  /** Local-shadowed: recall of session notes hits the local store. */
  async recall(query: string, scope: Scope): Promise<SessionNote[]> {
    return this.shadow.recall(query, scope);
  }
}
