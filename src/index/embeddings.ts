// src/index/embeddings.ts — the single Embeddings interface (the separate embed lane).
//
// M1 scope: the interface only. FakeEmbeddings + OpenAIEmbeddings (batched, L2-normalized,
// typed EmbeddingError) land in M2 (task 2.5).
export interface Embeddings {
  readonly dim: number;
  readonly id: string; // e.g. `${baseURLHost}:${model}` — persisted to detect stale stores
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddingsConfig {
  baseURL: string;
  apiKey?: string;
  model: string;
  dim?: number;
  batchSize?: number; // default 64
}
