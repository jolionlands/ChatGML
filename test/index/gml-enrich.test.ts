import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { runIndex } from '../../src/index/indexer.js';
import { LocalMemoryProvider } from '../../src/memory/local.js';
import { FakeEmbeddings, makeTmpRepo } from '../helpers/fakes.js';
import {
  enrichmentSidecarPath,
  loadEnrichmentSidecar,
  createEnrichedGmlDeriver,
  clearGmlDeriverCache,
} from '../../src/index/gml-enrich.js';
import type { GmlEventMeta } from '../../src/index/gml.js';
import type { Scope } from '../../src/memory/types.js';
import { buildIgnoreFilter } from '../../src/index/files.js';
import { makeToolContext } from '../helpers/tool-context.js';
import { readTool } from '../../src/tools/read.js';
import { globTool } from '../../src/tools/glob.js';

const SCOPE: Scope = { repo: 'gm-enrich' };

function deps(root: string) {
  const emb = new FakeEmbeddings();
  return { memory: new LocalMemoryProvider({ provider: 'local', root }, { embeddings: emb }), embeddings: emb };
}

// A synthetic GM project on disk: obj_enemy inherits obj_actor and has a collision-with-obj_player
// event. The collision .gml filename carries only a GUID token; the .yy eventList is authoritative.
const COLLISION_GUID = 'abcd1234-0000-1111-2222-333344445555';
function gmProjectFiles(): Record<string, string> {
  return {
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
    // The actual GML the agent searches over:
    'objects/obj_enemy/Create_0.gml': 'hp = 10;',
    'objects/obj_enemy/Step_0.gml': 'x += 1;',
    [`objects/obj_enemy/Collision_${COLLISION_GUID}.gml`]: 'instance_destroy();',
    'objects/obj_player/Create_0.gml': 'score = 0;',
  };
}

afterEach(() => clearGmlDeriverCache());

