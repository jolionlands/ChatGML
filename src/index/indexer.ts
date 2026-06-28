// src/index/indexer.ts — incremental index driver.
//
// Walks a repo, chunks changed files, and upserts them into a MemoryProvider. A manifest under
// `<root>/.chatgml/manifest.json` records per-file `{ contentHash, mtimeMs, size }`. Change detection
// is HASH-FIRST: `mtimeMs`+`size` is only a fast-path hint to SKIP re-reading a file; whenever a file
// is read its sha256 is the source of truth (so a content change with an identical mtime is still
// re-embedded). The manifest also records the embeddings store identity — the embedding MODEL id and
// the vector DIMENSION (D3). A full rebuild is forced ONLY when the MODEL changes or the DIMENSION
// changes (both known) — NOT when the host:port changes — so a llama.cpp/ollama restart on a new
// ephemeral port reuses the store and re-indexes incrementally. `opts.forceRebuild` is an explicit
// escape hatch. When a rebuild IS triggered, `IndexResult.rebuildReason` states why.
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
import { deriveGmlMeta } from './gml.js';
import { buildGmResolver, findYypOnDisk, defaultReader, type GmResolver } from './gm-resolver.js';
import { writeEnrichmentSidecar, clearGmlDeriverCache, type GmEnrichment } from './gml-enrich.js';

interface ManifestEntry {
  contentHash: string;
  mtimeMs: number;
  size: number;
}

interface Manifest {
  version: number;
  /** Embedding store identity = the MODEL id (D3); a change forces a full rebuild. */
  embeddingsId: string;
  /** Vector dimension (D3); a change (when both old + new are known, >0) forces a full rebuild. */
  dim: number;
  files: Record<string, ManifestEntry>;
}

const MANIFEST_VERSION = 1;

export interface IndexOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  walk?: WalkOptions;
  /** Explicit escape hatch: discard the manifest and re-embed everything regardless of identity. */
  forceRebuild?: boolean;
}

export interface IndexResult {
  scanned: number;
  added: number;
  modified: number;
  unchanged: number;
  deleted: number;
  fullRebuild: boolean;
  /**
   * Why a full rebuild was triggered (model/dim change, or an explicit force), or `undefined` when
   * the run was incremental. Surfaced in the CLI's `(full rebuild: <reason>)` banner. (D3)
   */
  rebuildReason?: string;
  /**
   * Number of `.gml` object-event files whose citation meta was enriched with fs-aware `.yy`/`.yyp`
   * data (resolved collision targets and/or parent inheritance). 0 when the root is not a GameMaker
   * project or when no event file resolved anything.
   */
  gmEnriched: number;
}

export interface IndexerDeps {
  memory: MemoryProvider;
  embeddings: Embeddings;
}

function manifestPath(root: string): string {
  return path.join(root, '.chatgml', 'manifest.json');
}

/** Cheap binary sniff: a NUL byte in the first ~8KB (same heuristic as read_file/grep). */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Decide whether to reuse or discard the on-disk manifest. A rebuild is forced when (a) the caller
 * passes `forceRebuild`, (b) the manifest is absent/version-stale, (c) the embedding MODEL id changed,
 * or (d) the vector DIMENSION changed — but only when BOTH the stored and the current dim are KNOWN
 * (> 0), mirroring the local store's stale guard (a fresh OpenAIEmbeddings learns its dim lazily, so
 * dim is 0 at load time and must not spuriously trip a rebuild). NOTE: a host:port change does NOT
 * trip a rebuild — `embeddingsId` is keyed on the model only (D3). `fresh` distinguishes "no prior
 * manifest" (a first-ever index, NOT reported as a full rebuild) from a genuine identity change.
 */
