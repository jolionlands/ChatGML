// src/tool-error.ts — runtime-only (a class + a function), so src/types.ts stays purely erasable.
import type { ToolDef, ToolErrorCode } from './types.js';

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

// Identity helper that preserves the literal type of a tool definition.
export function defineTool<A>(def: ToolDef<A>): ToolDef<A> {
  return def;
}
