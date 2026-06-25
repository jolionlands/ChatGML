// src/memory/provider.ts — the single MemoryProvider seam.
//
// The interface + the MemoryProviderInput type (declared exactly once) plus the runtime
// `createMemoryProvider`, which selects a backend via dynamic `import()` of a STATIC path
// (`./local.js` or `./hippo.js`) so choosing one never loads the other. The discriminated
// `MemoryConfig` makes the never-branch real (exhaustiveness is meaningful).
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

/**
 * Construct the configured memory provider. Switches on `input.provider` with a dynamic import of a
 * static path (the unselected backend is never loaded). The `never`-branch is a real compile-time
 * exhaustiveness check AND a runtime throw for a bogus provider passed via `as any`.
 */
export async function createMemoryProvider(
  input: MemoryProviderInput,
  deps: MemoryDeps,
): Promise<MemoryProvider> {
  switch (input.provider) {
    case 'local': {
      const { LocalMemoryProvider } = await import('./local.js');
      return new LocalMemoryProvider(input, deps);
    }
    case 'hippo': {
      const { HippoMemoryProvider } = await import('./hippo.js');
      return new HippoMemoryProvider(input, deps);
    }
    default: {
      const _exhaustive: never = input;
      throw new Error(
        `unknown memory provider: ${String((_exhaustive as { provider?: unknown }).provider)}`,
      );
    }
  }
}
