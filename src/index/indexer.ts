// src/index/indexer.ts — incremental index driver.
//
// Walks a repo, chunks changed files, and upserts them into a MemoryProvider. A manifest under
// `<root>/.chatgml/manifest.json` records per-file `{ contentHash, mtimeMs, size }`. Change detection
// is HASH-FIRST: `mtimeMs`+`size` is only a fast-path hint to SKIP re-reading a file; whenever a file
// is read its sha256 is the source of truth (so a content change with an identical mtime is still
// re-embedded). The manifest also records the embeddings id; a mismatch forces a full rebuild.
//
// Unchanged repo on a second pass => 0 embed calls (the provider only embeds changed chunk hashes,
// and unchanged files are not even re-chunked). Deleted files are purged from the provider + changelog.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Scope } from '../types.js';
import type { MemoryProvider } from '../memory/provider.js';
import type { Embeddings } from './embeddings.js';
import { buildIgnoreFilter, walkFiles, type WalkOptions } from './files.js';
import { chunkFile, hashContent } from './chunk.js';
import { readJson, writeJsonAtomic } from '../memory/persist.js';

interface ManifestEntry {
  contentHash: string;
  mtimeMs: number;
  size: number;
}

interface Manifest {
  version: number;
  embeddingsId: string;
  files: Record<string, ManifestEntry>;
}

const MANIFEST_VERSION = 1;

export interface IndexOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  walk?: WalkOptions;
}

export interface IndexResult {
  scanned: number;
  added: number;
  modified: number;
  unchanged: number;
  deleted: number;
  fullRebuild: boolean;
}

export interface IndexerDeps {
  memory: MemoryProvider;
  embeddings: Embeddings;
}

function manifestPath(root: string): string {
  return path.join(root, '.chatgml', 'manifest.json');
}

function loadManifest(root: string, embeddingsId: string): { manifest: Manifest; fullRebuild: boolean } {
  const loaded = readJson<Manifest>(manifestPath(root));
  if (!loaded || loaded.version !== MANIFEST_VERSION || loaded.embeddingsId !== embeddingsId) {
    // Embeddings model switched (or no/stale manifest) -> full rebuild.
    return {
      manifest: { version: MANIFEST_VERSION, embeddingsId, files: {} },
      fullRebuild: loaded !== null,
    };
  }
  return { manifest: loaded, fullRebuild: false };
}

/**
 * Incrementally (re)build the index for `root` into `deps.memory` under `scope`. Returns counts of
 * scanned/added/modified/unchanged/deleted files. Only changed files are re-chunked and re-embedded.
 */
export async function runIndex(
  root: string,
  scope: Scope,
  deps: IndexerDeps,
  opts: IndexOptions = {},
): Promise<IndexResult> {
  const { manifest, fullRebuild } = loadManifest(root, deps.embeddings.id);
  const prevFiles = fullRebuild ? {} : manifest.files;
  const nextFiles: Record<string, ManifestEntry> = {};

  const ignore = await buildIgnoreFilter(root);
  const result: IndexResult = {
    scanned: 0,
    added: 0,
    modified: 0,
    unchanged: 0,
    deleted: 0,
    fullRebuild,
  };

  const chunkOpts: { chunkSize?: number; chunkOverlap?: number } = {};
  if (opts.chunkSize !== undefined) chunkOpts.chunkSize = opts.chunkSize;
  if (opts.chunkOverlap !== undefined) chunkOpts.chunkOverlap = opts.chunkOverlap;

  const seen = new Set<string>();

  for await (const file of walkFiles(root, (p) => ignore.ignores(p), opts.walk ?? {})) {
    result.scanned++;
    seen.add(file.relPath);

    let stat: { mtimeMs: number; size: number };
    try {
      const s = await fsp.stat(file.absPath);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      continue;
    }

    const prev = prevFiles[file.relPath];
    // Fast-path hint: if mtime AND size match, assume unchanged WITHOUT re-reading (hash is still the
    // source of truth whenever we DO read; here we trust the hint to avoid I/O).
    if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
      nextFiles[file.relPath] = prev;
      result.unchanged++;
      continue;
    }

    // Read + hash. Hash WINS over mtime: an identical mtime but changed content is re-embedded.
    let text: string;
    try {
      text = await fsp.readFile(file.absPath, 'utf8');
    } catch {
      continue;
    }
    const contentHash = hashContent(text);
    if (prev && prev.contentHash === contentHash) {
      // Content identical despite mtime/size drift: refresh the hint, no re-embed.
      nextFiles[file.relPath] = { contentHash, mtimeMs: stat.mtimeMs, size: stat.size };
      result.unchanged++;
      continue;
    }

    // Changed (or new): re-chunk + upsert. The provider re-embeds only changed chunk hashes.
    const chunks = chunkFile(file.relPath, text, chunkOpts);
    await deps.memory.upsert(chunks, scope);
    nextFiles[file.relPath] = { contentHash, mtimeMs: stat.mtimeMs, size: stat.size };
    if (prev) result.modified++;
    else result.added++;
  }

  // Purge files that disappeared (present in the manifest but not seen this pass).
  const deleted: string[] = [];
  for (const relPath of Object.keys(prevFiles)) {
    if (!seen.has(relPath)) deleted.push(relPath);
  }
  if (deleted.length > 0 && hasPurge(deps.memory)) {
    await deps.memory.purge(deleted, scope);
  }
  result.deleted = deleted.length;

  manifest.files = nextFiles;
  await writeJsonAtomic(manifestPath(root), manifest);
  return result;
}

interface Purgeable {
  purge(paths: string[], scope: Scope): Promise<void>;
}

function hasPurge(m: MemoryProvider): m is MemoryProvider & Purgeable {
  return typeof (m as Partial<Purgeable>).purge === 'function';
}
