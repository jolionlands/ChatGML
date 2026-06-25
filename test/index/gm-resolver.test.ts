import { describe, it, expect } from 'vitest';
import {
  buildGmResolver,
  findYypOnDisk,
  defaultReader,
} from '../../src/index/gm-resolver.js';
import { deriveGmlMeta } from '../../src/index/gml.js';
import { applyEnrichment } from '../../src/index/gml-enrich.js';
import { makeTmpRepo } from '../helpers/fakes.js';
import type { ReadFile } from '../../src/index/yy.js';
import type { GmlEventMeta } from '../../src/index/gml.js';

function memReader(files: Record<string, string>): ReadFile {
  return async (p: string): Promise<string> => {
    const posix = p.replace(/\\/g, '/');
    const hit = files[posix];
    if (hit === undefined) throw new Error(`ENOENT: ${posix}`);
    return hit;
  };
}

// A synthetic GM project modeled on the real format: obj_enemy inherits obj_actor and collides obj_player.
const PROJECT: Record<string, string> = {
  'game.yyp': `{
    "resources":[
      {"id":{"name":"obj_actor","path":"objects/obj_actor/obj_actor.yy",},},
      {"id":{"name":"obj_enemy","path":"objects/obj_enemy/obj_enemy.yy",},},
      {"id":{"name":"obj_player","path":"objects/obj_player/obj_player.yy",},},
    ],
    "resourceType":"GMProject","resourceVersion":"2.0",
  }`,
  'objects/obj_actor/obj_actor.yy': `{
    "name":"obj_actor","parentObjectId":null,"spriteId":null,
    "eventList":[{"$GMEvent":"v1","collisionObjectId":null,"eventNum":0,"eventType":0,"name":"",},],
    "resourceType":"GMObject","resourceVersion":"2.0",
  }`,
  'objects/obj_enemy/obj_enemy.yy': `{
    "name":"obj_enemy",
    "parentObjectId":{"name":"obj_actor","path":"objects/obj_actor/obj_actor.yy",},
    "spriteId":null,
    "eventList":[
      {"$GMEvent":"v1","collisionObjectId":null,"eventNum":0,"eventType":0,"name":"",},
      {"$GMEvent":"v1","collisionObjectId":{"name":"obj_player","path":"objects/obj_player/obj_player.yy",},"eventNum":0,"eventType":4,"name":"",},
    ],
    "resourceType":"GMObject","resourceVersion":"2.0",
  }`,
  'objects/obj_player/obj_player.yy': `{
    "name":"obj_player","parentObjectId":null,"spriteId":null,
    "eventList":[{"$GMEvent":"v1","collisionObjectId":null,"eventNum":0,"eventType":0,"name":"",},],
    "resourceType":"GMObject","resourceVersion":"2.0",
  }`,
};

