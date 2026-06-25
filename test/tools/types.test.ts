import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolError, defineTool } from '../../src/tools/types.js';
import type { ToolDef, ToolResult, ToolContext } from '../../src/tools/types.js';

describe('tools/types re-exports', () => {
  it('ToolError carries code + meta', () => {
    const e = new ToolError('bad_args', 'nope', { field: 'pattern' });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('bad_args');
    expect(e.meta).toEqual({ field: 'pattern' });
    expect(e.name).toBe('ToolError');
  });

  it('defineTool preserves name/kind and the schema/execute shape', () => {
    const tool: ToolDef<{ q: string }> = defineTool({
      name: 'noop',
      description: 'does nothing',
      kind: 'read',
      schema: z.object({ q: z.string() }),
      async execute(args: { q: string }, _ctx: ToolContext): Promise<ToolResult> {
        return { content: args.q };
      },
    });
    expect(tool.name).toBe('noop');
    expect(tool.kind).toBe('read');
    expect(tool.schema.safeParse({ q: 'hi' }).success).toBe(true);
  });
});
