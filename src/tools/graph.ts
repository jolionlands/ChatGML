// src/tools/graph.ts — graph-neighbor / related-symbol traversal via the active provider.
//
// Resolves a symbol reference (name + path) to its neighbors through `ctx.memory.graphNeighbors`.
// Maps Hits to Citations via hitToCitation. Provider throw -> provider_error.
import { defineTool, ToolError } from '../tool-error.js';
import type { ToolDef, ToolResult, ToolContext, Citation } from '../types.js';
import { z } from 'zod';
import { hitToCitation } from '../memory/types.js';
import { deriveGmlMeta } from '../index/files.js';
import { formatHits } from './search.js';

const GraphArgs = z.object({
  name: z.string().min(1).describe('symbol name, e.g. "apply_dmg" or "obj_player"'),
  path: z.string().optional().describe('repo-relative path the symbol lives in (improves precision)'),
  kind: z
    .enum(['function', 'class', 'method', 'struct', 'enum', 'object', 'event'])
    .optional(),
});
type GraphArgs = z.infer<typeof GraphArgs>;

export const graphTool: ToolDef<GraphArgs> = defineTool<GraphArgs>({
  name: 'graph_neighbors',
  description:
    'Find code related to a symbol (same-file chunks, name references, and KG edges where available) via the active memory provider. Returns related chunks with citations.',
  kind: 'read',
  schema: GraphArgs,
  async execute(args: GraphArgs, ctx: ToolContext): Promise<ToolResult> {
    const ref = {
      name: args.name,
      path: args.path ?? '',
      ...(args.kind ? { kind: args.kind } : {}),
    };
    let hits;
    try {
      hits = await ctx.memory.graphNeighbors(ref, ctx.scope);
    } catch (err) {
      throw new ToolError('provider_error', `graph_neighbors failed: ${(err as Error).message}`);
    }
    const citations: Citation[] = hits.map((h) => hitToCitation(h, ctx.memory.id, deriveGmlMeta));
    return { content: formatHits('graph', hits), citations };
  },
});
