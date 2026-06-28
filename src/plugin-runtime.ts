// src/plugin-runtime.ts — pure, headless-testable logic shared (by COPY) with the GMEdit plugin.
//
// The GMEdit plugin runs in an Electron renderer as CommonJS and CANNOT import this ESM module
// (require() of ESM throws ERR_REQUIRE_ESM). So `plugin/state.js` is a hand-maintained CommonJS
// PORT of the functions here; `test/plugin/parity.test.ts` asserts the two copies stay byte-for-byte
// equivalent in behavior so they can never drift. These functions are the source of truth and carry
// the unit tests; the plugin glue is thin and only wires DOM/process I/O around them.
//
// Nothing here touches the DOM, the filesystem, or `process` — every dependency (env, platform,
// existence probe) is passed in, so the whole surface is deterministic under vitest.
import type { AgentEvent, Citation, EditorContext, Mode, ToolCatalogEntry } from './types.js';

// ---------------------------------------------------------------------------
// 1. NDJSON line buffer (raw-chunk, streaming-UTF-8, tolerant of a malformed line).
//
// Mirrors src/protocol.ts NdjsonDecoder semantics but is dependency-free (no zod) so it can be
// ported verbatim into the plugin. Feed RAW stdout chunks (string OR Buffer); a per-chunk `.trim()`
// would corrupt multi-event chunks and drop partial-line state — the OLD plugin's latent framing bug.
// ---------------------------------------------------------------------------
export interface DecodeResult {
  /** Parsed JSON values for every COMPLETE line found in this push. */
  events: unknown[];
  /** Raw text of any line that was complete but not valid JSON (caller routes to diagnostics). */
  malformed: string[];
}

export class NdjsonLineBuffer {
  private buffer = '';
  // One persistent decoder so a multibyte UTF-8 codepoint split across two chunks is carried over;
  // a fresh decoder per push() would drop the partial-byte state and corrupt the split codepoint.
  private readonly decoder = new TextDecoder();

