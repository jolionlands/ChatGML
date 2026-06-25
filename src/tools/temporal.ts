// src/tools/temporal.ts — time-traversal / file-history query via the active provider.
//
// Answers "what changed in <path> since X" / "history of <path>" by calling
// `ctx.memory.temporalQuery`. Maps Hits to Citations via hitToCitation. Provider throw ->
// provider_error.
import { defineTool, ToolError } from '../tool-error.js';
import type { ToolDef, ToolResult, ToolContext, Citation } from '../types.js';
import { z } from 'zod';
import type { TemporalQuery } from '../memory/types.js';
import { hitToCitation } from '../memory/types.js';
import { deriveGmlMeta } from '../index/files.js';
import { formatHits } from './search.js';

const TemporalArgs = z.object({
  path: z.string().optional().describe('repo-relative path to query history for (omit for all)'),
  kind: z
    .enum(['history', 'changed-since', 'at-time'])
    .optional()
    .describe('query kind (default "history")'),
  since: z.number().int().optional().describe('epoch ms lower bound'),
  until: z.number().int().optional().describe('epoch ms upper bound'),
  limit: z.number().int().positive().max(100).optional(),
});
type TemporalArgs = z.infer<typeof TemporalArgs>;

export const temporalTool: ToolDef<TemporalArgs> = defineTool<TemporalArgs>({
  name: 'temporal_query',
  description:
    'Query the change history of files (e.g. "what changed in obj_player since <time>") via the active memory provider. Returns change events, newest first.',
  kind: 'read',
  schema: TemporalArgs,
  async execute(args: TemporalArgs, ctx: ToolContext): Promise<ToolResult> {
    const q: TemporalQuery = { kind: args.kind ?? 'history' };
    if (args.path !== undefined) q.path = args.path;
    if (args.since !== undefined) q.since = args.since;
    if (args.until !== undefined) q.until = args.until;
    if (args.limit !== undefined) q.limit = args.limit;

    let hits;
    try {
      hits = await ctx.memory.temporalQuery(q, ctx.scope);
    } catch (err) {
      throw new ToolError('provider_error', `temporal_query failed: ${(err as Error).message}`);
    }
    const citations: Citation[] = hits.map((h) => hitToCitation(h, ctx.memory.id, deriveGmlMeta));
    return { content: formatHits('temporal', hits), citations };
  },
});
