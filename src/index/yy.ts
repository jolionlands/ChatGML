// src/index/yy.ts — tolerant GameMaker .yy/.yyp parsing + fs-aware resource resolution.
//
// GameMaker 2.3+ writes `.yy` (per-resource) and `.yyp` (project) files as JSON-WITH-TRAILING-COMMAS
// (e.g. `...,"resourceVersion":"2.0",}` and `[ ... ,]`). Strict `JSON.parse` therefore FAILS on real
// project files, so these files must NEVER route through the strict `readJson` used for the ChatGML
// store envelope. `parseYy` is the dedicated TOLERANT parser: it strips trailing commas that sit
// before a `}` or `]` (ignoring commas inside string literals) and then `JSON.parse`s the result.
//
// On top of `parseYy` we resolve the modern `{name, path}` reference objects:
//   - the `.yyp` `resources[]` map (name <-> path, the resource directory)
//   - an object `.yy`'s `parentObjectId` (inheritance) and `eventList[].collisionObjectId`
//     (eventType 4 = collision; the named OTHER object is the authoritative collision target).
//
// All disk access is INJECTED via a `readFile` reader, so tests need no disk and the indexer passes a
// real reader. Resolution is GRACEFUL: a missing or corrupt `.yy`/`.yyp` resolves to `undefined`
// rather than throwing up to the indexer; only the low-level `parseYy` throws (a typed `YyError`) so
// callers can distinguish "genuinely invalid" from "absent".

/** Thrown by `parseYy` when the input is not valid even after tolerant trailing-comma stripping. */
export class YyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'YyError';
  }
}

/**
 * Strip trailing commas (a comma immediately before a closing `}` or `]`, possibly across
 * whitespace) from a `.yy`/`.yyp` document WITHOUT touching commas inside string literals.
 *
 * The scan is a tiny string-aware state machine: it tracks whether we are inside a double-quoted
 * string (honoring `\"` escapes) and only treats a `,` as a candidate trailing comma when OUTSIDE a
 * string. A candidate comma is dropped only if the next non-whitespace character is `}` or `]`. This
 * means a string value like `"a,}"` is preserved verbatim, while `{"a":1,}` becomes `{"a":1}`.
 */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      // Look ahead past whitespace; drop the comma if the next real char closes a container.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      const next = text[j];
      if (next === '}' || next === ']') {
        // Skip this comma (do not append). Whitespace between is preserved by the normal loop.
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Tolerantly parse a GameMaker `.yy`/`.yyp` document. Strips trailing commas (string-safe) then
 * `JSON.parse`s. Throws a typed {@link YyError} on input that is invalid even after stripping.
 *
 * NEVER use the strict `readJson` (store envelope) for `.yy`/`.yyp` — it would reject trailing commas
 * and silently treat the file as "corrupt".
 */
export function parseYy(text: string): unknown {
  const cleaned = stripTrailingCommas(text);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new YyError(`invalid .yy/.yyp JSON: ${(err as Error).message}`, { cause: err });
  }
}

// ---------------------------------------------------------------------------
// Reference resolution.
// ---------------------------------------------------------------------------

/** An injected file reader. Returns the file's UTF-8 text, or rejects/throws if unreadable. */
export type ReadFile = (relOrAbsPath: string) => Promise<string>;

/** A modern GameMaker `{name, path}` reference object. `path` is project-relative POSIX. */
export interface YyRef {
  name: string;
  path: string;
}

/** Best-effort extraction of a `{name, path}` ref from an arbitrary value. */
function asRef(value: unknown): YyRef | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.name === 'string' && typeof o.path === 'string') {
    return { name: o.name, path: o.path };
  }
  return undefined;
}

/** The kind of a resource, inferred from its `.yy` path's top-level directory. */
export type ResourceKind =
  | 'object'
  | 'room'
  | 'script'
  | 'sprite'
  | 'shader'
  | 'sound'
  | 'tileset'
  | 'font'
  | 'timeline'
  | 'sequence'
  | 'path'
  | 'note'
  | 'unknown';

function kindFromPath(p: string): ResourceKind {
  const top = p.replace(/\\/g, '/').split('/')[0] ?? '';
  switch (top) {
    case 'objects':
      return 'object';
    case 'rooms':
      return 'room';
    case 'scripts':
      return 'script';
    case 'sprites':
      return 'sprite';
    case 'shaders':
      return 'shader';
    case 'sounds':
      return 'sound';
    case 'tilesets':
      return 'tileset';
    case 'fonts':
      return 'font';
    case 'timelines':
      return 'timeline';
    case 'sequences':
      return 'sequence';
    case 'paths':
      return 'path';
    case 'notes':
      return 'note';
    default:
      return 'unknown';
  }
}

export interface ResourceMapEntry {
  name: string;
  path: string; // project-relative POSIX path to the resource's `.yy`
  kind: ResourceKind;
}

export interface ResourceMap {
  byName: Map<string, ResourceMapEntry>;
  byPath: Map<string, ResourceMapEntry>;
}

/**
 * Load the `.yyp` `resources[]` array into a name<->path map. The reader is injected and given the
 * `.yyp` path. Returns `undefined` if the file is missing/corrupt or has no usable `resources[]`
 * (never throws up to the caller).
 */
