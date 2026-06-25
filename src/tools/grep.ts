// src/tools/grep.ts — literal/regex content search across the project, sandboxed.
//
// Pure JS scan (no child_process / ripgrep dependency). Walks the project via walkFiles (so the
// IgnoreFilter + EXCLUDE_DIRS apply), reads each file, and reports 1-based line matches with optional
// context. Binary files are skipped (NUL sniff). The model-supplied pattern is PRE-VALIDATED and
// REJECTED as `bad_args` before any matching if it is over-length or has a nested-quantifier ReDoS
// shape — there is no in-flight regex timeout (single thread can't interrupt a match), so prevention
// is by rejection. A per-call match budget + ctx.signal bound the file fan-out.
import fsp from 'node:fs/promises';
import { defineTool, ToolError } from '../tool-error.js';
import type { ToolDef, ToolResult, ToolContext } from '../types.js';
import { z } from 'zod';
import { walkFiles } from '../index/files.js';

const MAX_PATTERN_LEN = 512;
const DEFAULT_MAX_MATCHES = 100;
const MAX_MAX_MATCHES = 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const GrepArgs = z.object({
  pattern: z.string().min(1).max(MAX_PATTERN_LEN).describe('literal text or regex to search for'),
  regex: z.boolean().optional().describe('treat pattern as a JS regex (default false = literal)'),
  ignoreCase: z.boolean().optional(),
  glob: z.string().optional().describe('restrict to files matching this glob (e.g. "**/*.gml")'),
  contextLines: z.number().int().min(0).max(10).optional(),
  maxMatches: z.number().int().positive().max(MAX_MAX_MATCHES).optional(),
});
type GrepArgs = z.infer<typeof GrepArgs>;

/**
 * Reject patterns whose shape can cause catastrophic backtracking. Heuristic: a quantified group
 * immediately followed by another quantifier — `(x+)+`, `(x*)*`, `(x+)*`, `(x*)+`, and the `{n,}`
 * variants. Not exhaustive, but it catches the classic exponential blowups.
 */
function isReDoSShape(pattern: string): boolean {
  // group ending in a quantifier, then an outer quantifier
  const nested = /\([^)]*[+*]\)[+*]|\([^)]*\{\d+,\}\)[+*{]|\([^)]*[+*]\)\{\d+,\}/;
  return nested.test(pattern);
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const grepTool: ToolDef<GrepArgs> = defineTool<GrepArgs>({
  name: 'grep',
  description:
    'Search file contents for literal text or a regex across the project. Returns matching file:line entries (1-based) with optional context. Read-only; sandboxed.',
  kind: 'read',
  schema: GrepArgs,
  async execute(args: GrepArgs, ctx: ToolContext): Promise<ToolResult> {
    if (args.regex && isReDoSShape(args.pattern)) {
      throw new ToolError('bad_args', 'rejected pattern with nested-quantifier (ReDoS) shape');
    }
    let re: RegExp;
    try {
      const flags = args.ignoreCase ? 'i' : '';
      re = args.regex
        ? new RegExp(args.pattern, flags)
        : new RegExp(escapeLiteral(args.pattern), flags);
    } catch (err) {
      throw new ToolError('bad_args', `invalid regex: ${(err as Error).message}`);
    }

    const maxMatches = Math.min(args.maxMatches ?? DEFAULT_MAX_MATCHES, MAX_MAX_MATCHES);
    const context = args.contextLines ?? 0;
    const globRe = args.glob ? globToRegExp(args.glob) : null;

    const results: string[] = [];
    let matchCount = 0;
    let truncated = false;

    outer: for await (const file of walkFiles(ctx.root, (p) => ctx.ignore.ignores(p), {
      allExtensions: true,
    })) {
      if (ctx.signal.aborted) throw new ToolError('aborted', 'grep aborted');
      if (globRe && !globRe.test(file.relPath)) continue;

      let buf: Buffer;
      try {
        const stat = await fsp.stat(file.absPath);
        if (stat.size > MAX_FILE_BYTES) continue;
        buf = await fsp.readFile(file.absPath);
      } catch {
        continue;
      }
      if (looksBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');

      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          const lo = Math.max(0, i - context);
          const hi = Math.min(lines.length - 1, i + context);
          const block: string[] = [];
          for (let j = lo; j <= hi; j++) {
            const marker = j === i ? ':' : '-';
            block.push(`${file.relPath}${marker}${j + 1}${marker} ${lines[j]}`);
          }
          results.push(block.join('\n'));
          matchCount++;
          if (matchCount >= maxMatches) {
            truncated = true;
            break outer;
          }
        }
      }
    }

    if (results.length === 0) return { content: 'no matches' };
    const header = `${matchCount} match(es)${truncated ? ' (truncated)' : ''}`;
    return { content: `${header}\n${results.join('\n')}` };
  },
});

/** Minimal glob -> RegExp for the optional file filter (matches against repo-relative POSIX path). */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
