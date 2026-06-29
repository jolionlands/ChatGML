// test/plugin/tier.test.ts — pure-function tests for the per-turn tier UI (Cline-style Plan/Act).
//
// The tier system is a partial-override of the global chat lane: the agent dispatches each turn
// to one of three roles (planner / implementer / reviewer) and stamps the chosen role on the
// `turn_end` event so the panel can render a per-bubble badge. These tests pin the reducer's
// behavior on the tier stamp and the `parseSlashCommand` cases for the `/tier` slash command.
// The plugin-state and slash-command shapes are kept in lock-step between plugin/state.js (CJS)
// and src/plugin-runtime.ts (ESM); this file exercises BOTH via the parity helpers and the
// dedicated runtime imports.
//
// Coverage:
//   1. turn_end with tier set stores the tier on the turn record.
//   2. turn_end without tier field stores null on the turn record.
//   3. An unknown tier name in turn_end falls back to null (defensive — like src/protocol.ts).
//   4. /tier <planner|implementer|reviewer> parses with `arg` = the canonical name.
//   5. /tier off (and unknown names) parse with `arg` = null.
//   6. /tier with no value parses with `arg` = null.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initialPluginState,
  reducePluginState,
  parseSlashCommand,
  type PluginState,
} from '../../src/plugin-runtime.js';
import type { AgentEvent } from '../../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsState = require(path.join(HERE, '../../plugin/state.js')) as {
  initialPluginState: () => PluginState;
  reducePluginState: (event: AgentEvent, state: PluginState) => PluginState;
  parseSlashCommand: (line: string) => unknown;
};

describe('reducePluginState — turn_end tier stamp (per-turn tier UI)', () => {
  it('stores the tier on the turn record when turn_end.tier is set', () => {
    const ev: AgentEvent = {
      type: 'turn_end',
      userText: 'plan this',
      assistantText: 'first, gather the events…',
      sources: [],
      tier: 'planner',
    };
    const state = reducePluginState(ev, initialPluginState());
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.tier).toBe('planner');
    expect(state.turns[0]?.userText).toBe('plan this');
    expect(state.turns[0]?.assistantText).toBe('first, gather the events…');
  });

  it('stores null on the turn record when turn_end.tier is absent (no override)', () => {
    // The TierName field on turn_end is OPTIONAL; absent means the global chat lane was used and
    // the panel must render NO badge. The reducer normalizes undefined -> null so the field is
    // always present (and the panel can rely on `t === null` rather than `t == null` checks).
    const ev: AgentEvent = {
      type: 'turn_end',
      userText: 'hi',
      assistantText: 'hello',
      sources: [],
    };
    const state = reducePluginState(ev, initialPluginState());
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.tier ?? null).toBeNull();
  });

  it('stores null on the turn record when turn_end.tier is explicitly null', () => {
    // Same end-state as absent: a wire event that explicitly stamps tier: null. The panel must
    // not render a badge.
    const ev = {
      type: 'turn_end' as const,
      userText: 'q',
      assistantText: 'a',
      sources: [],
      tier: null,
    };
    const state = reducePluginState(ev, initialPluginState());
    expect(state.turns[0]?.tier ?? null).toBeNull();
  });

  it('falls back to null for an unknown tier name (defensive normalization)', () => {
    // src/protocol.ts already validates the tier name on the wire, but the reducer is reachable
    // from tests / future callers that bypass the schema. Storing a non-TierName value would
    // silently miss the panel's `s === 'planner'` lookups and render a missing badge. The
    // reducer whitelists the three known values; anything else becomes null.
    const ev = {
      type: 'turn_end' as const,
      userText: 'q',
      assistantText: 'a',
      sources: [],
      // Cast to silence the TS union: this is the exact case the defensive code is for.
      tier: 'bogus' as unknown as 'planner',
    };
    const state = reducePluginState(ev, initialPluginState());
    expect(state.turns[0]?.tier ?? null).toBeNull();
  });

  it('preserves the tier stamp across the TURN_CAP FIFO eviction', () => {
    // A long session caps the visible turn history at TURN_CAP (200) by dropping the FRONT-most
    // entries. The retained entries must keep their `tier` field so the panel still has a
    // badge color to draw for the most recent turns. We push 205 turns and assert the last
    // 200 all have a tier (alternating planner / implementer).
    const TOTAL = 205;
    const firstRetainedIndex = TOTAL - 200; // events 0..(firstRetainedIndex-1) get evicted
    const events: AgentEvent[] = [];
    for (let i = 0; i < TOTAL; i++) {
      events.push({
        type: 'turn_end',
        userText: 'q' + i,
        assistantText: 'a' + i,
        sources: [],
        tier: i % 2 === 0 ? 'planner' : 'implementer',
      });
    }
    let state = initialPluginState();
    for (const e of events) state = reducePluginState(e, state);
    // Cap held; tier pattern preserved.
    expect(state.turns.length).toBeLessThanOrEqual(200);
    // The first retained turn is index `firstRetainedIndex` of the original sequence (cap
    // dropped the older ones from the front).
    expect(state.turns[0]?.userText).toBe('q' + firstRetainedIndex);
    expect(state.turns[0]?.tier).toBe(firstRetainedIndex % 2 === 0 ? 'planner' : 'implementer');
    // The most recent turn (last element) is event #TOTAL-1 -> 204 (even) -> 'planner'.
    expect(state.turns[state.turns.length - 1]?.userText).toBe('q' + (TOTAL - 1));
    expect(state.turns[state.turns.length - 1]?.tier).toBe('planner');
  });
});

