// src/index.ts — public barrel (the integration surface).
//
// Re-exports the shared types, config, llm client, the index pipeline (files/chunk/embeddings/gml/
// indexer), and the memory layer (provider seam + local/hippo backends). Agent/tools land in M3.
export type * from './types.js';
export * from './tool-error.js';
export * from './config.js';
export * from './llm.js';

// Index pipeline.
export * from './index/gml.js';
export * from './index/files.js';
export * from './index/chunk.js';
export * from './index/embeddings.js';
export * from './index/indexer.js';
export * from './index/run-index.js';

// fs-aware GameMaker .yy/.yyp resolution (collision targets + object inheritance).
export { parseYy, YyError, loadResourceMap, loadObjectMeta, eventKeyFor } from './index/yy.js';
export type {
  ReadFile,
  YyRef,
  ResourceKind,
  ResourceMap,
  ResourceMapEntry,
  ObjectMeta,
  EventKey,
} from './index/yy.js';
export { buildGmResolver, findYypOnDisk, defaultReader } from './index/gm-resolver.js';
export type { GmResolver, BuildResolverOptions } from './index/gm-resolver.js';
export {
  applyEnrichment,
  createEnrichedGmlDeriver,
  loadEnrichmentSidecar,
  enrichmentSidecarPath,
  writeEnrichmentSidecar,
  ENRICHMENT_VERSION,
} from './index/gml-enrich.js';
export type { GmEnrichment, EnrichmentSidecar } from './index/gml-enrich.js';

// Memory layer.
export * from './memory/types.js';
export * from './memory/provider.js';
export * from './memory/persist.js';
export * from './memory/bm25.js';
export * from './memory/fusion.js';
export { LocalMemoryProvider } from './memory/local.js';
export { HippoMemoryProvider } from './memory/hippo.js';

// ---------------------------------------------------------------------------
// M3 — agent, protocol, tools, serve, CLI (named exports to avoid barrel collisions).
// ---------------------------------------------------------------------------
export {
  PROTOCOL_VERSION,
  InEventSchema,
  ClientCommandSchema,
  encodeEvent,
  parseInEvent,
  NdjsonDecoder,
  ProtocolError,
  writeEvent,
  isAgentEvent,
} from './protocol.js';
export type { InEvent, ClientCommand } from './protocol.js';

export {
  runAgent,
  createApprovalGate,
  buildSystemPrompt,
  createAgentLike,
  DEFAULT_MAX_STEPS,
} from './agent.js';
export type {
  AgentDeps,
  AgentOptions,
  AgentRunResult,
  AgentLike,
  AgentLikeDeps,
  ApprovalGate,
  LlmLike,
} from './agent.js';

// Tools.
export {
  buildToolRegistry,
  toOpenAiToolSpecs,
  dispatchTool,
  globTool,
  grepTool,
  readTool,
  searchTool,
  graphTool,
  temporalTool,
  editTool,
  searchReplaceTool,
} from './tools/index.js';
export type { BuildRegistryOptions, DispatchResult } from './tools/index.js';
export {
  assertInsideRoot,
  resolveInsideRoot,
  isInsideRoot,
  toPosix,
  SandboxError,
} from './tools/sandbox.js';
export { editProposalId } from './tools/edit.js';

// Serve transport.
export { runServe, createStdioTransport } from './serve.js';
export type { Transport, ServeOptions } from './serve.js';

// MCP server (Model Context Protocol over stdio — the agent-IDE leverage route).
export { runMcpServer, MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, MCP_SERVER_VERSION } from './mcp.js';
export type { McpTransport, McpServerDeps } from './mcp.js';

// CLI surface.
export { main as runCli, buildProgram } from './cli.js';
export type { CliDeps, CliIo } from './cli.js';

// CLI rendering (for embedders building their own front-end).
export { EventRenderer, runChatRepl } from './cli/repl.js';
export type { LineSource, ReplDeps, RendererOptions } from './cli/repl.js';
export { supportsColor, styles, diffLine, colorizeDiff, Spinner } from './cli/theme.js';
