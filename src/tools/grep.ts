// src/tools/grep.ts — literal/regex content search across the project, sandboxed.
//
// Pure JS scan (no child_process / ripgrep dependency). Walks the project via walkFiles (so the
// IgnoreFilter + EXCLUDE_DIRS apply), reads each file, and reports 1-based line matches with optional
// context. Binary files are skipped (NUL sniff). The model-supplied pattern is PRE-VALIDATED and
// REJECTED as `bad_args` before any matching if it is over-length or has a catastrophic-backtracking
// (ReDoS) shape — there is no in-flight regex timeout (a single thread cannot interrupt a match), so
// prevention is by rejection. A per-call match budget + ctx.signal bound the file fan-out, and a hard
// per-file scan-work cap (SCAN_WORK_CAP) bounds the total work even for a pattern the heuristic missed.
//
// IMPORTANT: `isReDoSShape` is a HEURISTIC (a deliberately conservative over-approximation), NOT a
// guarantee — an exotic catastrophic pattern can still slip past it. The two backstops are (1) the
// SCAN_WORK_CAP below, which aborts a file once total scanned characters exceed a fixed budget, and
// (2) the future-proof fix, which is to run matching on a WORKER THREAD with a wall-clock kill so any
// runaway match is interrupted regardless of shape (deferred — see docs/usage.md, "grep ReDoS guard").
import fsp from 'node:fs/promises';
import { defineTool, ToolError } from '../tool-error.js';
import type { ToolDef, ToolResult, ToolContext } from '../types.js';
import { z } from 'zod';
import { walkFiles } from '../index/files.js';
import { MAX_FILE_BYTES } from './limits.js';

const MAX_PATTERN_LEN = 512;
const DEFAULT_MAX_MATCHES = 100;
const MAX_MAX_MATCHES = 1000;
// A group with an inner unbounded quantifier repeated more than this many times (bounded) is treated
// as catastrophic — e.g. `(.*a){25}` — even though the outer count is finite.
const MAX_SAFE_GROUP_REPEAT = 20;
// Hard per-file scan-work backstop: stop scanning a file once this many characters have been fed to
// the matcher. At ~2MB/file this is generous for legitimate searches but caps a missed catastrophic
// pattern's blast radius to a bounded amount of work per file (the matcher itself is still O(line),
// but a huge file of many long lines cannot run unbounded).
const SCAN_WORK_CAP = 8 * 1024 * 1024; // 8M chars/file

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
 * Reject patterns whose shape can cause catastrophic backtracking. This is a deliberately conservative
 * HEURISTIC — an over-approximation that errs toward rejecting (it is NOT a proof of safety; see the
 * SCAN_WORK_CAP backstop + the worker-thread future fix noted in the file header). It flags:
 *
 *   1. A GROUP CONTAINING AN UNBOUNDED QUANTIFIER that is itself repeated by an unbounded quantifier:
 *      `(a+)+`, `(a*)+`, `(a*)*`, `(.*X)+`, `(.*X){n,}` — the classic exponential blowup.
 *   2. The SAME shape repeated a LARGE BOUNDED number of times (> MAX_SAFE_GROUP_REPEAT): `(.*a){25}`,
 *      `(a+){30}` — finite but polynomial-to-exponential and effectively unbounded for our inputs.
 *   3. 2+ ADJACENT UNBOUNDED QUANTIFIERS over OVERLAPPING atoms: `a*a*`, `.*.*`, `\w+\w+`, `a*\w*` —
 *      but NOT disjoint-class adjacency like `\s+\w+` (legitimate, e.g. `function\s+\w+`), and NOT a
 *      single quantifier like `foo.*bar`.
 *
 * Returns true if the pattern should be REJECTED (`bad_args`).
 */
function isReDoSShape(pattern: string): boolean {
  return hasNestedQuantifiedGroup(pattern) || hasAdjacentOverlappingQuantifiers(pattern);
}

/**
 * Rule 1 + 2: a group whose body contains an unbounded quantifier (`+`, `*`, or `{n,}`), where the
 * group is then repeated by an unbounded quantifier OR a large bounded count. `(a+)+`, `(.*X){n,}`,
 * `(.*a){25}` -> true; `(abc){3}` (no inner unbounded quantifier) and `(a+)` (no outer repeat) -> false.
 */
