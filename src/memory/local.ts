// src/memory/local.ts — the full local memory backend.
//
// Persistence lives under `<root>/.chatgml/<scopeKey>/`:
//   - vectors.json   : { envelope, chunks: [{id,path,text,contentHash,startLine,endLine,symbol?,b64}] }
//   - bm25.json      : serialized Bm25Index
//   - changelog.json : per-file [{ contentHash, timestamp, previousHash?, changeKind }]
//   - notes.json     : cross-session SessionNote[]
//
// search = embed(query) -> cosine top-k AND bm25 -> fuse -> Hit[]. graphNeighbors = same-file +
// name-reference heuristic (documented best-effort). temporalQuery filters the changelog. remember /
// recall = BM25 over notes. The store records the embeddings id + dim; on open, a mismatch makes the
// store stale and it is rebuilt empty. Every record is scoped (scopeKey) -> multi-codebase isolation.
//
// NO pickle / NO eval: vectors are base64-Float32 + JSON only.
import path from 'node:path';
import type { MemoryProvider, MemoryProviderInput, MemoryDeps } from './provider.js';
import type { Embeddings } from '../index/embeddings.js';
import type { Scope, Chunk, Hit, TemporalQuery, SessionNote, SymbolRef } from './types.js';
import { scopeKey } from './types.js';
import { Bm25Index, type Bm25Json } from './bm25.js';
import { cosineSim, fuse, type Scored } from './fusion.js';
import {
  f32ToBase64,
  base64ToF32,
  writeJsonAtomic,
  readJson,
  type StoreEnvelope,
} from './persist.js';

const STORE_VERSION = 1;

interface StoredChunk {
  id: string;
  path: string;
  text: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  symbol?: SymbolRef;
  b64: string; // base64 Float32 vector
}

interface ChangelogEntry {
  contentHash: string;
  previousHash?: string;
  timestamp: number;
  changeKind: 'added' | 'modified' | 'unchanged' | 'deleted';
}

type ChangelogMap = Record<string, ChangelogEntry[]>;

/** In-memory per-scope state, lazily loaded from disk on first touch. */
interface ScopeState {
  chunks: Map<string, { meta: StoredChunk; vector: Float32Array }>;
  bm25: Bm25Index;
  changelog: ChangelogMap;
  notes: SessionNote[];
  loaded: boolean;
}

export class LocalMemoryProvider implements MemoryProvider {
  readonly id = 'local' as const;
  readonly capabilities = new Set([
    'upsert',
    'search',
    'graph',
    'temporal',
    'remember',
    'recall',
  ] as const);

  private readonly root: string;
  private readonly embeddings: Embeddings;
  private readonly states = new Map<string, ScopeState>();

  constructor(input: MemoryProviderInput, deps: MemoryDeps) {
    this.root = input.root;
    this.embeddings = deps.embeddings;
  }

  // --- paths ---------------------------------------------------------------
  private scopeDir(scope: Scope): string {
    return path.join(this.root, '.chatgml', sanitize(scopeKey(scope)));
  }
  private vectorsPath(scope: Scope): string {
    return path.join(this.scopeDir(scope), 'vectors.json');
  }
  private bm25Path(scope: Scope): string {
    return path.join(this.scopeDir(scope), 'bm25.json');
  }
  private changelogPath(scope: Scope): string {
    return path.join(this.scopeDir(scope), 'changelog.json');
  }
  private notesPath(scope: Scope): string {
    return path.join(this.scopeDir(scope), 'notes.json');
  }

  // --- state load/save -----------------------------------------------------
  private state(scope: Scope): ScopeState {
    const key = scopeKey(scope);
    let st = this.states.get(key);
    if (!st) {
      st = { chunks: new Map(), bm25: new Bm25Index(), changelog: {}, notes: [], loaded: false };
      this.states.set(key, st);
    }
    if (!st.loaded) this.load(scope, st);
    return st;
  }

  private load(scope: Scope, st: ScopeState): void {
    st.loaded = true;
    const env = readJson<StoreEnvelope<StoredChunk[]>>(this.vectorsPath(scope));
    // Stale-store guard: an embeddings id/dim mismatch rebuilds the vector store empty.
    const stale =
      env !== null &&
      (env.embeddingsId !== this.embeddings.id ||
        (this.embeddings.dim > 0 && env.dim > 0 && env.dim !== this.embeddings.dim));
    if (env !== null && !stale && Array.isArray(env.data)) {
      for (const sc of env.data) {
        try {
          st.chunks.set(sc.id, { meta: sc, vector: base64ToF32(sc.b64) });
        } catch {
          // corrupt vector for this chunk: skip it (store degrades, never crashes).
        }
      }
    }
    // BM25: prefer the persisted index; if missing/stale, rebuild from loaded chunks.
    const bm = stale ? null : readJson<Bm25Json>(this.bm25Path(scope));
    if (bm && Array.isArray(bm.docs)) {
      st.bm25 = Bm25Index.fromJSON(bm);
    } else {
      st.bm25 = new Bm25Index();
      for (const { meta } of st.chunks.values()) st.bm25.add(meta.id, meta.text);
    }
    const cl = readJson<ChangelogMap>(this.changelogPath(scope));
    if (cl && typeof cl === 'object') st.changelog = cl;
    const notes = readJson<SessionNote[]>(this.notesPath(scope));
    if (Array.isArray(notes)) st.notes = notes;
  }

