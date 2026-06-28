// src/index/gml.ts
// GameMaker resource/event metadata derived purely from file paths.
//
// The type vocabulary (GmlMeta) is imported type-only by src/types.ts; keeping the types here
// (not in types.ts) avoids a runtime edge into types.ts. The runtime `GML_EVENT_TABLE`
// (GMEdit-authoritative) and the pure path classifier `deriveGmlMeta` are M2.
//
// `deriveGmlMeta` is PURE and PATH-ONLY: it never reads file contents, never reads `.yy`/`.yyp`,
// and never resolves a GUID to an object name. Collision events therefore carry the RAW token from
// the filename (`collisionWithRaw`); name resolution is a deferred fs-aware pass.

export type GmlEventType =
  | 'Create'
  | 'Destroy'
  | 'Cleanup'
  | 'Step'
  | 'Alarm'
  | 'Draw'
  | 'Collision'
  | 'Mouse'
  | 'Key'
  | 'Other'
  | 'Async'
  | 'Gesture';

export type GmlMeta =
  | GmlEventMeta
  | GmlScriptMeta
  | GmlShaderMeta
  | GmlRoomCreationMeta
  | GmlInstanceCreationMeta
  | GmlOtherResourceMeta;

export interface GmlEventMeta {
  kind: 'event';
  resource: 'object';
  object: string;
  eventType: GmlEventType;
  eventNumber: number;
  /** Raw token (a GUID on GMS2.3+, an object name on legacy); NOT a resolved object name. */
  collisionWithRaw?: string;
  /**
   * fs-AWARE enrichment (optional): the resolved NAME of the OTHER object this collision event
   * targets, read from the authoritative `eventList` in the object's `.yy` (NOT the .gml filename).
   * Absent unless a `.yyp` resolver enriched this meta.
   */
  collisionWith?: string;
  /**
   * fs-AWARE enrichment (optional): the resolved NAME of this object's parent (inheritance), read
   * from `parentObjectId` in the object's `.yy`. Absent unless a `.yyp` resolver enriched this meta.
   */
  parentObject?: string;
  displayName: string;
}

export interface GmlScriptMeta {
  kind: 'script';
  resource: 'script';
  script: string;
}

export interface GmlShaderMeta {
  kind: 'shader';
  resource: 'shader';
  shader: string;
  stage: 'vertex' | 'fragment' | 'unknown';
}

export interface GmlRoomCreationMeta {
  kind: 'room_creation';
  resource: 'room';
  room: string;
}

export interface GmlInstanceCreationMeta {
  kind: 'instance_creation';
  resource: 'room';
  room: string;
  instanceGuid: string;
}

export interface GmlOtherResourceMeta {
  kind: 'other';
  resource: 'room' | 'sequence' | 'timeline' | 'note' | 'unknown';
  name: string;
}

// ---------------------------------------------------------------------------
// GMEdit-authoritative event table.
//
// Maps a GameMaker event filename stem (without the `.gml` suffix) to its event type, number, and a
// human display label. Lifted from GMEdit's own eventType/eventNum -> label map so labels match the
// IDE the user works in (Draw 64 = Draw GUI, 67 = Draw End, 68/69 = Draw GUI Begin/End, etc.).
//
// Filename stems follow GameMaker's on-disk convention: `<Category>_<number>` (e.g. `Step_0`,
// `Alarm_3`, `Draw_64`, `Other_10`, `Mouse_50`). Collision events are `Collision_<token>` where the
// token is a GUID (GMS 2.3+) or an object name (legacy) — handled specially below, not via this table.
// ---------------------------------------------------------------------------

interface EventTableEntry {
  type: GmlEventType;
  label: string;
}

/** Step sub-events (Step category, eventType 3). */
const STEP_LABELS: Record<number, string> = {
  0: 'Step',
  1: 'Begin Step',
  2: 'End Step',
};

/** Draw sub-events (Draw category, eventType 8). Numbers per GMEdit's table. */
const DRAW_LABELS: Record<number, string> = {
  0: 'Draw',
  64: 'Draw GUI',
  65: 'Resize',
  66: 'Pre-Draw',
  67: 'Post-Draw',
  72: 'Draw Begin',
  73: 'Draw End',
  74: 'Draw GUI Begin',
  75: 'Draw GUI End',
  76: 'Window Resize',
  // GMEdit also surfaces these legacy/intermediate Draw numbers:
  68: 'Draw GUI Begin',
  69: 'Draw GUI End',
};