function loadManifest(
  root: string,
  embeddingsId: string,
  dim: number,
  forceRebuild: boolean,
): { manifest: Manifest; fullRebuild: boolean; reason?: string } {
  const loaded = readJson<Manifest>(manifestPath(root));
  const empty: Manifest = { version: MANIFEST_VERSION, embeddingsId, dim, files: {} };

  if (forceRebuild) {
    return { manifest: empty, fullRebuild: loaded !== null, reason: 'forced' };
  }
  if (!loaded || loaded.version !== MANIFEST_VERSION) {
    // No prior manifest (first index) or an incompatible version: build from scratch. A first-ever
    // index is not surfaced as a "(full rebuild)" — there was nothing to rebuild.
    return { manifest: empty, fullRebuild: false };
  }
  if (loaded.embeddingsId !== embeddingsId) {
    return {
      manifest: empty,
      fullRebuild: true,
      reason: `embedding model changed (${loaded.embeddingsId} -> ${embeddingsId})`,
    };
  }
  // Dimension change, but only when BOTH dims are known (>0). A lazily-learned 0 never trips this.
  const storedDim = loaded.dim ?? 0;
  if (storedDim > 0 && dim > 0 && storedDim !== dim) {
    return {
      manifest: empty,
      fullRebuild: true,
      reason: `vector dimension changed (${storedDim} -> ${dim})`,
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
  const { manifest, fullRebuild, reason } = loadManifest(
    root,
    deps.embeddings.id,
    deps.embeddings.dim,
    opts.forceRebuild ?? false,
  );
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
    gmEnriched: 0,
  };
  if (reason !== undefined) result.rebuildReason = reason;

  const chunkOpts: { chunkSize?: number; chunkOverlap?: number } = {};
  if (opts.chunkSize !== undefined) chunkOpts.chunkSize = opts.chunkSize;
  if (opts.chunkOverlap !== undefined) chunkOpts.chunkOverlap = opts.chunkOverlap;

  const seen = new Set<string>();
  // Every `.gml` path seen this pass (changed or not), for the post-walk fs-aware enrichment.
  const gmlPaths: string[] = [];

  for await (const file of walkFiles(root, (p) => ignore.ignores(p), opts.walk ?? {})) {
    result.scanned++;
    seen.add(file.relPath);
    if (file.relPath.toLowerCase().endsWith('.gml')) gmlPaths.push(file.relPath);

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
    let buf: Buffer;
    try {
      buf = await fsp.readFile(file.absPath);
    } catch {
      continue;
    }
    // Binary sniff (first ~8KB NUL-byte check), mirroring read_file/grep. A NUL-bearing file under an
    // indexed extension would otherwise be embedded verbatim as junk. Skip it (not even manifested,
    // so it is re-checked next pass). (F6)
    if (looksBinary(buf)) continue;
    const text = buf.toString('utf8');
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
  // Record the dim as known NOW (after embedding) — an OpenAIEmbeddings learns its dim lazily from the
  // first response, so capturing it post-walk persists the real vector dimension for the next run's
  // dim-change check. Preserve an already-known dim if nothing was embedded this pass. (D3)
  if (deps.embeddings.dim > 0) manifest.dim = deps.embeddings.dim;
  await writeJsonAtomic(manifestPath(root), manifest);

  // fs-aware GameMaker enrichment (best-effort): when the root is a GM project, resolve each `.gml`
  // object-event's collision target + parent from the `.yyp`/`.yy` and persist a sidecar the citation
  // layer layers over the path-only meta. ANY failure here is swallowed — indexing must not break.
  result.gmEnriched = await enrichGmlSidecar(root, gmlPaths);

  return result;
}

/**
 * Resolve fs-aware GameMaker enrichment for every walked `.gml` and persist it to the sidecar.
 * Returns the number of `.gml` files that resolved at least one enrichment field. Fully GRACEFUL:
 * no `.yyp`/parse failure/unknown ref => writes an empty sidecar (or none) and returns 0; never throws.
 */
async function enrichGmlSidecar(root: string, gmlPaths: string[]): Promise<number> {
  let resolver: GmResolver | undefined;
  try {
    const yypRel = await findYypOnDisk(root);
    if (yypRel === undefined) return 0; // not a GM project: nothing to enrich.
    resolver = await buildGmResolver({ root, yypPath: yypRel, readFile: defaultReader(root) });
  } catch {
    return 0;
  }
  if (!resolver) return 0;

  const byPath: Record<string, GmEnrichment> = {};
  let count = 0;
  for (const relPath of gmlPaths) {
    const base = deriveGmlMeta(relPath);
    if (!base || base.kind !== 'event' || base.resource !== 'object') continue;
    let enriched;
    try {
      enriched = await resolver.enrich(base);
    } catch {
      continue; // one bad object .yy must not poison the rest.
    }
    if (enriched === base) continue;
    const fields: GmEnrichment = {};
    if (enriched.kind === 'event' && enriched.resource === 'object') {
      if (enriched.collisionWith !== undefined) fields.collisionWith = enriched.collisionWith;
      if (enriched.parentObject !== undefined) fields.parentObject = enriched.parentObject;
    }
    if (fields.collisionWith !== undefined || fields.parentObject !== undefined) {
      const posix = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
      byPath[posix] = fields;
      count++;
    }
  }

  try {
    await writeEnrichmentSidecar(root, byPath);
    // A same-process serve should pick up freshly-resolved enrichment, not a stale cached deriver.
    clearGmlDeriverCache();
  } catch {
    // Sidecar write failure is non-fatal: citations simply stay path-only.
  }
  return count;
}

interface Purgeable {
  purge(paths: string[], scope: Scope): Promise<void>;
}

function hasPurge(m: MemoryProvider): m is MemoryProvider & Purgeable {
  return typeof (m as Partial<Purgeable>).purge === 'function';
}