  private async persist(scope: Scope, st: ScopeState): Promise<void> {
    const envelope: StoreEnvelope<StoredChunk[]> = {
      version: STORE_VERSION,
      embeddingsId: this.embeddings.id,
      dim: this.embeddings.dim,
      data: [...st.chunks.values()].map((c) => c.meta),
    };
    await writeJsonAtomic(this.vectorsPath(scope), envelope);
    await writeJsonAtomic(this.bm25Path(scope), st.bm25.toJSON());
    await writeJsonAtomic(this.changelogPath(scope), st.changelog);
    await writeJsonAtomic(this.notesPath(scope), st.notes);
  }

  // --- MemoryProvider ------------------------------------------------------

  /**
   * Idempotent upsert keyed on chunk id. Embeds only chunks whose content hash changed (or that are
   * new). Records a changelog entry per distinct path. Re-upserting identical chunks is a no-op for
   * the vector count and emits an `unchanged` changelog entry.
   */
  async upsert(chunks: Chunk[], scope: Scope): Promise<void> {
    if (chunks.length === 0) return;
    const st = this.state(scope);
    const now = Date.now();

    // Determine which chunks need (re-)embedding.
    const toEmbed: Chunk[] = [];
    for (const c of chunks) {
      const existing = st.chunks.get(c.id);
      if (!existing || existing.meta.contentHash !== c.contentHash) toEmbed.push(c);
    }
    const vectors =
      toEmbed.length > 0 ? await this.embeddings.embed(toEmbed.map((c) => c.text)) : [];

    for (let i = 0; i < toEmbed.length; i++) {
      const c = toEmbed[i]!;
      const meta: StoredChunk = {
        id: c.id,
        path: c.path,
        text: c.text,
        contentHash: c.contentHash,
        startLine: c.startLine,
        endLine: c.endLine,
        b64: f32ToBase64(vectors[i]!),
      };
      if (c.symbol !== undefined) meta.symbol = c.symbol;
      st.chunks.set(c.id, { meta, vector: vectors[i]! });
      st.bm25.add(c.id, c.text);
    }

    // Per-path changelog (group chunks by path; a file's hash is the hash of its chunk texts).
    const byPath = new Map<string, Chunk[]>();
    for (const c of chunks) {
      const arr = byPath.get(c.path) ?? [];
      arr.push(c);
      byPath.set(c.path, arr);
    }
    for (const [p, cs] of byPath) {
      const fileHash = combinedHash(cs.map((c) => c.contentHash));
      this.recordChange(st, p, fileHash, now);
    }

    await this.persist(scope, st);
  }

  /** Record a file-level change in the changelog (added/modified/unchanged). */
  private recordChange(st: ScopeState, p: string, fileHash: string, now: number): void {
    const history = st.changelog[p] ?? [];
    const last = history[history.length - 1];
    let changeKind: ChangelogEntry['changeKind'];
    if (!last) changeKind = 'added';
    else if (last.contentHash === fileHash) changeKind = 'unchanged';
    else changeKind = 'modified';
    const entry: ChangelogEntry = { contentHash: fileHash, timestamp: now, changeKind };
    if (last && last.contentHash !== fileHash) entry.previousHash = last.contentHash;
    history.push(entry);
    st.changelog[p] = history;
  }

  /** Remove all chunks for a set of paths and record a `deleted` changelog entry. */
  async purge(paths: string[], scope: Scope): Promise<void> {
    if (paths.length === 0) return;
    const st = this.state(scope);
    const now = Date.now();
    const set = new Set(paths);
    for (const [id, { meta }] of [...st.chunks.entries()]) {
      if (set.has(meta.path)) {
        st.chunks.delete(id);
        st.bm25.remove(id);
      }
    }
    for (const p of paths) {
      const history = st.changelog[p] ?? [];
      const last = history[history.length - 1];
      if (last && last.changeKind === 'deleted') continue;
      const entry: ChangelogEntry = { contentHash: '', timestamp: now, changeKind: 'deleted' };
      if (last) entry.previousHash = last.contentHash;
      history.push(entry);
      st.changelog[p] = history;
    }
    await this.persist(scope, st);
  }

