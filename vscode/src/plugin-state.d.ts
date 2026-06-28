// vscode/src/plugin-state.d.ts — ambient types for the core's CommonJS plugin/state.js so the VS
// Code extension's TS build has full types without importing the ESM source. The runtime module is
// a verified CommonJS port of src/plugin-runtime.ts; this surface mirrors its public exports.
declare module 'chatgml-plugin-state' {
  export class NdjsonLineBuffer {
    push(chunk: string | Uint8Array): { events: unknown[]; malformed: string[] };
    flush(): { events: unknown[]; malformed: string[] };
  }
  export function isReadyHandshake(e: unknown): e is {
    type: 'status';
    phase: 'ready';
    protocolVersion: number;
  };
  export interface ServeArgvOptions {
    dir: string;
    chat?: { baseURL?: string; model?: string };
    embed?: { baseURL?: string; model?: string };
    scope?: string;
    approval?: 'gated' | 'auto';
    trustProjectConfig?: boolean;
  }
  export function buildServeArgv(opts: ServeArgvOptions): string[];
  export interface ResolvedBinary {
    cmd: string;
    argvPrefix: string[];
  }
  export interface ResolveBinaryOpts {
    configuredPath?: string;
    env: Record<string, string | undefined>;
    platform: NodeJS.Platform;
    distCliPath: string;
    nodePath: string;
    exists: (p: string) => boolean;
  }
  export function resolveServeBinary(opts: ResolveBinaryOpts): ResolvedBinary;

  export interface EditorContextLike {
    openFile?: string;
    selection?: string;
    cursorLine?: number;
  }
  export function buildEditorContext(opts: EditorContextLike): EditorContextLike | undefined;

  export interface ActivityEntry {
    id: string;
    name: string;
    status: 'running' | 'ok' | 'error';
  }
  export interface PendingProposal {
    id: string;
    path: string;
    diff: string;
  }
  export interface CitationLike {
    path?: string;
    startLine?: number;
    endLine?: number;
    snippet?: string;
    provider?: 'local' | 'hippo';
  }
  export interface PluginState {
    ready: boolean;
    phase: string;
    transcript: string;
    answer: string | null;
    sources: CitationLike[];
    activity: ActivityEntry[];
    pendingProposals: Map<string, PendingProposal>;
    error: string | null;
    checkpoints: { id: string; path: string; label?: string }[];
  }
  export function initialPluginState(): PluginState;
  export function reducePluginState(event: unknown, state: PluginState): PluginState;
  export function settleProposal(id: string, state: PluginState): PluginState;

  export type SlashCommand =
    | { kind: 'clear' }
    | { kind: 'reindex' }
    | { kind: 'resume' }
    | { kind: 'scope'; value: string }
    | { kind: 'model'; value: string }
    | { kind: 'approval'; value: 'gated' | 'auto' }
    | { kind: 'undo'; checkpointId?: string }
    | { kind: 'help' }
    | { kind: 'unknown'; name: string }
    | { kind: 'empty'; name: string };
  export function parseSlashCommand(line: string): SlashCommand | null;
  export const SLASH_HELP: readonly string[];

  export interface ResumableMessageLike {
    role: 'user' | 'assistant';
    content: string | null;
  }
  export function turnEndToMessages(
    turns: Array<{ userText: string; assistantText: string }>,
  ): ResumableMessageLike[];
  export function buildResumeCommand(turns: Array<{ userText: string; assistantText: string }>): {
    type: 'resume';
    messages: ResumableMessageLike[];
  };
}