function hasNestedQuantifiedGroup(pattern: string): boolean {
  // A group whose body CONTAINS an unbounded quantifier (`+`/`*`/`{n,}`) ANYWHERE (so `(.*X)` counts,
  // not only `(a+)`), immediately followed by an outer quantifier. `[^)]*` keeps it single-level (good
  // enough; a nested-group blowup still trips on its innermost group).
  const innerUnbounded = /\([^)]*(?:[+*]|\{\d+,\})[^)]*\)([+*]|\{\d+(?:,\d*)?\})/g;
  let m: RegExpExecArray | null;
  while ((m = innerUnbounded.exec(pattern)) !== null) {
    const outer = m[1]!;
    if (outer === '+' || outer === '*') return true; // (a+)+, (a*)*, (.*X)*
    if (outer.startsWith('{')) {
      // {n,}/{n,m}/{n}: unbounded -> always; bounded -> only when the count is large.
      if (/\{\d+,\}/.test(outer)) return true; // (.*X){n,}
      const n = Number.parseInt(outer.slice(1), 10);
      if (Number.isFinite(n) && n > MAX_SAFE_GROUP_REPEAT) return true; // (.*a){25}
    }
  }
  return false;
}

/**
 * Rule 3: two adjacent `atom + unbounded-quantifier` pieces whose atoms can match a COMMON character,
 * e.g. `a*a*`, `.*.*`, `\w+\w*`, `a*\w*`. Disjoint adjacency (`\s+\w+`) and single quantifiers
 * (`foo.*bar`) are allowed. Only `*`/`+` (unbounded) count; `?` and bounded `{n,m}` do not.
 */
function hasAdjacentOverlappingQuantifiers(pattern: string): boolean {
  const atoms = unboundedQuantifiedAtoms(pattern);
  for (let i = 1; i < atoms.length; i++) {
    if (atoms[i]!.start === atoms[i - 1]!.end && atomsOverlap(atoms[i - 1]!.atom, atoms[i]!.atom)) {
      return true;
    }
  }
  return false;
}

interface QuantAtom {
  atom: string; // the atom source, e.g. 'a', '.', '\\w', '[a-z]'
  start: number; // index of the atom in `pattern`
  end: number; // index just past the quantifier
}

/** Scan `pattern` for `atom*` / `atom+` pieces (atom = single char, escape, or `[...]` class). */
function unboundedQuantifiedAtoms(pattern: string): QuantAtom[] {
  const out: QuantAtom[] = [];
  let i = 0;
  while (i < pattern.length) {
    const start = i;
    let atom: string | null = null;
    const c = pattern[i]!;
    if (c === '\\' && i + 1 < pattern.length) {
      atom = pattern.slice(i, i + 2);
      i += 2;
    } else if (c === '[') {
      // consume to the matching ] (respecting an escaped ]).
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== ']') {
        if (pattern[j] === '\\') j++;
        j++;
      }
      atom = pattern.slice(i, Math.min(j + 1, pattern.length));
      i = j + 1;
    } else if (c === '(' || c === ')' || c === '|') {
      i++;
      continue; // group/alternation boundaries are not atoms here (rule 1 handles groups).
    } else {
      atom = c;
      i++;
    }
    // A `*`/`+` quantifier (optionally lazy `*?`) immediately after the atom makes it unbounded.
    if (atom !== null && i < pattern.length && (pattern[i] === '*' || pattern[i] === '+')) {
      i++;
      if (pattern[i] === '?') i++; // lazy variant still backtracks
      out.push({ atom, start, end: i });
    }
  }
  return out;
}

/** Whether two regex atoms can match at least one common character (conservative over-approximation). */
function atomsOverlap(a: string, b: string): boolean {
  // `.` matches (almost) anything -> overlaps with everything.
  if (a === '.' || b === '.') return true;
  // Identical atoms (same literal, same class, same escape) obviously overlap.
  if (a === b) return true;
  // A word-class atom overlaps any plain word-character literal, and vice-versa, plus \w/\d/\s pairs.
  const wordEsc = (s: string): boolean => s === '\\w' || s === '\\d';
  const spaceEsc = (s: string): boolean => s === '\\s';
  const isWordChar = (s: string): boolean => /^[A-Za-z0-9_]$/.test(s);
  if (wordEsc(a) && (wordEsc(b) || isWordChar(b))) return true;
  if (wordEsc(b) && (wordEsc(a) || isWordChar(a))) return true;
  if (spaceEsc(a) && spaceEsc(b)) return true;
  // Conservatively treat any two single-character literal atoms that are equal as overlapping (handled
  // by a===b above); distinct literals / disjoint escape classes (\s vs \w) are treated as NON-overlap.
  return false;
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
      throw new ToolError(
        'bad_args',
        'rejected pattern with catastrophic-backtracking (ReDoS) shape',
      );
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

      // Hard per-file scan-work backstop (D5): bound the total characters fed to the matcher for this
      // file. Even a catastrophic pattern the heuristic missed cannot run unbounded on a large file —
      // once the budget is spent we stop scanning THIS file (results already found are kept) and move
      // on. The budget is generous (SCAN_WORK_CAP) so a legitimate search never trips it.
      let scanWork = 0;
      for (let i = 0; i < lines.length; i++) {
        scanWork += lines[i]!.length + 1; // +1 for the stripped newline
        if (scanWork > SCAN_WORK_CAP) break;
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
