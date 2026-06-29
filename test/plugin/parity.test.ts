// test/plugin/parity.test.ts — proves plugin/state.js (CommonJS port) behaves identically to
// src/plugin-runtime.ts (the ESM source of truth). Cross-module-system import of the ESM core into
// the CJS plugin is blocked (ERR_REQUIRE_ESM), so the plugin carries a COPY — this test is the guard
// that the copy can never drift in observable behavior.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from '../../src/plugin-runtime.js';
import type { AgentEvent } from '../../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const js = require(path.join(HERE, '../../plugin/state.js')) as typeof ts;

describe('plugin/state.js <-> src/plugin-runtime.ts parity', () => {
  it('NdjsonLineBuffer: identical decode of a chunked stream incl malformed', () => {
    const chunks = ['{"a":1}\n{"b', '":2}\nnot json\n', '{"c":3}'];
    const tsBuf = new ts.NdjsonLineBuffer();
    const jsBuf = new js.NdjsonLineBuffer();
    for (const c of chunks) {
      expect(jsBuf.push(c)).toEqual(tsBuf.push(c));
    }
    expect(jsBuf.flush()).toEqual(tsBuf.flush());
  });

  it('NdjsonLineBuffer: streaming UTF-8 — a multibyte codepoint split across byte chunks is not corrupted', () => {
    // '€' = UTF-8 0xE2 0x82 0xAC. Split those 3 bytes across two stdout chunks (mid-codepoint).
    // Before the persistent-decoder fix this corrupted the euro into replacement chars (U+FFFD).
    const line = '{"type":"token","text":"€"}\n';
    const bytes = new TextEncoder().encode(line);
    const splitAt = new TextEncoder().encode(line.slice(0, line.indexOf('€'))).length + 1; // after 1st euro byte
    const a = bytes.slice(0, splitAt);
    const b = bytes.slice(splitAt);

    const tsBuf = new ts.NdjsonLineBuffer();
    const jsBuf = new js.NdjsonLineBuffer();
    const tsOut = [...tsBuf.push(a).events, ...tsBuf.push(b).events];
    const jsOut = [...jsBuf.push(a).events, ...jsBuf.push(b).events];

    expect(tsOut).toEqual([{ type: 'token', text: '€' }]);
    expect(jsOut).toEqual(tsOut);
  });

  it('isReadyHandshake: identical truth table', () => {
    const cases: unknown[] = [
      { type: 'status', phase: 'ready', protocolVersion: 1 },
      { type: 'status', phase: 'ready' },
      { type: 'token', text: 'x' },
      null,
      'ready',
    ];
    for (const c of cases) {
      expect(js.isReadyHandshake(c)).toBe(ts.isReadyHandshake(c));
    }
  });

  it('buildServeArgv: identical argv', () => {
    const opts = {
      dir: '/p',
      chat: { baseURL: 'http://c', model: 'm' },
      embed: { baseURL: 'http://e', model: 'e' },
      scope: 'game',
      approval: 'gated' as const,
      trustProjectConfig: true,
    };
    expect(js.buildServeArgv(opts)).toEqual(ts.buildServeArgv(opts));
    expect(js.buildServeArgv({ dir: '/q' })).toEqual(ts.buildServeArgv({ dir: '/q' }));
  });

  it('resolveServeBinary: identical resolution across the ladder', () => {
    const common = {
      distCliPath: '/repo/dist/cli.js',
      nodePath: '/usr/bin/node',
    };
    const scenarios = [
      {
        ...common,
        configuredPath: '/opt/x',
        env: {},
        platform: 'linux' as const,
        exists: () => true,
      },
      {
        ...common,
        env: { CHATGML_BIN: '/b/chatgml' },
        platform: 'linux' as const,
        exists: () => true,
      },
      {
        ...common,
        env: { APPDATA: 'C:\\R' },
        platform: 'win32' as const,
        exists: (p: string) => p === 'C:\\R\\npm\\chatgml.cmd',
      },
      {
        ...common,
        env: {},
        platform: 'linux' as const,
        exists: (p: string) => p === common.distCliPath,
      },
    ];
    for (const s of scenarios) {
      expect(js.resolveServeBinary(s)).toEqual(ts.resolveServeBinary(s));
    }
    // both throw when nothing resolves
    const none = { ...common, env: {}, platform: 'linux' as const, exists: () => false };
    expect(() => js.resolveServeBinary(none)).toThrow();
    expect(() => ts.resolveServeBinary(none)).toThrow();
  });

  it('reducePluginState: identical state after replaying the worked transcript', () => {
    const events: AgentEvent[] = [
      { type: 'status', phase: 'ready', protocolVersion: 1 },
      { type: 'status', phase: 'thinking' },
      { type: 'tool_call', id: 't1', name: 'glob', args: { pattern: '**/*.gml' } },
      { type: 'tool_result', id: 't1', name: 'glob', ok: true, content: '3 files' },
      { type: 'mcp_tool_call', id: 'm1', name: 'list_files', server: 'fs' },
      {
        type: 'mcp_tool_result',
        id: 'm1',
        name: 'list_files',
        server: 'fs',
        ok: true,
        content: 'a.gml',
      },
      {
        type: 'mcp_resource',
        id: 'mr1',
        server: 'fetch',
        name: 'https://example.com',
        content: 'hello',
      },
      { type: 'token', text: 'Hi ' },
      { type: 'token', text: 'there' },
      { type: 'edit_proposal', id: 'e1', path: 'a.gml', diff: 'DIFF' },
      { type: 'approval_request', id: 'e1', kind: 'edit', path: 'a.gml' },
      { type: 'answer', text: 'done', sources: [{ path: 'a.gml', provider: 'local' }] },
      { type: 'checkpoint', id: 'cp1', path: 'a.gml', label: 'before edit' },
      { type: 'error', message: 'late error', code: 'x' },
    ];
    let tsState = ts.initialPluginState();
    let jsState = js.initialPluginState();
    for (const e of events) {
      tsState = ts.reducePluginState(e as AgentEvent, tsState);
      jsState = js.reducePluginState(e as AgentEvent, jsState);
    }
    // Compare the observable fields (Map compared via entries).
    expect(jsState.ready).toBe(tsState.ready);
    expect(jsState.phase).toBe(tsState.phase);
    expect(jsState.mode).toBe(tsState.mode);
    expect(jsState.transcript).toBe(tsState.transcript);
    expect(jsState.answer).toBe(tsState.answer);
    expect(jsState.sources).toEqual(tsState.sources);
    expect(jsState.activity).toEqual(tsState.activity);
    expect(jsState.error).toBe(tsState.error);
    expect([...jsState.pendingProposals.entries()]).toEqual([
      ...tsState.pendingProposals.entries(),
    ]);
    expect(jsState.checkpoints).toEqual(tsState.checkpoints);
    // Cap-eviction counters (audit gap #21) must agree field-for-field on both copies.
    expect(jsState.turnsEvicted).toBe(tsState.turnsEvicted);
    expect(jsState.activityEvicted).toBe(tsState.activityEvicted);
  });

  it('reducePluginState: turn_cap + activity_cap apply identically on both copies (over-cap stress)', () => {
    // Generate TURN_CAP + 50 turn_ends and ACTIVITY_CAP + 50 tool_calls; both copies must agree on
    // the resulting `turns`/`activity` length, the *content* (latest items retained), and the
    // cumulative evicted counters.
    const events: AgentEvent[] = [];
    const turnCount = ts.TURN_CAP + 50;
    const activityCount = ts.ACTIVITY_CAP + 50;
    for (let i = 0; i < activityCount; i++) {
      events.push({ type: 'tool_call', id: 'a' + i, name: 'tool_' + i, args: {} });
    }
    for (let i = 0; i < turnCount; i++) {
      events.push({
        type: 'turn_end',
        userText: 'q' + i,
        assistantText: 'a' + i,
        sources: [],
      });
    }
    let tsState = ts.initialPluginState();
    let jsState = js.initialPluginState();
    for (const e of events) {
      tsState = ts.reducePluginState(e as AgentEvent, tsState);
      jsState = js.reducePluginState(e as AgentEvent, jsState);
    }
    // Both must cap at exactly the configured size with the most-recent 200/500 retained.
    expect(tsState.turns.length).toBe(ts.TURN_CAP);
    expect(jsState.turns.length).toBe(ts.TURN_CAP);
    expect(tsState.activity.length).toBe(ts.ACTIVITY_CAP);
    expect(jsState.activity.length).toBe(ts.ACTIVITY_CAP);
    // Identical content (FIFO drop from the front) on both copies.
    expect(jsState.turns).toEqual(tsState.turns);
    expect(jsState.activity.map((a) => a.id)).toEqual(tsState.activity.map((a) => a.id));
    // Identical evicted totals.
    expect(jsState.turnsEvicted).toBe(tsState.turnsEvicted);
    expect(jsState.activityEvicted).toBe(tsState.activityEvicted);
    expect(tsState.turnsEvicted).toBe(turnCount - ts.TURN_CAP);
    expect(tsState.activityEvicted).toBe(activityCount - ts.ACTIVITY_CAP);
  });

  it('reducePluginState: command lifecycle is identical on both copies', () => {
    const events: AgentEvent[] = [
      { type: 'command_request', id: 'c1', command: 'echo hi', cwd: '/proj' },
      { type: 'command_output', id: 'c1', stream: 'stdout', text: 'hi\n' },
      { type: 'command_exit', id: 'c1', code: 0 },
      { type: 'command_request', id: 'c2', command: 'false' },
      { type: 'command_exit', id: 'c2', code: 1 },
    ];
    let tsState = ts.initialPluginState();
    let jsState = js.initialPluginState();
    for (const e of events) {
      tsState = ts.reducePluginState(e, tsState);
      jsState = js.reducePluginState(e, jsState);
    }
    expect(jsState.activity).toEqual(tsState.activity);
  });

  it('matchApproval + settleProposal: identical behavior', () => {
    const proposals = new Map([['e1', { id: 'e1', path: 'a', diff: 'd' }]]);
    expect(js.matchApproval({ id: 'e1', kind: 'edit', path: 'a' }, proposals)).toEqual(
      ts.matchApproval({ id: 'e1', kind: 'edit', path: 'a' }, proposals),
    );
    let tsState = ts.reducePluginState(
      { type: 'edit_proposal', id: 'e1', path: 'a', diff: 'd' },
      ts.initialPluginState(),
    );
    let jsState = js.reducePluginState(
      { type: 'edit_proposal', id: 'e1', path: 'a', diff: 'd' },
      js.initialPluginState(),
    );
    tsState = ts.settleProposal('e1', tsState);
    jsState = js.settleProposal('e1', jsState);
    expect(jsState.pendingProposals.has('e1')).toBe(tsState.pendingProposals.has('e1'));
  });

  it('reducePluginState: status handshake mode is stored identically on both copies', () => {
    const ev = {
      type: 'status' as const,
      phase: 'ready' as const,
      protocolVersion: 1,
      mode: 'architect' as const,
    };
    const tsState = ts.reducePluginState(ev, ts.initialPluginState());
    const jsState = js.reducePluginState(ev, js.initialPluginState());
    expect(tsState.mode).toBe('architect');
    expect(jsState.mode).toBe(tsState.mode);
  });

  it('reducePluginState: turn_end is a no-op side signal on both copies', () => {
    const ev = {
      type: 'turn_end' as const,
      userText: 'hi',
      assistantText: 'hello',
      sources: [],
    };
    let tsState = ts.initialPluginState();
    let jsState = js.initialPluginState();
    tsState = ts.reducePluginState(ev, tsState);
    jsState = js.reducePluginState(ev, jsState);
    expect(jsState).toEqual(tsState);
    // it must NOT have surfaced as an answer
    expect(jsState.answer).toBeNull();
  });

  it('reducePluginState: turn_end with tier stamps the per-turn tier on both copies (parity: audit gap #22)', () => {
    // The Cline-style tier UI needs turn_end.tier to land on the stored turn record so the panel
    // can render the per-bubble badge. Both reducer copies MUST agree on the stored value field-
    // for-field (additive — does not change the existing assertions above).
    const cases: Array<{ tier: unknown; expected: 'planner' | 'implementer' | 'reviewer' | null }> =
      [
        { tier: 'planner', expected: 'planner' },
        { tier: 'implementer', expected: 'implementer' },
        { tier: 'reviewer', expected: 'reviewer' },
        { tier: null, expected: null },
        { tier: undefined, expected: null },
        { tier: 'bogus', expected: null }, // defensive normalization
      ];
    for (const c of cases) {
      const ev = {
        type: 'turn_end' as const,
        userText: 'q',
        assistantText: 'a',
        sources: [],
        // Cast to silence the TS union: we're testing the reducer's defensive normalization
        // across values the schema would already have rejected.
        tier: c.tier as 'planner' | 'implementer' | 'reviewer' | null | undefined,
      };
      const tsState = ts.reducePluginState(ev, ts.initialPluginState());
      const jsState = js.reducePluginState(ev, js.initialPluginState());
      // The latest turn record (index 0; the reducer appends) must carry the normalized tier.
      expect(jsState.turns.length).toBe(tsState.turns.length);
      expect(jsState.turns[0]?.tier ?? null).toBe(c.expected);
      expect(tsState.turns[0]?.tier ?? null).toBe(c.expected);
      // Both copies must agree field-for-field on the new tier stamp.
      expect(jsState.turns[0]?.tier).toBe(tsState.turns[0]?.tier);
    }
  });

  it('parseSlashCommand: /tier is parsed identically on both copies (parity: audit gap #22)', () => {
    // The new /tier slash command is dispatched by both the CJS plugin and the ESM runtime's
    // copy of parseSlashCommand. Their outputs MUST agree on the four cases (one canonical name
    // per tier + the "off" sentinel) so the panel and the test runtime see the same shape.
    const cases = [
      '/tier',
      '/tier planner',
      '/tier implementer',
      '/tier reviewer',
      '/tier off',
      '/tier nonsense',
    ];
    for (const c of cases) {
      expect(js.parseSlashCommand(c)).toEqual(ts.parseSlashCommand(c));
    }
  });

  it('reducePluginState: tool_catalog is stored identically on both copies', () => {
    const tools = [{ name: 'read_file', description: 'Read a file', kind: 'read' as const }];
    const ev = { type: 'tool_catalog' as const, tools };
    const tsState = ts.reducePluginState(ev, ts.initialPluginState());
    const jsState = js.reducePluginState(ev, js.initialPluginState());
    expect(tsState.catalog).toEqual(tools);
    expect(jsState.catalog).toEqual(tsState.catalog);
  });

  it('parseSlashCommand: identical parse across the forms', () => {
    const cases = [
      'hello world', // not a slash
      '',
      '   ',
      '/clear',
      '/reindex',
      '/resume',
      '/help',
      '/?',
      '/scope mygame',
      '/scope',
      '/model qwen2.5-coder',
      '/model',
      '/approval gated',
      '/approval auto',
      '/approval nope',
      '/mode architect',
      '/mode code',
      '/mode ask',
      '/mode debug',
      '/mode flying',
      '/mode',
      '/mcp',
      '/foo bar',
      '/  ',
      '/undo',
      '/undo abc123',
      '/new feature-ui',
      '/new',
      '/tasks',
      '/switch feature-ui',
      '/switch',
      '/delete-task old',
      '/delete-task',
    ];
    for (const c of cases) {
      expect(js.parseSlashCommand(c)).toEqual(ts.parseSlashCommand(c));
    }
  });

  it('SLASH_HELP is identical and stable', () => {
    expect(js.SLASH_HELP).toEqual([...ts.SLASH_HELP]);
  });

  it('buildEditorContext: identical — drops empties, undefined when nothing useful', () => {
    const cases = [
      {},
      { openFile: '' },
      { openFile: '  ', selection: '  ' },
      { openFile: 'objects/obj_player/Step_0.gml' },
      { openFile: 'a.gml', cursorLine: 0 },
      { openFile: 'a.gml', cursorLine: 3 },
      { openFile: 'a.gml', selection: '', cursorLine: 5 },
      { selection: 'hp -= 1;' },
      { cursorLine: 7 },
      { openFile: 'a.gml', selection: 'x', cursorLine: 2 },
    ];
    for (const c of cases) {
      expect(js.buildEditorContext(c)).toEqual(ts.buildEditorContext(c));
    }
  });

  it('turnEndToMessages + buildResumeCommand: identical flattening of persisted turns', () => {
    const turns = [
      { userText: 'q1', assistantText: 'a1' },
      { userText: '   ', assistantText: 'a2' }, // empty user -> skipped
      { userText: 'q3', assistantText: '' }, // empty assistant -> null
      { userText: 'q4', assistantText: 'a4' },
    ];
    expect(js.turnEndToMessages(turns)).toEqual(ts.turnEndToMessages(turns));
    expect(js.buildResumeCommand(turns)).toEqual(ts.buildResumeCommand(turns));
    expect(ts.buildResumeCommand(turns)).toEqual({
      type: 'resume',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q3' },
        { role: 'assistant', content: null },
        { role: 'user', content: 'q4' },
        { role: 'assistant', content: 'a4' },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Streaming UX: pendingUserText + token->answer accumulation.
// These tests pin behavior so the streaming bubble renders mid-turn AND the
// user's bubble can appear the moment a turn starts. Both reducers (TS + JS)
// must agree.
// ---------------------------------------------------------------------------
describe('streaming UX (pendingUserText + token->answer)', () => {
  it('initialPluginState: pendingUserText starts as null on both copies', () => {
    expect(js.initialPluginState().pendingUserText).toBeNull();
    expect(ts.initialPluginState().pendingUserText).toBeNull();
    // The two copies must agree on every key, including the new one.
    expect(Object.keys(js.initialPluginState()).sort()).toEqual(
      Object.keys(ts.initialPluginState()).sort(),
    );
  });

  it('token event accumulates to BOTH transcript and answer (so the streaming bubble updates live)', () => {
    const ev = { type: 'token' as const, text: 'hello ' };
    const tsState = ts.reducePluginState(ev, ts.initialPluginState());
    const jsState = js.reducePluginState(ev, js.initialPluginState());
    // Before this fix `token` only touched `transcript`; `answer` was left null until the terminal
    // `answer` event, which made the streaming bubble appear blank during a turn.
    expect(tsState.transcript).toBe('hello ');
    expect(tsState.answer).toBe('hello ');
    expect(jsState.transcript).toBe('hello ');
    expect(jsState.answer).toBe('hello ');
    expect(jsState).toEqual(tsState);
  });

  it('multiple token events accumulate sequentially to answer (no overwrite)', () => {
    const events: AgentEvent[] = [
      { type: 'token', text: 'Hi ' },
      { type: 'token', text: 'there ' },
      { type: 'token', text: 'friend' },
    ];
    let tsState = ts.initialPluginState();
    let jsState = js.initialPluginState();
    for (const e of events) {
      tsState = ts.reducePluginState(e, tsState);
      jsState = js.reducePluginState(e, jsState);
    }
    expect(tsState.transcript).toBe('Hi there friend');
    expect(tsState.answer).toBe('Hi there friend');
    expect(jsState.transcript).toBe('Hi there friend');
    expect(jsState.answer).toBe('Hi there friend');
    expect(jsState).toEqual(tsState);
  });

  it('turn_end clears pendingUserText AND answer (the next user turn starts clean)', () => {
    // Pretend the client set pendingUserText mid-turn (typing -> sent) and streaming has accumulated.
    let tsState = ts.reducePluginState({ type: 'token', text: 'a' }, ts.initialPluginState());
    tsState = { ...tsState, pendingUserText: 'user said hi' };
    let jsState = js.reducePluginState({ type: 'token', text: 'a' }, js.initialPluginState());
    jsState = { ...jsState, pendingUserText: 'user said hi' };

    const ev: AgentEvent = {
      type: 'turn_end',
      userText: 'user said hi',
      assistantText: 'a',
      sources: [],
    };
    tsState = ts.reducePluginState(ev, tsState);
    jsState = js.reducePluginState(ev, jsState);
    expect(tsState.answer).toBeNull();
    expect(tsState.pendingUserText).toBeNull();
    expect(jsState.answer).toBeNull();
    expect(jsState.pendingUserText).toBeNull();
    expect(jsState).toEqual(tsState);
  });

  it('answer event replaces the accumulated streaming answer (terminal text wins)', () => {
    // Build up some streamed tokens, then the terminal `answer` arrives.
    const events: AgentEvent[] = [
      { type: 'token', text: 'draft ' },
      { type: 'token', text: 'one' },
      { type: 'answer', text: 'final answer', sources: [{ path: 'a.gml', provider: 'local' }] },
    ];
    let tsState = ts.initialPluginState();
    let jsState = js.initialPluginState();
    for (const e of events) {
      tsState = ts.reducePluginState(e, tsState);
      jsState = js.reducePluginState(e, jsState);
    }
    // The terminal answer REPLACES the streamed draft — it does not concatenate.
    expect(tsState.answer).toBe('final answer');
    expect(jsState.answer).toBe('final answer');
    // transcript still carries the streamed accumulation (kept for diagnostics).
    expect(tsState.transcript).toBe('draft one');
    expect(jsState.transcript).toBe('draft one');
    // Sources come from the answer event.
    expect(tsState.sources).toEqual([{ path: 'a.gml', provider: 'local' }]);
    expect(jsState.sources).toEqual(tsState.sources);
    expect(jsState).toEqual(tsState);
  });

  it('other events carry pendingUserText through unchanged (it only mutates on turn_end)', () => {
    // Cast through PluginState so the literal `'pending'` does not narrow the field type.
    let tsState: ts.PluginState = { ...ts.initialPluginState(), pendingUserText: 'pending' };
    // The CJS port uses plain objects with the same shape; keep parity via the same cast pattern.
    type JsState = ReturnType<typeof js.initialPluginState>;
    let jsState: JsState = { ...js.initialPluginState(), pendingUserText: 'pending' };
    const events: AgentEvent[] = [
      { type: 'status', phase: 'thinking' },
      { type: 'token', text: 'x' },
      { type: 'answer', text: 'y', sources: [] },
    ];
    for (const e of events) {
      tsState = ts.reducePluginState(e, tsState);
      jsState = js.reducePluginState(e, jsState);
      expect(tsState.pendingUserText).toBe('pending');
      expect(jsState.pendingUserText).toBe('pending');
    }
    expect(jsState).toEqual(tsState);
  });
});
