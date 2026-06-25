// src/index/gml-enrich.ts — persisted fs-aware GML enrichment sidecar + enriched deriver.
//
// `deriveGmlMeta` is pure/path-only and runs at citation time inside the tools. The fs-aware
// `.yy`/`.yyp` resolution (collision targets + object parents) is computed ONCE at INDEX time by the
// indexer (it needs disk + the resource map) and written to a small sidecar under `.chatgml/`. The
// citation layer then layers that enrichment over the path-only meta via `createEnrichedGmlDeriver`,
// so a `search_code` citation for a collision event carries the resolved target object NAME.
//
// The sidecar is BEST-EFFORT: a missing/corrupt sidecar yields the plain path-only deriver. It never
// routes through the strict store `readJson` schema (it is its own tiny file), but plain JSON here is
// fine because WE write it (no trailing commas).
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../memory/persist.js';
import { deriveGmlMeta, type GmlMeta } from './gml.js';

/** Per-`.gml`-path enrichment fields resolved from the `.yyp`/`.yy`. */
export interface GmEnrichment {
  /** Resolved collision-target object NAME (collision events only). */
  collisionWith?: string;
  /** Resolved parent object NAME (inheritance). */
  parentObject?: string;
}

/** The sidecar file shape: a version tag + a map of repo-relative `.gml` path -> enrichment. */
export interface EnrichmentSidecar {
  version: number;
  /** repo-relative POSIX `.gml` path -> resolved enrichment fields. */
  byPath: Record<string, GmEnrichment>;
}

export const ENRICHMENT_VERSION = 1;

/** Path to the enrichment sidecar under a project root. */
export function enrichmentSidecarPath(root: string): string {
  return path.join(root, '.chatgml', 'gml-enrich.json');
}

/** Write the enrichment sidecar atomically. Empty maps are still written (records "no enrichment"). */
export async function writeEnrichmentSidecar(
  root: string,
  byPath: Record<string, GmEnrichment>,
): Promise<void> {
  const sidecar: EnrichmentSidecar = { version: ENRICHMENT_VERSION, byPath };
  await writeJsonAtomic(enrichmentSidecarPath(root), sidecar);
}

/** Validate a parsed sidecar shape (best-effort; tolerates extra fields). */
function isSidecar(v: unknown): v is EnrichmentSidecar {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.version === ENRICHMENT_VERSION && typeof o.byPath === 'object' && o.byPath !== null;
}

/** Load the enrichment sidecar for a root, or `undefined` if absent/corrupt (never throws). */
export function loadEnrichmentSidecar(root: string): EnrichmentSidecar | undefined {
  const loaded = readJson<EnrichmentSidecar>(enrichmentSidecarPath(root), {
    validate: isSidecar,
    warn: () => {}, // a missing/corrupt sidecar is non-fatal: silently fall back to path-only.
  });
  return loaded ?? undefined;
}

/**
 * Apply enrichment fields to a path-only `GmlMeta`. Only object-event meta is enriched; everything
 * else passes through. Returns a NEW object when fields are added, else the input.
 */
export function applyEnrichment(meta: GmlMeta, enrich: GmEnrichment | undefined): GmlMeta {
  if (!enrich) return meta;
  if (meta.kind !== 'event' || meta.resource !== 'object') return meta;
  let next = meta;
  let changed = false;
  if (enrich.parentObject !== undefined) {
    next = { ...next, parentObject: enrich.parentObject };
    changed = true;
  }
  if (enrich.collisionWith !== undefined) {
    next = { ...next, collisionWith: enrich.collisionWith };
    changed = true;
  }
  return changed ? next : meta;
}

/**
 * Build a `deriveGmlMeta`-compatible function that layers the persisted fs-aware enrichment over the
 * pure path-only derivation. If no sidecar exists, this is exactly `deriveGmlMeta` (path-only). The
 * citation layer can swap to this without any other change (same `(path) => GmlMeta | undefined` shape).
 */
export function createEnrichedGmlDeriver(root: string): (relPath: string) => GmlMeta | undefined {
  const sidecar = loadEnrichmentSidecar(root);
  if (!sidecar) return deriveGmlMeta;
  return (relPath: string): GmlMeta | undefined => {
    const base = deriveGmlMeta(relPath);
    if (!base) return base;
    const posix = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    return applyEnrichment(base, sidecar.byPath[posix]);
  };
}

// ---------------------------------------------------------------------------
// Per-root memoized deriver for the citation layer (tools call this with `ctx.root`).
// ---------------------------------------------------------------------------

const deriverCache = new Map<string, (relPath: string) => GmlMeta | undefined>();

/**
 * Return a cached enriched deriver for `root`. The sidecar is read at most once per root per process
 * (the common flow is "index then serve"), so tool calls don't repeatedly hit disk. Use
 * {@link clearGmlDeriverCache} in tests or after a re-index when staleness matters.
 */
export function gmlDeriverForRoot(root: string): (relPath: string) => GmlMeta | undefined {
  const cached = deriverCache.get(root);
  if (cached) return cached;
  const deriver = createEnrichedGmlDeriver(root);
  deriverCache.set(root, deriver);
  return deriver;
}

/** Clear the memoized deriver cache (call after a re-index, or between tests). */
export function clearGmlDeriverCache(): void {
  deriverCache.clear();
}
