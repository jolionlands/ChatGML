// src/index.ts — public barrel (the integration surface).
//
// Re-exports the shared types, config, llm client, the index pipeline (files/chunk/embeddings/gml/
// indexer), and the memory layer (provider seam + local/hippo backends). Agent/tools land in M3.
export type * from './types.js';
export * from './tool-error.js';
export * from './config.js';
export * from './llm.js';

// Index pipeline.
export * from './index/gml.js';
export * from './index/files.js';
export * from './index/chunk.js';
export * from './index/embeddings.js';
export * from './index/indexer.js';
export * from './index/run-index.js';

// Memory layer.
export * from './memory/types.js';
export * from './memory/provider.js';
export * from './memory/persist.js';
export * from './memory/bm25.js';
export * from './memory/fusion.js';
export { LocalMemoryProvider } from './memory/local.js';
export { HippoMemoryProvider } from './memory/hippo.js';
