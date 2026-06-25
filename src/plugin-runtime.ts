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
import type { AgentEvent, Citation } from './types.js';

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

  /**
   * Feed a chunk; returns the parsed values for every complete line plus the raw text of any
   * complete-but-malformed line. A trailing partial line is buffered across calls. Unlike the
   * core decoder (which throws on bad JSON), this never throws — a junk line is reported in
   * `malformed` and the stream keeps flowing (a child that prints a stray non-JSON line to stdout
   * must not kill the plugin).
   */
  push(chunk: string | Uint8Array): DecodeResult {
    this.buffer +=
      typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk, { stream: true });
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
  return (
    o.type === 'status' && o.phase === 'ready' && typeof o.protocolVersion === 'number'
  );
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
  // (3) win32 npm shim, if present (resolve the ABSOLUTE .cmd so shell:false can spawn it).
  if (opts.platform === 'win32') {
    const appData = opts.env['APPDATA'];
    if (appData && appData.trim() !== '') {
      const shim = `${appData.replace(/[\\/]+$/, '')}\\npm\\chatgml.cmd`;
      if (opts.exists(shim)) {
        return { cmd: shim, argvPrefix: [] };
      }
    }
  }
  // (4) bundled dist/cli.js via node — the dev fallback (no global install required).
  if (opts.exists(opts.distCliPath)) {
    return { cmd: opts.nodePath, argvPrefix: [opts.distCliPath] };
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
  | 'indexing'
  | 'idle'
  | 'done'
  | 'cancelled'
  | 'launching'
  | 'stopped';

export interface ActivityEntry {
  id: string;
  name: string;
  /** 'running' once tool_call seen, then 'ok'/'error' once tool_result arrives. */
  status: 'running' | 'ok' | 'error';
}

export interface PendingProposal {
  id: string;
  path: string;
  diff: string;
}

export interface PluginState {
  /** True once the ready handshake arrived; gates Send/Approve. */
  ready: boolean;
  phase: PluginStatusPhase;
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
}

export function initialPluginState(): PluginState {
  return {
    ready: false,
    phase: 'stopped',
    transcript: '',
    answer: null,
    sources: [],
    activity: [],
    pendingProposals: new Map(),
    error: null,
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
      if (event.phase === 'ready') next.ready = true;
      return next;
    }
    case 'token': {
      next.transcript = state.transcript + event.text;
      return next;
    }
    case 'tool_call': {
      next.activity = [
        ...state.activity,
        { id: event.id, name: event.name, status: 'running' },
      ];
      return next;
    }
    case 'tool_result': {
      next.activity = state.activity.map((a) =>
        a.id === event.id ? { ...a, status: event.ok ? ('ok' as const) : ('error' as const) } : a,
      );
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
    case 'error': {
      next.error = event.message;
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
