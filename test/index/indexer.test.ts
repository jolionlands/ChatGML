import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runIndex } from '../../src/index/indexer.js';
import { runIndexCommand } from '../../src/index/run-index.js';
import { LocalMemoryProvider } from '../../src/memory/local.js';
import { FakeEmbeddings, makeTmpRepo } from '../helpers/fakes.js';
import { installFetchMock, jsonResponse } from '../helpers/mock-fetch.js';
import type { Scope } from '../../src/memory/types.js';
import type { Config } from '../../src/types.js';

const SCOPE: Scope = { repo: 'idx-repo' };

function deps(root: string, emb = new FakeEmbeddings()) {
  return {
    memory: new LocalMemoryProvider({ provider: 'local', root }, { embeddings: emb }),
    embeddings: emb,
  };
}

describe('runIndex (incremental)', () => {
  it('first pass indexes; second pass on an unchanged repo does 0 embed calls', async () => {
    const repo = makeTmpRepo({
      'objects/obj_a/Step_0.gml': 'hp -= 1;',
      'scripts/s/s.gml': 'function f(){ return 1; }',
    });
    try {
      const emb = new FakeEmbeddings();
      const spy = vi.spyOn(emb, 'embed');
      const d = deps(repo.root, emb);
      const first = await runIndex(repo.root, SCOPE, d);
      expect(first.scanned).toBe(2);
      expect(first.added).toBe(2);
      expect(spy.mock.calls.length).toBeGreaterThan(0);

      spy.mockClear();
      const second = await runIndex(repo.root, SCOPE, d);
      expect(second.unchanged).toBe(2);
      expect(second.added).toBe(0);
      expect(spy.mock.calls.length).toBe(0); // 0 embed calls when nothing changed
    } finally {
      repo.cleanup();
    }
  });

  it('a single edited file is re-embedded alone', async () => {
    const repo = makeTmpRepo({
      'a.gml': 'aaa',
      'b.gml': 'bbb',
    });
    try {
      const emb = new FakeEmbeddings();
      const d = deps(repo.root, emb);
      await runIndex(repo.root, SCOPE, d);

      // Edit only a.gml.
      fs.writeFileSync(path.join(repo.root, 'a.gml'), 'aaa changed', 'utf8');
      const spy = vi.spyOn(emb, 'embed');
      const res = await runIndex(repo.root, SCOPE, d);
      expect(res.modified).toBe(1);
      expect(res.unchanged).toBe(1);
      // exactly one file embedded (one embed call with the changed chunk).
      expect(spy.mock.calls.length).toBe(1);
    } finally {
      repo.cleanup();
    }
  });

  it('content change with an identical mtime is still re-embedded (hash wins)', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'original' });
    try {
      const emb = new FakeEmbeddings();
      const d = deps(repo.root, emb);
      await runIndex(repo.root, SCOPE, d);

      const file = path.join(repo.root, 'a.gml');
      const stat = fs.statSync(file);
      // Rewrite content to the SAME byte length but different content, then pin mtime back.
      fs.writeFileSync(file, 'modified', 'utf8'); // same length as 'original' (8 chars)
      fs.utimesSync(file, stat.atime, stat.mtime);

      const spy = vi.spyOn(emb, 'embed');
      const res = await runIndex(repo.root, SCOPE, d);
      // Despite identical mtime+size, the hash differs -> re-embedded.
      expect(res.modified).toBe(1);
      expect(spy.mock.calls.length).toBe(1);
    } finally {
      repo.cleanup();
    }
  });

  it('switching the embeddings model forces a full rebuild (with a stated reason) — D3', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'content' });
    try {
      const d1 = deps(repo.root, new FakeEmbeddings({ id: 'model-a' }));
      await runIndex(repo.root, SCOPE, d1);

      const emb2 = new FakeEmbeddings({ id: 'model-b' });
      const spy = vi.spyOn(emb2, 'embed');
      const d2 = deps(repo.root, emb2);
      const res = await runIndex(repo.root, SCOPE, d2);
      expect(res.fullRebuild).toBe(true);
      expect(res.rebuildReason).toMatch(/model changed.*model-a.*model-b/);
      expect(res.added).toBe(1); // treated as new because the manifest was invalidated
      expect(spy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      repo.cleanup();
    }
  });

  it('same model on a DIFFERENT host/port reuses the store — no rebuild (D3)', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'content', 'b.gml': 'more' });
    try {
      // Identity is keyed on the MODEL only (id), so an ollama/llama.cpp restart that moves to a new
      // port presents the SAME id and must NOT re-embed. Two distinct provider instances, same id.
      const first = deps(repo.root, new FakeEmbeddings({ id: 'embed-3' }));
      const r1 = await runIndex(repo.root, SCOPE, first);
      expect(r1.added).toBe(2);

      const emb2 = new FakeEmbeddings({ id: 'embed-3' }); // same model, "different port"
      const spy = vi.spyOn(emb2, 'embed');
      const second = deps(repo.root, emb2);
      const r2 = await runIndex(repo.root, SCOPE, second);
      expect(r2.fullRebuild).toBe(false);
      expect(r2.rebuildReason).toBeUndefined();
      expect(r2.unchanged).toBe(2);
      expect(r2.added).toBe(0);
      expect(spy.mock.calls.length).toBe(0); // store reused: zero embed calls
    } finally {
      repo.cleanup();
    }
  });

  it('a changed vector DIMENSION forces a full rebuild — D3', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'content' });
    try {
      // Same model id, but the vector dim changed (e.g. a model re-quantized to a different head dim).
      const first = deps(repo.root, new FakeEmbeddings({ id: 'embed-3', dim: 64 }));
      await runIndex(repo.root, SCOPE, first);

      const emb2 = new FakeEmbeddings({ id: 'embed-3', dim: 32 });
      const spy = vi.spyOn(emb2, 'embed');
      const second = deps(repo.root, emb2);
      const res = await runIndex(repo.root, SCOPE, second);
      expect(res.fullRebuild).toBe(true);
      expect(res.rebuildReason).toMatch(/dimension changed.*64.*32/);
      expect(res.added).toBe(1);
      expect(spy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      repo.cleanup();
    }
  });

  it('forceRebuild discards the manifest and re-processes every file even when identity is unchanged — D3', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'content', 'b.gml': 'more' });
    try {
      const first = deps(repo.root, new FakeEmbeddings({ id: 'embed-3' }));
      const r1 = await runIndex(repo.root, SCOPE, first);
      expect(r1.added).toBe(2);

      // Same id+dim, so WITHOUT forceRebuild the second pass would be all-unchanged (0 added). With
      // forceRebuild the manifest is discarded and every file is re-chunked + re-upserted as "added".
      // (The vector store still dedupes by content hash, so unchanged content isn't re-embedded — the
      // observable contract of forceRebuild is "manifest discarded, every file re-processed".)
      const second = deps(repo.root, new FakeEmbeddings({ id: 'embed-3' }));
      const res = await runIndex(repo.root, SCOPE, second, { forceRebuild: true });
      expect(res.fullRebuild).toBe(true);
      expect(res.rebuildReason).toBe('forced');
      expect(res.added).toBe(2); // manifest discarded -> both treated as new
      expect(res.unchanged).toBe(0);
    } finally {
      repo.cleanup();
    }
  });

  it('skips a NUL-bearing file under an indexed extension (binary sniff) — F6', async () => {
    const repo = makeTmpRepo({ 'good.gml': 'hp -= 1;' });
    try {
      // A .txt (indexed extension) that actually contains NUL bytes must not be embedded verbatim.
      fs.writeFileSync(path.join(repo.root, 'blob.txt'), Buffer.from([0x61, 0x00, 0x62, 0x00]));
      const emb = new FakeEmbeddings();
      const spy = vi.spyOn(emb, 'embed');
      const d = deps(repo.root, emb);
      const res = await runIndex(repo.root, SCOPE, d);
      // The binary file is scanned (walked) but NOT added (no chunk upserted for it).
      expect(res.added).toBe(1); // only good.gml
      // None of the embedded inputs contain a NUL byte.
      const embedded = spy.mock.calls.flatMap((c) => c[0]);
      expect(embedded.some((t) => t.includes('\0'))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('does NOT index its own project-local .chatgml.json — F7', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'hp -= 1;' });
    try {
      fs.writeFileSync(
        path.join(repo.root, '.chatgml.json'),
        JSON.stringify({ chat: { model: 'm' } }),
        'utf8',
      );
      const d = deps(repo.root);
      const res = await runIndex(repo.root, SCOPE, d);
      // Only a.gml is indexed; the config .json is excluded from the walk.
      expect(res.added).toBe(1);
      const hits = await d.memory.search('chat model', { k: 5, scope: SCOPE });
      expect(hits.every((h) => h.path !== '.chatgml.json')).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  it('a deleted file is purged and recorded in the changelog', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'aaa', 'b.gml': 'bbb' });
    try {
      const d = deps(repo.root);
      await runIndex(repo.root, SCOPE, d);
      fs.rmSync(path.join(repo.root, 'b.gml'));
      const res = await runIndex(repo.root, SCOPE, d);
      expect(res.deleted).toBe(1);
      const hist = await d.memory.temporalQuery({ kind: 'history', path: 'b.gml' }, SCOPE);
      const kinds = hist.map((h) => (h.extra as { changeKind: string }).changeKind);
      expect(kinds).toContain('deleted');
    } finally {
      repo.cleanup();
    }
  });
});