  /**
   * Feed a chunk; returns the parsed values for every complete line plus the raw text of any
   * complete-but-malformed line. A trailing partial line is buffered across calls. Unlike the
   * core decoder (which throws on bad JSON), this never throws — a junk line is reported in
   * `malformed` and the stream keeps flowing (a child that prints a stray non-JSON line to stdout
   * must not kill the plugin).
   */
  push(chunk: string | Uint8Array): DecodeResult {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const events: unknown[] = [];
    const malformed: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim() === '') continue; // skip blank lines
      try {
        events.push(JSON.parse(line));
      } catch {
        malformed.push(line);
      }
    }
    return { events, malformed };
  }

  /** Flush a trailing buffered partial line (no terminating '\n'), if any. */
  flush(): DecodeResult {
    this.buffer += this.decoder.decode(); // drain any bytes held back by a split multibyte sequence
    const rest = this.buffer;
    this.buffer = '';
    const line = rest.endsWith('\r') ? rest.slice(0, -1) : rest;
    if (line.trim() === '') return { events: [], malformed: [] };
    try {
      return { events: [JSON.parse(line)], malformed: [] };
    } catch {
      return { events: [], malformed: [line] };
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Handshake gate. The plugin enables Send/Approve only after the FIRST stdout line parses to
//    {type:'status',phase:'ready',protocolVersion:N} — the exact line the real core emits first.
// ---------------------------------------------------------------------------
export function isReadyHandshake(
  e: unknown,
): e is { type: 'status'; phase: 'ready'; protocolVersion: number } {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as { type?: unknown; phase?: unknown; protocolVersion?: unknown };
  return o.type === 'status' && o.phase === 'ready' && typeof o.protocolVersion === 'number';
}

// ---------------------------------------------------------------------------
// 3. buildServeArgv — encode the commander positional-options ordering ONCE.
//
// `chatgml serve` uses .enablePositionalOptions(), so global flags MUST precede the `serve`
// subcommand: argv = [<globalFlags...>, 'serve', dir]. Putting a --chat-* flag AFTER `serve` exits 2
// ('unknown option'). We emit the MINIMAL argv: only flags the caller explicitly set, so endpoints/
// model/scope can come from the user-global config file (the preferred path) and no secret is ever
// placed on the command line (never --chat-api-key — it would show in process listings).
// ---------------------------------------------------------------------------
export interface ServeArgvOptions {
  dir: string;
  chat?: { baseURL?: string; model?: string };
  embed?: { baseURL?: string; model?: string };
  scope?: string;
  approval?: 'gated' | 'auto';
  trustProjectConfig?: boolean;
}

export function buildServeArgv(opts: ServeArgvOptions): string[] {
  const flags: string[] = [];
  if (opts.chat?.baseURL) flags.push('--chat-base-url', opts.chat.baseURL);
  if (opts.chat?.model) flags.push('--chat-model', opts.chat.model);
  if (opts.embed?.baseURL) flags.push('--embed-base-url', opts.embed.baseURL);
  if (opts.embed?.model) flags.push('--embed-model', opts.embed.model);
  if (opts.scope) flags.push('--scope', opts.scope);
  if (opts.approval) flags.push('--approval', opts.approval);
  if (opts.trustProjectConfig) flags.push('--trust-project-config');
  // Global flags FIRST, then the subcommand, then the project dir LAST.
  return [...flags, 'serve', opts.dir];
}

// ---------------------------------------------------------------------------
// 4. resolveServeBinary — pick the executable + argv prefix to spawn `chatgml serve`.
//
// `chatgml` is frequently NOT on PATH (it is not on this dev host). Priority ladder:
//   (1) an explicitly configured absolute path (a GMEdit Preference);
//   (2) the CHATGML_BIN env var;
//   (3) on win32, the npm shim at %APPDATA%/npm/chatgml.cmd if it exists;
//   (4) the bundled dist/cli.js, spawned via the current node (process.execPath) — always present
//       in a dev checkout, no global install required.
// We NEVER spawn a bare 'chatgml' with shell:false (it would ENOENT a .cmd on Windows); the result
// is always a concrete cmd + an argvPrefix that precedes the serve argv.
// ---------------------------------------------------------------------------
export interface ResolveBinaryOpts {
  /** An absolute path configured via a GMEdit Preference (highest priority). */
  configuredPath?: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** Absolute path to the bundled dist/cli.js (the dev fallback). */
  distCliPath: string;
  /** The node executable to run dist/cli.js with (defaults to process.execPath at the call site). */
  nodePath: string;
  /** Injected existence probe (defaults to fs.existsSync at the call site). */
  exists: (p: string) => boolean;
}

export interface ResolvedBinary {
  cmd: string;
  /** Args that PRECEDE the serve argv (e.g. ['<dist/cli.js>'] when cmd is node). */
  argvPrefix: string[];
}

export function resolveServeBinary(opts: ResolveBinaryOpts): ResolvedBinary {
  // (1) explicit absolute path from a Preference.
  if (opts.configuredPath && opts.configuredPath.trim() !== '') {
    return { cmd: opts.configuredPath, argvPrefix: [] };
  }
  // (2) CHATGML_BIN env reference.
  const fromEnv = opts.env['CHATGML_BIN'];
  if (fromEnv && fromEnv.trim() !== '') {
    return { cmd: fromEnv, argvPrefix: [] };
  }
  // (3) bundled dist/cli.js via node — the dev fallback (no global install required).
  //     Preferred over the npm shim because Electron's renderer cannot reliably spawn .cmd
  //     files with shell:false, and process.execPath in a packaged app is the app exe, not node.
  if (opts.exists(opts.distCliPath)) {
    return { cmd: opts.nodePath, argvPrefix: [opts.distCliPath] };
  }
  // (4) win32 npm shim, if present (spawned via cmd.exe /c in client.js because .cmd files
  //     cannot be run directly with shell:false).
  if (opts.platform === 'win32') {
    const appData = opts.env['APPDATA'];
    if (appData && appData.trim() !== '') {
      const shim = `${appData.replace(/[\\/]+$/, '')}\\npm\\chatgml.cmd`;
      if (opts.exists(shim)) {
        return { cmd: shim, argvPrefix: [] };
      }
    }
  }
  // Nothing resolved -> an actionable error rather than a silent ENOENT child.
  throw new Error(
    'chatgml executable not found. Set the "ChatGML binary path" plugin preference to an ' +
      'absolute path, set CHATGML_BIN, or build the core (dist/cli.js) in the checkout.',
  );
}

// ---------------------------------------------------------------------------
// 5. PluginState + reducePluginState — project the AgentEvent stream into a UI-ready state.
//
// PURE: (event, state) -> next state. No DOM. The DOM layer (panel.js / diff-view.js) renders from
// this and never owns protocol logic. `pendingProposals` is keyed by the deterministic edit id so
// matchApproval can correlate an approval_request back to its proposal by id alone.
// ---------------------------------------------------------------------------
export type PluginStatusPhase =
  | 'ready'
  | 'thinking'
  | 'streaming'
  | 'indexing'
  | 'idle'
  | 'done'
  | 'cancelled'
  | 'launching'
  | 'stopped';

export interface ActivityEntry {
  id: string;
  name: string;
  /** Discriminator so the panel can render tool calls, command execution, and MCP activity differently. */
  kind: 'tool' | 'command' | 'mcp';
  /** 'running' once tool_call or command_output seen; 'ok'/'error' once resolved; 'waiting' for command approval. */
  status: 'running' | 'ok' | 'error' | 'waiting';
  /** Present for MCP activity rows: the configured MCP server name. */
  server?: string;
  content?: string;
  error?: string;
  command?: string;
  cwd?: string;
  output?: string;
}

export interface PendingProposal {
  id: string;
  path: string;
  diff: string;
}

export interface PluginCheckpoint {
  id: string;
  path: string;
  label?: string;
}

export interface PluginState {
  /** True once the ready handshake arrived; gates Send/Approve. */
  ready: boolean;
  phase: PluginStatusPhase;
  /** Active agent mode reported by the core in the ready handshake. */
  mode: Mode;
  /** Accumulated streamed assistant text for the current turn (token deltas concatenated). */
  transcript: string;
  /** The finalized answer text + its sources (set on `answer`). */
  answer: string | null;
  sources: Citation[];
  activity: ActivityEntry[];
  /** Pending gated edits awaiting approve/reject, keyed by edit id. */
  pendingProposals: Map<string, PendingProposal>;
  /** Last error message, if any (cleared at the start of a new user turn). */
  error: string | null;
  /** Tool catalog broadcast by the core after the ready handshake. */
  catalog?: ToolCatalogEntry[] | null;
  /** Checkpoints emitted by the core after successful edits; rendered as clickable chips. */
  checkpoints: PluginCheckpoint[];
}

export function initialPluginState(): PluginState {
  return {
    ready: false,
    phase: 'stopped',
    mode: 'code',
    transcript: '',
    answer: null,
    sources: [],
    activity: [],
    pendingProposals: new Map(),
    error: null,
    catalog: null,
    checkpoints: [],
  };
}

/**
 * Apply one AgentEvent to the state, returning the NEXT state. Returns a NEW object (shallow clone)
 * so a renderer can diff cheaply; nested collections (`activity`, `pendingProposals`, `sources`) are
 * also fresh per call.
 */
export function reducePluginState(event: AgentEvent, state: PluginState): PluginState {
  const next: PluginState = {
    ...state,
    sources: state.sources,
    activity: state.activity,
    pendingProposals: state.pendingProposals,
  };
  switch (event.type) {
    case 'status': {
      next.phase = event.phase;
      if (event.phase === 'ready') {
        next.ready = true;
        const mode = (event as { mode?: Mode }).mode;
        if (mode) next.mode = mode;
      }
      return next;
    }
    case 'token': {
      next.transcript = state.transcript + event.text;
      return next;
    }
    case 'tool_call': {
      next.activity = [
        ...state.activity,
        {
          id: event.id,
          kind: 'tool',
          name: event.name,
          status: 'running',
          content: undefined,
          error: undefined,
        },
      ];
      return next;
    }
    case 'tool_result': {
      // The core wire shape for tool_result currently omits `error` from the TS union, but the
      // plugin port defensively carries it when present so a future core event can surface it.
      const toolEvent = event as typeof event & { error?: unknown };
      next.activity = state.activity.map((a) =>
        a.id === event.id
          ? {
              ...a,
              status: event.ok ? ('ok' as const) : ('error' as const),
              ...(event.content != null
                ? {
                    content:
                      String(event.content).length > 4096
                        ? String(event.content).slice(0, 4096) + '…'
                        : String(event.content),
                  }
                : {}),
              ...(toolEvent.error != null ? { error: String(toolEvent.error) } : {}),
            }
          : a,
      );
      return next;
    }
    case 'command_request': {
      next.activity = [
        ...state.activity,
        {
          id: event.id,
          kind: 'command',
          name: 'execute_command',
          status: 'waiting',
          command: event.command,
          cwd: event.cwd,
          output: '',
        },
      ];
      return next;
    }
    case 'command_output': {
      const MAX_OUTPUT = 8192;
      next.activity = state.activity.map((a) => {
        if (a.id !== event.id || a.kind !== 'command') return a;
        const text = String(a.output || '') + String(event.text || '');
        const output = text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + '…' : text;
        return { ...a, status: 'running', output };
      });
      return next;
    }
    case 'command_exit': {
      next.activity = state.activity.map((a) => {
        if (a.id !== event.id || a.kind !== 'command') return a;
        const output = String(a.output || '') + '\n[exit code ' + event.code + ']';
        return { ...a, status: event.code === 0 ? ('ok' as const) : ('error' as const), output };
      });
      return next;
    }
    case 'mcp_tool_call': {
      next.activity = [
        ...state.activity,
        {
          id: event.id,
          kind: 'mcp',
          name: event.name,
          server: event.server,
          status: 'running',
          content: undefined,
          error: undefined,
        },
      ];
      return next;
    }
    case 'mcp_tool_result': {
      next.activity = state.activity.map((a) =>
        a.id === event.id && a.kind === 'mcp'
          ? {
              ...a,
              status: event.ok ? ('ok' as const) : ('error' as const),
              ...(event.content != null
                ? {
                    content:
                      String(event.content).length > 4096
                        ? String(event.content).slice(0, 4096) + '…'
                        : String(event.content),
                  }
                : {}),
              ...(event.error != null ? { error: String(event.error) } : {}),
            }
          : a,
      );
      return next;
    }
    case 'mcp_resource': {
      next.activity = [
        ...state.activity,
        {
          id: event.id,
          kind: 'mcp',
          name: event.name,
          server: event.server,
          status: 'ok',
          content:
            event.content != null
              ? String(event.content).length > 4096
                ? String(event.content).slice(0, 4096) + '…'
                : String(event.content)
              : undefined,
        },
      ];
      return next;
    }
    case 'edit_proposal': {
      const map = new Map(state.pendingProposals);
      map.set(event.id, { id: event.id, path: event.path, diff: event.diff });
      next.pendingProposals = map;
      return next;
    }
    case 'approval_request': {
      // The proposal is already pending (edit_proposal precedes approval_request and shares the id).
      // If a request arrives without a prior proposal, record a path-only placeholder so the UI can
      // still surface Approve/Reject.
      if (!state.pendingProposals.has(event.id)) {
        const map = new Map(state.pendingProposals);
        map.set(event.id, { id: event.id, path: event.path, diff: '' });
        next.pendingProposals = map;
      }
      return next;
    }
    case 'answer': {
      next.answer = event.text;
      next.sources = event.sources;
      return next;
    }
    case 'turn_end': {
      // A persistence side-channel (emitted after the terminal answer/error). The running/answer
      // state was already finalized by the answer event, so the reducer does NOT mutate the visible
      // state here; the panel picks the record up separately to append to its per-project session
      // log. Returning `next` keeps the projection a pure function of (event, state).
      return next;
    }
    case 'error': {
      next.error = event.message;
      return next;
    }
    // Protocol v3 events: tool catalog is stored; checkpoint chips are accumulated; pong is ignored.
    case 'tool_catalog': {
      next.catalog = event.tools;
      return next;
    }
    case 'checkpoint': {
      next.checkpoints = [
        ...state.checkpoints,
        { id: event.id, path: event.path, label: event.label },
      ];
      return next;
    }
    case 'pong': {
      return next;
    }
    default: {
      // Exhaustiveness guard: every AgentEvent variant is handled above.
      const _never: never = event;
      return _never;
    }
  }
}

/** Clear the pending proposal for an id (called after the client sends approve/reject). */
export function settleProposal(id: string, state: PluginState): PluginState {
  if (!state.pendingProposals.has(id)) return state;
  const map = new Map(state.pendingProposals);
  map.delete(id);
  return { ...state, pendingProposals: map };
}

// ---------------------------------------------------------------------------
// 6. matchApproval — correlate an approval_request back to its pending proposal BY ID (the
//    deterministic sha1(path+'\0'+diff)). Correlate on id ONLY so two edits to the same path never
//    alias. Returns undefined when no pending proposal matches (e.g. a stale/late request).
// ---------------------------------------------------------------------------
export function matchApproval(
  req: { id: string; kind: 'edit'; path: string },
  pendingProposals: ReadonlyMap<string, PendingProposal>,
): PendingProposal | undefined {
  return pendingProposals.get(req.id);
}

// ---------------------------------------------------------------------------
// 7. Slash commands (opencode-style chat input).
//
// The panel interprets a line that starts with '/' as a client-side command, NOT a user message
// to the agent. parseSlashCommand returns a discriminated result the panel acts on (clear history,
// reindex, resume last session, change scope/model/approval, show help). A leading '/' with no
// recognized name is 'unknown' (the panel shows a hint). Returns null for a plain (non-slash)
// line so the caller knows to send it as a user message. Case-insensitive on the command name;
// the value argument keeps its case (a model id is case-sensitive). Trailing/leading whitespace
// around the value is trimmed; an empty value for value-bearing commands is 'empty' so the panel
// can prompt instead of silently no-op'ing.
// ---------------------------------------------------------------------------
export type SlashCommand =
  | { kind: 'clear' }
  | { kind: 'reindex' }
  | { kind: 'resume' }
  | { kind: 'scope'; value: string }
  | { kind: 'model'; value: string }
  | { kind: 'mode'; value: Mode }
  | { kind: 'approval'; value: 'gated' | 'auto' }
  | { kind: 'mcp' }
  | { kind: 'undo'; checkpointId?: string }
  | { kind: 'new_task'; value: string }
  | { kind: 'list_tasks' }
  | { kind: 'switch_task'; value: string }
  | { kind: 'delete_task'; value: string }
  | { kind: 'help' }
  | { kind: 'unknown'; name: string }
  | { kind: 'empty'; name: string };

export function parseSlashCommand(line: string): SlashCommand | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed[0] !== '/') return null;
  // first whitespace splits name from the (optional) value
  const sp = trimmed.indexOf(' ');
  const name = (sp === -1 ? trimmed.slice(1) : trimmed.slice(1, sp)).toLowerCase();
  if (name === '') return { kind: 'empty', name: '' };
  const value = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
  switch (name) {
    case 'clear':
      return { kind: 'clear' };
    case 'reindex':
      return { kind: 'reindex' };
    case 'resume':
      return { kind: 'resume' };
    case 'help':
    case '?':
      return { kind: 'help' };
    case 'scope':
      return value === '' ? { kind: 'empty', name } : { kind: 'scope', value };
    case 'model':
      return value === '' ? { kind: 'empty', name } : { kind: 'model', value };
    case 'mode': {
      if (value === '') return { kind: 'empty', name };
      if (value !== 'architect' && value !== 'code' && value !== 'ask' && value !== 'debug')
        return { kind: 'unknown', name: name + ' ' + value };
      return { kind: 'mode', value };
    }
    case 'approval':
      if (value !== 'gated' && value !== 'auto')
        return { kind: 'unknown', name: name + ' ' + value };
      return { kind: 'approval', value };
    case 'mcp':
      return { kind: 'mcp' };
    case 'undo':
      return { kind: 'undo', checkpointId: value || undefined };
    case 'new':
      return value === '' ? { kind: 'empty', name } : { kind: 'new_task', value };
    case 'tasks':
      return { kind: 'list_tasks' };
    case 'switch':
      return value === '' ? { kind: 'empty', name } : { kind: 'switch_task', value };
    case 'delete-task':
      return value === '' ? { kind: 'empty', name } : { kind: 'delete_task', value };
    default:
      return { kind: 'unknown', name };
  }
}

