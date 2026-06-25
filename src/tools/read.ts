// src/tools/read.ts — read a file (or a 1-based line window), sandboxed + symlink-checked.
//
// Routes through `resolveInsideRoot` (lexical + realpath of the deepest existing ancestor) so a
// symlinked dir cannot leak a file outside the root. A 1MB size cap (`too_large`) and a NUL-byte
// binary sniff (`binary`) bound what is returned. `startLine`/`endLine` are 1-based and clamped to
// the file; endLine < startLine is `bad_args`. The result carries a single Citation for the read
// region (with GML metadata when the path is a GameMaker resource).
import fsp from 'node:fs/promises';
import { defineTool, ToolError } from '../tool-error.js';
import type { ToolDef, ToolResult, ToolContext, Citation } from '../types.js';
import { z } from 'zod';
import { resolveInsideRoot, toPosix, SandboxError } from './sandbox.js';
import { deriveGmlMeta } from '../index/files.js';

const MAX_BYTES = 1024 * 1024; // 1MB

const ReadArgs = z.object({
  path: z.string().min(1).describe('repo-relative file path, e.g. "objects/obj_player/Step_0.gml"'),
  startLine: z.number().int().positive().optional().describe('1-based start line (inclusive)'),
  endLine: z.number().int().positive().optional().describe('1-based end line (inclusive)'),
});
type ReadArgs = z.infer<typeof ReadArgs>;

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const readTool: ToolDef<ReadArgs> = defineTool<ReadArgs>({
  name: 'read_file',
  description:
    'Read a file (or a 1-based line range) from the project. Returns the text plus a citation. Read-only; sandboxed to the project root.',
  kind: 'read',
  schema: ReadArgs,
  async execute(args: ReadArgs, ctx: ToolContext): Promise<ToolResult> {
    if (args.startLine !== undefined && args.endLine !== undefined && args.endLine < args.startLine) {
      throw new ToolError('bad_args', 'endLine must be >= startLine');
    }

    let abs: string;
    try {
      abs = await resolveInsideRoot(ctx.root, args.path);
    } catch (err) {
      if (err instanceof SandboxError) {
        throw new ToolError('sandbox_escape', `path escapes the project root: ${args.path}`, {
          reason: err.reason,
        });
      }
      throw err;
    }

    let buf: Buffer;
    try {
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) throw new ToolError('not_found', `not a file: ${args.path}`);
      if (stat.size > MAX_BYTES) {
        throw new ToolError('too_large', `file exceeds ${MAX_BYTES} bytes: ${args.path}`, {
          size: stat.size,
        });
      }
      buf = await fsp.readFile(abs);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new ToolError('not_found', `file not found: ${args.path}`);
      throw new ToolError('not_found', `cannot read file: ${args.path}`);
    }

    if (looksBinary(buf)) {
      throw new ToolError('binary', `refusing to read binary file: ${args.path}`);
    }

    const rel = toPosix(args.path).replace(/^\.\//, '');
    const allLines = buf.toString('utf8').split('\n');
    const total = allLines.length;

    let start = 1;
    let end = total;
    if (args.startLine !== undefined) start = Math.min(args.startLine, total);
    if (args.endLine !== undefined) end = Math.min(args.endLine, total);
    if (start > end) end = start;

    const slice = allLines.slice(start - 1, end);
    const numbered = slice.map((l, i) => `${start + i}\t${l}`).join('\n');

    const citation: Citation = {
      path: rel,
      startLine: start,
      endLine: end,
      provider: 'local',
    };
    const meta = deriveGmlMeta(rel);
    if (meta) citation.gml = meta;

    return {
      content: numbered,
      citations: [citation],
    };
  },
});
