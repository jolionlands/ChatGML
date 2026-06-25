import { describe, it } from 'vitest';
import { runContractCases, assertContractFails, type Capability } from './provider-contract.js';
import { LocalMemoryProvider } from '../../src/memory/local.js';
import type { MemoryProvider } from '../../src/memory/provider.js';
import type { Chunk, Scope, Hit, SessionNote } from '../../src/memory/types.js';
import { FakeEmbeddings, makeTmpRepo } from './fakes.js';

const ALL: Capability[] = ['upsert', 'search', 'graph', 'temporal', 'remember', 'recall'];

function localFactory(): MemoryProvider {
  const repo = makeTmpRepo({});
  // Leak the dir intentionally per-test; the OS tmp reaper handles cleanup. Tests stay short-lived.
  return new LocalMemoryProvider(
    { provider: 'local', root: repo.root },
    { embeddings: new FakeEmbeddings() },
  );
}

describe('provider contract', () => {
  it('LocalMemoryProvider satisfies the full contract', async () => {
    await runContractCases(localFactory, { capabilities: ALL });
  });

  // --- Negative controls: GREEN assertions that the harness CATCHES broken providers. ---

  it('catches a provider that drops upserts (search returns nothing)', async () => {
    const broken = (): MemoryProvider => {
      const real = localFactory();
      return {
        ...realDelegates(real),
        async upsert(_chunks: Chunk[], _scope: Scope): Promise<void> {
          // intentionally a no-op: upsert is dropped
        },
      };
    };
    await assertContractFails(broken, { capabilities: ALL });
  });

  it('catches a provider that double-inserts (duplicate chunk ids in search)', async () => {
    const broken = (): MemoryProvider => {
      const real = localFactory();
      return {
        ...realDelegates(real),
        async search(query: string, opts: { k: number; scope: Scope }): Promise<Hit[]> {
          const hits = await real.search(query, opts);
          return [...hits, ...hits]; // duplicate every hit
        },
      };
    };
    await assertContractFails(broken, { capabilities: ['upsert', 'search'] });
  });

  it('catches a provider whose recall never returns the remembered note', async () => {
    const broken = (): MemoryProvider => {
      const real = localFactory();
      return {
        ...realDelegates(real),
        async recall(_query: string, _scope: Scope): Promise<SessionNote[]> {
          return [];
        },
      };
    };
    await assertContractFails(broken, { capabilities: ['remember', 'recall'] });
  });
});

/** Spread the real provider's bound methods so an override object stays a valid MemoryProvider. */
function realDelegates(real: MemoryProvider): MemoryProvider {
  return {
    id: real.id,
    capabilities: real.capabilities,
    upsert: real.upsert.bind(real),
    search: real.search.bind(real),
    graphNeighbors: real.graphNeighbors.bind(real),
    temporalQuery: real.temporalQuery.bind(real),
    remember: real.remember.bind(real),
    recall: real.recall.bind(real),
  };
}
