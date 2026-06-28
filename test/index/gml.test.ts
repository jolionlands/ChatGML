import { describe, it, expect } from 'vitest';
import { deriveGmlMeta, GML_EVENT_TABLE, lookupEvent } from '../../src/index/gml.js';

describe('deriveGmlMeta — object events', () => {
  it('Step_0 -> Step event 0', () => {
    const m = deriveGmlMeta('objects/obj_player/Step_0.gml');
    expect(m).toMatchObject({
      kind: 'event',
      resource: 'object',
      object: 'obj_player',
      eventType: 'Step',
      eventNumber: 0,
      displayName: 'Step',
    });
  });

  it('Alarm_3 -> Alarm 3', () => {
    const m = deriveGmlMeta('objects/obj_enemy/Alarm_3.gml');
    expect(m).toMatchObject({ eventType: 'Alarm', eventNumber: 3, displayName: 'Alarm 3' });
  });

  it('Create_0 -> Create', () => {
    const m = deriveGmlMeta('objects/obj_a/Create_0.gml');
    expect(m).toMatchObject({ eventType: 'Create', displayName: 'Create' });
  });

  it('GMS2.3 Collision_<guid> keeps the raw GUID token (no name resolution)', () => {
    const guid = 'a1b2c3d4-1111-2222-3333-444455556666';
    const m = deriveGmlMeta(`objects/obj_player/Collision_${guid}.gml`);
    expect(m).toMatchObject({
      kind: 'event',
      eventType: 'Collision',
      object: 'obj_player',
      collisionWithRaw: guid,
    });
  });

  it('legacy Collision_obj_b keeps the raw name token', () => {
    const m = deriveGmlMeta('objects/obj_a/Collision_obj_b.gml');
    expect(m).toMatchObject({ eventType: 'Collision', collisionWithRaw: 'obj_b' });
  });

  it('Other_10 -> User Event 0', () => {
    const m = deriveGmlMeta('objects/obj_a/Other_10.gml');
    expect(m).toMatchObject({ eventType: 'Other', eventNumber: 10, displayName: 'User Event 0' });
  });

  it('Other_25 -> User Event 15', () => {
    const m = deriveGmlMeta('objects/obj_a/Other_25.gml');
    expect(m).toMatchObject({ displayName: 'User Event 15' });
  });

  it('Draw GUI / Pre/Post/Begin labels are GMEdit-accurate', () => {
    expect((deriveGmlMeta('objects/o/Draw_64.gml') as { displayName: string }).displayName).toBe(
      'Draw GUI',
    );
    expect((deriveGmlMeta('objects/o/Draw_66.gml') as { displayName: string }).displayName).toBe(
      'Pre-Draw',
    );
    expect((deriveGmlMeta('objects/o/Draw_67.gml') as { displayName: string }).displayName).toBe(
      'Post-Draw',
    );
    expect((deriveGmlMeta('objects/o/Draw_68.gml') as { displayName: string }).displayName).toBe(
      'Draw GUI Begin',
    );
    expect((deriveGmlMeta('objects/o/Draw_69.gml') as { displayName: string }).displayName).toBe(
      'Draw GUI End',
    );
  });
});

describe('deriveGmlMeta — non-event resources', () => {
  it('scripts/<s>/<s>.gml -> script meta', () => {
    expect(deriveGmlMeta('scripts/scr_util/scr_util.gml')).toEqual({
      kind: 'script',
      resource: 'script',
      script: 'scr_util',
    });
  });

  it('RoomCreationCode.gml -> room_creation', () => {
    expect(deriveGmlMeta('rooms/rm_main/RoomCreationCode.gml')).toEqual({
      kind: 'room_creation',
      resource: 'room',
      room: 'rm_main',
    });
  });

  it('InstanceCreationCode_<guid>.gml -> instance_creation', () => {
    const m = deriveGmlMeta('rooms/rm_main/InstanceCreationCode_dead-beef.gml');
    expect(m).toMatchObject({
      kind: 'instance_creation',
      resource: 'room',
      room: 'rm_main',
      instanceGuid: 'dead-beef',
    });
  });

  it('non-gml and unrecognized paths -> undefined', () => {
    expect(deriveGmlMeta('datafiles/readme.txt')).toBeUndefined();
    expect(deriveGmlMeta('README.md')).toBeUndefined();
    expect(deriveGmlMeta('src/cli.ts')).toBeUndefined();
  });

  it('handles Windows backslash separators', () => {
    const m = deriveGmlMeta('objects\\obj_player\\Step_0.gml');
    expect(m).toMatchObject({ object: 'obj_player', eventType: 'Step' });
  });
});

