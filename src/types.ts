// src/types.ts — THE single shared type vocabulary. Pure types only (erased at runtime).
//
// This file must stay runtime-free: every import is `import type`, there are no values,
// classes, or functions. Runtime helpers (ToolError, defineTool) live in src/tool-error.ts
// so types.ts can never participate in a require cycle.
import type { ZodType } from 'zod';
import type { GmlMeta } from './index/gml.js';
import type { MemoryProvider } from './memory/provider.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type Mode = 'architect' | 'code' | 'ask' | 'debug';

/**
 * Editor context the client (e.g. the GMEdit plugin) attaches to a `user` command so the agent
 * knows what file/selection the human is looking at. All fields optional; absent fields are
 * ignored. This is USER-originated context (the human's current view), not untrusted tool data —
 * the agent may treat it as authoritative about what the user is asking about.
 */
export type Mention = {
  type: 'file' | 'folder' | 'problems' | 'terminal' | 'url' | 'image';
  target: string;
  label?: string;
  content?: string;
};

export interface EditorContext {
  /** Repo-relative path of the currently open file, when known. */
  openFile?: string;
  /** The selected text in the editor (may be multi-line); empty/whitespace selections are dropped. */
  selection?: string;
  /** 1-based line number of the cursor in the open file. */
  cursorLine?: number;
  /** Resolved @mentions assembled by the client and attached as explicit context. */
  mentions?: Mention[];
}

export interface UserCommand {
  type: 'user';
  text: string;
  context?: EditorContext;
  taskId?: string;
}

// OpenAI wire shape; arguments is a JSON STRING (the agent parses it).
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string; // required when role === 'tool'
  name?: string;
}

// What we send in request.tools[].
export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export type OpenAiToolSpec = ToolSpec;

export type ToolCatalogEntry = {
  name: string;
  description: string;
  kind: 'read' | 'gated' | 'command' | 'mcp';
  /** Present when kind === 'mcp': the configured MCP server name. */
  server?: string;
  autoApprove?: boolean;
};

// ONE canonical Scope (the memory lens's {repoId} is renamed to {repo}).
export interface Scope {
  repo: string;
  sub?: string;
}

// Canonical home (avoids a memory<->types cycle); re-exported (type-only) from src/memory/types.ts.
export interface SymbolRef {
  name: string;
  path: string;
  kind?: 'function' | 'class' | 'method' | 'struct' | 'enum' | 'object' | 'event';
}

// THE single source-ref type (frontends' Source merged in). `path` is OPTIONAL because
// hippo memory nodes have no file path (audit: hippo recall has no path field).
export interface Citation {
  path?: string;
  startLine?: number;
  endLine?: number;
  snippet?: string;
  /** Relevance score (0..1 for search/graph). NOT a timestamp — temporal hits use `changedAt`. */
  score?: number;
  provider?: 'local' | 'hippo';
  symbol?: SymbolRef;
  gml?: GmlMeta;
  /** Epoch ms of the change, for temporal-history citations (never overloaded into `score`). */
  changedAt?: number;
  /** The kind of change, for temporal-history citations. */
  changeKind?: 'added' | 'modified' | 'unchanged' | 'deleted';
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

// THE single outbound NDJSON union.
export type AgentEvent =
  | {
      type: 'status';
      // `streaming` is the IDLE HEARTBEAT (GAP5): a slow upstream whose body chunks undici batches on
      // Node25/Win-ARM64 can stall the token read for seconds; the streaming-turn watchdog emits this
      // (at most every IDLE_MS) so a serve client knows the turn is alive during the buffered gap.
      phase: 'ready' | 'thinking' | 'streaming' | 'indexing' | 'idle' | 'done' | 'cancelled';
      detail?: string;
      protocolVersion?: number;
      mode?: Mode;
    }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      ok: boolean;
      content: string;
      citations?: Citation[];
      error?: string;
      code?: string;
    }
  | { type: 'edit_proposal'; id: string; path: string; diff: string }
  | { type: 'approval_request'; id: string; kind: 'edit'; path: string }
  | { type: 'answer'; text: string; sources: Citation[]; usage?: Usage }
  // turn_end: a persistence side-channel. Emitted ONCE at the end of a `user` turn (after the
  // terminal answer/error) carrying the original user text, the finalized assistant text, the
  // turn's citations, and the editor context that was attached to the request. A client that wants
  // to resume a conversation after a restart persists these records and replays them via a
  // `resume` inbound command (see protocol.ts). The reducer treats it as a no-op side signal; it
  // does NOT change the running/answer/phase state (those were already set by the answer event).
  | {
      type: 'turn_end';
      userText: string;
      assistantText: string;
      sources: Citation[];
      context?: EditorContext;
      taskId?: string;
    }
  // Protocol v3 events: command execution lifecycle, checkpointing, and tool catalog.
  | { type: 'pong'; id: string }
  | { type: 'tool_catalog'; tools: ToolCatalogEntry[] }
  | { type: 'checkpoint'; id: string; path: string; label?: string }
  | { type: 'command_request'; id: string; command: string; cwd?: string }
  | { type: 'command_output'; id: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'command_exit'; id: string; code: number }
  // Protocol v4 events: MCP client activity. Emitted when ChatGML acts as an MCP client to
  // external servers; the GMEdit plugin renders these in the activity panel.
  | { type: 'mcp_tool_call'; id: string; name: string; server: string; args?: unknown }
  | {
      type: 'mcp_tool_result';
      id: string;
      name: string;
      server: string;
      ok: boolean;
      content?: string;
      error?: string;
    }
  | {
      type: 'mcp_resource';
      id: string;
      server: string;
      name: string;
      uri?: string;
      content?: string;
    }
  | { type: 'error'; message: string; code?: string };