  async search(
    query: string,
    opts: { k: number; scope: Scope; minScore?: number },
  ): Promise<Hit[]> {
    const st = this.state(opts.scope);
    if (st.chunks.size === 0) return [];
    const [qVec] = await this.embeddings.embed([query]);

    // RAW cosine per chunk (NOT the minmax-normalized fused score). This is the cross-query-comparable
    // similarity an absolute floor (`minScore`) is checked against; the fused score is only for order.
    const cosineById = new Map<string, number>();
    const vectorScores: Scored[] = [];
    if (qVec) {
      for (const { meta, vector } of st.chunks.values()) {
        const cos = cosineSim(qVec, vector);
        cosineById.set(meta.id, cos);
        vectorScores.push({ id: meta.id, score: cos });
      }
    }
    const keywordScores: Scored[] = st.bm25.search(query);

    const fused = fuse(vectorScores, keywordScores, { method: 'minmax', k: opts.k });

    // OPT-IN absolute relevance floor: drop any hit whose RAW cosine is below `minScore`. A hit with no
    // computed cosine (no query vector / not in the vector set) cannot clear a SEMANTIC floor, so it is
    // dropped too. If this empties the set, return [] — never substitute a wrong top-k. Off by default.
    const floored =
      opts.minScore === undefined
        ? fused
        : fused.filter((f) => (cosineById.get(f.id) ?? -Infinity) >= opts.minScore!);

    return floored.flatMap((f) => {
      const c = st.chunks.get(f.id);
      if (!c) return [];
      return [this.toHit(c.meta, f.score, 'fused')];
    });
  }

  /**
   * Best-effort graph neighbors: chunks in the SAME FILE as `ref`, plus chunks whose text mentions
   * `ref.name`. Documented as a heuristic (no real symbol graph in the local backend). Ranked by the
   * only signal this backend has — same-file (1.0) above a bare name-mention (0.5) — score DESC with a
   * deterministic chunkId tie-break. (D4: hippo ranks by its real walk score/depth; the local backend
   * has no such graph, so this coarse relation score is the documented ordering.)
   */
  async graphNeighbors(ref: SymbolRef, scope: Scope): Promise<Hit[]> {
    const st = this.state(scope);
    const hits: Hit[] = [];
    const seen = new Set<string>();
    const nameRe = ref.name ? new RegExp(`\\b${escapeRe(ref.name)}\\b`) : null;
    for (const { meta } of st.chunks.values()) {
      const sameFile = meta.path === ref.path;
      const mentions = nameRe !== null && meta.symbol?.name !== ref.name && nameRe.test(meta.text);
      if (sameFile || mentions) {
        if (seen.has(meta.id)) continue;
        seen.add(meta.id);
        hits.push(this.toHit(meta, sameFile ? 1 : 0.5, 'graph'));
      }
    }
    hits.sort((a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : 1));
    return hits;
  }

  async temporalQuery(q: TemporalQuery, scope: Scope): Promise<Hit[]> {
    const st = this.state(scope);
    const out: Hit[] = [];
    const paths = q.path ? [q.path] : Object.keys(st.changelog);
    for (const p of paths) {
      const history = st.changelog[p];
      if (!history) continue;
      for (const e of history) {
        if (q.since !== undefined && e.timestamp < q.since) continue;
        if (q.until !== undefined && e.timestamp > q.until) continue;
        if (q.kind === 'changed-since' && e.changeKind === 'unchanged') continue;
        out.push({
          chunkId: `temporal:${p}@${e.timestamp}`,
          path: p,
          text: `${e.changeKind} ${p} @ ${new Date(e.timestamp).toISOString()}`,
          score: e.timestamp,
          source: 'temporal',
          extra: { changeKind: e.changeKind, contentHash: e.contentHash, timestamp: e.timestamp },
        });
      }
    }
    out.sort((a, b) => b.score - a.score); // newest first
    return q.limit !== undefined ? out.slice(0, q.limit) : out;
  }

  async remember(note: SessionNote, scope: Scope): Promise<void> {
    const st = this.state(scope);
    const idx = st.notes.findIndex((n) => n.id === note.id);
    if (idx >= 0) st.notes[idx] = note;
    else st.notes.push(note);
    await this.persist(scope, st);
  }

  async recall(query: string, scope: Scope): Promise<SessionNote[]> {
    const st = this.state(scope);
    if (st.notes.length === 0) return [];
    // BM25 over note text+topic; empty query returns most-recent-first.
    if (query.trim() === '') {
      return [...st.notes].sort((a, b) => b.createdAt - a.createdAt);
    }
    const idx = new Bm25Index();
    for (const n of st.notes)
      idx.add(n.id, `${n.text} ${n.topic ?? ''} ${(n.tags ?? []).join(' ')}`);
    const ranked = idx.search(query);
    const byId = new Map(st.notes.map((n) => [n.id, n]));
    const hits = ranked.flatMap((r) => {
      const n = byId.get(r.id);
      return n ? [n] : [];
    });
    return hits.length > 0 ? hits : [];
  }

  // --- helpers -------------------------------------------------------------
  private toHit(meta: StoredChunk, score: number, source: Hit['source']): Hit {
    const hit: Hit = {
      chunkId: meta.id,
      path: meta.path,
      text: meta.text,
      score,
      source,
      startLine: meta.startLine,
      endLine: meta.endLine,
    };
    if (meta.symbol !== undefined) hit.symbol = meta.symbol;
    return hit;
  }
}

/** Combine an ordered list of hashes into one stable digest string (cheap, no crypto import here). */
function combinedHash(hashes: string[]): string {
  return hashes.join('|');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Make a scopeKey safe as a directory name. */
function sanitize(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}
