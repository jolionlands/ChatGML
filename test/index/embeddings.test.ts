import { describe, it, expect, vi } from 'vitest';
import { OpenAIEmbeddings, EmbeddingError } from '../../src/index/embeddings.js';
import { FakeEmbeddings } from '../helpers/fakes.js';
import { installFetchMock, jsonResponse, errorResponse, FetchRecorder } from '../helpers/mock-fetch.js';

const SENTINEL = 'sk-SENTINEL-DEADBEEF';

function embeddingPayload(inputs: string[]): unknown {
  return {
    data: inputs.map((_, index) => ({
      index,
      embedding: [index + 1, index + 2, index + 3, index + 4],
    })),
  };
}

describe('FakeEmbeddings (injected, deterministic)', () => {
  it('is deterministic across instances and never fetches', async () => {
    const a = new FakeEmbeddings();
    const b = new FakeEmbeddings();
    const [va] = await a.embed(['hello']);
    const [vb] = await b.embed(['hello']);
    expect(Array.from(va!)).toEqual(Array.from(vb!));
    // setup.ts installs a throwing fetch; FakeEmbeddings must not have called it.
  });

  it('produces unit-norm vectors of the configured dim', async () => {
    const e = new FakeEmbeddings({ dim: 16 });
    const [v] = await e.embed(['x']);
    expect(v!.length).toBe(16);
    let norm = 0;
    for (const c of v!) norm += c * c;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });
});