// ONE approval request shape used by BOTH ToolContext and ApprovalGate.
export type ApprovalRequest =
  | {
      id: string;
      kind: 'edit';
      path: string;
      diff: string;
      /**
       * AUTO-MODE DESTRUCTIVE-EDIT BACKSTOP (GAP4). When `true`, the gate WAITS for an explicit human
       * approve/reject EVEN in `auto` mode (it does not auto-resolve). The edit tool sets this for
       * HIGH-RISK diffs (whole-file rewrite / mass deletion / net deletion beyond a threshold) so an
       * injection-driven destructive edit cannot apply with no human in the loop. Small, additive,
       * in-place auto edits leave it unset and still auto-apply. Absent ⇒ false (existing behavior).
       */
      forceGate?: boolean;
      /**
       * Per-request policy override. When set, the gate uses this instead of the global autoApprove
       * setting, so per-tool approval policies can override the config default for one request.
       */
      policy?: 'gated' | 'auto';
      /**
       * Per-block approval tracking. Indices of hunks/blocks still pending a decision. Populated by
       * the edit tool/agent loop so the gate can resolve individual blocks. Absent ⇒ whole-proposal.
       */
      blocks?: number[];
      /**
       * Populated by the gate on resolution: the indices that were ultimately approved. When `blocks`
       * was set and the resolution is partial, this is a strict subset; when all blocks are approved
       * it equals the original `blocks` array; on full rejection it is empty.
       */
      approvedBlocks?: number[];
    }
  | { id: string; kind: 'exec'; command: string; cwd?: string; policy?: 'gated' | 'auto' };

/** Result of an approval request: full approve, full reject, or partial approve with approved blocks. */
export type ApprovalResolution = { approved: true; blocks?: number[] } | { approved: false };

// ToolErrorCode is a type (the ToolError CLASS lives in src/tool-error.ts to keep this file runtime-free).
export type ToolErrorCode =
  | 'sandbox_escape'
  | 'not_found'
  | 'too_large'
  | 'binary'
  | 'bad_args'
  | 'bad_patch'
  | 'not_implemented'
  | 'provider_error'
  | 'aborted'
  | 'timeout'
  | 'nonzero_exit'
  | 'interrupted';

export interface ToolResult {
  content: string;
  citations?: Citation[];
  isError?: boolean;
}

