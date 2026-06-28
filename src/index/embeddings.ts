// src/index/embeddings.ts — the single Embeddings interface (the separate embed lane).
//
// `Embeddings` is an INJECTABLE interface: tests pass a deterministic FakeEmbeddings (see
// test/helpers/fakes.ts), production passes OpenAIEmbeddings which calls an OpenAI-compatible
// `/v1/embeddings` endpoint, batched, over global fetch (injectable for tests). Vectors are
// L2-normalized so cosine similarity reduces to a dot product. Secrets are never logged; error
// bodies are truncated + key-scrubbed.
import type { FetchLike } from '../llm.js';
import { scrubBody, resolveFetch, trimTrailingSlash } from '../http.js';

export interface Embeddings {
  readonly dim: number;
  /**
   * Store-identity key, persisted to detect a stale store. (D3) Keyed on the embedding MODEL — NOT on
   * host:port — so re-indexing the SAME model on a different baseURL (a llama.cpp/ollama restart that
   * lands on a new ephemeral port) reuses the existing store instead of forcing a needless full
   * re-embed. A genuinely different MODEL changes `id`; a different vector DIMENSION is caught via the
   * separate `dim` field (see indexer/local store staleness checks). Together `id` + `dim` are the
   * store identity.
   */
  readonly id: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddingsConfig {
  baseURL: string;
  apiKey?: string;
  model: string;
  dim?: number;
  batchSize?: number; // default 64
}

export class EmbeddingError extends Error {
  readonly status?: number;
  readonly body?: string; // truncated, key-scrubbed

  constructor(message: string, opts?: { status?: number; body?: string }) {
    super(message);
    this.name = 'EmbeddingError';
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.body !== undefined) this.body = opts.body;
  }
}

export interface EmbeddingsDeps {
  fetch?: FetchLike;
}

const DEFAULT_BATCH = 64;

function embeddingsUrl(baseURL: string): string {
  return `${trimTrailingSlash(baseURL)}/embeddings`;
}

/** L2-normalize a vector in place and return it. A zero vector is left as-is. */
function l2normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  }
  return v;
}

interface RawEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

/**
 * OpenAI-compatible embeddings over the separate embed lane. Batches requests at `batchSize`,
 * preserves input order across batches and within a batch (sorting by the server-returned `index`),
 * and L2-normalizes each vector. `dim` is learned from the first response if not configured.
 */
export class OpenAIEmbeddings implements Embeddings {
  readonly id: string;
  private _dim: number;
  private readonly cfg: EmbeddingsConfig;
  private readonly fetchImpl: FetchLike;

  constructor(cfg: EmbeddingsConfig, deps?: EmbeddingsDeps) {
    this.cfg = cfg;
    // (D3) Identity = MODEL (not host:port). A restart on a new port reuses the store; the vector
    // DIMENSION is tracked separately (this.dim, learned from the first response if not configured).
    this.id = cfg.model;
    this._dim = cfg.dim ?? 0;
    try {
      this.fetchImpl = resolveFetch(deps);
    } catch {
      throw new EmbeddingError('no fetch implementation available');
    }
  }

  get dim(): number {
    return this._dim;
  }

  private get batchSize(): number {
    const b = this.cfg.batchSize ?? DEFAULT_BATCH;
    return b > 0 ? b : DEFAULT_BATCH;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vecs = await this.embedBatch(batch);
      for (const v of vecs) out.push(v);
    }
    return out;
  }

  private async embedBatch(batch: string[]): Promise<Float32Array[]> {
    const url = embeddingsUrl(this.cfg.baseURL);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.apiKey !== undefined && this.cfg.apiKey !== '') {
      headers['authorization'] = `Bearer ${this.cfg.apiKey}`;
    }
    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.cfg.model, input: batch }),
    };

    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch {
      throw new EmbeddingError('network error contacting embeddings endpoint');
    }
    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        body = '';
      }
      throw new EmbeddingError(`embeddings endpoint returned HTTP ${res.status}`, {
        status: res.status,
        body: scrubBody(body),
      });
    }

    let json: RawEmbeddingResponse;
    try {
      json = (await res.json()) as RawEmbeddingResponse;
    } catch {
      throw new EmbeddingError('failed to parse embeddings response');
    }
    const data = json.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new EmbeddingError(
        `embeddings response count mismatch (expected ${batch.length}, got ${data?.length ?? 0})`,
      );
    }
    // Order by server `index` when present, else assume response order.
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((d, i) => {
      const arr = d.embedding;
      if (!Array.isArray(arr) || arr.length === 0) {
        throw new EmbeddingError(`embeddings response missing embedding at index ${i}`);
      }
      if (this._dim === 0) this._dim = arr.length;
      const v = new Float32Array(arr.length);
      for (let k = 0; k < arr.length; k++) v[k] = arr[k]!;
      return l2normalize(v);
    });
  }
}
