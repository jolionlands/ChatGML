// src/tools/search_replace.ts — SEARCH/REPLACE block editor (Cline/Roo-style).
//
// The model proposes one or more exact SEARCH/REPLACE blocks for a single in-root file. This tool:
//   1. lexically sandboxes the target path (out-of-root -> sandbox_escape, before any I/O);
//   2. reads the current file and validates that every `search` string appears exactly once;
//   3. builds a SEARCH/REPLACE-marker diff for the plugin diff-view and requests approval;
//   4. ONLY on approve does it materialize the replacements (end-to-start to keep offsets stable)
//      and write atomically inside the sandbox via safeWriteFileInRoot.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineTool, ToolError } from '../tool-error.js';
import type {
  ToolDef,
  ToolResult,
  ToolContext,
  ApprovalRequest,
  ApprovalResolution,
} from '../types.js';
import { z } from 'zod';
import { resolveInsideRoot, safeWriteFileInRoot, toPosix, SandboxError } from './sandbox.js';
import { writeCheckpoint, appendCheckpointIndex, checkpointPath } from './checkpoint.js';
import { countLines, assessLineRisk } from './util.js';

const SearchReplaceArgs = z.object({
  path: z.string().min(1).describe('repo-relative file path to edit'),
  blocks: z
    .array(
      z.object({
        search: z.string().min(0).describe('exact existing text to replace'),
        replace: z.string().min(0).describe('text to insert in its place'),
      }),
    )
    .min(1)
    .max(50)
    .describe('one or more SEARCH/REPLACE blocks'),
});
type SearchReplaceArgs = z.infer<typeof SearchReplaceArgs>;

interface BlockMatch {
  index: number;
  search: string;
  replace: string;
}

/** Validate a set of SEARCH/REPLACE blocks and materialize them into the patched text. */
function validateAndApplyBlocks(
  original: string,
  blocks: Array<{ search: string; replace: string }>,
  path: string,
): string {
  const matches: BlockMatch[] = [];
  for (const b of blocks) {
    if (b.search === '') {
      throw new ToolError(
        'bad_patch',
        `empty search is only valid when creating a new file: ${path}`,
      );
    }
    const idx = original.indexOf(b.search);
    if (idx === -1) {
      throw new ToolError('bad_patch', `search text not found in ${path}`);
    }
    if (original.indexOf(b.search, idx + 1) !== -1) {
      throw new ToolError('bad_patch', `search text appears multiple times in ${path}`);
    }
    matches.push({ index: idx, search: b.search, replace: b.replace });
  }

  matches.sort((a, b) => a.index - b.index);
  for (let i = 0; i < matches.length - 1; i++) {
    const cur = matches[i]!;
    const next = matches[i + 1]!;
    if (cur.index + cur.search.length > next.index) {
      throw new ToolError('bad_patch', `SEARCH/REPLACE blocks overlap in ${path}`);
    }
  }

  let patched = original;
  for (const m of [...matches].sort((a, b) => b.index - a.index)) {
    patched = patched.slice(0, m.index) + m.replace + patched.slice(m.index + m.search.length);
  }
  return patched;
}

/** Render one SEARCH/REPLACE block as a diff-view-compatible marker block. */
function renderBlock(search: string, replace: string): string {
  const ensureNlBeforeMarker = (s: string): string => (s.endsWith('\n') ? '' : '\n');
  return `<<<<<<< SEARCH\n${search}${ensureNlBeforeMarker(search)}=======\n${replace}${ensureNlBeforeMarker(replace)}>>>>>>> REPLACE\n`;
}

/** Build a single diff string from all blocks. */
function buildDiff(blocks: Array<{ search: string; replace: string }>): string {
  return blocks.map((b) => renderBlock(b.search, b.replace)).join('\n');
}

/** Exported for the agent loop so it can build an approval request from SEARCH/REPLACE blocks. */
export function buildSearchReplaceDiff(blocks: Array<{ search: string; replace: string }>): string {
  return buildDiff(blocks);
}

/**
 * Filter SEARCH/REPLACE blocks to keep only the approved indices. Used after a mixed per-block
 * approval resolution so only accepted blocks are materialized.
 */
