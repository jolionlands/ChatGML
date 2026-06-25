// src/index/run-index.ts — the `chatgml index <dir>` runner.
//
// Assembles the embed lane + memory provider from a resolved Config and runs the incremental indexer
// over <dir>. This is the reusable piece the CLI's `index` subcommand calls (M3 wires the commander
// command to this function). Embeddings are INJECTABLE so a smoke/test run can pass FakeEmbeddings.
import type { Config } from '../types.js';
import { makeScope } from '../memory/types.js';
import { createMemoryProvider } from '../memory/provider.js';
import { OpenAIEmbeddings, type Embeddings } from './embeddings.js';
import { runIndex, type IndexResult } from './indexer.js';
import type { FetchLike } from '../llm.js';

export interface RunIndexDeps {
  /** Inject a deterministic Embeddings (tests/smoke); defaults to OpenAIEmbeddings over the embed lane. */
  embeddings?: Embeddings;
  fetch?: FetchLike;
}

/**
 * Build (or incrementally update) the local index for `config.index.root`. Only files whose content
 * hash changed are re-embedded. Returns the per-file change counts.
 */
export async function runIndexCommand(config: Config, deps: RunIndexDeps = {}): Promise<IndexResult> {
  const root = config.index.root;
  const scope = makeScope(config.scope);

  const embeddings =
    deps.embeddings ??
    new OpenAIEmbeddings(
      {
        baseURL: config.embed.baseURL,
        ...(config.embed.apiKey !== undefined ? { apiKey: config.embed.apiKey } : {}),
        model: config.embed.model,
        batchSize: config.embed.batchSize,
      },
      deps.fetch ? { fetch: deps.fetch } : {},
    );

  const memory = await createMemoryProvider({ ...config.memory, root }, { embeddings });

  const result = await runIndex(root, scope, { memory, embeddings }, {
    chunkSize: config.index.chunkSize,
    chunkOverlap: config.index.chunkOverlap,
  });

  if (memory.close) await memory.close();
  return result;
}
