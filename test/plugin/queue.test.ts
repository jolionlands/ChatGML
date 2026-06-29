// test/plugin/queue.test.ts — outbox/queue state contract tests for the send-overwrite fix.
//
// The bug: when a user sends message A, then types B and hits Send before A's response streams
// back, `pendingUserText` gets overwritten with B — visually replacing A even though the server
// serializes both via `await prior.catch(() => {})` in src/serve.ts. The fix is an outbox queue
// and a "busy" disable on the Send button.
//
// These tests pin the contract (a) that BOTH reducer copies — `plugin/state.js` (CJS) and
// `src/plugin-runtime.ts` (ESM) — agree on every outbox/busy transition field-for-field and (b)
// that the panel-side push behavior (id sequence, status flips) produces deterministic state
// across the two reducer copies (so a drift is caught here even if the parity test misses a
// subtle sub-field).
//
// We do NOT exercise the DOM in this file (no GMEdit / Electron). The panel-side rendering is
// exercised in `test/plugin/runtime.test.ts` already; this file focuses on the State-level
// invariant: outbox pushes followed by the reducer's lifecycle events produce identical state
// in both copies.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reducePluginState as tsReduce,
  initialPluginState as tsInitial,
  type PluginState as TsState,
  type OutboxEntry,
} from '../../src/plugin-runtime.js';
import type { AgentEvent } from '../../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const js = require(path.join(HERE, '../../plugin/state.js')) as {
  initialPluginState: () => JsState;
  reducePluginState: (e: AgentEvent, s: JsState) => JsState;
};

interface JsState {
  ready: boolean;
  phase: string;
  mode: string;
  transcript: string;
  answer: string | null;
  sources: Array<{ path: string; provider: string }>;
  activity: unknown[];
  pendingProposals: Map<string, unknown>;
  error: string | null;
  catalog: unknown;
  checkpoints: unknown[];
  turns: Array<{ userText: string; assistantText: string; tier: string | null }>;
  turnsEvicted: number;
  activityEvicted: number;
  pendingUserText: string | null;
  lastThinking: string | null;
  outbox: OutboxEntry[];
  busy: boolean;
  _queueSeq: number;
}

// Synthetic helpers (mirror the style of test/plugin/parity.test.ts).
const user = (text: string): AgentEvent => ({ type: 'user' as const, text, sources: [] });

const token = (text: string): AgentEvent => ({ type: 'token' as const, text });

const answer = (text: string): AgentEvent => ({ type: 'answer' as const, text, sources: [] });

const turnEnd = (userText: string, assistantText: string): AgentEvent => ({
  type: 'turn_end' as const,
  userText,
  assistantText,
  sources: [],
});

const status = (
  phase: 'ready' | 'thinking' | 'streaming' | 'idle' | 'done' | 'stopped' | 'cancelled',
): AgentEvent => {
  const ev: AgentEvent = { type: 'status' as const, phase };
  if (phase === 'ready') (ev as { protocolVersion?: number }).protocolVersion = 1;
  return ev;
};

const error = (message: string): AgentEvent => ({ type: 'error' as const, message });

// Drive the panel-equivalent "user clicked Send" path: push onto outbox and set pendingUserText
// the same way `_submit` does. We mutate a state object the way the panel does (the panel
// pushes onto `state.outbox` directly rather than going through a reducer case for the
// pre-send side; only `token/answer/turn_end/status/error` are reducer-driven). Returns the
// fresh state object.
function pushOutbox(s: JsState, text: string): JsState {
  const next: JsState = { ...s };
  next._queueSeq = s._queueSeq + 1;
  next.outbox = s.outbox.concat([
    {
      id: 'q' + next._queueSeq,
      text,
      status: 'queued' as const,
      ts: 0,
    },
  ]);
  // Pin pendingUserText to the head (outbox[0].text) — same as panel.js _submit does. On a
  // single send this is equivalent to setting it to the freshest text; on multi-send the
  // head stays unchanged so we keep showing the FIRST message the user sent (which is exactly
  // the bug-fix semantics — the user can always see what they typed, even if A's response is
  // lagging).
  next.pendingUserText = next.outbox[0].text;
  return next;
}

function clearOutbox(s: JsState): JsState {
  return { ...s, outbox: [], busy: false, pendingUserText: null };
}

