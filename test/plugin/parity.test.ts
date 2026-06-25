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
      { ...common, configuredPath: '/opt/x', env: {}, platform: 'linux' as const, exists: () => true },
      { ...common, env: { CHATGML_BIN: '/b/chatgml' }, platform: 'linux' as const, exists: () => true },
      {
        ...common,
        env: { APPDATA: 'C:\\R' },
        platform: 'win32' as const,
        exists: (p: string) => p === 'C:\\R\\npm\\chatgml.cmd',
      },
      { ...common, env: {}, platform: 'linux' as const, exists: (p: string) => p === common.distCliPath },
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
      { type: 'token', text: 'Hi ' },
      { type: 'token', text: 'there' },
      { type: 'edit_proposal', id: 'e1', path: 'a.gml', diff: 'DIFF' },
      { type: 'approval_request', id: 'e1', kind: 'edit', path: 'a.gml' },
      { type: 'answer', text: 'done', sources: [{ path: 'a.gml', provider: 'local' }] },
      { type: 'error', message: 'late error', code: 'x' },
    ];
    let tsState = ts.initialPluginState();
    let jsState = js.initialPluginState();
    for (const e of events) {
      tsState = ts.reducePluginState(e, tsState);
      jsState = js.reducePluginState(e, jsState);
    }
    // Compare the observable fields (Map compared via entries).
    expect(jsState.ready).toBe(tsState.ready);
    expect(jsState.phase).toBe(tsState.phase);
    expect(jsState.transcript).toBe(tsState.transcript);
    expect(jsState.answer).toBe(tsState.answer);
    expect(jsState.sources).toEqual(tsState.sources);
    expect(jsState.activity).toEqual(tsState.activity);
    expect(jsState.error).toBe(tsState.error);
    expect([...jsState.pendingProposals.entries()]).toEqual([...tsState.pendingProposals.entries()]);
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
});
