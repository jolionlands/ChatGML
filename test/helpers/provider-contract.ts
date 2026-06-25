// test/helpers/provider-contract.ts — the MemoryProvider contract harness.
//
// `runProviderContract` exercises a provider against the MemoryProvider interface, asserting only the
// capabilities passed (local => all six; hippo => its read set). `assertContractFails` runs the suite
// programmatically against a deliberately-broken provider and asserts it FAILS — a GREEN negative
// control that proves the harness actually catches violations (never CI-red).
import { expect } from 'vitest';
import type { MemoryProvider } from '../../src/memory/provider.js';
import type { Scope, Chunk } from '../../src/memory/types.js';

export type Capability = 'upsert' | 'search' | 'graph' | 'temporal' | 'remember' | 'recall';

export interface ContractOptions {
  capabilities: ReadonlySet<Capability> | Capability[];
}

const SCOPE: Scope = { repo: 'contract-repo' };

function sampleChunks(): Chunk[] {
  return [
    {
      id: 'objects/obj_player/Step_0.gml#1-3',
      path: 'objects/obj_player/Step_0.gml',
      text: 'hp -= dmg;\nif (hp <= 0) instance_destroy();',
      contentHash: 'h1',
      startLine: 1,
      endLine: 3,
    },
    {
      id: 'scripts/scr_util/scr_util.gml#1-2',
      path: 'scripts/scr_util/scr_util.gml',
      text: 'function clampHealth(v) { return clamp(v, 0, 100); }',
      contentHash: 'h2',
      startLine: 1,
      endLine: 2,
    },
  ];
}

/**
 * Run the contract suite against `factory()` (a fresh provider). Returns a list of `{name, run}`
 * cases for the caller to register in a describe/it block, OR can be invoked directly via
 * `runContractCases`. Designed to be called from inside a vitest `describe`.
 */
export async function runContractCases(
  factory: () => Promise<MemoryProvider> | MemoryProvider,
  opts: ContractOptions,
): Promise<void> {
  const caps = new Set(opts.capabilities);
  const provider = await factory();

  if (caps.has('upsert')) {
    await provider.upsert(sampleChunks(), SCOPE);
    // Idempotent re-upsert: must not throw and must not duplicate (verified via search count below).
    await provider.upsert(sampleChunks(), SCOPE);
  }

  if (caps.has('search')) {
    const hits = await provider.search('player health damage', { k: 5, scope: SCOPE });
    expect(Array.isArray(hits)).toBe(true);
    if (caps.has('upsert')) {
      expect(hits.length).toBeGreaterThan(0);
      // Idempotency: a re-upserted store must not return duplicate chunk ids.
      const ids = hits.map((h) => h.chunkId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const h of hits) {
        expect(typeof h.chunkId).toBe('string');
        expect(typeof h.score).toBe('number');
      }
    }
  }

  if (caps.has('graph')) {
    const neighbors = await provider.graphNeighbors(
      { name: 'clampHealth', path: 'scripts/scr_util/scr_util.gml' },
      SCOPE,
    );
    expect(Array.isArray(neighbors)).toBe(true);
  }

  if (caps.has('temporal')) {
    const history = await provider.temporalQuery({ kind: 'history' }, SCOPE);
    expect(Array.isArray(history)).toBe(true);
  }

  if (caps.has('remember') && caps.has('recall')) {
    await provider.remember(
      { id: 'note-1', text: 'the player uses FSRS scheduling', createdAt: Date.now() },
      SCOPE,
    );
    const recalled = await provider.recall('FSRS scheduling', SCOPE);
    expect(Array.isArray(recalled)).toBe(true);
    expect(recalled.some((n) => n.id === 'note-1')).toBe(true);
  }

  if (provider.close) await provider.close();
}

/**
 * Negative control: assert that running the contract against a broken provider FAILS. Returns
 * normally when the suite throws (as expected); throws if the broken provider somehow passed.
 */
export async function assertContractFails(
  factory: () => Promise<MemoryProvider> | MemoryProvider,
  opts: ContractOptions,
): Promise<void> {
  let failed = false;
  try {
    await runContractCases(factory, opts);
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
}
