import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { EventRenderer, runChatRepl, type LineSource } from '../src/cli/repl.js';
import type { AgentEvent } from '../src/types.js';
import { FakeAgent } from './helpers/fake-agent.js';

function stringSink(): { out: Writable; text: () => string } {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { out, text: () => chunks.join('') };
}

function lineSource(lines: string[]): LineSource {
  return {
    async *[Symbol.asyncIterator]() {
      for (const l of lines) yield l;
    },
  };
}

describe('EventRenderer (exact transcript, color:false)', () => {
  it('renders a full turn with tokens, a tool call, and an answer with sources', () => {
    const { out, text } = stringSink();
    const r = new EventRenderer({ out, color: false });
    const events: AgentEvent[] = [
      { type: 'status', phase: 'thinking' },
      { type: 'tool_call', id: 't1', name: 'glob', args: { pattern: '**/*.gml' } },
      { type: 'tool_result', id: 't1', name: 'glob', ok: true, content: '3 files\nmore' },
      { type: 'token', text: 'The answer ' },
      { type: 'token', text: 'is 42.' },
      {
        type: 'answer',
        text: 'The answer is 42.',
        sources: [
          { path: 'objects/obj_player/Step_0.gml', startLine: 1, endLine: 2, provider: 'local' },
        ],
      },
    ];
    for (const e of events) r.render(e);
    // Tokens were streamed this turn, so the answer text is printed ONCE (streamed) — not re-printed
    // by the answer event. endStream() emits the newline that finishes the streamed line. (F15)
    expect(text()).toBe(
      [
        '· thinking…',
        '→ glob({"pattern":"**/*.gml"})',
        '  ✓ 3 files',
        'The answer is 42.',
        'sources:',
        '  - objects/obj_player/Step_0.gml:1-2',
        '',
      ].join('\n'),
    );
  });

  it('prints the answer text when NO tokens streamed (tool-only / non-streaming model)', () => {
    const { out, text } = stringSink();
    const r = new EventRenderer({ out, color: false });
    // No token events this turn -> the answer event must print the text exactly once.
    r.render({ type: 'answer', text: 'final only', sources: [] });
    expect(text()).toBe('final only\n');
  });

  it('renders an error and a failed tool result', () => {
    const { out, text } = stringSink();
    const r = new EventRenderer({ out, color: false });
    r.render({ type: 'tool_result', id: 'x', name: 'read_file', ok: false, content: 'not found' });
    r.render({ type: 'error', message: 'boom', code: 'http' });
    expect(text()).toBe('  ✗ not found\n! boom\n');
  });

  it('color:true emits SGR codes', () => {
    const { out, text } = stringSink();
    const r = new EventRenderer({ out, color: true });
    r.render({ type: 'answer', text: 'hi', sources: [] });
    expect(text()).toContain('[32m');
  });

  it('returns the pending approval descriptor on approval_request', () => {
    const { out } = stringSink();
    const r = new EventRenderer({ out, color: false });
    const pend = r.render({ type: 'approval_request', id: 'e1', kind: 'edit', path: 'a.gml' });
    expect(pend).toEqual({ approvalId: 'e1', path: 'a.gml' });
  });

  it('renders every status:phase variant (thinking, indexing, cancelled, done w/ detail, done w/o)', () => {
    const { out, text } = stringSink();
    const r = new EventRenderer({ out, color: false });
    r.render({ type: 'status', phase: 'thinking' });
    r.render({ type: 'status', phase: 'indexing' });
    r.render({ type: 'status', phase: 'cancelled' });
    r.render({ type: 'status', phase: 'done', detail: 'finished: 3 added' });
    r.render({ type: 'status', phase: 'done' }); // no detail → no output
    r.render({ type: 'status', phase: 'ready' }); // not in switch → falls through to default → no output
    expect(text()).toContain('· thinking…');
    expect(text()).toContain('· indexing…');
    expect(text()).toContain('· cancelled');
    expect(text()).toContain('· finished: 3 added');
  });

  it('renders a token and ends the streaming line on the next non-token event', () => {
    const { out, text } = stringSink();
    const r = new EventRenderer({ out, color: false });
    r.render({ type: 'token', text: 'hello ' });
    r.render({ type: 'token', text: 'world' });
    // Non-token event → endStream emits the trailing newline.
    r.render({ type: 'answer', text: '', sources: [] });
    expect(text()).toBe('hello world\n');
  });

  it('renders an edit_proposal (path header + colorized diff)', () => {
    const { out, text } = stringSink();
    const r = new EventRenderer({ out, color: false });
    r.render({
      type: 'edit_proposal',
      id: 'e1',
      path: 'a.gml',
      diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n',
    });
    expect(text()).toContain('proposed edit to a.gml');
    expect(text()).toContain('-old');
    expect(text()).toContain('+new');
  });

  it('returns null (no-op) for protocol events the terminal REPL ignores', () => {
    const { out } = stringSink();
    const r = new EventRenderer({ out, color: false });
    const ignored: AgentEvent[] = [
      { type: 'turn_end', userText: 'u', assistantText: 'a', sources: [] },
      { type: 'tool_catalog', tools: [] },
      { type: 'checkpoint', id: 'c1', path: 'a.gml' },
      { type: 'command_request', id: 'cr1', command: 'ls' },
      { type: 'command_output', id: 'cr1', stream: 'stdout', text: 'a\n' },
      { type: 'command_exit', id: 'cr1', code: 0 },
      { type: 'mcp_tool_call', id: 'm1', name: 'echo', server: 'mock' },
      { type: 'mcp_tool_result', id: 'm1', server: 'mock', name: 'echo', ok: true, content: 'hi' },
    ];
    for (const e of ignored) {
      expect(r.render(e)).toBeNull();
    }
    // No output produced for any of them.
    // (stringSink was used as `out`; its `text` is empty unless render wrote something.)
  });

  it('answer event with memory-only citation renders the "(memory)" fallback', () => {
    const { out, text } = stringSink();
    const r = new EventRenderer({ out, color: false });
    r.render({
      type: 'answer',
      text: 'ok',
      sources: [{ provider: 'local', snippet: 'a memory hit' }],
    });
    expect(text()).toContain('sources:');
    expect(text()).toContain('(memory)');
  });

  it('answer event with citation path but no startLine renders the bare path', () => {
    const { out, text } = stringSink();
    const r = new EventRenderer({ out, color: false });
    r.render({
      type: 'answer',
      text: 'ok',
      sources: [{ path: 'notes/readme.md', provider: 'local' }],
    });
    expect(text()).toContain('  - notes/readme.md\n');
    expect(text()).not.toMatch(/notes\/readme\.md:/); // no colon / line range
  });
});