/**
 * "Other" sub-events (Other category, eventType 7). Includes Outside/Boundary/Game Start/End,
 * Room Start/End, No More Lives/Health, Animation End, the User Events (10..25 -> User Event 0..15),
 * and async sub-events (Other_62..Other_75 range on various runtimes). We map the common, stable
 * ones; unknown numbers fall back to a generic label rather than being dropped.
 */
const OTHER_LABELS: Record<number, string> = {
  0: 'Outside Room',
  1: 'Intersect Boundary',
  2: 'Game Start',
  3: 'Game End',
  4: 'Room Start',
  5: 'Room End',
  6: 'No More Lives',
  7: 'Animation End',
  8: 'End of Path',
  9: 'No More Health',
  30: 'Close Button',
  40: 'Outside View 0',
  50: 'Boundary View 0',
  // User Events 0..15 are Other_10 .. Other_25.
  // Async sub-events (numbers vary by runtime; these are the GMS2 stable set GMEdit surfaces):
  62: 'Async - Audio Playback',
  63: 'Async - Audio Recording',
  68: 'Async - System',
  70: 'Async - HTTP',
  71: 'Async - Dialog',
  72: 'Async - Steam',
  73: 'Async - Social',
  74: 'Async - Push Notification',
  75: 'Async - Networking',
  76: 'Async - Cloud',
  77: 'Async - In-App-Purchase',
};

/** Categories whose filename label is a verbatim type with a numeric index. */
const SIMPLE_CATEGORY: Record<string, GmlEventType> = {
  Create: 'Create',
  Destroy: 'Destroy',
  Cleanup: 'Cleanup',
  Alarm: 'Alarm',
  Step: 'Step',
  Draw: 'Draw',
  Mouse: 'Mouse',
  KeyPress: 'Key',
  KeyRelease: 'Key',
  Keyboard: 'Key',
  Gesture: 'Gesture',
  Other: 'Other',
};

/**
 * Resolve a `<Category>_<number>` event filename stem to its type/number/label.
 * Returns undefined for stems that are not recognized as object events.
 */
export function lookupEvent(stem: string): (EventTableEntry & { number: number }) | undefined {
  const m = /^([A-Za-z]+)_(\d+)$/.exec(stem);
  if (!m) {
    // Create/Destroy/Cleanup commonly appear without a number on some exports.
    const cat = SIMPLE_CATEGORY[stem];
    if (cat && (stem === 'Create' || stem === 'Destroy' || stem === 'Cleanup')) {
      return { type: cat, number: 0, label: stem };
    }
    return undefined;
  }
  const category = m[1]!;
  const number = Number(m[2]!);
  const type = SIMPLE_CATEGORY[category];
  if (!type) return undefined;

  switch (type) {
    case 'Step':
      return { type, number, label: STEP_LABELS[number] ?? `Step (event ${number})` };
    case 'Draw':
      return { type, number, label: DRAW_LABELS[number] ?? `Draw (event ${number})` };
    case 'Alarm':
      return { type, number, label: `Alarm ${number}` };
    case 'Other': {
      if (number >= 10 && number <= 25) {
        return { type, number, label: `User Event ${number - 10}` };
      }
      return { type, number, label: OTHER_LABELS[number] ?? `Other (event ${number})` };
    }
    case 'Mouse':
      return { type, number, label: `Mouse (event ${number})` };
    case 'Key':
      return { type, number, label: `${category} (key ${number})` };
    case 'Gesture':
      return { type, number, label: `Gesture (event ${number})` };
    case 'Create':
    case 'Destroy':
    case 'Cleanup':
      // These categories have only event 0; GMEdit labels them without a number.
      return { type, number, label: category };
    default:
      return { type, number, label: `${category} ${number}` };
  }
}