export interface ToolContext {
  readonly root: string;
  readonly scope: Scope;
  readonly memory: MemoryProvider;
  readonly approval: 'gated' | 'auto';
  readonly toolApproval?: Record<string, 'gated' | 'auto'>;
  readonly ignore: IgnoreFilter;
  readonly signal: AbortSignal;
  /**
   * Optional config-level absolute cosine floor for `search_code` (`search.minScore`). A per-call
   * `minScore` tool arg overrides it; undefined here AND in the arg means no floor.
   */
  readonly searchMinScore?: number;
  /** The tool-call id from the model turn; useful for correlating approval/execution events. */
  readonly toolCallId?: string;
  /** True when the agent loop has already obtained human approval for this call. */
  readonly preApproved?: boolean;
  /**
   * When the agent loop pre-approved an edit with per-block granularity, the indices of the blocks
   * that were approved (undefined means the whole proposal was approved). The edit tools use this to
   * apply only the approved subset when mixed approval is resolved.
   */
  readonly approvedBlocks?: number[];
  emit(event: AgentEvent): void;
  requestApproval(req: ApprovalRequest): Promise<ApprovalResolution>;
  log(level: 'debug' | 'info' | 'warn', msg: string, meta?: Record<string, unknown>): void;
}

// The ONE tool contract. execute ALWAYS returns ToolResult (no generic R).
export interface ToolDef<A> {
  readonly name: string;
  readonly description: string;
  readonly schema: ZodType<A>;
  readonly kind: 'read' | 'gated' | 'command' | 'mcp';
  /** Present when kind === 'mcp': the configured MCP server name. */
  server?: string;
  /**
   * Optional override JSON Schema for OpenAI tool-spec generation. Used for MCP tools so the
   * advertised parameters match the external server's inputSchema instead of a permissive zod
   * fallback.
   */
  inputSchema?: Record<string, unknown>;
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}
export type Tool = ToolDef<unknown>;
export type ToolRegistry = ReadonlyMap<string, Tool>;

// IgnoreFilter is co-located in src/index/files.ts; re-declared as a type here to avoid a runtime edge.
export interface IgnoreFilter {
  ignores(repoRelPosixPath: string): boolean;
}

// ---- Config types (single home; src/config.ts imports these, does not redeclare) ----
export interface ChatLane {
  baseURL: string;
  apiKey?: string;
  model: string;
  temperature: number;
  maxTokens?: number;
}
export interface EmbedLane {
  baseURL: string;
  apiKey?: string;
  model: string;
  batchSize: number;
}
// ONE discriminated union for memory config (audit: declared exactly once, here).
export type MemoryConfig = { provider: 'local' } | { provider: 'hippo'; url: string; key?: string };

// Retrieval-tuning lane. `minScore` is an OPT-IN absolute cosine floor for `search_code` (raw cosine
// of the L2-normalized query/chunk embeddings, ~[0,1]); when set, semantic hits below it are dropped.
// Undefined (the default) means NO floor — existing behavior is unchanged. Tune against a REAL embedder.
export interface SearchConfig {
  minScore?: number;
}

/** External MCP server configuration (ChatGML acts as an MCP client). */
export interface McpServerConfig {
  /** Display name; falls back to the record key when omitted. */
  name?: string;
  /** Stdio command to spawn. Required for stdio transport. */
  command?: string;
  /** Arguments passed to `command`. */
  args?: string[];
  /** Extra environment variables for the spawned process. */
  env?: Record<string, string>;
  /** SSE endpoint URL. Not yet implemented (stdio is the MVP transport). */
  url?: string;
  /** Request timeout in milliseconds. */
  timeout?: number;
  /** When true, this server is skipped during initialization. */
  disabled?: boolean;
}

export interface Config {
  chat: ChatLane;
  embed: EmbedLane;
  memory: MemoryConfig;
  scope: string; // converted to Scope via makeScope at the wiring seam
  mode: Mode;
  approval: 'gated' | 'auto';
  toolApproval?: Record<string, 'gated' | 'auto'>;
  index: { chunkSize: number; chunkOverlap: number; root: string };
  search: SearchConfig;
  /** External MCP servers whose tools/resources ChatGML can use. */
  mcpServers?: Record<string, McpServerConfig>;
}
