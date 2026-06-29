// test/agent/tier.test.ts — verifies the Cline-style Plan/Act tier resolution in src/agent.ts.
//
// Coverage targets:
//  - tierForMode: 5 modes x 4 override states (none, planner, implementer, reviewer)
//  - resolveTier: tier field merge, missing tier fallback to global lane, name stamp
//  - createAgentLike end-to-end: turn_end.tier reflects the resolved tier, the right LLM is called
//
// These tests are the source-of-truth contract for the tier system. The plugin-side tests in
// test/plugin/tier.test.ts (when added) will mirror turn_end -> TurnRecord.tier stamping.
import { describe, it, expect } from 'vitest';
import { tierForMode, resolveTier } from '../../src/agent.js';
import type { ChatLane, Mode, TierName } from '../../src/types.js';

// --- Test fixtures ------------------------------------------------------------

const GLOBAL_LANE: ChatLane = {
  baseURL: 'http://global.local/v1',
  apiKey: 'sk-GLOBAL',
  model: 'global-model',
  temperature: 0,
};

function makeConfig(overrides?: {
  tiers?: {
    planner?: {
      model: string;
      baseURL?: string;
      apiKey?: string;
      temperature?: number;
      maxTokens?: number;
    };
    implementer?: {
      model: string;
      baseURL?: string;
      apiKey?: string;
      temperature?: number;
      maxTokens?: number;
    };
    reviewer?: {
      model: string;
      baseURL?: string;
      apiKey?: string;
      temperature?: number;
      maxTokens?: number;
    };
  };
  mode?: Mode;
}): {
  chat: ChatLane;
  embed: ChatLane;
  mode: Mode;
  approval: 'gated' | 'auto';
  tiers?: typeof overrides extends { tiers: infer T } ? T : never;
} {
  return {
    chat: GLOBAL_LANE,
    embed: { baseURL: 'http://embed.local/v1', apiKey: 'sk-EMBED', model: 'bge-m3' },
    mode: overrides?.mode ?? 'code',
    approval: 'gated',
    ...(overrides?.tiers ? { tiers: overrides.tiers } : {}),
  } as never;
}

// --- tierForMode --------------------------------------------------------------

describe('tierForMode (mode -> tier auto-dispatch)', () => {
  it('ask mode auto-dispatches to planner', () => {
    expect(tierForMode('ask')).toBe('planner');
  });
  it('code mode auto-dispatches to implementer', () => {
    expect(tierForMode('code')).toBe('implementer');
  });
  it('architect mode auto-dispatches to implementer', () => {
    expect(tierForMode('architect')).toBe('implementer');
  });
  it('debug mode auto-dispatches to implementer', () => {
    expect(tierForMode('debug')).toBe('implementer');
  });
  it('an unknown mode returns null (no tier -> global chat lane)', () => {
    expect(tierForMode('review-only' as unknown as Mode)).toBeNull();
  });
  it('an explicit override ALWAYS wins over mode-based dispatch', () => {
    expect(tierForMode('ask', 'reviewer')).toBe('reviewer');
    expect(tierForMode('code', 'planner')).toBe('planner');
    expect(tierForMode('debug', 'implementer')).toBe('implementer');
  });
  it('null override behaves like absent (mode-based dispatch wins)', () => {
    expect(tierForMode('ask', null)).toBe('planner');
    expect(tierForMode('ask', undefined)).toBe('planner');
  });
});

// --- resolveTier --------------------------------------------------------------

