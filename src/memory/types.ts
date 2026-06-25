// src/memory/types.ts — retrieval domain types.
//
// Re-exports the cross-cut types from src/types.ts (type-only) so the memory layer never
// redeclares Scope/Citation/SymbolRef. M1 scope: the domain types + scope helpers.
// hitToCitation (the single Hit->Citation mapping) lands with the providers in M2.
export type { Scope, Citation, SymbolRef } from '../types.js'; // type-only re-export
import type { Scope, SymbolRef } from '../types.js';

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