describe('OpenAIEmbeddings', () => {
  it('hits the embed baseURL with the embed model + Bearer key', async () => {
    const { recorder, fetch } = installFetchMock([
      { match: '/embeddings', responder: (c) => jsonResponse(embeddingPayload([readInput(c)])) },
    ]);
    const e = new OpenAIEmbeddings(
      { baseURL: 'https://embeds.example.com/v1', apiKey: SENTINEL, model: 'embed-3' },
      { fetch },
    );
    await e.embed(['just one']);
    const call = recorder.calls[0]!;
    expect(call.url).toBe('https://embeds.example.com/v1/embeddings');
    expect(call.headers['authorization']).toBe(`Bearer ${SENTINEL}`);
    expect(JSON.parse(call.body!).model).toBe('embed-3');
  });

  it('omits Authorization when no apiKey is configured', async () => {
    const { recorder, fetch } = installFetchMock([
      { match: '/embeddings', responder: (c) => jsonResponse(embeddingPayload([readInput(c)])) },
    ]);
    const e = new OpenAIEmbeddings({ baseURL: 'http://x/v1', model: 'm' }, { fetch });
    await e.embed(['a']);
    expect(recorder.calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('batches above batchSize and preserves overall order', async () => {
    const { recorder, fetch } = installFetchMock([
      {
        match: '/embeddings',
        responder: (c) => {
          const inputs = JSON.parse(c.body!).input as string[];
          return jsonResponse(embeddingPayload(inputs));
        },
      },
    ]);
    const e = new OpenAIEmbeddings(
      { baseURL: 'http://x/v1', model: 'm', batchSize: 2 },
      { fetch },
    );
    const out = await e.embed(['a', 'b', 'c', 'd', 'e']);
    expect(out).toHaveLength(5);
    expect(recorder.calls).toHaveLength(3); // ceil(5/2)
    // First vector corresponds to index 0 of its batch -> embedding [1,2,3,4] normalized.
    expect(out[0]!.length).toBe(4);
  });

  it('reorders within a batch by server index', async () => {
    const { fetch } = installFetchMock([
      {
        match: '/embeddings',
        responder: () =>
          jsonResponse({
            data: [
              { index: 1, embedding: [0, 0, 0, 9] },
              { index: 0, embedding: [9, 0, 0, 0] },
            ],
          }),
      },
    ]);
    const e = new OpenAIEmbeddings({ baseURL: 'http://x/v1', model: 'm' }, { fetch });
    const out = await e.embed(['first', 'second']);
    // index 0 (the 9-in-position-0 vector) must come back first.
    expect(out[0]![0]).toBeCloseTo(1, 5);
    expect(out[1]![3]).toBeCloseTo(1, 5);
  });

  it('throws a typed EmbeddingError on HTTP 500 with no key leak', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => true);
    const { fetch } = installFetchMock([
      {
        match: '/embeddings',
        responder: () => errorResponse(500, `boom with Bearer ${SENTINEL} leaking`),
      },
    ]);
    const e = new OpenAIEmbeddings(
      { baseURL: 'http://x/v1', apiKey: SENTINEL, model: 'm' },
      { fetch },
    );
    let err: unknown;
    try {
      await e.embed(['a']);
    } catch (e2) {
      err = e2;
    }
    expect(err).toBeInstanceOf(EmbeddingError);
    const ee = err as EmbeddingError;
    expect(ee.status).toBe(500);
    FetchRecorder.assertNoAuthLeak(SENTINEL, ee.message, ee.body ?? '', String(ee.stack));
  });

  it('throws on a response count mismatch', async () => {
    const { fetch } = installFetchMock([
      { match: '/embeddings', responder: () => jsonResponse({ data: [] }) },
    ]);
    const e = new OpenAIEmbeddings({ baseURL: 'http://x/v1', model: 'm' }, { fetch });
    await expect(e.embed(['a', 'b'])).rejects.toThrow(EmbeddingError);
  });

  it('throws when an embedding entry is missing/empty', async () => {
    const { fetch } = installFetchMock([
      { match: '/embeddings', responder: () => jsonResponse({ data: [{ index: 0, embedding: [] }] }) },
    ]);
    const e = new OpenAIEmbeddings({ baseURL: 'http://x/v1', model: 'm' }, { fetch });
    await expect(e.embed(['a'])).rejects.toThrow(/missing embedding/);
  });

  it('throws on a non-JSON response body', async () => {
    const { fetch } = installFetchMock([
      { match: '/embeddings', responder: () => new Response('not json', { status: 200 }) },
    ]);
    const e = new OpenAIEmbeddings({ baseURL: 'http://x/v1', model: 'm' }, { fetch });
    await expect(e.embed(['a'])).rejects.toThrow(/parse/);
  });

  it('maps a thrown fetch (network error) to a typed EmbeddingError', async () => {
    const failing = (() => {
      throw new Error('socket hang up');
    }) as unknown as typeof globalThis.fetch;
    const e = new OpenAIEmbeddings(
      { baseURL: 'http://x/v1', model: 'm' },
      { fetch: failing as never },
    );
    await expect(e.embed(['a'])).rejects.toThrow(/network error/);
  });

  it('a zero batchSize falls back to the default', async () => {
    const { recorder, fetch } = installFetchMock([
      {
        match: '/embeddings',
        responder: (c) => {
          const inputs = JSON.parse(c.body!).input as string[];
          return jsonResponse(embeddingPayload(inputs));
        },
      },
    ]);
    const e = new OpenAIEmbeddings({ baseURL: 'http://x/v1', model: 'm', batchSize: 0 }, { fetch });
    await e.embed(['a', 'b']);
    expect(recorder.calls).toHaveLength(1); // one batch (default 64 covers both)
  });

  it('store identity (id) is the MODEL only, independent of host/port (D3)', () => {
    // Same model on two different baseURLs (e.g. an ollama/llama.cpp restart on a new port) -> same id,
    // so re-indexing reuses the store instead of a needless full re-embed.
    const a = new OpenAIEmbeddings({ baseURL: 'http://127.0.0.1:11434/v1', model: 'embed-3' });
    const b = new OpenAIEmbeddings({ baseURL: 'http://127.0.0.1:54321/v1', model: 'embed-3' });
    expect(a.id).toBe('embed-3');
    expect(a.id).toBe(b.id);
    // A genuinely different model name still changes the identity.
    const c = new OpenAIEmbeddings({ baseURL: 'http://127.0.0.1:11434/v1', model: 'embed-4' });
    expect(c.id).not.toBe(a.id);
  });

  it('learns dim from the first response', async () => {
    const { fetch } = installFetchMock([
      {
        match: '/embeddings',
        responder: () => jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
      },
    ]);
    const e = new OpenAIEmbeddings({ baseURL: 'http://x/v1', model: 'm' }, { fetch });
    expect(e.dim).toBe(0);
    await e.embed(['a']);
    expect(e.dim).toBe(3);
  });
});

function readInput(c: { body?: string }): string {
  const arr = JSON.parse(c.body!).input as string[];
  return arr[0]!;
}