// A short help string the panel renders for /help or an unknown/empty command. Kept here (pure)
// so the test snapshot is stable and the help text is single-sourced.
export const SLASH_HELP: readonly string[] = [
  'ChatGML slash commands:',
  '  /clear          drop conversation history (this session)',
  '  /reindex        rebuild the code index now',
  '  /resume         reload the last saved session for this project',
  '  /new <name>     create a new task workspace',
  '  /tasks          list existing task workspaces',
  '  /switch <name>  switch to a task workspace',
  '  /delete-task <name>  delete a task workspace',
  '  /mode architect|code|ask|debug   set the agent mode and restart the core',
  '  /scope <name>   set the memory scope and restart the core',
  '  /model <id>     set the chat model (chat.model) and restart the core',
  '  /approval gated|auto   set edit approval mode and restart the core',
  '  /mcp            list configured MCP servers and tool counts',
  '  /undo [id]      undo the most recent checkpoint (or the specified checkpoint id)',
  '  /help           show this help',
];

// ---------------------------------------------------------------------------
// 8. Editor context construction (opencode-style '@current file' awareness).
//
// buildEditorContext takes what the GMEdit glue knows about the active file and returns the
// {openFile,selection,cursorLine} object attached to a `user` command, or undefined when there is
// nothing useful to attach (so a bare user message is sent — v1 behavior). Empty/whitespace
// selections are dropped; an openFile that is empty/whitespace is dropped; a cursorLine <= 0 is
// dropped. Pure + total so it is unit-tested directly.
// ---------------------------------------------------------------------------
export function buildEditorContext(opts: {
  openFile?: string;
  selection?: string;
  cursorLine?: number;
}): EditorContext | undefined {
  const context: EditorContext = {};
  const file = opts.openFile != null ? String(opts.openFile) : '';
  if (file.trim() !== '') context.openFile = file;
  const sel = opts.selection != null ? String(opts.selection) : '';
  if (sel.trim() !== '') context.selection = sel;
  const line = Number(opts.cursorLine);
  if (Number.isInteger(line) && line > 0) context.cursorLine = line;
  if (
    context.openFile === undefined &&
    context.selection === undefined &&
    context.cursorLine === undefined
  ) {
    return undefined;
  }
  return context;
}