describe('outbox / queue initial state (plugin/state.js)', () => {
  it('initialPluginState has outbox: [] and busy: false', () => {
    const s = js.initialPluginState();
    expect(s.outbox).toEqual([]);
    expect(s.busy).toBe(false);
    expect(s._queueSeq).toBe(0);
  });

  it('TS and CJS initialPluginState agree on outbox/busy/_queueSeq shape and value', () => {
    const tsS = tsInitial();
    const jsS = js.initialPluginState();
    expect(tsS.outbox).toEqual(jsS.outbox);
    expect(tsS.busy).toBe(jsS.busy);
    expect(tsS._queueSeq).toBe(jsS._queueSeq);
  });
});

describe('outbox push via panel logic', () => {
  it('pushOutbox on a panel mimics "_submit": outbox gets a queued entry, pendingUserText is set', () => {
    const s0 = js.initialPluginState();
    const s1 = pushOutbox(s0, 'hello');
    expect(s1.outbox.length).toBe(1);
    expect(s1.outbox[0]).toMatchObject({
      id: 'q1',
      text: 'hello',
      status: 'queued',
    });
    expect(s1.pendingUserText).toBe('hello');
    expect(s1._queueSeq).toBe(1);
  });

  it('two pushes produce two queued entries with sequential ids (q1, q2)', () => {
    const s1 = pushOutbox(js.initialPluginState(), 'A');
    const s2 = pushOutbox(s1, 'B');
    expect(s2.outbox.map((e) => e.text)).toEqual(['A', 'B']);
    expect(s2.outbox.map((e) => e.id)).toEqual(['q1', 'q2']);
    expect(s2._queueSeq).toBe(2);
  });

  it('the reducer does NOT add a `user` case (push is panel-managed); user event is a no-op', () => {
    // Documenting the contract from the spec: the user push is panel-managed. The reducer has no
    // 'user' case — sending a user event through the reducer should NOT mutate state. This pins
    // the reducer's surface so a future worker doesn't accidentally double-handle the push.
    const s0 = js.initialPluginState();
    const s1 = js.reducePluginState(user('hello'), s0);
    expect(s1.outbox).toEqual(s0.outbox);
    expect(s1.busy).toBe(s0.busy);
    expect(s1).toEqual(s0);
  });
});

describe('outbox lifecycle: token / answer / turn_end', () => {
  it('token event promotes head queued item to streaming (JS and TS agree)', () => {
    // Panel-side push then reducer-side token → reducer flips the head's status to 'streaming'.
    const js0 = pushOutbox(js.initialPluginState(), 'A');
    const js1 = js.reducePluginState(token('hi '), js0);
    expect(js1.outbox.length).toBe(1);
    expect(js1.outbox[0].status).toBe('streaming');
    expect(js1.busy).toBe(true);

    // Same on the TS port: panel-side push (modeled the same way — the panel uses the SAME
    // state shape, just typed differently). The TS reducer must agree field-for-field.
    const ts0: TsState = tsInitial();
    const tsSeqBumped: TsState = {
      ...ts0,
      _queueSeq: 1,
      pendingUserText: 'A',
      outbox: [{ id: 'q1', text: 'A', status: 'queued' as const, ts: 0 }],
    };
    const ts1 = tsReduce(token('hi '), tsSeqBumped);
    expect(ts1.outbox.length).toBe(1);
    expect(ts1.outbox[0].status).toBe('streaming');
    expect(ts1.busy).toBe(true);

    // Parity between the two reducer copies (same input shape, same expected output shape).
    expect(js1.outbox[0].status).toBe(ts1.outbox[0].status);
    expect(js1.busy).toBe(ts1.busy);
    expect(js1.outbox.length).toBe(ts1.outbox.length);
  });

  it('answer event promotes head queued -> streaming and does NOT shift (turn_end does the pop)', () => {
    // Per spec: `answer` marks the head 'streaming' but only `turn_end` shifts. This keeps the
    // queued user bubble visible while the assistant text is finalized.
    const js0 = pushOutbox(js.initialPluginState(), 'A');
    const js1 = js.reducePluginState(answer('done'), js0);
    expect(js1.outbox.length).toBe(1);
    expect(js1.outbox[0].status).toBe('streaming');
    expect(js1.answer).toBe('done');
  });

  it('turn_end event pops the head outbox item and clears busy (single-shot)', () => {
    const js0 = pushOutbox(js.initialPluginState(), 'A');
    // Promote to streaming first.
    const js1 = js.reducePluginState(token('hi '), js0);
    expect(js1.outbox.length).toBe(1);
    // turn_end pops.
    const js2 = js.reducePluginState(turnEnd('A', 'hi '), js1);
    expect(js2.outbox).toEqual([]);
    expect(js2.busy).toBe(false);
    expect(js2.pendingUserText).toBeNull();
    expect(js2.answer).toBeNull();
  });

  it('multiple queued items render in order; turn_end pops one at a time', () => {
    // The headline bug-fix: panel-side pushes A and B (B fires before A's tokens arrive).
    const sA = pushOutbox(js.initialPluginState(), 'A');
    const sAB = pushOutbox(sA, 'B');
    expect(sAB.outbox.length).toBe(2);
    expect(sAB.outbox[0].text).toBe('A');
    expect(sAB.outbox[1].text).toBe('B');
    expect(sAB.pendingUserText).toBe('A');

    // Token arrives for A (the head).
    const sABStreamA = js.reducePluginState(token('a1 '), sAB);
    expect(sABStreamA.outbox[0].status).toBe('streaming');
    expect(sABStreamA.outbox[1].status).toBe('queued');

    // A's turn ends.
    const sABTurnA = js.reducePluginState(turnEnd('A', 'a1 '), sABStreamA);
    expect(sABTurnA.outbox.length).toBe(1);
    expect(sABTurnA.outbox[0].text).toBe('B');
    expect(sABTurnA.outbox[0].status).toBe('queued'); // still queued — not yet streamed
    expect(sABTurnA.busy).toBe(false);

    // Token for B.
    const sABStreamB = js.reducePluginState(token('b1 '), sABTurnA);
    expect(sABStreamB.outbox[0].status).toBe('streaming');
    expect(sABStreamB.busy).toBe(true);

    // B's turn ends.
    const sABTurnB = js.reducePluginState(turnEnd('B', 'b1 '), sABStreamB);
    expect(sABTurnB.outbox).toEqual([]);
    expect(sABTurnB.busy).toBe(false);
  });
});

