// src/index/gm-resolver.ts — fs-aware GameMaker project resolver for citation enrichment.
//
// `deriveGmlMeta` (src/index/gml.ts) is PURE/PATH-ONLY: a collision event carries only the RAW token
// from its filename. This module is the deferred fs-AWARE pass: when the indexed root is a GameMaker
// project (a `.yyp` exists at root), it reads the `.yyp` resource map + each object's `.yy` once and
// ENRICHES a path-only `GmlEventMeta` with the resolved collision target NAME (`collisionWith`, the
// authoritative `eventList[].collisionObjectId`, NOT the .gml filename) and the object's parent
// (`parentObject`, inheritance via `parentObjectId`).
//
// Everything is GRACEFUL + BEST-EFFORT: no `.yyp`, a parse failure, or an unknown ref all fall back to
// the existing path-only meta — indexing never breaks. All disk access goes through an injected
// `ReadFile` (project-relative POSIX paths) so the unit is testable with no disk.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GmlMeta, GmlEventMeta } from './gml.js';
import {
  loadResourceMap,
  loadObjectMeta,
  type ReadFile,
  type ResourceMap,
  type ObjectMeta,
} from './yy.js';

const YYP_EXTENSION = '.yyp';

/** A resolver that enriches path-only `GmlMeta` with fs-aware `.yy`/`.yyp` data. */
export interface GmResolver {
  /** The resource map from the `.yyp` (name <-> path). */
  readonly resources: ResourceMap;
  /**
   * Resolve + cache an object's `.yy` meta by object NAME (or `undefined` if absent/corrupt).
   * Memoized: each object `.yy` is read at most once.
   */
  objectMeta(objectName: string): Promise<ObjectMeta | undefined>;
  /**
   * Enrich a path-only `GmlMeta` (returns a NEW object when enriched, else the input unchanged). For a
   * collision/object event it resolves `collisionWith` (target name) and `parentObject` (inheritance).
   * Non-event or non-object meta is returned unchanged. Always GRACEFUL: any miss leaves it path-only.
   */
  enrich(meta: GmlMeta): Promise<GmlMeta>;
}

export interface BuildResolverOptions {
  /** Project root. Used by the default disk reader and to discover the `.yyp` when not injected. */
  root?: string;
  /**
   * Project-relative POSIX path to the `.yyp`. If omitted, it is discovered by reading `root` from
   * disk (requires `root`). Tests pass this explicitly alongside an injected `readFile`.
   */
  yypPath?: string;
  /** Injected reader (project-relative POSIX path -> UTF-8 text). Defaults to a real reader over `root`. */
  readFile?: ReadFile;
}

/**
 * Build a {@link GmResolver} IF the target is a GameMaker project (a `.yyp` with a non-empty resource
 * map). Returns `undefined` when there is no `.yyp`, the `.yyp` is unreadable/corrupt, or its resource
 * map is empty — in every such case the caller falls back to path-only meta.
 *
 * Disk access is injected via `opts.readFile` (project-relative POSIX -> text); the default reader
 * resolves against `opts.root`. The `.yyp` is parsed ONCE; object `.yy` files are read lazily + memoized.
 */
