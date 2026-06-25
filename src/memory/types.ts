// src/memory/types.ts — retrieval domain types.
//
// Re-exports the cross-cut types from src/types.ts (type-only) so the memory layer never
// redeclares Scope/Citation/SymbolRef. M1 scope: the domain types + scope helpers.
// hitToCitation (the single Hit->Citation mapping) lands with the providers in M2.
export type { Scope, Citation, SymbolRef } from '../types.js'; // type-only re-export
import type { Scope, Citation, SymbolRef } from '../types.js';
import type { GmlMeta } from '../index/gml.js';

export type EmbedVector = Float32Array;

export interface Chunk {
  id: string; // `${path}#${startLine}-${endLine}`
  path: string;
  text: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  symbol?: SymbolRef;
  lang?: string;
  vector?: Float32Array;
}

export interface Hit {
  chunkId: string;
  path?: string; // optional: hippo memory nodes have no path
  text: string;
  score: number;
  source: 'vector' | 'keyword' | 'fused' | 'graph' | 'temporal' | 'hippo';
  startLine?: number;
  endLine?: number;
  symbol?: SymbolRef;
  extra?: Record<string, unknown>;
}

export interface TemporalQuery {
  path?: string;
  symbol?: SymbolRef;
  since?: number;
  until?: number;
  kind: 'history' | 'changed-since' | 'at-time';
  limit?: number;
}

export interface TemporalChange {
  path: string;
  contentHash: string;
  previousHash?: string;
  timestamp: number;
  changeKind: 'added' | 'modified' | 'unchanged' | 'deleted';
}

export interface SessionNote {
  id: string;
  text: string;
  topic?: string;
  createdAt: number;
  tags?: string[];
  importance?: number;
}

export function scopeKey(scope: Scope): string {
  return scope.sub ? `${scope.repo}::${scope.sub}` : scope.repo;
}

export function makeScope(raw: string): Scope {
  const i = raw.indexOf('::');
  return i === -1 ? { repo: raw } : { repo: raw.slice(0, i), sub: raw.slice(i + 2) };
}

// ---------------------------------------------------------------------------
// THE single Hit -> Citation mapping.
//
// `provider` comes from the PROVIDER IDENTITY passed by the caller, NOT from `hit.source` (a hippo
// graph hit still has provider:'hippo'). `gml` is filled by the caller-provided `deriveGmlMeta` so
// this module needs no runtime edge into index/. The mapping is TOTAL: every field that exists on the
// Hit copies through, and a Hit without a path produces a Citation without a path.
// ---------------------------------------------------------------------------
export function hitToCitation(
  hit: Hit,
  provider: 'local' | 'hippo',
  deriveGmlMeta: (p: string) => GmlMeta | undefined,
): Citation {
  const c: Citation = { snippet: hit.text, score: hit.score, provider };
  if (hit.path !== undefined) {
    c.path = hit.path;
    const gml = deriveGmlMeta(hit.path);
    if (gml) c.gml = gml;
  }
  if (hit.startLine !== undefined) c.startLine = hit.startLine;
  if (hit.endLine !== undefined) c.endLine = hit.endLine;
  if (hit.symbol !== undefined) c.symbol = hit.symbol;
  return c;
}
