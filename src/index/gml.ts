// src/index/gml.ts
// GameMaker resource/event metadata derived purely from file paths.
//
// M1 scope: the type vocabulary only (GmlMeta is imported type-only by src/types.ts).
// The runtime `GML_EVENT_TABLE` (GMEdit-authoritative) and the pure `deriveGmlMeta`
// path classifier land in M2. Keeping the types here (not in types.ts) avoids a
// runtime edge into types.ts.

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