// ---------------------------------------------------------------------------
// 9. Session persistence (resumable conversation history).
//
// A `turn_end` outbound event is the per-turn persistence record. The panel appends these to a
// per-project session file. On the next `chatgml serve` start the panel reads the file, converts
// the turns into plain {role,content} pairs, and sends ONE `resume` command seeding the in-memory
// history. turnEndToMessages flattens each turn_end into a user/assistant pair (the editor-context
// is NOT replayed — it was only relevant to the turn it was attached to). Returns the array shape
// the `resume` inbound command expects.
// ---------------------------------------------------------------------------
export interface ResumableMessage {
  role: 'user' | 'assistant';
  content: string | null;
}

export function turnEndToMessages(
  turns: Array<{ userText: string; assistantText: string }>,
): ResumableMessage[] {
  const out: ResumableMessage[] = [];
  for (const t of turns) {
    // Skip turns with no user text (a user-spam/empty case) so we never replay a null user turn.
    if (!t.userText || t.userText.trim() === '') continue;
    out.push({ role: 'user', content: t.userText });
    // An assistant turn that ended in an error has empty assistantText; keep it as null (the shape
    // the core's resume() accepts — content string|null).
    out.push({
      role: 'assistant',
      content: t.assistantText && t.assistantText.length > 0 ? t.assistantText : null,
    });
  }
  return out;
}

/** Build the inbound `resume` command from a persisted turn list. */
export function buildResumeCommand(turns: Array<{ userText: string; assistantText: string }>): {
  type: 'resume';
  messages: ResumableMessage[];
} {
  return { type: 'resume', messages: turnEndToMessages(turns) };
}