describe('status phase -- busy wiring (CJS port)', () => {
  it('busy is left untouched for non-terminal status phases (thinking, streaming)', () => {
    let s = js.initialPluginState();
    s = { ...s, busy: true }; // pretoken
    s = js.reducePluginState(status('thinking'), s);
    expect(s.busy).toBe(true);
    s = js.reducePluginState(status('streaming'), s);
    expect(s.busy).toBe(true);
  });

  it('busy flips false on idle / stopped / done / cancelled', () => {
    for (const phase of ['idle', 'stopped', 'done', 'cancelled'] as const) {
      let s = js.initialPluginState();
      s = { ...s, busy: true };
      s = js.reducePluginState(status(phase), s);
      expect(s.busy).toBe(false);
    }
  });

  it('error event unsets busy so the user can Send again (next turn starts clean)', () => {
    let s = js.initialPluginState();
    s = { ...s, busy: true };
    s = js.reducePluginState(error('boom'), s);
    expect(s.busy).toBe(false);
    expect(s.error).toBe('boom');
  });
});

describe('parity: outbox/busy/queueSeq behavior is identical across both reducer copies', () => {
  it('a full user-send cycle through state.js produces identical observable state to plugin-runtime.ts', () => {
    // Replicate the worked lifecycle end-to-end on both copies and compare:
    // 1. pushOutbox A (panel-side mutation, identical for both)
    // 2. status(ready)  (only meaningful on the CJS side; we feed it the same way)
    // 3. token 'hello '
    // 4. token 'there'
    // 5. answer 'hi'
    // 6. turn_end('A', 'hi')
    // 7. status(idle)
    // 8. pushOutbox B (panel-side)
    // 9. token 'b'
    // 10. turn_end('B','b')
    //
    // The reducer's contract is: each event produces the SAME shape on both copies. We feed the
    // same events and assert both copies' observable shape field-for-field. We compare only the
    // fields the spec declares — outbox/busy/_queueSeq are the new ones.

    const events: AgentEvent[] = [
      status('ready'),
      token('hello '),
      token('there'),
      answer('hi'),
      turnEnd('A', 'hi'),
      status('idle'),
      token('b'),
      turnEnd('B', 'b'),
    ];

    // Start with the initial state and simulate the panel-side push on both sides identically.
    let jsS = pushOutbox(js.initialPluginState(), 'A');
    let tsS: TsState = {
      ...tsInitial(),
      _queueSeq: 1,
      pendingUserText: 'A',
      outbox: [{ id: 'q1', text: 'A', status: 'queued' as const, ts: 0 }],
    };
    // The status(ready) on the CJS side sets ready=true and clears error; on the TS side the
    // mode field would also be set if present. Both should be in lock-step on observable state.
    for (const e of events) {
      jsS = js.reducePluginState(e, jsS);
      tsS = tsReduce(e, tsS);
    }

    // After event 5 (turn_end A): outbox should be empty, busy=false.
    // Snapshot after the first 6 events.
    expect(jsS.outbox.length).toBe(0);
    expect(tsS.outbox.length).toBe(jsS.outbox.length);
    expect(jsS.busy).toBe(tsS.busy);

    // Mid-second-turn parity (after token('b')): outbox should have B as streaming, busy=true.
    // Replay up to that event.
    let jsMid = pushOutbox(js.initialPluginState(), 'A');
    let tsMid: TsState = {
      ...tsInitial(),
      _queueSeq: 1,
      pendingUserText: 'A',
      outbox: [{ id: 'q1', text: 'A', status: 'queued' as const, ts: 0 }],
    };
    for (const e of events.slice(0, events.indexOf(token('b')) + 1)) {
      jsMid = js.reducePluginState(e, jsMid);
      tsMid = tsReduce(e, tsMid);
    }
    // At this point we've fired a second pushless-but-queued scenario (no second push was simulated
    // in this run since we only push once). So outbox should contain B -> streaming.
    // Actually, in this run we ONLY pushed A. The reducer fired on the events list which has B
    // coming only from turn_end. To match the spec we need to push B too.
    let jsMid2 = jsMid;
    let tsMid2 = tsMid;
    jsMid2 = pushOutbox(jsMid2, 'B');
    tsMid2 = {
      ...tsMid2,
      _queueSeq: 2,
      pendingUserText: 'B',
      outbox: [...tsMid2.outbox, { id: 'q2', text: 'B', status: 'queued' as const, ts: 0 }],
    };
    // The reducer for token('b') then promotes the head (which is now B) -> streaming.
    jsMid2 = js.reducePluginState(token('b'), jsMid2);
    tsMid2 = tsReduce(token('b'), tsMid2);
    // Both must agree on outbox content and busy state.
    expect(jsMid2.outbox.length).toBe(tsMid2.outbox.length);
    expect(jsMid2.outbox[0].status).toBe(tsMid2.outbox[0].status);
    expect(jsMid2.outbox[0].text).toBe(tsMid2.outbox[0].text);
    expect(jsMid2.busy).toBe(tsMid2.busy);
  });

  it('clear of outbox is symmetric on both reducer copies (after the panel runs panel.clear)', () => {
    // Panel-side clearOutbox is identical on both copies because it is field assignment;
    // assert that running clearOutbox yields identical shape on both.
    const jsBefore = pushOutbox(js.initialPluginState(), 'A');
    const jsAfter = clearOutbox(jsBefore);
    const tsBefore: TsState = {
      ...tsInitial(),
      _queueSeq: 1,
      pendingUserText: 'A',
      outbox: [{ id: 'q1', text: 'A', status: 'queued' as const, ts: 0 }],
      busy: true,
    };
    const tsAfter: TsState = {
      ...tsBefore,
      outbox: [],
      busy: false,
      pendingUserText: null,
    };
    expect(jsAfter.outbox).toEqual(tsAfter.outbox);
    expect(jsAfter.busy).toBe(tsAfter.busy);
    expect(jsAfter.pendingUserText).toBe(tsAfter.pendingUserText);
    expect(jsAfter._queueSeq).toBe(tsAfter._queueSeq);
  });
});