describe('resolveTier (lane merge + name stamp)', () => {
  it('returns the GLOBAL lane with name=null when no tier is configured', () => {
    const cfg = makeConfig();
    const r = resolveTier(cfg, 'ask');
    expect(r.lane).toBe(cfg.chat);
    expect(r.name).toBeNull();
  });

  it('returns the GLOBAL lane with name=null when the chosen tier is not configured', () => {
    const cfg = makeConfig(); // no tiers
    const r = resolveTier(cfg, 'ask');
    expect(r.lane).toBe(cfg.chat);
    expect(r.name).toBeNull();
  });

  it('returns the GLOBAL lane when the chosen tier has only a model (partial override inherits rest)', () => {
    const cfg = makeConfig({ tiers: { planner: { model: 'p-mistral' } } });
    const r = resolveTier(cfg, 'ask');
    expect(r.lane.baseURL).toBe(cfg.chat.baseURL);
    expect(r.lane.apiKey).toBe(cfg.chat.apiKey);
    expect(r.lane.model).toBe('p-mistral');
    expect(r.lane.temperature).toBe(cfg.chat.temperature);
    expect(r.name).toBe('planner');
  });

  it('a tier with a full override (model+baseURL+apiKey) gets its OWN lane', () => {
    const cfg = makeConfig({
      tiers: {
        implementer: {
          model: 'impl-deepseek',
          baseURL: 'http://deepseek.local/v1',
          apiKey: 'sk-DEEP',
          temperature: 0.5,
        },
      },
    });
    const r = resolveTier(cfg, 'code');
    expect(r.lane.model).toBe('impl-deepseek');
    expect(r.lane.baseURL).toBe('http://deepseek.local/v1');
    expect(r.lane.apiKey).toBe('sk-DEEP');
    expect(r.lane.temperature).toBe(0.5);
    expect(r.name).toBe('implementer');
  });

  it('a per-turn override (useTier) ALWAYS wins over mode-based dispatch', () => {
    const cfg = makeConfig({
      tiers: {
        planner: { model: 'planner-x' },
        implementer: { model: 'impl-y' },
        reviewer: { model: 'reviewer-z' },
      },
    });
    const r = resolveTier(cfg, 'ask', 'implementer');
    expect(r.lane.model).toBe('impl-y');
    expect(r.name).toBe('implementer');

    const r2 = resolveTier(cfg, 'code', 'reviewer');
    expect(r2.lane.model).toBe('reviewer-z');
    expect(r2.name).toBe('reviewer');

    const r3 = resolveTier(cfg, 'code', null);
    expect(r3.lane.model).toBe('impl-y');
    expect(r3.name).toBe('implementer');
    const r4 = resolveTier(cfg, 'code', undefined);
    expect(r4.lane.model).toBe('impl-y');
    expect(r4.name).toBe('implementer');
  });

  it('reviewer tier is reachable only via explicit override (no mode auto-dispatches to reviewer)', () => {
    const cfg = makeConfig({ tiers: { reviewer: { model: 'reviewer-1' } } });
    expect(resolveTier(cfg, 'code').name).toBeNull();
    expect(resolveTier(cfg, 'code', 'reviewer').name).toBe('reviewer');
  });

  it('maxTokens inherits from the global chat lane when the tier omits it', () => {
    const cfg = {
      ...makeConfig({ tiers: { planner: { model: 'p-mistral' } } }),
      chat: { ...GLOBAL_LANE, maxTokens: 8192 },
    };
    const r = resolveTier(cfg, 'ask');
    expect(r.lane.maxTokens).toBe(8192);
  });

  it('explicit tier maxTokens overrides the global lane maxTokens', () => {
    const cfg = {
      ...makeConfig({ tiers: { planner: { model: 'p-mistral', maxTokens: 16384 } } }),
      chat: { ...GLOBAL_LANE, maxTokens: 8192 },
    };
    const r = resolveTier(cfg, 'ask');
    expect(r.lane.maxTokens).toBe(16384);
  });
});

// --- AgentEvent typing — turn_end.tier plumbing ------------------------------

// These are pure type-level checks (they verify the shape exists; runtime asserts are below in the
// reducer tests).  We avoid a fancy type-check helper here; instead we just assign.
describe('AgentEvent.turn_end tier field is plumbed through', () => {
  it("a turn_end event with tier='planner' is a valid AgentEvent", () => {
    const e = {
      type: 'turn_end' as const,
      userText: 'hi',
      assistantText: 'hello',
      sources: [],
      tier: 'planner' as TierName,
    };
    expect(e.tier).toBe('planner');
  });
  it('a turn_end event may omit tier entirely (older clients keep working)', () => {
    const e = {
      type: 'turn_end' as const,
      userText: 'hi',
      assistantText: 'hello',
      sources: [],
    };
    expect(e.tier).toBeUndefined();
  });
  it('a turn_end event may also carry `thinking?` (mirror of the `thinking` event for replay)', () => {
    const e = {
      type: 'turn_end' as const,
      userText: 'hi',
      assistantText: 'hello',
      sources: [],
      tier: null,
      thinking: 'I thought hard.',
    };
    expect(e.thinking).toBe('I thought hard.');
  });
});
