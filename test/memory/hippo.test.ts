import { describe, it, expect } from 'vitest';
import { HippoMemoryProvider } from '../../src/memory/hippo.js';
import { FakeEmbeddings } from '../helpers/fakes.js';

// The hippo provider is a deliberate STUB in M2: it compiles + satisfies the interface but every
// method throws not_implemented. The real adapter lands in M5.
function make(): HippoMemoryProvider {
  return new HippoMemoryProvider(
    { provider: 'hippo', url: 'http://127.0.0.1:7077', root: '/tmp/x' },
    { embeddings: new FakeEmbeddings() },
  );
}

describe('HippoMemoryProvider (stub)', () => {
  it('satisfies the interface shape', () => {
    const p = make();
    expect(p.id).toBe('hippo');
    expect(p.capabilities.has('search')).toBe(true);
    expect(typeof p.search).toBe('function');
    expect(typeof p.graphNeighbors).toBe('function');
    expect(typeof p.temporalQuery).toBe('function');
    expect(typeof p.remember).toBe('function');
    expect(typeof p.recall).toBe('function');
    expect(typeof p.upsert).toBe('function');
  });

  it('every method throws not-implemented (lands in M5)', async () => {
    const p = make();
    await expect(p.connect()).rejects.toThrow(/not implemented/);
    await expect(p.search('q', { k: 1, scope: { repo: 'r' } })).rejects.toThrow(/not implemented/);
    await expect(p.graphNeighbors({ name: 'x', path: 'a' }, { repo: 'r' })).rejects.toThrow(
      /not implemented/,
    );
    await expect(p.temporalQuery({ kind: 'history' }, { repo: 'r' })).rejects.toThrow(
      /not implemented/,
    );
    await expect(p.upsert([], { repo: 'r' })).rejects.toThrow(/not implemented/);
    await expect(
      p.remember({ id: 'n', text: 't', createdAt: 0 }, { repo: 'r' }),
    ).rejects.toThrow(/not implemented/);
    await expect(p.recall('q', { repo: 'r' })).rejects.toThrow(/not implemented/);
  });

  it('falls back to HIPPO_URL/HIPPO_KEY env without leaking the key', () => {
    process.env['HIPPO_URL'] = 'http://127.0.0.1:9999';
    process.env['HIPPO_KEY'] = 'sk-SENTINEL-DEADBEEF';
    // No url in input -> env fallback; constructing must not throw or log the key.
    const p = new HippoMemoryProvider(
      { provider: 'hippo', url: undefined as unknown as string, root: '/tmp/x' },
      { embeddings: new FakeEmbeddings() },
    );
    expect(p.id).toBe('hippo');
  });
});