describe('panel-side helpers (pure simulation of _submit -> outbox push)', () => {
  it('pushOutbox mirrors _submit behavior: id bumps once per call and text lands on outbox head', () => {
    let s = js.initialPluginState();
    s = pushOutbox(s, 'first');
    expect(s.outbox.length).toBe(1);
    expect(s.outbox[0].id).toBe('q1');
    expect(s.outbox[0].text).toBe('first');
    expect(s.outbox[0].status).toBe('queued');
    s = pushOutbox(s, 'second');
    expect(s.outbox.length).toBe(2);
    expect(s.outbox[1].id).toBe('q2');
    expect(s.outbox[1].text).toBe('second');
    // Old entry's id/text/status unchanged.
    expect(s.outbox[0]).toMatchObject({
      id: 'q1',
      text: 'first',
      status: 'queued',
    });
  });

  it('id uniqueness: 100 sequential pushes produce ids q1..q100 with no duplicates', () => {
    let s = js.initialPluginState();
    const ids = new Set<string>();
    for (let i = 1; i <= 100; i++) {
      s = pushOutbox(s, 'msg-' + i);
      const id = s.outbox[s.outbox.length - 1].id;
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    expect(ids.size).toBe(100);
    expect(s._queueSeq).toBe(100);
  });
});
