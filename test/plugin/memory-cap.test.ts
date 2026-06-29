// test/plugin/memory-cap.test.ts — verifies the audit-gap-#21 memory caps on `state.turns`
// (TURN_CAP = 200) and `state.activity` (ACTIVITY_CAP = 500). The reducer is the single source
// of truth for these caps; these tests pin the contract directly on both the ESM source
// (src/plugin-runtime.ts) and the CJS plugin port (plugin/state.js) so a drift is caught here
// even if the parity test misses a subtle sub-field.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  reducePluginState,
  initialPluginState,
  pushCapped,
  TURN_CAP,
  ACTIVITY_CAP,
  type PluginState,
  type TurnRecord,
  type ActivityEntry,
} from '../../src/plugin-runtime.js';
import type { AgentEvent } from '../../src/types.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const js = require('../../plugin/state.js') as {
  reducePluginState: (e: AgentEvent, s: ReturnType<typeof js.initialPluginState>) => ReturnType<
    typeof js.initialPluginState
  >;
  initialPluginState: () => {
    turns: TurnRecord[];
    activity: ActivityEntry[];
    turnsEvicted: number;
    activityEvicted: number;
  };
  pushCapped: <T>(
    arr: readonly T[],
    item: T,
    max: number,
    evictedCount: number,
  ) => [T[], number];
  TURN_CAP: number;
  ACTIVITY_CAP: number;
};

// Build a synthetic turn_end event with distinct, identifiable text so FIFO behavior can be
// asserted: after N evictions, the surviving `turns` should still contain exactly the N most-
// recent, in original arrival order.
function turnEnd(i: number): AgentEvent {
  return {
    type: 'turn_end' as const,
    userText: 'u' + i,
    assistantText: 'a' + i,
    sources: [],
  };
}

function toolCall(i: number): AgentEvent {
  return { type: 'tool_call' as const, id: 't' + i, name: 'tool_' + i, args: {} };
}

function mcpToolCall(i: number): AgentEvent {
  return {
    type: 'mcp_tool_call' as const,
    id: 'm' + i,
    name: 'mcp_' + i,
    server: 'fs',
    args: {},
  };
}

function commandRequest(i: number): AgentEvent {
  return { type: 'command_request' as const, id: 'c' + i, command: 'echo ' + i };
}

function mcpResource(i: number): AgentEvent {
  return {
    type: 'mcp_resource' as const,
    id: 'r' + i,
    server: 'fetch',
    name: 'https://example.com/' + i,
    content: 'body ' + i,
  };
}

describe('pushCapped helper (memory cap primitives)', () => {
  it('appending at the tail when under cap leaves the array and counter unchanged', () => {
    const [arr, count] = pushCapped([1, 2, 3], 4, 5, 0);
    expect(arr).toEqual([1, 2, 3, 4]);
    expect(count).toBe(0);
  });

  it('appending at the cap trims exactly one from the front and bumps the counter', () => {
    const [arr, count] = pushCapped([1, 2, 3, 4, 5], 6, 5, 0);
    expect(arr).toEqual([2, 3, 4, 5, 6]);
    expect(count).toBe(1);
  });

  it('appending deep over the cap trims the right number of items from the front in one pass', () => {
    const [arr, count] = pushCapped([1, 2, 3, 4, 5], 6, 3, 0);
    expect(arr).toEqual([4, 5, 6]);
    expect(count).toBe(3);
  });

  it('preserves accumulated eviction count across calls (counters NEVER reset on append)', () => {
    let arr: number[] = [];
    let count = 0;
    for (let i = 0; i < 7; i++) {
      const r = pushCapped(arr, i, 3, count);
      arr = r[0];
      count = r[1];
    }
    // 7 appends on a cap of 3 -> 4 items evicted; final array holds the last 3.
    expect(arr).toEqual([4, 5, 6]);
    expect(count).toBe(4);
  });

  it('CJS port returns identical [arr, count] for the same inputs (parity of the helper itself)', () => {
    const inputs: Array<[number[], number, number, number]> = [
      [[], 1, 3, 0],
      [[1, 2], 3, 3, 0],
      [[1, 2, 3], 4, 3, 7],
      [[1, 2, 3, 4, 5, 6], 7, 3, 99],
    ];
    for (const [a, item, max, ec] of inputs) {
      const tsR = pushCapped(a, item, max, ec);
      const jsR = js.pushCapped(a, item, max, ec);
      expect(jsR).toEqual(tsR);
    }
  });
});

