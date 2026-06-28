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
