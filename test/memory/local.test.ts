import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LocalMemoryProvider } from '../../src/memory/local.js';
import { FakeEmbeddings, makeTmpRepo } from '../helpers/fakes.js';
import type { Chunk, Scope } from '../../src/memory/types.js';

function provider(root: string, embeddings = new FakeEmbeddings()): LocalMemoryProvider {
  return new LocalMemoryProvider({ provider: 'local', root }, { embeddings });
}

function chunk(id: string, p: string, text: string, hash: string): Chunk {
  return { id, path: p, text, contentHash: hash, startLine: 1, endLine: 1 };
}

const SCOPE: Scope = { repo: 'repo-a' };

describe('LocalMemoryProvider', () => {
  it('upsert then search returns the chunk (cosine ranking)', async () => {
    const repo = makeTmpRepo({});
    try {
      const p = provider(repo.root);
      await p.upsert(
        [
          chunk('c1', 'a.gml', 'the player loses health when damaged by enemies', 'h1'),
          chunk('c2', 'b.gml', 'render the user interface and draw buttons', 'h2'),
        ],
        SCOPE,
      );
      const hits = await p.search('the player loses health when damaged by enemies', {
        k: 5,
        scope: SCOPE,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.chunkId).toBe('c1');
      expect(hits[0]!.path).toBe('a.gml');
    } finally {
      repo.cleanup();
    }
  });

  it('bm25 + cosine fusion surfaces a keyword-only match', async () => {
    const repo = makeTmpRepo({});
    try {
      const p = provider(repo.root);
      await p.upsert(
        [
          chunk('c1', 'a.gml', 'zebra unicorn quokka', 'h1'),
          chunk('c2', 'b.gml', 'completely different lexical content here', 'h2'),
        ],
        SCOPE,
      );
      const hits = await p.search('quokka', { k: 5, scope: SCOPE });
      expect(hits.map((h) => h.chunkId)).toContain('c1');
    } finally {
      repo.cleanup();
    }
  });

  it('re-upsert with the same hash does not re-embed and keeps count stable', async () => {
    const repo = makeTmpRepo({});
    try {
      const emb = new FakeEmbeddings();
      const spy = vi.spyOn(emb, 'embed');
      const p = provider(repo.root, emb);
      await p.upsert([chunk('c1', 'a.gml', 'hello', 'h1')], SCOPE);
      const afterFirst = spy.mock.calls.length;
      await p.upsert([chunk('c1', 'a.gml', 'hello', 'h1')], SCOPE);
      // No new embed call for the unchanged chunk (only the query embeds happen in search).
      expect(spy.mock.calls.length).toBe(afterFirst);
      const hits = await p.search('hello', { k: 10, scope: SCOPE });
      expect(hits.filter((h) => h.chunkId === 'c1')).toHaveLength(1);
    } finally {
      repo.cleanup();
    }
  });

  it('re-embeds when the content hash changes', async () => {
    const repo = makeTmpRepo({});
    try {
      const emb = new FakeEmbeddings();
      const spy = vi.spyOn(emb, 'embed');
      const p = provider(repo.root, emb);
      await p.upsert([chunk('c1', 'a.gml', 'v1', 'h1')], SCOPE);
      spy.mockClear();
      await p.upsert([chunk('c1', 'a.gml', 'v2', 'h2')], SCOPE);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      repo.cleanup();
    }
  });

  it('isolates two scopes', async () => {
    const repo = makeTmpRepo({});
    try {
      const p = provider(repo.root);
      const a: Scope = { repo: 'A' };
      const b: Scope = { repo: 'B' };
      await p.upsert([chunk('c1', 'a.gml', 'alpha content here', 'h1')], a);
      await p.upsert([chunk('c2', 'b.gml', 'beta content here', 'h2')], b);
      const hitsA = await p.search('alpha content here', { k: 5, scope: a });
      const hitsB = await p.search('alpha content here', { k: 5, scope: b });
      expect(hitsA.map((h) => h.chunkId)).toContain('c1');
      expect(hitsB.map((h) => h.chunkId)).not.toContain('c1');
    } finally {
      repo.cleanup();
    }
  });

  it('changelog tracks added -> modified -> unchanged and temporalQuery is newest-first', async () => {
    const repo = makeTmpRepo({});
    try {
      const p = provider(repo.root);
      await p.upsert([chunk('c1', 'f.gml', 'v1', 'h1')], SCOPE); // added
      await p.upsert([chunk('c1', 'f.gml', 'v2', 'h2')], SCOPE); // modified
      await p.upsert([chunk('c1', 'f.gml', 'v2', 'h2')], SCOPE); // unchanged
      const hist = await p.temporalQuery({ kind: 'history', path: 'f.gml' }, SCOPE);
      const kinds = hist.map((h) => (h.extra as { changeKind: string }).changeKind);
      expect(kinds).toContain('added');
      expect(kinds).toContain('modified');
      expect(kinds).toContain('unchanged');
      // newest-first: timestamps descending
      for (let i = 0; i + 1 < hist.length; i++) {
        expect(hist[i]!.score).toBeGreaterThanOrEqual(hist[i + 1]!.score);
      }
    } finally {
      repo.cleanup();
    }
  });

  it('changed-since filters out unchanged entries', async () => {
    const repo = makeTmpRepo({});
    try {
      const p = provider(repo.root);
      await p.upsert([chunk('c1', 'f.gml', 'v1', 'h1')], SCOPE);
      await p.upsert([chunk('c1', 'f.gml', 'v1', 'h1')], SCOPE); // unchanged
      const changed = await p.temporalQuery({ kind: 'changed-since', path: 'f.gml' }, SCOPE);
      const kinds = changed.map((h) => (h.extra as { changeKind: string }).changeKind);
      expect(kinds).not.toContain('unchanged');
    } finally {
      repo.cleanup();
    }
  });

  it('purge removes chunks and records a deleted changelog entry', async () => {
    const repo = makeTmpRepo({});
    try {
      const p = provider(repo.root);
      await p.upsert([chunk('c1', 'gone.gml', 'temp content', 'h1')], SCOPE);
      await p.purge(['gone.gml'], SCOPE);
      const hits = await p.search('temp content', { k: 5, scope: SCOPE });
      expect(hits.map((h) => h.chunkId)).not.toContain('c1');
      const hist = await p.temporalQuery({ kind: 'history', path: 'gone.gml' }, SCOPE);
      const kinds = hist.map((h) => (h.extra as { changeKind: string }).changeKind);
      expect(kinds).toContain('deleted');
    } finally {
      repo.cleanup();
    }
  });

  it('remember / recall round-trips a session note (scope-filtered)', async () => {
    const repo = makeTmpRepo({});
    try {
      const p = provider(repo.root);
      await p.remember(
        { id: 'n1', text: 'the project uses FSRS scheduling for reviews', createdAt: 1 },
        SCOPE,
      );
      const got = await p.recall('FSRS scheduling', SCOPE);
      expect(got.map((n) => n.id)).toContain('n1');
      // a different scope does not see it
      expect((await p.recall('FSRS', { repo: 'other' })).length).toBe(0);
    } finally {
      repo.cleanup();
    }
  });

  it('graphNeighbors returns same-file and name-referencing chunks', async () => {
    const repo = makeTmpRepo({});
    try {
      const p = provider(repo.root);
      await p.upsert(
        [
          chunk('c1', 'scripts/s/s.gml', 'function clampHealth(v) {}', 'h1'),
          chunk('c2', 'scripts/s/s.gml', 'other line in same file', 'h2'),
          chunk('c3', 'objects/o/Step_0.gml', 'clampHealth(hp);', 'h3'),
        ],
        SCOPE,
      );
      const neighbors = await p.graphNeighbors(
        { name: 'clampHealth', path: 'scripts/s/s.gml' },
        SCOPE,
      );
      const ids = neighbors.map((h) => h.chunkId);
      expect(ids).toContain('c2'); // same file
      expect(ids).toContain('c3'); // mentions clampHealth
    } finally {
      repo.cleanup();
    }
  });

  it('persists across reopen (JSON round-trip)', async () => {
    const repo = makeTmpRepo({});
    try {
      const p1 = provider(repo.root);
      await p1.upsert([chunk('c1', 'a.gml', 'persistent content here', 'h1')], SCOPE);
      // New provider instance over the same root reads from disk.
      const p2 = provider(repo.root);
      const hits = await p2.search('persistent content here', { k: 5, scope: SCOPE });
      expect(hits.map((h) => h.chunkId)).toContain('c1');
    } finally {
      repo.cleanup();
    }
  });

  it('a stale embeddings id rebuilds the store empty', async () => {
    const repo = makeTmpRepo({});
    try {
      const p1 = new LocalMemoryProvider(
        { provider: 'local', root: repo.root },
        { embeddings: new FakeEmbeddings({ id: 'model-a', dim: 64 }) },
      );
      await p1.upsert([chunk('c1', 'a.gml', 'content', 'h1')], SCOPE);
      // Reopen with a DIFFERENT embeddings id -> store is stale -> empty.
      const p2 = new LocalMemoryProvider(
        { provider: 'local', root: repo.root },
        { embeddings: new FakeEmbeddings({ id: 'model-b', dim: 64 }) },
      );
      const hits = await p2.search('content', { k: 5, scope: SCOPE });
      expect(hits.map((h) => h.chunkId)).not.toContain('c1');
    } finally {
      repo.cleanup();
    }
  });

  it('corrupt vectors.json rebuilds empty without crashing', async () => {
    const repo = makeTmpRepo({});
    try {
      const p1 = provider(repo.root);
      await p1.upsert([chunk('c1', 'a.gml', 'content', 'h1')], SCOPE);
      // Corrupt the persisted vectors file.
      const scopeDir = path.join(repo.root, '.chatgml', 'repo-a');
      fs.writeFileSync(path.join(scopeDir, 'vectors.json'), '{ corrupt', 'utf8');
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const p2 = provider(repo.root);
      const hits = await p2.search('content', { k: 5, scope: SCOPE });
      expect(hits.map((h) => h.chunkId)).not.toContain('c1');
    } finally {
      repo.cleanup();
    }
  });
});