export async function loadResourceMap(
  yypPath: string,
  readFile: ReadFile,
): Promise<ResourceMap | undefined> {
  let text: string;
  try {
    text = await readFile(yypPath);
  } catch {
    return undefined;
  }
  let doc: unknown;
  try {
    doc = parseYy(text);
  } catch {
    return undefined;
  }
  if (doc === null || typeof doc !== 'object') return undefined;
  const resources = (doc as Record<string, unknown>).resources;
  if (!Array.isArray(resources)) return undefined;

  const byName = new Map<string, ResourceMapEntry>();
  const byPath = new Map<string, ResourceMapEntry>();
  for (const r of resources) {
    if (r === null || typeof r !== 'object') continue;
    const id = (r as Record<string, unknown>).id;
    const ref = asRef(id);
    if (!ref) continue;
    const pathPosix = ref.path.replace(/\\/g, '/');
    const entry: ResourceMapEntry = {
      name: ref.name,
      path: pathPosix,
      kind: kindFromPath(pathPosix),
    };
    byName.set(ref.name, entry);
    byPath.set(pathPosix, entry);
  }
  if (byName.size === 0) return undefined;
  return { byName, byPath };
}

/**
 * A stable key for an event in an object's `eventList`. Matches the on-disk filename convention used
 * by {@link eventFileKey} so a derived `.gml` path can look up its resolved collision target.
 * `Collision` events are keyed purely by `Collision` (an object has at most one collision event per
 * target, and the .gml path's raw token is the target — we key by type+num and ALSO expose a
 * per-target map below).
 */
export type EventKey = string;

/** Build the event key for an `eventList` entry's `{eventType, eventNum}`. */
export function eventKeyFor(eventType: number, eventNum: number): EventKey {
  return `${eventType}:${eventNum}`;
}

export interface ObjectMeta {
  name: string;
  /** Resolved parent object NAME (inheritance), if `parentObjectId` is a ref. */
  parentName?: string;
  /** Resolved sprite NAME, if `spriteId` is a ref. */
  spriteName?: string;
  /**
   * Collision targets resolved from `eventList`. Keyed by `eventKeyFor(eventType,eventNum)`; the value
   * is the resolved NAME of the OTHER object the collision event targets. Only eventType 4 (collision)
   * entries with a `collisionObjectId` ref appear here.
   */
  collisionTargetsByEvent: Map<EventKey, string>;
  /** Flat set of all resolved collision-target object names (convenience for path-only matching). */
  collisionTargets: Set<string>;
}

/** GameMaker collision event type number in the `.yy` `eventList`. */
const EVENT_TYPE_COLLISION = 4;

/**
 * Load + resolve an object's `.yy` into {@link ObjectMeta}: its name, resolved `parentObjectId`
 * (inheritance), resolved `spriteId`, and the resolved collision targets from its `eventList`.
 *
 * The reader is injected and given the object `.yy` path. Returns `undefined` if the file is
 * missing/corrupt (GRACEFUL — never throws up to the indexer). The `{name,path}` refs are resolved
 * to NAMES directly (the ref already carries the name; we do not need the resource map here, though
 * the indexer cross-checks against it).
 */
export async function loadObjectMeta(
  objYyPath: string,
  readFile: ReadFile,
): Promise<ObjectMeta | undefined> {
  let text: string;
  try {
    text = await readFile(objYyPath);
  } catch {
    return undefined;
  }
  let doc: unknown;
  try {
    doc = parseYy(text);
  } catch {
    return undefined;
  }
  if (doc === null || typeof doc !== 'object') return undefined;
  const o = doc as Record<string, unknown>;

  const name = typeof o.name === 'string' ? o.name : objectNameFromPath(objYyPath);
  if (name === undefined) return undefined;

  const meta: ObjectMeta = {
    name,
    collisionTargetsByEvent: new Map<EventKey, string>(),
    collisionTargets: new Set<string>(),
  };

  const parentRef = asRef(o.parentObjectId);
  if (parentRef) meta.parentName = parentRef.name;

  const spriteRef = asRef(o.spriteId);
  if (spriteRef) meta.spriteName = spriteRef.name;

  const eventList = o.eventList;
  if (Array.isArray(eventList)) {
    for (const ev of eventList) {
      if (ev === null || typeof ev !== 'object') continue;
      const e = ev as Record<string, unknown>;
      const eventType = typeof e.eventType === 'number' ? e.eventType : undefined;
      if (eventType !== EVENT_TYPE_COLLISION) continue;
      const targetRef = asRef(e.collisionObjectId);
      if (!targetRef) continue;
      const eventNum = typeof e.eventNum === 'number' ? e.eventNum : 0;
      meta.collisionTargetsByEvent.set(eventKeyFor(eventType, eventNum), targetRef.name);
      meta.collisionTargets.add(targetRef.name);
    }
  }
  return meta;
}

/** Derive an object name from a `.yy` path (`objects/<Name>/<Name>.yy` -> `<Name>`) as a fallback. */
function objectNameFromPath(p: string): string | undefined {
  const parts = p.replace(/\\/g, '/').split('/');
  // objects/<Name>/<Name>.yy
  if (parts[0] === 'objects' && parts.length >= 3) return parts[1];
  return undefined;
}