describe('deriveGmlMeta — more resources and fallbacks', () => {
  it('an unrecognized event file under an object becomes a generic object event', () => {
    const m = deriveGmlMeta('objects/obj_a/Weird_thing.gml');
    expect(m).toMatchObject({
      kind: 'event',
      object: 'obj_a',
      eventType: 'Other',
      displayName: 'Weird_thing',
    });
  });

  it('a .gml under shaders classifies by stage hint', () => {
    expect(deriveGmlMeta('shaders/sh_blur/vertex.gml')).toMatchObject({
      kind: 'shader',
      shader: 'sh_blur',
      stage: 'vertex',
    });
    expect(deriveGmlMeta('shaders/sh_blur/fragment.gml')).toMatchObject({ stage: 'fragment' });
    expect(deriveGmlMeta('shaders/sh_blur/other.gml')).toMatchObject({ stage: 'unknown' });
  });

  it('a non-creation-code gml under a room is generic room other', () => {
    expect(deriveGmlMeta('rooms/rm_main/whatever.gml')).toEqual({
      kind: 'other',
      resource: 'room',
      name: 'rm_main',
    });
  });

  it('timelines / sequences / notes classify by their resource kind', () => {
    expect(deriveGmlMeta('timelines/tl_a/tl_a.gml')).toMatchObject({
      resource: 'timeline',
      name: 'tl_a',
    });
    expect(deriveGmlMeta('sequences/sq_a/sq_a.gml')).toMatchObject({ resource: 'sequence' });
    expect(deriveGmlMeta('notes/todo.gml')).toMatchObject({ resource: 'note', name: 'todo' });
  });

  it('a bare top-level gml with no recognized resource is undefined', () => {
    expect(deriveGmlMeta('loose.gml')).toBeUndefined();
  });
});

describe('GML_EVENT_TABLE / lookupEvent', () => {
  it('exposes a populated table with GMEdit labels', () => {
    expect(GML_EVENT_TABLE.get('Step_0')).toEqual({ type: 'Step', label: 'Step' });
    expect(GML_EVENT_TABLE.get('Draw_64')).toEqual({ type: 'Draw', label: 'Draw GUI' });
  });
  it('unknown Draw / Step numbers fall back to a generic label, not dropped', () => {
    expect(lookupEvent('Draw_999')).toMatchObject({ label: 'Draw (event 999)' });
    expect(lookupEvent('Step_9')).toMatchObject({ label: 'Step (event 9)' });
    expect(lookupEvent('Other_999')).toMatchObject({ label: 'Other (event 999)' });
  });
  it('labels Mouse / Key / Gesture events', () => {
    expect(lookupEvent('Mouse_50')).toMatchObject({ type: 'Mouse', label: 'Mouse (event 50)' });
    expect(lookupEvent('KeyPress_65')).toMatchObject({ type: 'Key' });
    expect(lookupEvent('Gesture_1')).toMatchObject({ type: 'Gesture' });
  });
  it('returns undefined for an unknown category and bare Create/Destroy/Cleanup', () => {
    expect(lookupEvent('NotACategory_0')).toBeUndefined();
    expect(lookupEvent('Create')).toMatchObject({ type: 'Create', label: 'Create' });
    expect(lookupEvent('Destroy')).toMatchObject({ type: 'Destroy' });
    expect(lookupEvent('Cleanup')).toMatchObject({ type: 'Cleanup' });
    expect(lookupEvent('randomstem')).toBeUndefined();
  });
});