describe('runChatRepl over an injected line source', () => {
  it('runs a turn per line and exits 0 on the "exit" command', async () => {
    const agent = new FakeAgent({ after: undefined });
    // FakeAgent with no script emits nothing; that is fine for a smoke of the loop.
    const { out } = stringSink();
    const code = await runChatRepl({
      agent,
      lines: lineSource(['hello', 'exit', 'never reached']),
      out,
    });
    expect(code).toBe(0);
  });

  it('exits 0 at EOF (line source ends)', async () => {
    const agent = new FakeAgent();
    const { out } = stringSink();
    const code = await runChatRepl({ agent, lines: lineSource(['hi']), out });
    expect(code).toBe(0);
  });

  it('prompts on approval_request and forwards approve (y)', async () => {
    const agent = new FakeAgent({
      after: undefined,
    });
    // override run to emit an approval_request
    agent.run = (_cmd, _signal) =>
      (async function* () {
        yield {
          type: 'edit_proposal',
          id: 'e1',
          path: 'a.gml',
          diff: '--- a\n+++ b\n',
        } as AgentEvent;
        yield { type: 'approval_request', id: 'e1', kind: 'edit', path: 'a.gml' } as AgentEvent;
        yield { type: 'answer', text: 'proposed', sources: [] } as AgentEvent;
      })();
    const { out } = stringSink();
    await runChatRepl({
      agent,
      lines: lineSource(['edit a.gml']),
      out,
      promptApproval: async () => true,
    });
    expect(agent.approvals).toEqual([{ id: 'e1', approved: true }]);
  });

  it('forwards reject (n) when the prompt returns false', async () => {
    const agent = new FakeAgent();
    agent.run = (_cmd, _signal) =>
      (async function* () {
        yield { type: 'approval_request', id: 'e2', kind: 'edit', path: 'b.gml' } as AgentEvent;
      })();
    const { out } = stringSink();
    await runChatRepl({
      agent,
      lines: lineSource(['edit b.gml']),
      out,
      promptApproval: async () => false,
    });
    expect(agent.approvals).toEqual([{ id: 'e2', approved: false }]);
  });

  it('renders an error event and continues', async () => {
    const agent = new FakeAgent();
    agent.run = (_cmd, _signal) =>
      (async function* () {
        yield { type: 'error', message: 'oops', code: 'x' } as AgentEvent;
      })();
    const { out, text } = stringSink();
    const code = await runChatRepl({ agent, lines: lineSource(['boom']), out });
    expect(code).toBe(0);
    expect(text()).toContain('! oops');
  });
});
