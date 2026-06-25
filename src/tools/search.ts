// src/tools/search.ts — semantic + keyword code search via the active MemoryProvider.
//
// A thin adapter: validates args, calls `ctx.memory.search`, and maps each Hit to a Citation via the
// single `hitToCitation` mapping (provider identity = ctx.memory.id, gml derived from path). A
// provider that throws is surfaced as `provider_error` (never leaks an internal stack to the model).
import { defineTool, ToolError } from '../tool-error.js';
import type { ToolDef, ToolResult, ToolContext, Citation } from '../types.js';
import { z } from 'zod';
import { hitToCitation } from '../memory/types.js';
import { deriveGmlMeta } from '../index/files.js';

const SearchArgs = z.object({
  query: z.string().min(1).describe('natural-language or keyword query'),
  k: z.number().int().positive().max(50).optional().describe('max results (default 8)'),
});
type SearchArgs = z.infer<typeof SearchArgs>;

export const searchTool: ToolDef<SearchArgs> = defineTool<SearchArgs>({
  name: 'search_code',
  description:
    'Semantic + keyword search over the indexed codebase via the active memory provider. Returns the most relevant code chunks with citations.',
  kind: 'read',
  schema: SearchArgs,
  async execute(args: SearchArgs, ctx: ToolContext): Promise<ToolResult> {
    const k = args.k ?? 8;
    let hits;
    try {
      hits = await ctx.memory.search(args.query, { k, scope: ctx.scope });
    } catch (err) {
      throw new ToolError('provider_error', `search failed: ${(err as Error).message}`);
    }
    const provider = ctx.memory.id;
    const citations: Citation[] = hits.map((h) => hitToCitation(h, provider, deriveGmlMeta));
    return { content: formatHits('search', hits), citations };
  },
});

export function formatHits(
  label: string,
  hits: Array<{ path?: string; text: string; score: number; startLine?: number; endLine?: number }>,
): string {
  if (hits.length === 0) return `no ${label} results`;
  const lines = hits.map((h, i) => {
    const loc =
      h.path !== undefined
        ? h.startLine !== undefined
          ? `${h.path}:${h.startLine}-${h.endLine ?? h.startLine}`
          : h.path
        : '(memory)';
    const preview = h.text.replace(/\s+/g, ' ').slice(0, 200);
    return `${i + 1}. ${loc} (score ${h.score.toFixed(3)})\n   ${preview}`;
  });
  return `${hits.length} ${label} result(s):\n${lines.join('\n')}`;
}