describe('parseSlashCommand — /tier slash command (per-turn tier UI)', () => {
  it('/tier planner parses with arg="planner"', () => {
    expect(parseSlashCommand('/tier planner')).toEqual({ kind: 'tier', arg: 'planner' });
  });

  it('/tier implementer parses with arg="implementer"', () => {
    expect(parseSlashCommand('/tier implementer')).toEqual({
      kind: 'tier',
      arg: 'implementer',
    });
  });

  it('/tier reviewer parses with arg="reviewer"', () => {
    expect(parseSlashCommand('/tier reviewer')).toEqual({ kind: 'tier', arg: 'reviewer' });
  });

  it('/tier off parses with arg=null (the "no override" sentinel)', () => {
    // "off" is the explicit-clear form. The panel uses arg=null to drive the chip back to
    // "Tier: auto" and clears activeTierOverride in the glue.
    expect(parseSlashCommand('/tier off')).toEqual({ kind: 'tier', arg: null });
  });

  it('/tier <unknown> falls back to arg=null (defensive — like src/protocol.ts)', () => {
    // Any name that is not one of the three canonical TierName values is treated like "off"
    // (arg=null). This matches the reducer's defensive normalization for turn_end.tier.
    expect(parseSlashCommand('/tier nonsense')).toEqual({ kind: 'tier', arg: null });
    expect(parseSlashCommand('/tier coder')).toEqual({ kind: 'tier', arg: null });
    expect(parseSlashCommand('/tier PLANNER')).toEqual({ kind: 'tier', arg: null }); // case-sensitive
  });

  it('/tier with no value parses with arg=null (same as "off")', () => {
    // Bare `/tier` (no value) is a no-op that lands the user back in auto-dispatch.
    expect(parseSlashCommand('/tier')).toEqual({ kind: 'tier', arg: null });
  });

  it('case-insensitive on the command name; value is case-sensitive', () => {
    // The slash command name itself is lowercased (matches every other slash command) but the
    // value (the tier name) is case-sensitive so a mistyped `PLANNER` is treated as unknown
    // and falls back to arg=null.
    expect(parseSlashCommand('/TIER planner')).toEqual({ kind: 'tier', arg: 'planner' });
    expect(parseSlashCommand('/Tier implementer')).toEqual({
      kind: 'tier',
      arg: 'implementer',
    });
  });

  it('returns null for a non-slash line (does NOT shadow other slash commands)', () => {
    // Sanity: `/tier` is the only new slash kind added; other slash forms and plain text
    // continue to return their existing shape.
    expect(parseSlashCommand('hello world')).toBeNull();
    expect(parseSlashCommand('/clear')).toEqual({ kind: 'clear' });
    expect(parseSlashCommand('/mode code')).toEqual({ kind: 'mode', value: 'code' });
  });
});

describe('plugin/state.js (CJS port) — turn_end tier stamp parity (Cline-style Plan/Act)', () => {
  // The CJS port is the runtime copy used by the GMEdit renderer. It MUST agree with the ESM
  // src/plugin-runtime.ts on the new turn.tier field. This block asserts that agreement
  // independently of the centralized parity test (test/plugin/parity.test.ts) so a future
  // regression in the CJS port is caught here too.
  it('stores the tier on the turn record when turn_end.tier is set', () => {
    const ev = {
      type: 'turn_end' as const,
      userText: 'plan this',
      assistantText: 'first, gather the events…',
      sources: [],
      tier: 'planner' as const,
    };
    const state = jsState.reducePluginState(ev, jsState.initialPluginState());
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.tier).toBe('planner');
  });

  it('stores null on the turn record when turn_end.tier is absent', () => {
    const ev = {
      type: 'turn_end' as const,
      userText: 'hi',
      assistantText: 'hello',
      sources: [],
    };
    const state = jsState.reducePluginState(ev, jsState.initialPluginState());
    expect(state.turns[0]?.tier ?? null).toBeNull();
  });

  it('falls back to null for an unknown tier name', () => {
    const ev = {
      type: 'turn_end' as const,
      userText: 'q',
      assistantText: 'a',
      sources: [],
      // Cast to silence the TS union; the CJS port is duck-typed.
      tier: 'bogus' as unknown as 'planner',
    };
    const state = jsState.reducePluginState(ev, jsState.initialPluginState());
    expect(state.turns[0]?.tier ?? null).toBeNull();
  });

  it('parses /tier planner with arg="planner"', () => {
    expect(jsState.parseSlashCommand('/tier planner')).toEqual({ kind: 'tier', arg: 'planner' });
  });

  it('parses /tier off with arg=null', () => {
    expect(jsState.parseSlashCommand('/tier off')).toEqual({ kind: 'tier', arg: null });
  });
});