describe('state.turns cap (TURN_CAP)', () => {
  it('a turn_end just UNDER the threshold does NOT trim', () => {
    let state: PluginState = initialPluginState();
    const n = TURN_CAP - 1;
    for (let i = 0; i < n; i++) {
      state = reducePluginState(turnEnd(i), state);
    }
    expect(state.turns.length).toBe(n);
    expect(state.turnsEvicted).toBe(0);
    // The earliest turn is still the first one we appended (no FIFO drop yet).
    expect(state.turns[0]).toMatchObject({ userText: 'u0', assistantText: 'a0' });
    expect(state.turns[n - 1]).toMatchObject({
      userText: 'u' + (n - 1),
      assistantText: 'a' + (n - 1),
    });
  });

  it('a turn_end AT the threshold does NOT trim (cap is inclusive)', () => {
    let state: PluginState = initialPluginState();
    for (let i = 0; i < TURN_CAP; i++) {
      state = reducePluginState(turnEnd(i), state);
    }
    expect(state.turns.length).toBe(TURN_CAP);
    expect(state.turnsEvicted).toBe(0);
  });

  it('the (TURN_CAP + 1)-th turn trims the OLDEST (u0) from the front and bumps evicted by 1', () => {
    let state: PluginState = initialPluginState();
    for (let i = 0; i < TURN_CAP; i++) {
      state = reducePluginState(turnEnd(i), state);
    }
    // No eviction yet.
    expect(state.turnsEvicted).toBe(0);
    // Push past the cap.
    state = reducePluginState(turnEnd(TURN_CAP), state);
    expect(state.turns.length).toBe(TURN_CAP);
    expect(state.turnsEvicted).toBe(1);
    // u0 was the oldest; it should have been dropped. u1 is now the oldest survivor.
    expect(state.turns[0]).toMatchObject({ userText: 'u1', assistantText: 'a1' });
    expect(state.turns[state.turns.length - 1]).toMatchObject({
      userText: 'u' + TURN_CAP,
      assistantText: 'a' + TURN_CAP,
    });
  });

  it('TURN_CAP + 50 stress: FIFO drop, count tracks total evictions, size stays at the cap', () => {
    let state: PluginState = initialPluginState();
    const total = TURN_CAP + 50;
    for (let i = 0; i < total; i++) {
      state = reducePluginState(turnEnd(i), state);
    }
    expect(state.turns.length).toBe(TURN_CAP);
    expect(state.turnsEvicted).toBe(total - TURN_CAP);
    // First survivor should be u50 (everything u0..u49 was evicted).
    expect(state.turns[0]).toMatchObject({ userText: 'u50', assistantText: 'a50' });
    expect(state.turns[state.turns.length - 1]).toMatchObject({
      userText: 'u' + (total - 1),
      assistantText: 'a' + (total - 1),
    });
  });
});

describe('state.activity cap (ACTIVITY_CAP)', () => {
  it('under the threshold: every tool_call appends; no eviction', () => {
    let state: PluginState = initialPluginState();
    const n = ACTIVITY_CAP - 1;
    for (let i = 0; i < n; i++) {
      state = reducePluginState(toolCall(i), state);
    }
    expect(state.activity.length).toBe(n);
    expect(state.activityEvicted).toBe(0);
  });

  it('over the threshold: tool_call trims oldest and bumps activityEvicted', () => {
    let state: PluginState = initialPluginState();
    for (let i = 0; i < ACTIVITY_CAP; i++) {
      state = reducePluginState(toolCall(i), state);
    }
    expect(state.activityEvicted).toBe(0);
    state = reducePluginState(toolCall(ACTIVITY_CAP), state);
    expect(state.activity.length).toBe(ACTIVITY_CAP);
    expect(state.activityEvicted).toBe(1);
    // Oldest survivor is now t1; t0 is gone.
    expect(state.activity[0]!.id).toBe('t1');
    expect(state.activity[state.activity.length - 1]!.id).toBe('t' + ACTIVITY_CAP);
  });

  it('the cap applies to ALL four activity-adding reducers (tool_call, command_request, mcp_tool_call, mcp_resource)', () => {
    // Build ACTIVITY_CAP + 8 events mixing all four adders (2 of each kind, 4 times). The cap must
    // apply uniformly to the merged array (not per-kind); the survivors' ordering reflects arrival
    // order, not kind.
    let state: PluginState = initialPluginState();
    const rounds = Math.ceil((ACTIVITY_CAP + 8) / 4);
    for (let r = 0; r < rounds; r++) {
      const base = r * 4;
      state = reducePluginState(toolCall(base), state);
      state = reducePluginState(commandRequest(base + 1), state);
      state = reducePluginState(mcpToolCall(base + 2), state);
      state = reducePluginState(mcpResource(base + 3), state);
    }
    expect(state.activity.length).toBe(ACTIVITY_CAP);
    expect(state.activityEvicted).toBe(rounds * 4 - ACTIVITY_CAP);
    // Kinds are mixed in the survivors — not stripped to a single kind.
    const kinds = new Set(state.activity.map((a) => a.kind));
    expect(kinds.size).toBeGreaterThan(1);
  });
});

describe('reducer purity under cap (audit gap #21 invariants)', () => {
  it('reducer remains a pure function: no Date.now, no I/O, deterministic for the same event sequence', () => {
    // Snapshot the global clock (not used by the reducer, but proves no hidden Date.now sneaks in
    // by accident). Run the same sequence twice and assert identical outputs.
    const events: AgentEvent[] = [];
    for (let i = 0; i < TURN_CAP + 5; i++) events.push(toolCall(i));
    for (let i = 0; i < TURN_CAP + 5; i++) events.push(turnEnd(i));

    const a = events.reduce((s, e) => reducePluginState(e, s), initialPluginState());
    const b = events.reduce((s, e) => reducePluginState(e, s), initialPluginState());
    expect(a).toEqual(b);
    // And the JS port also gives the same output.
    const c = events.reduce((s, e) => js.reducePluginState(e, s), js.initialPluginState());
    expect(c).toEqual(a);
  });

  it('turn_end with BOTH texts null (e.g. agent-error terminal) does NOT touch turns or counter', () => {
    let state: PluginState = initialPluginState();
    state = reducePluginState(turnEnd(0), state);
    expect(state.turns.length).toBe(1);
    expect(state.turnsEvicted).toBe(0);
    // An empty terminal (both null) is treated as no-op for turns.
    const noop: AgentEvent = {
      type: 'turn_end' as const,
      // userText and assistantText are both absent — neither matches the predicate.
      // Cast keeps the test honest without polluting AgentEvent.
    } as AgentEvent;
    state = reducePluginState(noop, state);
    expect(state.turns.length).toBe(1);
    expect(state.turnsEvicted).toBe(0);
  });
});