describe('buildGmResolver — enrich path-only GmlMeta', () => {
  it('resolves a collision event target NAME from the authoritative eventList', async () => {
    const resolver = await buildGmResolver({ yypPath: 'game.yyp', readFile: memReader(PROJECT) });
    expect(resolver).toBeDefined();

    // A GMS2.3 collision file carries a GUID token in its name; the .yy eventList is authoritative.
    const base = deriveGmlMeta('objects/obj_enemy/Collision_aaaa-bbbb.gml') as GmlEventMeta;
    expect(base.collisionWith).toBeUndefined();

    const enriched = (await resolver!.enrich(base)) as GmlEventMeta;
    expect(enriched.collisionWith).toBe('obj_player'); // resolved from the .yy, not the filename
    expect(enriched.collisionWithRaw).toBe('aaaa-bbbb'); // raw token preserved
    expect(enriched.parentObject).toBe('obj_actor'); // inheritance attached too
  });

  it('attaches parentObject to a NON-collision event of an inheriting object', async () => {
    const resolver = await buildGmResolver({ yypPath: 'game.yyp', readFile: memReader(PROJECT) });
    const base = deriveGmlMeta('objects/obj_enemy/Step_0.gml') as GmlEventMeta;
    const enriched = (await resolver!.enrich(base)) as GmlEventMeta;
    expect(enriched.parentObject).toBe('obj_actor');
    expect(enriched.collisionWith).toBeUndefined(); // not a collision event
  });

  it('leaves a non-inheriting, non-collision event unchanged', async () => {
    const resolver = await buildGmResolver({ yypPath: 'game.yyp', readFile: memReader(PROJECT) });
    const base = deriveGmlMeta('objects/obj_player/Create_0.gml') as GmlEventMeta;
    const enriched = await resolver!.enrich(base);
    expect(enriched).toBe(base); // identity: nothing to add
  });

  it('memoizes object .yy reads (one read per object)', async () => {
    let reads = 0;
    const reader: ReadFile = async (p) => {
      reads++;
      const f = memReader(PROJECT);
      return f(p);
    };
    const resolver = await buildGmResolver({ yypPath: 'game.yyp', readFile: reader });
    const readsAfterBuild = reads; // the .yyp read
    await resolver!.objectMeta('obj_enemy');
    await resolver!.objectMeta('obj_enemy');
    await resolver!.objectMeta('obj_enemy');
    expect(reads - readsAfterBuild).toBe(1); // only one obj_enemy.yy read despite 3 calls
  });

  it('is graceful: no .yyp -> undefined resolver', async () => {
    const resolver = await buildGmResolver({ yypPath: 'absent.yyp', readFile: memReader(PROJECT) });
    expect(resolver).toBeUndefined();
  });

  it('is graceful: corrupt object .yy -> meta passes through unenriched', async () => {
    const broken = { ...PROJECT, 'objects/obj_enemy/obj_enemy.yy': '{ not valid' };
    const resolver = await buildGmResolver({ yypPath: 'game.yyp', readFile: memReader(broken) });
    const base = deriveGmlMeta('objects/obj_enemy/Collision_x.gml') as GmlEventMeta;
    const enriched = await resolver!.enrich(base);
    expect(enriched).toBe(base); // unchanged (the corrupt .yy resolved to undefined)
  });

  it('legacy collision token that names a real target is used as collisionWith', async () => {
    // Single-collision object: even without a name match, the lone target resolves.
    const resolver = await buildGmResolver({ yypPath: 'game.yyp', readFile: memReader(PROJECT) });
    const legacy = deriveGmlMeta('objects/obj_enemy/Collision_obj_player.gml') as GmlEventMeta;
    const enriched = (await resolver!.enrich(legacy)) as GmlEventMeta;
    expect(enriched.collisionWith).toBe('obj_player');
  });

  it('multi-collision object: a raw token that names one of several targets resolves to that name', async () => {
    // obj_multi collides BOTH obj_player and obj_wall -> size>1, so the raw name token disambiguates.
    const multi: Record<string, string> = {
      'game.yyp': `{
        "resources":[
          {"id":{"name":"obj_multi","path":"objects/obj_multi/obj_multi.yy",},},
          {"id":{"name":"obj_player","path":"objects/obj_player/obj_player.yy",},},
          {"id":{"name":"obj_wall","path":"objects/obj_wall/obj_wall.yy",},},
        ],"resourceType":"GMProject","resourceVersion":"2.0",
      }`,
      'objects/obj_multi/obj_multi.yy': `{
        "name":"obj_multi","parentObjectId":null,"spriteId":null,
        "eventList":[
          {"$GMEvent":"v1","collisionObjectId":{"name":"obj_player","path":"objects/obj_player/obj_player.yy",},"eventNum":0,"eventType":4,"name":"",},
          {"$GMEvent":"v1","collisionObjectId":{"name":"obj_wall","path":"objects/obj_wall/obj_wall.yy",},"eventNum":1,"eventType":4,"name":"",},
        ],"resourceType":"GMObject","resourceVersion":"2.0",
      }`,
    };
    const resolver = await buildGmResolver({ yypPath: 'game.yyp', readFile: memReader(multi) });
    // A legacy filename names obj_wall directly; eventNumber 0 won't key-match obj_wall (it's eventNum 1),
    // so resolution falls through to the raw-token-name match (size>1, no single fallback).
    const legacy = deriveGmlMeta('objects/obj_multi/Collision_obj_wall.gml') as GmlEventMeta;
    const enriched = (await resolver!.enrich(legacy)) as GmlEventMeta;
    expect(enriched.collisionWith).toBe('obj_wall');

    // A GUID token (unknown name) on a multi-collision object with no key match resolves nothing.
    const guid = deriveGmlMeta('objects/obj_multi/Collision_deadbeef.gml') as GmlEventMeta;
    const enrichedGuid = await resolver!.enrich(guid);
    expect((enrichedGuid as GmlEventMeta).collisionWith).toBeUndefined();
  });

  it('returns undefined when neither root nor readFile is provided', async () => {
    expect(await buildGmResolver({})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// D2 — safe multi-collision resolution. A synthetic GM project with one object that has TWO collision
// events, NAME-encoded on disk (`Collision_<TargetName>.gml`), each resolving to its OWN distinct
// target; plus a canonical-GUID-encoded collision file on the same object that stays path-only.
// ---------------------------------------------------------------------------
describe('multi-collision resolution (D2): name-encoded resolve, GUID stays path-only', () => {
  // obj_hero collides BOTH obj_enemy AND obj_coin. Modern GMS files name the .gml by GUID; this project
  // mixes a real canonical GUID file (stays path-only) with two name-encoded files (both resolve).
  const GUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'; // a canonical GameMaker GUID token
  const MULTI: Record<string, string> = {
    'game.yyp': `{
      "resources":[
        {"id":{"name":"obj_hero","path":"objects/obj_hero/obj_hero.yy",},},
        {"id":{"name":"obj_enemy","path":"objects/obj_enemy/obj_enemy.yy",},},
        {"id":{"name":"obj_coin","path":"objects/obj_coin/obj_coin.yy",},},
      ],"resourceType":"GMProject","resourceVersion":"2.0",
    }`,
    'objects/obj_hero/obj_hero.yy': `{
      "name":"obj_hero","parentObjectId":null,"spriteId":null,
      "eventList":[
        {"$GMEvent":"v1","collisionObjectId":{"name":"obj_enemy","path":"objects/obj_enemy/obj_enemy.yy",},"eventNum":0,"eventType":4,"name":"",},
        {"$GMEvent":"v1","collisionObjectId":{"name":"obj_coin","path":"objects/obj_coin/obj_coin.yy",},"eventNum":1,"eventType":4,"name":"",},
      ],"resourceType":"GMObject","resourceVersion":"2.0",
    }`,
    'objects/obj_enemy/obj_enemy.yy': `{"name":"obj_enemy","eventList":[],}`,
    'objects/obj_coin/obj_coin.yy': `{"name":"obj_coin","eventList":[],}`,
  };

  it('BOTH name-encoded collision events resolve to their OWN distinct target', async () => {
    const resolver = await buildGmResolver({ yypPath: 'game.yyp', readFile: memReader(MULTI) });
    expect(resolver).toBeDefined();

    const enemyEvt = deriveGmlMeta('objects/obj_hero/Collision_obj_enemy.gml') as GmlEventMeta;
    const coinEvt = deriveGmlMeta('objects/obj_hero/Collision_obj_coin.gml') as GmlEventMeta;

    const enemy = (await resolver!.enrich(enemyEvt)) as GmlEventMeta;
    const coin = (await resolver!.enrich(coinEvt)) as GmlEventMeta;

    // Distinct targets — NOT both collapsed to a single fallback, NOT swapped.
    expect(enemy.collisionWith).toBe('obj_enemy');
    expect(enemy.collisionWithRaw).toBe('obj_enemy'); // raw token preserved
    expect(coin.collisionWith).toBe('obj_coin');
    expect(coin.collisionWith).not.toBe(enemy.collisionWith);
  });

  it('a canonical GUID-encoded collision file on a multi-collision object stays path-only', async () => {
    const resolver = await buildGmResolver({ yypPath: 'game.yyp', readFile: memReader(MULTI) });
    const guidEvt = deriveGmlMeta(`objects/obj_hero/Collision_${GUID}.gml`) as GmlEventMeta;

    const enriched = (await resolver!.enrich(guidEvt)) as GmlEventMeta;
    // Unmappable GUID + >1 target -> never guess. collisionWith absent; raw token kept for the citation.
    expect(enriched.collisionWith).toBeUndefined();
    expect(enriched.collisionWithRaw).toBe(GUID);
  });

  it('a SINGLE-collision object still resolves even from a GUID filename', async () => {
    // The lone target is unambiguous, so a single-collision object keeps resolving (no regression).
    const single: Record<string, string> = {
      'game.yyp': `{
        "resources":[
          {"id":{"name":"obj_solo","path":"objects/obj_solo/obj_solo.yy",},},
          {"id":{"name":"obj_door","path":"objects/obj_door/obj_door.yy",},},
        ],"resourceType":"GMProject","resourceVersion":"2.0",
      }`,
      'objects/obj_solo/obj_solo.yy': `{
        "name":"obj_solo","parentObjectId":null,"spriteId":null,
        "eventList":[
          {"$GMEvent":"v1","collisionObjectId":{"name":"obj_door","path":"objects/obj_door/obj_door.yy",},"eventNum":0,"eventType":4,"name":"",},
        ],"resourceType":"GMObject","resourceVersion":"2.0",
      }`,
      'objects/obj_door/obj_door.yy': `{"name":"obj_door","eventList":[],}`,
    };
    const resolver = await buildGmResolver({ yypPath: 'game.yyp', readFile: memReader(single) });
    const guidEvt = deriveGmlMeta(`objects/obj_solo/Collision_${GUID}.gml`) as GmlEventMeta;
    const enriched = (await resolver!.enrich(guidEvt)) as GmlEventMeta;
    expect(enriched.collisionWith).toBe('obj_door'); // lone target -> safe
  });
});

describe('findYypOnDisk + defaultReader (real fs)', () => {
  it('finds the .yyp at a real project root and reads through defaultReader', async () => {
    const repo = makeTmpRepo({
      'My Game.yyp': '{"resources":[{"id":{"name":"Object1","path":"objects/Object1/Object1.yy",},},],}',
      'objects/Object1/Object1.yy': '{"name":"Object1","eventList":[],}',
    });
    try {
      const yyp = await findYypOnDisk(repo.root);
      expect(yyp).toBe('My Game.yyp');
      const reader = defaultReader(repo.root);
      const text = await reader(yyp!);
      expect(text).toContain('Object1');

      // buildGmResolver with root only (discovers the .yyp on disk).
      const resolver = await buildGmResolver({ root: repo.root });
      expect(resolver).toBeDefined();
      expect(resolver!.resources.byName.has('Object1')).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  it('returns undefined for a non-existent directory (catch branch)', async () => {
    expect(await findYypOnDisk('Z:/no/such/dir/here-xyz')).toBeUndefined();
  });

  it('returns undefined for a directory with no .yyp', async () => {
    const repo = makeTmpRepo({ 'readme.txt': 'hi' });
    try {
      expect(await findYypOnDisk(repo.root)).toBeUndefined();
      // buildGmResolver with root only and no .yyp -> undefined.
      expect(await buildGmResolver({ root: repo.root })).toBeUndefined();
    } finally {
      repo.cleanup();
    }
  });
});

describe('applyEnrichment (sidecar layering helper)', () => {
  it('layers collisionWith + parentObject onto an object event', () => {
    const base = deriveGmlMeta('objects/obj_enemy/Collision_x.gml') as GmlEventMeta;
    const out = applyEnrichment(base, { collisionWith: 'obj_player', parentObject: 'obj_actor' }) as GmlEventMeta;
    expect(out.collisionWith).toBe('obj_player');
    expect(out.parentObject).toBe('obj_actor');
  });

  it('passes through non-object meta and undefined enrichment unchanged', () => {
    const script = deriveGmlMeta('scripts/s/s.gml')!;
    expect(applyEnrichment(script, { parentObject: 'x' })).toBe(script);
    const base = deriveGmlMeta('objects/o/Step_0.gml')!;
    expect(applyEnrichment(base, undefined)).toBe(base);
  });
});
