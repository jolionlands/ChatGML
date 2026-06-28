// test/plugin/runtime.test.ts — unit tests for the pure plugin-runtime logic (the source of truth
// the GMEdit plugin copies). DOM-free, deterministic, no spawn.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  NdjsonLineBuffer,
  isReadyHandshake,
  buildServeArgv,
  resolveServeBinary,
  reducePluginState,
  initialPluginState,
  settleProposal,
  matchApproval,
  parseSlashCommand,
  type PluginState,
} from '../../src/plugin-runtime.js';
import type { AgentEvent } from '../../src/types.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsState = require('../../plugin/state.js');

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
    for (const flag of [
      '--chat-base-url',
      '--chat-model',
      '--embed-base-url',
      '--embed-model',
      '--scope',
      '--approval',
    ]) {
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
    expect(() => resolveServeBinary({ ...base, exists: () => false })).toThrow(
      /chatgml executable not found/,
    );
  });

  it('skips an empty configured path and empty CHATGML_BIN', () => {
    const r = resolveServeBinary({ ...base, configuredPath: '   ', env: { CHATGML_BIN: '' } });
    expect(r).toEqual({ cmd: '/usr/bin/node', argvPrefix: ['/repo/dist/cli.js'] });
  });
});

describe('reducePluginState', () => {
  const start = (): PluginState => initialPluginState();

  it('status:ready sets ready + phase + mode', () => {
    const s = reducePluginState(
      { type: 'status', phase: 'ready', protocolVersion: 1, mode: 'architect' } as AgentEvent,
      start(),
    );
    expect(s.ready).toBe(true);
    expect(s.phase).toBe('ready');
    expect(s.mode).toBe('architect');
  });

  it('initial mode defaults to code', () => {
    expect(start().mode).toBe('code');
  });

  it('non-ready status does not change mode', () => {
    let s = reducePluginState(
      { type: 'status', phase: 'ready', protocolVersion: 1, mode: 'ask' } as AgentEvent,
      start(),
    );
    s = reducePluginState({ type: 'status', phase: 'thinking' } as AgentEvent, s);
    expect(s.mode).toBe('ask');
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
    expect(s.activity).toEqual([
      {
        id: 't1',
        kind: 'tool',
        name: 'glob',
        status: 'running',
        content: undefined,
        error: undefined,
      },
    ]);
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

  it('tool_catalog stores the tool list', () => {
    const tools = [{ name: 'read_file', description: 'Read a file', kind: 'read' as const }];
    const s = reducePluginState({ type: 'tool_catalog', tools }, start());
    expect(s.catalog).toEqual(tools);
  });

  it('mcp_tool_call adds a running MCP activity entry; mcp_tool_result resolves it', () => {
    let s = reducePluginState(
      { type: 'mcp_tool_call', id: 'm1', name: 'list_files', server: 'filesystem' },
      start(),
    );
    expect(s.activity).toEqual([
      {
        id: 'm1',
        kind: 'mcp',
        name: 'list_files',
        server: 'filesystem',
        status: 'running',
        content: undefined,
        error: undefined,
      },
    ]);
    s = reducePluginState(
      {
        type: 'mcp_tool_result',
        id: 'm1',
        name: 'list_files',
        server: 'filesystem',
        ok: true,
        content: 'a.gml\nb.gml',
      },
      s,
    );
    expect(s.activity[0]?.status).toBe('ok');
    expect(s.activity[0]?.content).toBe('a.gml\nb.gml');
  });

  it('a failing mcp_tool_result marks the activity entry as error', () => {
    let s = reducePluginState(
      { type: 'mcp_tool_call', id: 'm2', name: 'fetch', server: 'fetch' },
      start(),
    );
    s = reducePluginState(
      {
        type: 'mcp_tool_result',
        id: 'm2',
        name: 'fetch',
        server: 'fetch',
        ok: false,
        error: 'timeout',
      },
      s,
    );
    expect(s.activity[0]?.status).toBe('error');
    expect(s.activity[0]?.error).toBe('timeout');
  });

  it('mcp_resource pushes a transient MCP activity row', () => {
    const s = reducePluginState(
      {
        type: 'mcp_resource',
        id: 'mr1',
        server: 'fetch',
        name: 'https://example.com',
        content: 'hello',
      },
      start(),
    );
    expect(s.activity).toEqual([
      {
        id: 'mr1',
        kind: 'mcp',
        name: 'https://example.com',
        server: 'fetch',
        status: 'ok',
        content: 'hello',
      },
    ]);
  });

  it('mcp results only update matching MCP rows, not tools or commands', () => {
    let s = reducePluginState({ type: 'tool_call', id: 't1', name: 'glob', args: {} }, start());
    s = reducePluginState(
      { type: 'mcp_tool_result', id: 't1', name: 'x', server: 's', ok: true, content: 'nope' },
      s,
    );
    expect(s.activity[0]?.status).toBe('running');
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
    expect(s.activity).toEqual([
      { id: 't1', kind: 'tool', name: 'glob', status: 'ok', content: '3 files', error: undefined },
    ]);
    expect(s.pendingProposals.has('e9a1')).toBe(true);
    expect(s.answer).toBe('Proposed an edit.');
    expect(s.sources).toHaveLength(1);
  });

  it('command_request creates a waiting command activity entry', () => {
    const s = reducePluginState(
      { type: 'command_request', id: 'c1', command: 'echo hi', cwd: '/proj' },
      start(),
    );
    expect(s.activity).toEqual([
      {
        id: 'c1',
        kind: 'command',
        name: 'execute_command',
        status: 'waiting',
        command: 'echo hi',
        cwd: '/proj',
        output: '',
      },
    ]);
  });

  it('command_output appends text and marks the command running', () => {
    let s = reducePluginState({ type: 'command_request', id: 'c1', command: 'echo hi' }, start());
    s = reducePluginState({ type: 'command_output', id: 'c1', stream: 'stdout', text: 'hi\n' }, s);
    s = reducePluginState({ type: 'command_output', id: 'c1', stream: 'stdout', text: 'bye' }, s);
    expect(s.activity[0]?.status).toBe('running');
    expect(s.activity[0]?.output).toBe('hi\nbye');
  });

  it('command_exit marks success/error and appends the exit code', () => {
    let s = reducePluginState({ type: 'command_request', id: 'c1', command: 'false' }, start());
    s = reducePluginState({ type: 'command_output', id: 'c1', stream: 'stderr', text: 'oops' }, s);
    s = reducePluginState({ type: 'command_exit', id: 'c1', code: 1 }, s);
    expect(s.activity[0]?.status).toBe('error');
    expect(s.activity[0]?.output).toBe('oops\n[exit code 1]');

    let s2 = reducePluginState({ type: 'command_request', id: 'c2', command: 'true' }, start());
    s2 = reducePluginState({ type: 'command_exit', id: 'c2', code: 0 }, s2);
    expect(s2.activity[0]?.status).toBe('ok');
    expect(s2.activity[0]?.output).toBe('\n[exit code 0]');
  });

  it('checkpoint appends a checkpoint chip to the state', () => {
    const s = reducePluginState(
      {
        type: 'checkpoint',
        id: 'cp1',
        path: 'objects/obj_player/Step_0.gml',
        label: 'before Step edit',
      },
      initialPluginState(),
    );
    expect(s.checkpoints).toEqual([
      { id: 'cp1', path: 'objects/obj_player/Step_0.gml', label: 'before Step edit' },
    ]);
  });

  it('checkpoints preserve order across multiple events', () => {
    let s = initialPluginState();
    s = reducePluginState({ type: 'checkpoint', id: 'a', path: 'a.gml' }, s);
    s = reducePluginState({ type: 'checkpoint', id: 'b', path: 'b.gml', label: 'B' }, s);
    expect(s.checkpoints).toEqual([
      { id: 'a', path: 'a.gml' },
      { id: 'b', path: 'b.gml', label: 'B' },
    ]);
  });
});

describe('parseSlashCommand', () => {
  it('parses /undo with no id as undo-most-recent', () => {
    expect(parseSlashCommand('/undo')).toEqual({ kind: 'undo', checkpointId: undefined });
  });

  it('parses /undo with an id', () => {
    expect(parseSlashCommand('/undo abc123')).toEqual({ kind: 'undo', checkpointId: 'abc123' });
  });

  it('still parses the existing slash commands', () => {
    expect(parseSlashCommand('/clear')).toEqual({ kind: 'clear' });
    expect(parseSlashCommand('/scope game')).toEqual({ kind: 'scope', value: 'game' });
    expect(parseSlashCommand('/approval auto')).toEqual({ kind: 'approval', value: 'auto' });
    expect(parseSlashCommand('/foo')).toEqual({ kind: 'unknown', name: 'foo' });
  });

  it('parses /mode with a valid mode', () => {
    expect(parseSlashCommand('/mode architect')).toEqual({ kind: 'mode', value: 'architect' });
    expect(parseSlashCommand('/mode code')).toEqual({ kind: 'mode', value: 'code' });
    expect(parseSlashCommand('/mode ask')).toEqual({ kind: 'mode', value: 'ask' });
    expect(parseSlashCommand('/mode debug')).toEqual({ kind: 'mode', value: 'debug' });
  });

  it('rejects an invalid /mode value', () => {
    expect(parseSlashCommand('/mode flying')).toEqual({ kind: 'unknown', name: 'mode flying' });
    expect(parseSlashCommand('/mode')).toEqual({ kind: 'empty', name: 'mode' });
  });

  it('parses task workspace slash commands', () => {
    expect(parseSlashCommand('/new feature-ui')).toEqual({ kind: 'new_task', value: 'feature-ui' });
    expect(parseSlashCommand('/new')).toEqual({ kind: 'empty', name: 'new' });
    expect(parseSlashCommand('/tasks')).toEqual({ kind: 'list_tasks' });
    expect(parseSlashCommand('/switch feature-ui')).toEqual({
      kind: 'switch_task',
      value: 'feature-ui',
    });
    expect(parseSlashCommand('/switch')).toEqual({ kind: 'empty', name: 'switch' });
    expect(parseSlashCommand('/delete-task old')).toEqual({ kind: 'delete_task', value: 'old' });
    expect(parseSlashCommand('/delete-task')).toEqual({ kind: 'empty', name: 'delete-task' });
  });

  it('parses /mcp', () => {
    expect(parseSlashCommand('/mcp')).toEqual({ kind: 'mcp' });
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

describe('parseMentions', () => {
  it('returns empty when there are no mentions', () => {
    expect(jsState.parseMentions('hello world')).toEqual({
      mentions: [],
      cleanText: 'hello world',
    });
  });

  it('parses file and folder mentions and strips them from cleanText', () => {
    const r = jsState.parseMentions('@file scripts/AI.gml\n@folder objects/\nexplain this');
    expect(r.mentions).toEqual([
      { type: 'file', target: 'scripts/AI.gml' },
      { type: 'folder', target: 'objects/' },
    ]);
    expect(r.cleanText).toBe('explain this');
  });

  it('parses the @/path shorthand', () => {
    const r = jsState.parseMentions('@/scripts/AI.gml\n@/objects/');
    expect(r.mentions).toEqual([
      { type: 'file', target: '/scripts/AI.gml' },
      { type: 'folder', target: '/objects/' },
    ]);
  });

  it('parses @problems, @diagnostics, and @terminal', () => {
    const r = jsState.parseMentions('@problems\n@diagnostics\n@terminal\nfix');
    expect(r.mentions).toEqual([
      { type: 'problems', target: 'problems' },
      { type: 'problems', target: 'problems' },
      { type: 'terminal', target: 'terminal' },
    ]);
    expect(r.cleanText).toBe('fix');
  });

  it('parses @url and bare @https://... mentions', () => {
    const r = jsState.parseMentions('@url https://example.com\n@https://example.org/page');
    expect(r.mentions).toEqual([
      { type: 'url', target: 'https://example.com' },
      { type: 'url', target: 'https://example.org/page' },
    ]);
  });

  it('parses @image mentions', () => {
    const r = jsState.parseMentions('@image screenshots/bug.png');
    expect(r.mentions).toEqual([{ type: 'image', target: 'screenshots/bug.png' }]);
  });

  it('ignores incomplete or unknown mentions', () => {
    const r = jsState.parseMentions('@file\n@unknown thing\nreal text');
    expect(r.mentions).toEqual([]);
    expect(r.cleanText).toBe('@file\n@unknown thing\nreal text');
  });

  it('trims leading and trailing whitespace from cleanText', () => {
    const r = jsState.parseMentions('\n  @file a.gml  \n  explain  \n');
    expect(r.cleanText).toBe('explain');
  });
});
