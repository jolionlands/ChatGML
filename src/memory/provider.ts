// src/memory/provider.ts — the single MemoryProvider seam.
//
// M1 scope: the interface + the MemoryProviderInput type (declared exactly once). The runtime
// `createMemoryProvider` (dynamic import('./local.js') / import('./hippo.js')) lands in M2 (task 2.8).
import type { Config } from '../types.js';
import type { Scope } from '../types.js';
import type { Chunk, Hit, SymbolRef, TemporalQuery, SessionNote } from './types.js';
import type { Embeddings } from '../index/embeddings.js';

export interface MemoryProvider {
  readonly id: 'local' | 'hippo';
  readonly capabilities: ReadonlySet<
    'upsert' | 'search' | 'graph' | 'temporal' | 'remember' | 'recall'
  >;
  upsert(chunks: Chunk[], scope: Scope): Promise<void>;
  search(query: string, opts: { k: number; scope: Scope }): Promise<Hit[]>;
  graphNeighbors(ref: SymbolRef, scope: Scope): Promise<Hit[]>;
  temporalQuery(q: TemporalQuery, scope: Scope): Promise<Hit[]>;
  remember(note: SessionNote, scope: Scope): Promise<void>;
  recall(query: string, scope: Scope): Promise<SessionNote[]>;
  close?(): Promise<void>;
}

export interface MemoryDeps {
  embeddings: Embeddings;
}

// audit: provider input declared ONCE; root is explicit, not an ad-hoc intersection at the call site.
export type MemoryProviderInput = Config['memory'] & { root: string };
