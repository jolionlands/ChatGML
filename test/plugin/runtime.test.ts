// test/plugin/runtime.test.ts — unit tests for the pure plugin-runtime logic (the source of truth
// the GMEdit plugin copies). DOM-free, deterministic, no spawn.
import { describe, it, expect } from 'vitest';
import {
  NdjsonLineBuffer,
  isReadyHandshake,
  buildServeArgv,
  resolveServeBinary,
  reducePluginState,
  initialPluginState,
  settleProposal,
  matchApproval,
  type PluginState,
} from '../../src/plugin-runtime.js';
import type { AgentEvent } from '../../src/types.js';

describe('NdjsonLineBuffer', () => {
  it('decodes multiple complete lines in one chunk', () => {
    const buf = new NdjsonLineBuffer();
    const r = buf.push('{"a":1}\n{"b":2}\n');
    expect(r.events).toEqual([{ a: 1 }, { b: 2 }]);
    expect(r.malformed).toEqual([]);
  });

  it('buffers a trailing partial line across pushes (a JSON object split over two chunks)', () => {
    const buf = new NdjsonLineBuffer();
    const r1 = buf.push('{"type":"sta');
    expect(r1.events).toEqual([]);
    const r2 = buf.push('tus","phase":"ready"}\n');
    expect(r2.events).toEqual([{ type: 'status', phase: 'ready' }]);
  });

  it('reassembles a single object split across THREE chunks', () => {
    const buf = new NdjsonLineBuffer();
    expect(buf.push('{"x":').events).toEqual([]);
    expect(buf.push('"hel').events).toEqual([]);
    const r = buf.push('lo"}\n');
    expect(r.events).toEqual([{ x: 'hello' }]);
  });

  it('skips blank lines and strips a trailing \\r (CRLF framing)', () => {
    const buf = new NdjsonLineBuffer();
    const r = buf.push('{"a":1}\r\n\r\n{"b":2}\r\n');
    expect(r.events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('reports a malformed complete line WITHOUT throwing, and keeps decoding following lines', () => {
    const buf = new NdjsonLineBuffer();
    const r = buf.push('not json\n{"ok":true}\n');
    expect(r.malformed).toEqual(['not json']);
    expect(r.events).toEqual([{ ok: true }]);
  });

  it('decodes Buffer/Uint8Array chunks (raw stdout bytes)', () => {
    const buf = new NdjsonLineBuffer();
    const r = buf.push(Buffer.from('{"n":7}\n', 'utf8'));
    expect(r.events).toEqual([{ n: 7 }]);
  });

  it('flush() returns a trailing line that lacked a newline', () => {
    const buf = new NdjsonLineBuffer();
    buf.push('{"partial":1}'); // no newline
    expect(buf.flush().events).toEqual([{ partial: 1 }]);
  });

  it('flush() reports a malformed trailing line rather than throwing', () => {
    const buf = new NdjsonLineBuffer();
    buf.push('garbage-no-newline');
    const r = buf.flush();
    expect(r.events).toEqual([]);
    expect(r.malformed).toEqual(['garbage-no-newline']);
  });
});

describe('isReadyHandshake', () => {
  it('is true for the exact first line the real core emits', () => {
    expect(isReadyHandshake({ type: 'status', phase: 'ready', protocolVersion: 1 })).toBe(true);
  });
  it('is false for any other event', () => {
    expect(isReadyHandshake({ type: 'status', phase: 'thinking' })).toBe(false);
    expect(isReadyHandshake({ type: 'token', text: 'hi' })).toBe(false);
    expect(isReadyHandshake({ type: 'status', phase: 'ready' })).toBe(false); // no protocolVersion
    expect(isReadyHandshake(null)).toBe(false);
    expect(isReadyHandshake('ready')).toBe(false);
  });
});

describe('buildServeArgv', () => {
  it('emits global flags BEFORE the serve subcommand, with dir last', () => {
    const argv = buildServeArgv({
      dir: '/proj',
      chat: { baseURL: 'http://c', model: 'm' },
      embed: { baseURL: 'http://e', model: 'e' },
      scope: 'game',
      approval: 'gated',
    });
    const serveIdx = argv.indexOf('serve');
    expect(serveIdx).toBeGreaterThan(0);
    expect(argv[argv.length - 1]).toBe('/proj');
    // every flag occurs before 'serve'
    for (const flag of ['--chat-base-url', '--chat-model', '--embed-base-url', '--embed-model', '--scope', '--approval']) {
      expect(argv.indexOf(flag)).toBeGreaterThanOrEqual(0);
      expect(argv.indexOf(flag)).toBeLessThan(serveIdx);
    }
  });

  it('produces the minimal [serve, dir] form when no flags are set (defers to config file)', () => {
    expect(buildServeArgv({ dir: '/p' })).toEqual(['serve', '/p']);
  });

  it('includes --trust-project-config only when requested', () => {
    expect(buildServeArgv({ dir: '/p', trustProjectConfig: true })).toEqual([
      '--trust-project-config',
      'serve',
      '/p',
    ]);
    expect(buildServeArgv({ dir: '/p' })).not.toContain('--trust-project-config');
  });

  it('never emits an api-key flag (secrets must not hit the command line)', () => {
    const argv = buildServeArgv({ dir: '/p', chat: { baseURL: 'http://c', model: 'm' } });
    expect(argv.join(' ')).not.toMatch(/api-key/);
  });
});

describe('resolveServeBinary', () => {
  const base = {
    env: {},
    platform: 'linux' as NodeJS.Platform,
    distCliPath: '/repo/dist/cli.js',
    nodePath: '/usr/bin/node',
    exists: () => true,
  };

  it('(1) prefers an explicit configured absolute path', () => {
    const r = resolveServeBinary({ ...base, configuredPath: '/opt/chatgml' });
    expect(r).toEqual({ cmd: '/opt/chatgml', argvPrefix: [] });
  });

  it('(2) falls back to CHATGML_BIN env when no configured path', () => {
    const r = resolveServeBinary({ ...base, env: { CHATGML_BIN: '/usr/local/bin/chatgml' } });
    expect(r).toEqual({ cmd: '/usr/local/bin/chatgml', argvPrefix: [] });
  });

  it('(3) on win32 resolves the absolute npm .cmd shim when it exists', () => {
    const r = resolveServeBinary({
      ...base,
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
      exists: (p) => p === 'C:\\Users\\me\\AppData\\Roaming\\npm\\chatgml.cmd',
    });
    expect(r).toEqual({ cmd: 'C:\\Users\\me\\AppData\\Roaming\\npm\\chatgml.cmd', argvPrefix: [] });
  });

  it('(4) falls back to node + dist/cli.js when nothing else resolves', () => {
    const r = resolveServeBinary({
      ...base,
      platform: 'win32',
      env: { APPDATA: 'C:\\nope' },
      exists: (p) => p === '/repo/dist/cli.js', // shim missing, dist present
    });
    expect(r).toEqual({ cmd: '/usr/bin/node', argvPrefix: ['/repo/dist/cli.js'] });
  });

  it('throws an actionable error when NOTHING resolves (binary not on PATH)', () => {
    expect(() =>
      resolveServeBinary({ ...base, exists: () => false }),
    ).toThrow(/chatgml executable not found/);
  });

  it('skips an empty configured path and empty CHATGML_BIN', () => {
    const r = resolveServeBinary({ ...base, configuredPath: '   ', env: { CHATGML_BIN: '' } });
    expect(r).toEqual({ cmd: '/usr/bin/node', argvPrefix: ['/repo/dist/cli.js'] });
  });
});

describe('reducePluginState', () => {
  const start = (): PluginState => initialPluginState();

  it('status:ready sets ready + phase', () => {
    const s = reducePluginState(
      { type: 'status', phase: 'ready', protocolVersion: 1 },
      start(),
    );
    expect(s.ready).toBe(true);
    expect(s.phase).toBe('ready');
  });

  it('token deltas accumulate into transcript', () => {
    let s = start();
    s = reducePluginState({ type: 'token', text: 'Hello ' }, s);
    s = reducePluginState({ type: 'token', text: 'world' }, s);
    expect(s.transcript).toBe('Hello world');
  });

  it('tool_call adds a running activity entry; tool_result resolves it', () => {
    let s = start();
    s = reducePluginState({ type: 'tool_call', id: 't1', name: 'glob', args: {} }, s);
    expect(s.activity).toEqual([{ id: 't1', name: 'glob', status: 'running' }]);
    s = reducePluginState(
      { type: 'tool_result', id: 't1', name: 'glob', ok: true, content: '3 files' },
      s,
    );
    expect(s.activity[0]?.status).toBe('ok');
  });

  it('a failing tool_result marks the activity entry as error', () => {
    let s = reducePluginState({ type: 'tool_call', id: 't9', name: 'read', args: {} }, start());
    s = reducePluginState(
      { type: 'tool_result', id: 't9', name: 'read', ok: false, content: 'nope' },
      s,
    );
    expect(s.activity[0]?.status).toBe('error');
  });

  it('edit_proposal records a pending proposal keyed by id', () => {
    const s = reducePluginState(
      { type: 'edit_proposal', id: 'e9a1', path: 'a.gml', diff: '--- a\n+++ b\n' },
      start(),
    );
    expect(s.pendingProposals.get('e9a1')).toEqual({
      id: 'e9a1',
      path: 'a.gml',
      diff: '--- a\n+++ b\n',
    });
  });

  it('approval_request without a prior proposal records a path-only placeholder', () => {
    const s = reducePluginState(
      { type: 'approval_request', id: 'x', kind: 'edit', path: 'b.gml' },
      start(),
    );
    expect(s.pendingProposals.get('x')).toEqual({ id: 'x', path: 'b.gml', diff: '' });
  });

  it('approval_request after its proposal does NOT clobber the diff', () => {
    let s = reducePluginState(
      { type: 'edit_proposal', id: 'e1', path: 'c.gml', diff: 'DIFF' },
      start(),
    );
    s = reducePluginState({ type: 'approval_request', id: 'e1', kind: 'edit', path: 'c.gml' }, s);
    expect(s.pendingProposals.get('e1')?.diff).toBe('DIFF');
  });

  it('answer finalizes text + sources', () => {
    const sources = [{ path: 'a.gml', provider: 'local' as const }];
    const s = reducePluginState({ type: 'answer', text: 'final', sources }, start());
    expect(s.answer).toBe('final');
    expect(s.sources).toEqual(sources);
  });

  it('error records the message', () => {
    const s = reducePluginState({ type: 'error', message: 'boom', code: 'http' }, start());
    expect(s.error).toBe('boom');
  });

  it('does not mutate the input state (returns a fresh object)', () => {
    const s0 = start();
    const s1 = reducePluginState({ type: 'token', text: 'x' }, s0);
    expect(s0.transcript).toBe('');
    expect(s1).not.toBe(s0);
  });

  it('reduces the full worked transcript into a coherent UI state', () => {
    const events: AgentEvent[] = [
      { type: 'status', phase: 'ready', protocolVersion: 1 },
      { type: 'status', phase: 'thinking' },
      { type: 'tool_call', id: 't1', name: 'glob', args: { pattern: '**/*.gml' } },
      { type: 'tool_result', id: 't1', name: 'glob', ok: true, content: '3 files' },
      { type: 'token', text: "I'll update the " },
      { type: 'token', text: 'Step event.' },
      {
        type: 'edit_proposal',
        id: 'e9a1',
        path: 'objects/obj_player/Step_0.gml',
        diff: '--- a\n+++ b\n',
      },
      { type: 'approval_request', id: 'e9a1', kind: 'edit', path: 'objects/obj_player/Step_0.gml' },
      {
        type: 'answer',
        text: 'Proposed an edit.',
        sources: [{ path: 'objects/obj_player/Step_0.gml', provider: 'local' }],
      },
    ];
    let s = initialPluginState();
    for (const e of events) s = reducePluginState(e, s);
    expect(s.ready).toBe(true);
    expect(s.transcript).toBe("I'll update the Step event.");
    expect(s.activity).toEqual([{ id: 't1', name: 'glob', status: 'ok' }]);
    expect(s.pendingProposals.has('e9a1')).toBe(true);
    expect(s.answer).toBe('Proposed an edit.');
    expect(s.sources).toHaveLength(1);
  });
});

describe('settleProposal', () => {
  it('removes a pending proposal by id', () => {
    let s = reducePluginState(
      { type: 'edit_proposal', id: 'e1', path: 'a', diff: 'd' },
      initialPluginState(),
    );
    s = settleProposal('e1', s);
    expect(s.pendingProposals.has('e1')).toBe(false);
  });
  it('is a no-op (same object) when the id is unknown', () => {
    const s = initialPluginState();
    expect(settleProposal('missing', s)).toBe(s);
  });
});

describe('matchApproval', () => {
  it('correlates an approval_request to its proposal by id', () => {
    const proposals = new Map([
      ['e1', { id: 'e1', path: 'a.gml', diff: 'DIFF-A' }],
      ['e2', { id: 'e2', path: 'a.gml', diff: 'DIFF-B' }],
    ]);
    const m = matchApproval({ id: 'e2', kind: 'edit', path: 'a.gml' }, proposals);
    expect(m?.diff).toBe('DIFF-B'); // by id, not path — two edits to same path don't alias
  });

  it('returns undefined when no pending proposal matches', () => {
    const m = matchApproval({ id: 'gone', kind: 'edit', path: 'a.gml' }, new Map());
    expect(m).toBeUndefined();
  });
});
