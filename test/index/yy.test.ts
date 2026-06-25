import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseYy,
  YyError,
  loadResourceMap,
  loadObjectMeta,
  eventKeyFor,
  type ReadFile,
} from '../../src/index/yy.js';

/** Build an injected reader from an in-memory path->text map (no disk). */
function memReader(files: Record<string, string>): ReadFile {
  return async (p: string): Promise<string> => {
    const posix = p.replace(/\\/g, '/');
    const hit = files[posix];
    if (hit === undefined) throw new Error(`ENOENT: ${posix}`);
    return hit;
  };
}

describe('parseYy — tolerant trailing-comma parsing', () => {
  it('strips a trailing comma before } (real .yy shape)', () => {
    const text = '{"name":"Object1","resourceVersion":"2.0",}';
    expect(parseYy(text)).toEqual({ name: 'Object1', resourceVersion: '2.0' });
  });

  it('strips a trailing comma before ] (array)', () => {
    expect(parseYy('[1,2,3,]')).toEqual([1, 2, 3]);
  });

  it('handles nested arrays + objects with trailing commas at every level', () => {
    const text = `{
      "resources":[
        {"id":{"name":"Object1","path":"objects/Object1/Object1.yy",},},
        {"id":{"name":"Room1","path":"rooms/Room1/Room1.yy",},},
      ],
      "list":[[1,2,],[3,],],
    }`;
    expect(parseYy(text)).toEqual({
      resources: [
        { id: { name: 'Object1', path: 'objects/Object1/Object1.yy' } },
        { id: { name: 'Room1', path: 'rooms/Room1/Room1.yy' } },
      ],
      list: [
        [1, 2],
        [3],
      ],
    });
  });

  it('does NOT strip a comma inside a string literal (e.g. "a,}")', () => {
    const text = '{"note":"a,}","n":1,}';
    expect(parseYy(text)).toEqual({ note: 'a,}', n: 1 });
  });

  it('does NOT strip a comma followed by ] inside a string', () => {
    const text = '{"weird":"x,]","arr":[1,],}';
    expect(parseYy(text)).toEqual({ weird: 'x,]', arr: [1] });
  });

  it('preserves an escaped quote before a comma-brace inside a string', () => {
    // The string value is:  he said "hi",}
    const text = '{"q":"he said \\"hi\\",}","k":2,}';
    expect(parseYy(text)).toEqual({ q: 'he said "hi",}', k: 2 });
  });

  it('parses a document with no trailing commas unchanged', () => {
    expect(parseYy('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  it('throws a typed YyError on genuinely invalid input', () => {
    expect(() => parseYy('{"a":}')).toThrow(YyError);
    expect(() => parseYy('not json at all')).toThrow(YyError);
    // The thrown error carries the cause and a clear name.
    try {
      parseYy('{');
    } catch (err) {
      expect(err).toBeInstanceOf(YyError);
      expect((err as YyError).name).toBe('YyError');
    }
  });
});

describe('loadResourceMap', () => {
  const yyp = `{
    "resources":[
      {"id":{"name":"Object1","path":"objects/Object1/Object1.yy",},},
      {"id":{"name":"obj_player","path":"objects/obj_player/obj_player.yy",},},
      {"id":{"name":"Room1","path":"rooms/Room1/Room1.yy",},},
      {"id":{"name":"scr_util","path":"scripts/scr_util/scr_util.yy",},},
    ],
    "resourceType":"GMProject",
    "resourceVersion":"2.0",
  }`;

  it('builds byName + byPath maps with inferred kinds', async () => {
    const map = await loadResourceMap('proj.yyp', memReader({ 'proj.yyp': yyp }));
    expect(map).toBeDefined();
    expect(map!.byName.get('Object1')).toEqual({
      name: 'Object1',
      path: 'objects/Object1/Object1.yy',
      kind: 'object',
    });
    expect(map!.byName.get('Room1')!.kind).toBe('room');
    expect(map!.byName.get('scr_util')!.kind).toBe('script');
    expect(map!.byPath.get('objects/obj_player/obj_player.yy')!.name).toBe('obj_player');
  });

  it('returns undefined for a missing file (graceful)', async () => {
    const map = await loadResourceMap('absent.yyp', memReader({}));
    expect(map).toBeUndefined();
  });

  it('returns undefined for a corrupt file', async () => {
    const map = await loadResourceMap('bad.yyp', memReader({ 'bad.yyp': '{ this is not json' }));
    expect(map).toBeUndefined();
  });

  it('returns undefined when there are no resolvable resources', async () => {
    const map = await loadResourceMap('empty.yyp', memReader({ 'empty.yyp': '{"resources":[],}' }));
    expect(map).toBeUndefined();
  });
});

describe('loadObjectMeta — parent + collision resolution', () => {
  it('resolves parentObjectId (inheritance) and a collision target', async () => {
    const objYy = `{
      "$GMObject":"",
      "name":"obj_enemy",
      "parentObjectId":{"name":"obj_actor","path":"objects/obj_actor/obj_actor.yy",},
      "spriteId":{"name":"spr_enemy","path":"sprites/spr_enemy/spr_enemy.yy",},
      "eventList":[
        {"$GMEvent":"v1","collisionObjectId":null,"eventNum":0,"eventType":0,"name":"",},
        {"$GMEvent":"v1","collisionObjectId":{"name":"obj_player","path":"objects/obj_player/obj_player.yy",},"eventNum":0,"eventType":4,"name":"",},
      ],
      "resourceType":"GMObject",
      "resourceVersion":"2.0",
    }`;
    const meta = await loadObjectMeta('objects/obj_enemy/obj_enemy.yy', memReader({
      'objects/obj_enemy/obj_enemy.yy': objYy,
    }));
    expect(meta).toBeDefined();
    expect(meta!.name).toBe('obj_enemy');
    expect(meta!.parentName).toBe('obj_actor');
    expect(meta!.spriteName).toBe('spr_enemy');
    expect(meta!.collisionTargets.has('obj_player')).toBe(true);
    expect(meta!.collisionTargetsByEvent.get(eventKeyFor(4, 0))).toBe('obj_player');
  });

  it('handles a null parent + no collision (BLANK GAME shape) gracefully', async () => {
    const objYy = `{
      "name":"Object1",
      "parentObjectId":null,
      "spriteId":null,
      "eventList":[
        {"$GMEvent":"v1","collisionObjectId":null,"eventNum":0,"eventType":0,"name":"",},
      ],
      "resourceType":"GMObject",
      "resourceVersion":"2.0",
    }`;
    const meta = await loadObjectMeta('objects/Object1/Object1.yy', memReader({
      'objects/Object1/Object1.yy': objYy,
    }));
    expect(meta).toBeDefined();
    expect(meta!.name).toBe('Object1');
    expect(meta!.parentName).toBeUndefined();
    expect(meta!.collisionTargets.size).toBe(0);
  });

  it('returns undefined for a missing or corrupt .yy (never throws)', async () => {
    expect(await loadObjectMeta('objects/x/x.yy', memReader({}))).toBeUndefined();
    expect(
      await loadObjectMeta('objects/x/x.yy', memReader({ 'objects/x/x.yy': '{ broken' })),
    ).toBeUndefined();
  });

  it('falls back to the path-derived name when "name" is absent', async () => {
    const meta = await loadObjectMeta('objects/obj_path/obj_path.yy', memReader({
      'objects/obj_path/obj_path.yy': '{"eventList":[],}',
    }));
    expect(meta!.name).toBe('obj_path');
  });

  it('returns undefined when no "name" and the path is not an objects/<N>/<N>.yy', async () => {
    const meta = await loadObjectMeta('weird/place/thing.yy', memReader({
      'weird/place/thing.yy': '{"eventList":[],}',
    }));
    expect(meta).toBeUndefined();
  });

  it('an array doc at a non-object path returns undefined (no name resolvable)', async () => {
    const meta = await loadObjectMeta('weird/x.yy', memReader({ 'weird/x.yy': '[1,2,]' }));
    expect(meta).toBeUndefined();
  });

  it('ignores collision events without a ref and non-collision events with a ref', async () => {
    const objYy = `{
      "name":"obj_mixed","parentObjectId":null,
      "eventList":[
        {"$GMEvent":"v1","collisionObjectId":null,"eventNum":0,"eventType":4,"name":"",},
        {"$GMEvent":"v1","collisionObjectId":{"name":"spr_x","path":"sprites/spr_x/spr_x.yy",},"eventNum":0,"eventType":8,"name":"",},
        "not an object",
        {"eventType":4,"collisionObjectId":{"name":"obj_real","path":"objects/obj_real/obj_real.yy",},},
      ],
    }`;
    const meta = await loadObjectMeta('objects/obj_mixed/obj_mixed.yy', memReader({
      'objects/obj_mixed/obj_mixed.yy': objYy,
    }));
    // Only the valid eventType-4-with-ref entry counts; eventNum defaults to 0 when absent.
    expect([...meta!.collisionTargets]).toEqual(['obj_real']);
    expect(meta!.collisionTargetsByEvent.get(eventKeyFor(4, 0))).toBe('obj_real');
  });

  it('treats a non-object/array eventList and a non-object parentObjectId as absent', async () => {
    const meta = await loadObjectMeta('objects/o/o.yy', memReader({
      'objects/o/o.yy': '{"name":"o","parentObjectId":"not-a-ref","spriteId":42,"eventList":"nope",}',
    }));
    expect(meta!.parentName).toBeUndefined();
    expect(meta!.spriteName).toBeUndefined();
    expect(meta!.collisionTargets.size).toBe(0);
  });
});

describe('loadResourceMap — ref/kind edge cases', () => {
  it('infers every resource kind and falls back to "unknown" for odd top dirs', async () => {
    const yyp = `{"resources":[
      {"id":{"name":"spr_a","path":"sprites/spr_a/spr_a.yy",},},
      {"id":{"name":"snd_a","path":"sounds/snd_a/snd_a.yy",},},
      {"id":{"name":"ts_a","path":"tilesets/ts_a/ts_a.yy",},},
      {"id":{"name":"fnt_a","path":"fonts/fnt_a/fnt_a.yy",},},
      {"id":{"name":"sh_a","path":"shaders/sh_a/sh_a.yy",},},
      {"id":{"name":"tl_a","path":"timelines/tl_a/tl_a.yy",},},
      {"id":{"name":"seq_a","path":"sequences/seq_a/seq_a.yy",},},
      {"id":{"name":"pth_a","path":"paths/pth_a/pth_a.yy",},},
      {"id":{"name":"note_a","path":"notes/note_a.yy",},},
      {"id":{"name":"odd_a","path":"weirddir/odd_a.yy",},},
    ],}`;
    const map = await loadResourceMap('p.yyp', memReader({ 'p.yyp': yyp }));
    expect(map!.byName.get('spr_a')!.kind).toBe('sprite');
    expect(map!.byName.get('snd_a')!.kind).toBe('sound');
    expect(map!.byName.get('ts_a')!.kind).toBe('tileset');
    expect(map!.byName.get('fnt_a')!.kind).toBe('font');
    expect(map!.byName.get('sh_a')!.kind).toBe('shader');
    expect(map!.byName.get('tl_a')!.kind).toBe('timeline');
    expect(map!.byName.get('seq_a')!.kind).toBe('sequence');
    expect(map!.byName.get('pth_a')!.kind).toBe('path');
    expect(map!.byName.get('note_a')!.kind).toBe('note');
    expect(map!.byName.get('odd_a')!.kind).toBe('unknown');
  });

  it('skips malformed resource entries (non-object, missing id, non-ref id)', async () => {
    const yyp = `{"resources":[
      "junk",
      {"id":null,},
      {"id":{"name":"only_name",},},
      {"id":{"name":"good","path":"objects/good/good.yy",},},
    ],}`;
    const map = await loadResourceMap('p.yyp', memReader({ 'p.yyp': yyp }));
    expect(map!.byName.size).toBe(1);
    expect(map!.byName.has('good')).toBe(true);
  });

  it('returns undefined when resources is not an array', async () => {
    const map = await loadResourceMap('p.yyp', memReader({ 'p.yyp': '{"resources":"oops",}' }));
    expect(map).toBeUndefined();
  });

  it('returns undefined when the top-level doc is not an object', async () => {
    const map = await loadResourceMap('p.yyp', memReader({ 'p.yyp': '[1,2,3,]' }));
    expect(map).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// REAL-FORMAT tolerance: parse the actual BLANK GAME project if present.
// ---------------------------------------------------------------------------
const BLANK_GAME = 'C:/Users/kalli/GameMakerProjects/BLANK GAME';
const BLANK_GAME_YYP = path.join(BLANK_GAME, 'BLANK GAME.yyp');
const REAL_PRESENT = existsSync(BLANK_GAME_YYP);

describe.skipIf(!REAL_PRESENT)('REAL BLANK GAME project (trailing-comma tolerance on disk)', () => {
  it('parseYy parses the real .yyp and .yy without throwing', () => {
    const yypText = readFileSync(BLANK_GAME_YYP, 'utf8');
    expect(() => parseYy(yypText)).not.toThrow();
    const objText = readFileSync(path.join(BLANK_GAME, 'objects/Object1/Object1.yy'), 'utf8');
    expect(() => parseYy(objText)).not.toThrow();
  });

  it('loadResourceMap finds Object1 + Room1 in the real project', async () => {
    const realReader: ReadFile = async (rel) => readFileSync(path.join(BLANK_GAME, rel), 'utf8');
    const map = await loadResourceMap('BLANK GAME.yyp', realReader);
    expect(map).toBeDefined();
    expect(map!.byName.has('Object1')).toBe(true);
    expect(map!.byName.has('Room1')).toBe(true);
    expect(map!.byName.get('Object1')!.kind).toBe('object');
    expect(map!.byName.get('Room1')!.kind).toBe('room');
  });

  it('loadObjectMeta reads the real Object1.yy (null parent, no collision)', async () => {
    const realReader: ReadFile = async (rel) => readFileSync(path.join(BLANK_GAME, rel), 'utf8');
    const meta = await loadObjectMeta('objects/Object1/Object1.yy', realReader);
    expect(meta).toBeDefined();
    expect(meta!.name).toBe('Object1');
    expect(meta!.parentName).toBeUndefined();
    expect(meta!.collisionTargets.size).toBe(0);
  });
});
