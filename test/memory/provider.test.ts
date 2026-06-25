import { describe, it, expect } from 'vitest';
import { createMemoryProvider, type MemoryProviderInput } from '../../src/memory/provider.js';
import { LocalMemoryProvider } from '../../src/memory/local.js';
import { HippoMemoryProvider } from '../../src/memory/hippo.js';
import { FakeEmbeddings, makeTmpRepo } from '../helpers/fakes.js';

describe('createMemoryProvider', () => {
  it('returns a LocalMemoryProvider for provider:local and it works end-to-end', async () => {
    const repo = makeTmpRepo({});
    try {
      const provider = await createMemoryProvider(
        { provider: 'local', root: repo.root },
        { embeddings: new FakeEmbeddings() },
      );
      expect(provider).toBeInstanceOf(LocalMemoryProvider);
      expect(provider.id).toBe('local');
      await provider.upsert(
        [
          {
            id: 'c1',
            path: 'a.gml',
            text: 'quick check content',
            contentHash: 'h',
            startLine: 1,
            endLine: 1,
          },
        ],
        { repo: 'r' },
      );
      const hits = await provider.search('quick check content', { k: 3, scope: { repo: 'r' } });
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      repo.cleanup();
    }
  });

  it('returns a HippoMemoryProvider (stub) for provider:hippo', async () => {
    const provider = await createMemoryProvider(
      { provider: 'hippo', url: 'http://127.0.0.1:7077', root: '/tmp/x' },
      { embeddings: new FakeEmbeddings() },
    );
    expect(provider).toBeInstanceOf(HippoMemoryProvider);
    expect(provider.id).toBe('hippo');
  });

  it('throws at runtime for an unknown provider passed via as any', async () => {
    await expect(
      createMemoryProvider(
        { provider: 'bogus', root: '/tmp/x' } as unknown as MemoryProviderInput,
        { embeddings: new FakeEmbeddings() },
      ),
    ).rejects.toThrow(/unknown memory provider/);
  });
});
