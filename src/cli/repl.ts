// src/cli/repl.ts — the streaming chat REPL renderer + loop.
//
// `EventRenderer` turns the AgentEvent stream into terminal output against an injected Writable; its
// render(event) is fully testable with an exact transcript (color:false). `runChatRepl` drives the
// loop over an INJECTED line source (an async line iterator) and an AgentLike, so it is tested
// without a real TTY: pushed lines + a manually-fired abort, asserting approve/reject dispatch and
// exit codes against a FakeAgent. Pending edit approvals prompt y/n; `exit`/EOF cleanly ends.
import type { AgentEvent, Citation } from '../types.js';
import type { AgentLike } from '../agent.js';
import { styles, type Styles, colorizeDiff } from './theme.js';

export interface RendererOptions {
  out: NodeJS.WritableStream;
  color?: boolean;
}

/** Renders AgentEvents to a writable stream. Stateless except for the in-progress answer line. */
export class EventRenderer {
  private readonly out: NodeJS.WritableStream;
  private readonly st: Styles;
  private streaming = false;

  constructor(opts: RendererOptions) {
    this.out = opts.out;
    this.st = styles(opts.color === true);
  }

  private write(s: string): void {
    this.out.write(s);
  }

  /** Render one event. Returns a pending approval descriptor when one is requested. */
  render(event: AgentEvent): { approvalId: string; path: string } | null {
    switch (event.type) {
      case 'status':
        if (event.phase === 'thinking') this.write(this.st.dim('· thinking…\n'));
        else if (event.phase === 'indexing') this.write(this.st.dim('· indexing…\n'));
        else if (event.phase === 'cancelled') this.write(this.st.yellow('· cancelled\n'));
        else if (event.phase === 'done' && event.detail) {
          this.write(this.st.dim(`· ${event.detail}\n`));
        }
        return null;
      case 'token':
        this.streaming = true;
        this.write(event.text);
        return null;
      case 'tool_call':
        this.endStream();
        this.write(this.st.cyan(`→ ${event.name}(${compactArgs(event.args)})\n`));
        return null;
      case 'tool_result':
        this.write(
          event.ok
            ? this.st.gray(`  ✓ ${firstLine(event.content)}\n`)
            : this.st.red(`  ✗ ${firstLine(event.content)}\n`),
        );
        return null;
      case 'edit_proposal':
        this.endStream();
        this.write(this.st.bold(`✎ proposed edit to ${event.path}:\n`));
        this.write(colorizeDiff(event.diff, this.st) + '\n');
        return null;
      case 'approval_request':
        return { approvalId: event.id, path: event.path };
      case 'answer': {
        // When tokens were streamed this turn, the full text is already on screen — re-printing
        // event.text would duplicate the whole reply. Only finish the stream + render sources. The
        // answer EVENT is untouched (the serve protocol still emits it). When nothing streamed (e.g.
        // a tool-only turn or a non-streaming model), print the answer text. (F15)
        const wasStreaming = this.streaming;
        this.endStream();
        if (!wasStreaming && event.text.trim() !== '') {
          this.write(this.st.green(event.text) + '\n');
        }
        this.renderSources(event.sources);
        return null;
      }
      case 'error':
        this.endStream();
        this.write(this.st.red(`! ${event.message}\n`));
        return null;
    }
  }

  private renderSources(sources: Citation[]): void {
    if (sources.length === 0) return;
    this.write(this.st.dim('sources:\n'));
    for (const s of sources) {
      const loc =
        s.path !== undefined
          ? s.startLine !== undefined
            ? `${s.path}:${s.startLine}-${s.endLine ?? s.startLine}`
            : s.path
          : '(memory)';
      this.write(this.st.dim(`  - ${loc}\n`));
    }
  }

  private endStream(): void {
    if (this.streaming) {
      this.write('\n');
      this.streaming = false;
    }
  }
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

function compactArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args);
    return json.length > 80 ? `${json.slice(0, 77)}…` : json;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// REPL loop over an injected line source.
// ---------------------------------------------------------------------------
export interface LineSource {
  /** Yields each user input line (without trailing newline). Ends when the user EOFs (Ctrl-D). */
  [Symbol.asyncIterator](): AsyncIterator<string>;
}

export interface ReplDeps {
  agent: AgentLike;
  lines: LineSource;
  out: NodeJS.WritableStream;
  color?: boolean;
  /** A fresh AbortSignal per turn; the host fires it on Ctrl-C. Optional. */
  makeSignal?: () => AbortSignal;
  /** Prompt the user for an approval answer (y/N). Injected so tests can script it. */
  promptApproval?: (path: string) => Promise<boolean>;
}

export const REPL_EXIT_COMMANDS = new Set(['exit', 'quit', ':q']);

/**
 * Run the chat REPL until the line source ends or the user types `exit`. Returns an exit code
 * (0 = clean exit). For each non-empty line it starts an agent run, renders the stream, and on an
 * approval_request asks promptApproval and forwards approve/reject by id. An error event is rendered
 * and the REPL continues.
 */
export async function runChatRepl(deps: ReplDeps): Promise<number> {
  const renderer = new EventRenderer({ out: deps.out, color: deps.color === true });
  const prompt = deps.promptApproval ?? (async () => false);

  for await (const rawLine of deps.lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (REPL_EXIT_COMMANDS.has(line.toLowerCase())) return 0;

    const signal = deps.makeSignal ? deps.makeSignal() : new AbortController().signal;
    const pendingApprovals: Array<{ approvalId: string; path: string }> = [];

    for await (const event of deps.agent.run({ type: 'user', text: line }, signal)) {
      const approval = renderer.render(event);
      if (approval) pendingApprovals.push(approval);
    }

    // Resolve any approvals the turn requested (after the stream so the diff was shown).
    for (const a of pendingApprovals) {
      const approved = await prompt(a.path);
      deps.agent.resolveApproval(a.approvalId, approved);
    }
  }
  return 0;
}
