// src/tools/glob.ts — find files by glob pattern, sandboxed to the project root.
//
// Uses fast-glob with `cwd: root`, `dot: false`, `onlyFiles: true`. Results are repo-relative POSIX
// paths; every result is re-checked through the sandbox (defense in depth — fast-glob's `cwd`
// already scopes it, but a `../` in the pattern could otherwise escape). Ignored paths (via the
// IgnoreFilter) and EXCLUDE_DIRS are filtered out. A `limit` (default 200, cap 5000) truncates.
import fg from 'fast-glob';
import { defineTool } from '../tool-error.js';
import { ToolError } from '../tool-error.js';
import type { ToolDef, ToolResult, ToolContext } from '../types.js';
import { z } from 'zod';
import { isInsideRoot, toPosix } from './sandbox.js';
import { EXCLUDE_DIRS, deriveGmlMeta } from '../index/files.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;

const GlobArgs = z.object({
  pattern: z.string().min(1).describe('a glob pattern, e.g. "objects/**/*.gml"'),
  limit: z.number().int().positive().max(MAX_LIMIT).optional().describe('max results (default 200)'),
});
type GlobArgs = z.infer<typeof GlobArgs>;

export const globTool: ToolDef<GlobArgs> = defineTool<GlobArgs>({
  name: 'glob',
  description:
    'Find files in the project by glob pattern (e.g. "scripts/**/*.gml"). Returns repo-relative paths. Read-only; sandboxed to the project root.',
  kind: 'read',
  schema: GlobArgs,
  async execute(args: GlobArgs, ctx: ToolContext): Promise<ToolResult> {
    if (args.pattern.includes('\0')) throw new ToolError('bad_args', 'pattern contains a null byte');
    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    let matches: string[];
    try {
      matches = await fg(args.pattern, {
        cwd: ctx.root,
        dot: false,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
        ignore: EXCLUDE_DIRS.map((d) => `**/${d}/**`),
      });
    } catch (err) {
      throw new ToolError('bad_args', `invalid glob pattern: ${(err as Error).message}`);
    }

    const out: string[] = [];
    for (const m of matches) {
      if (ctx.signal.aborted) throw new ToolError('aborted', 'glob aborted');
      const rel = toPosix(m);
      if (!isInsideRoot(ctx.root, rel)) continue;
      if (ctx.ignore.ignores(rel)) continue;
      out.push(rel);
      if (out.length >= limit) break;
    }
    out.sort();

    const lines = out.map((p) => {
      const meta = deriveGmlMeta(p);
      return meta && meta.kind === 'event' ? `${p}  [${meta.displayName}]` : p;
    });
    const truncated = matches.length > out.length && out.length >= limit;
    const header = `${out.length} file(s)${truncated ? ' (truncated)' : ''}`;
    return {
      content: out.length === 0 ? 'no files matched' : `${header}\n${lines.join('\n')}`,
    };
  },
});