export function applySearchReplaceBlocks(
  blocks: Array<{ search: string; replace: string }>,
  approvedBlocks: number[],
): Array<{ search: string; replace: string }> {
  return approvedBlocks
    .map((i) => blocks[i])
    .filter((b): b is { search: string; replace: string } => b !== undefined);
}

export const searchReplaceTool: ToolDef<SearchReplaceArgs> = defineTool<SearchReplaceArgs>({
  name: 'search_replace',
  description:
    'Propose edits to a single file as exact SEARCH/REPLACE blocks. APPROVAL-GATED and sandboxed to the project root: changes are applied only after the user approves them.',
  kind: 'gated',
  schema: SearchReplaceArgs,
  async execute(args: SearchReplaceArgs, ctx: ToolContext): Promise<ToolResult> {
    // (1) Lexical + realpath sandbox check first.
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

    // (2) Read current content.
    let original: string;
    try {
      original = await fsp.readFile(abs, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new ToolError('bad_patch', `file not found: ${args.path}`);
      }
      throw new ToolError('not_found', `cannot read file: ${args.path}`);
    }

    // (3) Validate the full proposal up front so the client only sees a diff for a well-formed edit.
    validateAndApplyBlocks(original, args.blocks, args.path);

    // (4) Approval round-trip.
    const diff = buildDiff(args.blocks);
    // Block-level line counts feed the shared assessLineRisk so the SEARCH/REPLACE tool and the
    // unified-diff edit tool apply the exact same destructive-edit thresholds.
    const added = args.blocks.reduce((n, b) => n + countLines(b.replace), 0);
    const removed = args.blocks.reduce((n, b) => n + countLines(b.search), 0);
    const risk = assessLineRisk({ added, removed, originalLineCount: countLines(original) });
    if (risk.highRisk && ctx.approval === 'auto') {
      ctx.log('warn', `search_replace: destructive edit gated despite auto mode — ${risk.reason}`, {
        path: args.path,
      });
    }

    const req: ApprovalRequest = {
      id: ctx.toolCallId ?? args.path,
      kind: 'edit',
      path: args.path,
      diff,
      forceGate: risk.highRisk,
      blocks: args.blocks.map((_, i) => i),
    };

    let resolution: ApprovalResolution | undefined;
    let approved = ctx.preApproved === true;
    if (!approved) {
      resolution = await ctx.requestApproval(req);
      approved = resolution.approved;
    }

    if (!approved) {
      return {
        content: `edit to ${args.path} was not approved; no changes written`,
        isError: false,
      };
    }

    // If a per-block resolution narrowed the approved set, materialize only those blocks.
    const approvedBlocks =
      ctx.approvedBlocks ?? (resolution?.approved === true ? resolution.blocks : undefined);
    let blocksToApply = args.blocks;
    if (approvedBlocks !== undefined) {
      if (approvedBlocks.length === 0) {
        return {
          content: `edit to ${args.path} was not approved; no changes written`,
          isError: false,
        };
      }
      blocksToApply = applySearchReplaceBlocks(args.blocks, approvedBlocks);
    }

    // (5) Apply replacements end-to-start so earlier indices stay valid.
    const patched = validateAndApplyBlocks(original, blocksToApply, args.path);

    const rel = toPosix(args.path).replace(/^\.\//, '');
    const checkpointId = ctx.toolCallId ?? rel;

    // (6) Snapshot the original bytes before overwriting, then atomic, sandboxed, TOCTOU-safe write.
    const cpPath = checkpointPath(ctx.root, checkpointId);
    await fsp.mkdir(path.dirname(cpPath), { recursive: true });
    await writeCheckpoint(ctx.root, checkpointId, abs);
    await appendCheckpointIndex(ctx.root, { id: checkpointId, path: rel, ts: Date.now() });

    try {
      await safeWriteFileInRoot(ctx.root, args.path, patched);
    } catch (err) {
      if (err instanceof SandboxError) {
        throw new ToolError(
          'sandbox_escape',
          `refusing to write outside the project root: ${args.path}`,
          {
            reason: err.reason,
          },
        );
      }
      throw err;
    }

    if (ctx.emit) {
      ctx.emit({ type: 'checkpoint', id: checkpointId, path: rel, label: rel });
    }

    return {
      content: `updated ${rel}`,
      citations: [{ path: rel, provider: 'local' }],
      isError: false,
    };
  },
});