/** The exported event table view: stem -> entry, for tests/introspection of common events. */
export const GML_EVENT_TABLE: ReadonlyMap<string, EventTableEntry> = new Map(
  (
    [
      'Create_0',
      'Destroy_0',
      'Cleanup_0',
      'Step_0',
      'Step_1',
      'Step_2',
      'Alarm_0',
      'Alarm_3',
      'Draw_0',
      'Draw_64',
      'Draw_66',
      'Draw_67',
      'Draw_68',
      'Draw_69',
      'Draw_72',
      'Draw_73',
      'Other_0',
      'Other_4',
      'Other_5',
      'Other_10',
      'Other_25',
      'Other_62',
      'Other_75',
    ] as const
  ).flatMap((stem) => {
    const e = lookupEvent(stem);
    return e ? ([[stem, { type: e.type, label: e.label }]] as [string, EventTableEntry][]) : [];
  }),
);

// ---------------------------------------------------------------------------
// deriveGmlMeta — pure, path-only classifier.
// ---------------------------------------------------------------------------

/**
 * A canonical GameMaker GUID (the token GMS 2.3+ encodes into a `Collision_<guid>.gml` filename).
 * Exported so the fs-aware resolver can DISCRIMINATE a GUID token (unmappable by name) from a legacy
 * object-name token and never guess a multi-collision target from an unmappable GUID.
 */
export const GUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Normalize separators to forward slashes and drop a leading `./`. */
function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Derive GameMaker resource/event metadata from a repo-relative path. PURE and PATH-ONLY.
 * Returns undefined for non-GML or unrecognized paths (e.g. `datafiles/readme.txt`).
 */
export function deriveGmlMeta(relPath: string): GmlMeta | undefined {
  const p = toPosixPath(relPath);
  const parts = p.split('/');
  const file = parts[parts.length - 1] ?? '';

  // Only .gml files carry GML metadata.
  if (!file.toLowerCase().endsWith('.gml')) return undefined;
  const stem = file.slice(0, file.length - '.gml'.length);

  // objects/<obj>/<Event>.gml
  if (parts[0] === 'objects' && parts.length >= 3) {
    const object = parts[1]!;

    // Collision_<token>.gml — token is a GUID (2.3+) or an object name (legacy).
    const coll = /^Collision_(.+)$/.exec(stem);
    if (coll) {
      const raw = coll[1]!;
      return {
        kind: 'event',
        resource: 'object',
        object,
        eventType: 'Collision',
        eventNumber: 0,
        collisionWithRaw: raw,
        displayName: `Collision with ${raw}`,
      };
    }

    const ev = lookupEvent(stem);
    if (ev) {
      return {
        kind: 'event',
        resource: 'object',
        object,
        eventType: ev.type,
        eventNumber: ev.number,
        displayName: ev.label,
      };
    }
    // Unrecognized event file under an object: treat as a generic object event.
    return {
      kind: 'event',
      resource: 'object',
      object,
      eventType: 'Other',
      eventNumber: 0,
      displayName: stem,
    };
  }

  // scripts/<script>/<script>.gml
  if (parts[0] === 'scripts' && parts.length >= 3) {
    return { kind: 'script', resource: 'script', script: parts[1]! };
  }

  // shaders/<shader>/<shader>.fsh|.vsh handled elsewhere; a .gml under shaders is unusual.
  if (parts[0] === 'shaders' && parts.length >= 3) {
    const stage = stem.toLowerCase().includes('vert')
      ? 'vertex'
      : stem.toLowerCase().includes('frag')
        ? 'fragment'
        : 'unknown';
    return { kind: 'shader', resource: 'shader', shader: parts[1]!, stage };
  }

  // rooms/<room>/RoomCreationCode.gml
  if (parts[0] === 'rooms' && parts.length >= 3) {
    const room = parts[1]!;
    if (stem === 'RoomCreationCode') {
      return { kind: 'room_creation', resource: 'room', room };
    }
    // rooms/<room>/InstanceCreationCode_<guid>.gml
    const inst = /^InstanceCreationCode_(.+)$/.exec(stem);
    if (inst) {
      return { kind: 'instance_creation', resource: 'room', room, instanceGuid: inst[1]! };
    }
    return { kind: 'other', resource: 'room', name: room };
  }

  // timelines/<tl>/...gml
  if (parts[0] === 'timelines' && parts.length >= 3) {
    return { kind: 'other', resource: 'timeline', name: parts[1]! };
  }
  if (parts[0] === 'sequences' && parts.length >= 3) {
    return { kind: 'other', resource: 'sequence', name: parts[1]! };
  }
  if (parts[0] === 'notes' && parts.length >= 2) {
    return { kind: 'other', resource: 'note', name: stem };
  }

  return undefined;
}
