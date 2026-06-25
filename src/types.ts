// src/types.ts — THE single shared type vocabulary. Pure types only (erased at runtime).
//
// This file must stay runtime-free: every import is `import type`, there are no values,
// classes, or functions. Runtime helpers (ToolError, defineTool) live in src/tool-error.ts
// so types.ts can never participate in a require cycle.
import type { ZodType } from 'zod';
import type { GmlMeta } from './index/gml.js';
import type { MemoryProvider } from './memory/provider.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

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
  score?: number;
  provider?: 'local' | 'hippo';
  symbol?: SymbolRef;
  gml?: GmlMeta;
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
      phase: 'ready' | 'thinking' | 'indexing' | 'idle' | 'done' | 'cancelled';
      detail?: string;
      protocolVersion?: number;
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
    }
  | { type: 'edit_proposal'; id: string; path: string; diff: string }
  | { type: 'approval_request'; id: string; kind: 'edit'; path: string }
  | { type: 'answer'; text: string; sources: Citation[]; usage?: Usage }
  | { type: 'error'; message: string; code?: string };

// ONE approval request shape used by BOTH ToolContext and ApprovalGate.
export interface ApprovalRequest {
  id: string;
  kind: 'edit';
  path: string;
  diff: string;
}

// ToolErrorCode is a type (the ToolError CLASS lives in src/tool-error.ts to keep this file runtime-free).
export type ToolErrorCode =
  | 'sandbox_escape'
  | 'not_found'
  | 'too_large'
  | 'binary'
  | 'bad_args'
  | 'not_implemented'
  | 'provider_error'
  | 'aborted';

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
  readonly ignore: IgnoreFilter;
  readonly signal: AbortSignal;
  emit(event: AgentEvent): void;
  requestApproval(req: ApprovalRequest): Promise<boolean>;
  log(level: 'debug' | 'info' | 'warn', msg: string, meta?: Record<string, unknown>): void;
}

// The ONE tool contract. execute ALWAYS returns ToolResult (no generic R).
export interface ToolDef<A> {
  readonly name: string;
  readonly description: string;
  readonly schema: ZodType<A>;
  readonly kind: 'read' | 'gated';
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
export type MemoryConfig =
  | { provider: 'local' }
  | { provider: 'hippo'; url: string; key?: string };

export interface Config {
  chat: ChatLane;
  embed: EmbedLane;
  memory: MemoryConfig;
  scope: string; // converted to Scope via makeScope at the wiring seam
  approval: 'gated' | 'auto';
  index: { chunkSize: number; chunkOverlap: number; root: string };
}