export async function buildGmResolver(
  opts: BuildResolverOptions,
): Promise<GmResolver | undefined> {
  let reader: ReadFile;
  if (opts.readFile !== undefined) {
    reader = opts.readFile;
  } else if (opts.root !== undefined) {
    reader = defaultReader(opts.root);
  } else {
    return undefined; // no way to read anything
  }

  let yypRel = opts.yypPath;
  if (yypRel === undefined) {
    if (opts.root === undefined) return undefined;
    yypRel = await findYypOnDisk(opts.root);
  }
  if (yypRel === undefined) return undefined;

  const loaded = await loadResourceMap(yypRel, reader);
  if (!loaded) return undefined;
  const resources: ResourceMap = loaded;

  const objectCache = new Map<string, Promise<ObjectMeta | undefined>>();

  function objectMeta(objectName: string): Promise<ObjectMeta | undefined> {
    const cached = objectCache.get(objectName);
    if (cached) return cached;
    const entry = resources.byName.get(objectName);
    // If the resource map doesn't list this object, fall back to the conventional path.
    const objPath = entry?.path ?? `objects/${objectName}/${objectName}.yy`;
    const p = loadObjectMeta(objPath, reader);
    objectCache.set(objectName, p);
    return p;
  }

  async function enrich(meta: GmlMeta): Promise<GmlMeta> {
    if (meta.kind !== 'event' || meta.resource !== 'object') return meta;
    const om = await objectMeta(meta.object);
    if (!om) return meta;

    let next: GmlEventMeta = meta;
    let changed = false;

    if (om.parentName !== undefined) {
      next = { ...next, parentObject: om.parentName };
      changed = true;
    }

    if (meta.eventType === 'Collision') {
      const target = resolveCollisionTarget(meta, om);
      if (target !== undefined) {
        next = { ...next, collisionWith: target };
        changed = true;
      }
    }

    return changed ? next : meta;
  }

  return { resources, objectMeta, enrich };
}

/**
 * Resolve a collision event's target object NAME from a resolved {@link ObjectMeta}, SAFELY — never
 * guessing. The `.gml` filename's collision token is a GUID (GMS2.3+) or an object NAME (legacy); the
 * path-only `deriveGmlMeta` cannot map a GUID to an `eventNum` (it always reports `eventNumber: 0`),
 * so the raw token — NOT the event key — is the discriminator. Resolution order:
 *
 *  1. NAME MATCH (the primary path, and the ONLY thing that makes MULTI-collision objects resolvable):
 *     if the raw filename token names exactly one of the object's known collision targets, use it.
 *     This resolves legacy name-encoded files AND every name-encoded file of a multi-collision object
 *     (each `Collision_<TargetName>.gml` maps to its own distinct target).
 *  2. SINGLE-TARGET FALLBACK (GUID files only): if the token is an unmappable GUID and the object has
 *     EXACTLY ONE collision target, use that lone target — the only safe resolution for a GUID we
 *     cannot map by name. Single-collision objects therefore keep resolving as before.
 *
 * Everything else stays path-only (returns `undefined`): an unmappable token (GUID, or a name that
 * matched nothing) on a MULTI-collision object is AMBIGUOUS — we will not pick one of several. The
 * per-event key map is retained on {@link ObjectMeta} for callers that DO know the real `eventNum`.
 */
function resolveCollisionTarget(meta: GmlEventMeta, om: ObjectMeta): string | undefined {
  const raw = meta.collisionWithRaw;

  // 1. Name match: the raw token names a known collision target -> trust it. Works for a legacy
  //    filename and for any name-encoded file of a multi-collision object (disambiguates among many).
  if (raw !== undefined && om.collisionTargets.has(raw)) {
    return raw;
  }

  // 2. Single-target fallback, restricted to UNMAPPABLE tokens (a GUID, or any token that did not name
  //    a target): resolve ONLY when there is exactly one target, so we never pick among several. A name
  //    token that failed the match is treated the same as a GUID here — a lone target is still the only
  //    safe answer, and with >1 target we (correctly) decline.
  if (om.collisionTargets.size === 1) {
    return [...om.collisionTargets][0];
  }

  // Ambiguous: a multi-collision object addressed by an unmappable token (a GUID, or a name that did
  // not match any target). We cannot pick one of several targets without guessing — stay path-only.
  return undefined;
}

/** A real fs reader resolving project-relative POSIX paths against `root`. */
export function defaultReader(root: string): ReadFile {
  return (rel: string) => fsp.readFile(path.resolve(root, rel), 'utf8');
}

/** Find the `.yyp` on disk at the project root (the first one, alphabetically). Returns undefined if none. */
export async function findYypOnDisk(root: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return undefined;
  }
  const yyps = names.filter((n) => n.toLowerCase().endsWith(YYP_EXTENSION)).sort();
  return yyps[0];
}