describe('runIndex — fs-aware GameMaker enrichment (end-to-end)', () => {
  it('enriches a collision .gml with the resolved target + the object parent', async () => {
    const repo = makeTmpRepo(gmProjectFiles());
    try {
      const res = await runIndex(repo.root, SCOPE, deps(repo.root));
      // At least the collision event + the two parented events enriched.
      expect(res.gmEnriched).toBeGreaterThanOrEqual(1);

      // The sidecar landed on disk.
      expect(existsSync(enrichmentSidecarPath(repo.root))).toBe(true);
      const sidecar = loadEnrichmentSidecar(repo.root);
      expect(sidecar).toBeDefined();

      const collisionPath = `objects/obj_enemy/Collision_${COLLISION_GUID}.gml`;
      expect(sidecar!.byPath[collisionPath]).toEqual({
        collisionWith: 'obj_player',
        parentObject: 'obj_actor',
      });
      // A non-collision event of the inheriting object still gets parentObject.
      expect(sidecar!.byPath['objects/obj_enemy/Step_0.gml']).toEqual({ parentObject: 'obj_actor' });
      // A non-inheriting, non-collision event has no enrichment entry.
      expect(sidecar!.byPath['objects/obj_player/Create_0.gml']).toBeUndefined();

      // The enriched deriver (what the citation layer uses) surfaces both fields.
      const derive = createEnrichedGmlDeriver(repo.root);
      const meta = derive(collisionPath) as GmlEventMeta;
      expect(meta.kind).toBe('event');
      expect(meta.collisionWith).toBe('obj_player');
      expect(meta.collisionWithRaw).toBe(COLLISION_GUID);
      expect(meta.parentObject).toBe('obj_actor');
    } finally {
      repo.cleanup();
    }
  });

  it('graceful fallback: a repo with NO .yyp indexes and yields path-only meta', async () => {
    const repo = makeTmpRepo({
      'objects/obj_a/Collision_obj_b.gml': 'x = 0;',
      'objects/obj_a/Create_0.gml': 'y = 0;',
    });
    try {
      const res = await runIndex(repo.root, SCOPE, deps(repo.root));
      expect(res.gmEnriched).toBe(0);
      // No sidecar is written when there is no .yyp.
      expect(existsSync(enrichmentSidecarPath(repo.root))).toBe(false);

      // The deriver is exactly the path-only one: collisionWithRaw present, no resolved fields.
      const derive = createEnrichedGmlDeriver(repo.root);
      const meta = derive('objects/obj_a/Collision_obj_b.gml') as GmlEventMeta;
      expect(meta.collisionWithRaw).toBe('obj_b');
      expect(meta.collisionWith).toBeUndefined();
      expect(meta.parentObject).toBeUndefined();
    } finally {
      repo.cleanup();
    }
  });

  it('graceful fallback: a CORRUPT .yyp indexes normally with no enrichment', async () => {
    const repo = makeTmpRepo({
      'game.yyp': '{ this is not valid json at all',
      'objects/obj_a/Create_0.gml': 'y = 0;',
    });
    try {
      const res = await runIndex(repo.root, SCOPE, deps(repo.root));
      // Indexing still succeeds for the .gml; enrichment simply contributes nothing.
      expect(res.added).toBeGreaterThanOrEqual(1);
      expect(res.gmEnriched).toBe(0);
      const derive = createEnrichedGmlDeriver(repo.root);
      const meta = derive('objects/obj_a/Create_0.gml') as GmlEventMeta;
      expect(meta.parentObject).toBeUndefined();
    } finally {
      repo.cleanup();
    }
  });

  it('a second pass keeps the sidecar (enrichment persists across incremental runs)', async () => {
    const repo = makeTmpRepo(gmProjectFiles());
    try {
      const d = deps(repo.root);
      await runIndex(repo.root, SCOPE, d);
      const res2 = await runIndex(repo.root, SCOPE, d);
      // Unchanged files this pass, but the sidecar is still refreshed/complete.
      expect(res2.gmEnriched).toBeGreaterThanOrEqual(1);
      const sidecar = loadEnrichmentSidecar(repo.root);
      const collisionPath = `objects/obj_enemy/Collision_${COLLISION_GUID}.gml`;
      expect(sidecar!.byPath[collisionPath]!.collisionWith).toBe('obj_player');
    } finally {
      repo.cleanup();
    }
  });
});

// F8: read_file and glob must cite GML metadata WITH the enrichment sidecar (collisionWith /
// parentObject), exactly like search/graph/temporal — not the path-only deriver.
describe('read_file/glob use the ENRICHED GML deriver — F8', () => {
  const collisionPath = `objects/obj_enemy/Collision_${COLLISION_GUID}.gml`;

  it('read_file surfaces the resolved collisionWith/parentObject on a collision event', async () => {
    const repo = makeTmpRepo(gmProjectFiles());
    try {
      await runIndex(repo.root, SCOPE, deps(repo.root));
      clearGmlDeriverCache(); // ensure the tool reads the freshly-written sidecar
      const { ctx } = makeToolContext({ root: repo.root });
      const res = await readTool.execute({ path: collisionPath }, ctx);
      const gml = res.citations?.[0]?.gml as GmlEventMeta | undefined;
      expect(gml?.kind).toBe('event');
      expect(gml?.collisionWith).toBe('obj_player');
      expect(gml?.parentObject).toBe('obj_actor');
    } finally {
      repo.cleanup();
    }
  });

  it('glob annotates the collision event using the enriched displayName', async () => {
    const repo = makeTmpRepo(gmProjectFiles());
    try {
      await runIndex(repo.root, SCOPE, deps(repo.root));
      clearGmlDeriverCache();
      const ignore = await buildIgnoreFilter(repo.root);
      const { ctx } = makeToolContext({ root: repo.root, ignore });
      const res = await globTool.execute({ pattern: 'objects/obj_enemy/Collision_*.gml' }, ctx);
      // The displayName of a resolved collision event includes the target object name.
      expect(res.content).toContain('obj_player');
    } finally {
      repo.cleanup();
    }
  });
});