describe('runIndexCommand (CLI wiring)', () => {
  it('builds the local store from a Config using injected embeddings', async () => {
    const repo = makeTmpRepo({ 'objects/o/Step_0.gml': 'hp -= 1;' });
    try {
      const config: Config = {
        chat: { baseURL: 'http://x', model: 'm', temperature: 0.2 },
        embed: { baseURL: 'http://x', model: 'e', batchSize: 64 },
        memory: { provider: 'local' },
        scope: 'idx-repo',
        mode: 'code',
        approval: 'gated',
        index: { chunkSize: 1500, chunkOverlap: 200, root: repo.root },
        search: {},
      };
      const res = await runIndexCommand(config, { embeddings: new FakeEmbeddings() });
      expect(res.added).toBe(1);
      // The store can be searched afterward.
      const mem = new LocalMemoryProvider(
        { provider: 'local', root: repo.root },
        { embeddings: new FakeEmbeddings() },
      );
      const hits = await mem.search('hp', { k: 3, scope: { repo: 'idx-repo' } });
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      repo.cleanup();
    }
  });

  it('constructs OpenAIEmbeddings over the embed lane when none injected (fetch mocked)', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'hp -= dmg;' });
    try {
      const { recorder, fetch } = installFetchMock([
        {
          match: '/embeddings',
          responder: (c) => {
            const inputs = JSON.parse(c.body!).input as string[];
            return jsonResponse({
              data: inputs.map((_, index) => ({ index, embedding: [1, 2, 3, 4] })),
            });
          },
        },
      ]);
      const config: Config = {
        chat: { baseURL: 'http://chat', model: 'm', temperature: 0.2 },
        embed: {
          baseURL: 'http://embed/v1',
          apiKey: 'sk-SENTINEL-DEADBEEF',
          model: 'e',
          batchSize: 8,
        },
        memory: { provider: 'local' },
        scope: 'idx-repo',
        mode: 'code',
        approval: 'gated',
        index: { chunkSize: 1500, chunkOverlap: 200, root: repo.root },
        search: {},
      };
      const res = await runIndexCommand(config, { fetch });
      expect(res.added).toBe(1);
      expect(recorder.calls[0]!.url).toBe('http://embed/v1/embeddings');
    } finally {
      repo.cleanup();
    }
  });

  it('uses the global fetch and no apiKey when neither is provided', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'content' });
    try {
      // installFetchMock stubs globalThis.fetch; runIndexCommand is called with NO deps.fetch and the
      // embed lane has NO apiKey -> exercises both the missing-apiKey and missing-deps.fetch branches.
      const { recorder } = installFetchMock([
        {
          match: '/embeddings',
          responder: (c) => {
            const inputs = JSON.parse(c.body!).input as string[];
            return jsonResponse({
              data: inputs.map((_, index) => ({ index, embedding: [1, 2, 3, 4] })),
            });
          },
        },
      ]);
      const config: Config = {
        chat: { baseURL: 'http://chat', model: 'm', temperature: 0.2 },
        embed: { baseURL: 'http://embed/v1', model: 'e', batchSize: 64 },
        memory: { provider: 'local' },
        scope: 'idx-repo-2',
        mode: 'code',
        approval: 'gated',
        index: { chunkSize: 1500, chunkOverlap: 200, root: repo.root },
        search: {},
      };
      const res = await runIndexCommand(config);
      expect(res.added).toBe(1);
      expect(recorder.calls[0]!.headers['authorization']).toBeUndefined();
    } finally {
      repo.cleanup();
    }
  });
});
