// src/tools/types.ts — the tool layer's type/runtime re-export barrel.
//
// Tools import from here (not directly from src/types.ts + src/tool-error.ts) so the tool surface
// has a single, stable import point. Types are re-exported type-only; ToolError/defineTool are the
// only runtime values.
export type {
  ToolDef,
  Tool,
  ToolRegistry,
  ToolContext,
  ToolResult,
  ToolErrorCode,
  ApprovalRequest,
  OpenAiToolSpec,
  ToolSpec,
  Citation,
  Scope,
  IgnoreFilter,
} from '../types.js';

export { ToolError, defineTool } from '../tool-error.js';
