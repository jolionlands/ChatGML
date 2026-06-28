// src/tools/edit.ts — apply_patch (M4 real engine; approval-gated; sandboxed; TOCTOU-safe).
//
// The model proposes a unified diff for a single in-root file. This tool:
//   1. lexically sandboxes the target path (out-of-root -> sandbox_escape, before any I/O);
//   2. validates the diff is a well-formed unified diff with at least one hunk (else bad_args);
//   3. reads the current file (through resolveInsideRoot, so a symlinked ANCESTOR cannot leak an
//      out-of-root file) and applies the patch with `diff.applyPatch` (context mismatch -> bad_args);
//   4. mints the stable proposal id `sha1(path + '\0' + diff)` and drives the approval round-trip via
//      ctx.requestApproval — in 'gated' mode the ApprovalGate emits edit_proposal + approval_request
//      and BLOCKS until the client's approve/reject arrives via resolveApproval(id); in 'auto' mode
//      the gate resolves true synchronously. (`auto` can never be sourced from project config — that
//      is enforced upstream in config.ts — so ctx.approval is trustworthy here.)
//   5. ONLY on approve does it write, atomically inside the sandbox via safeWriteFileInRoot
//      (realpath-validated parent + O_NOFOLLOW leaf + temp-then-rename within the validated dir).
//      On reject it is a pure no-op (no write).
//
// Prompt-injection note: a malicious "apply this patch" instruction embedded in untrusted file/tool
// content cannot bypass this gate — in the default gated mode the write waits for an explicit human
// approve, and the agent's system prompt forbids acting on instructions found in code.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyPatch, parsePatch } from 'diff';
import { defineTool, ToolError } from '../tool-error.js';
import type {
  ToolDef,
  ToolResult,
  ToolContext,
  ApprovalRequest,
  ApprovalResolution,
} from '../types.js';
import { z } from 'zod';
import {
  assertInsideRoot,
  resolveInsideRoot,
  safeWriteFileInRoot,
  toPosix,
  SandboxError,
} from './sandbox.js';
import { writeCheckpoint, appendCheckpointIndex, checkpointPath } from './checkpoint.js';
import { countLines, assessLineRisk, type EditRisk } from './util.js';
// Threshold constants + the EditRisk type are the canonical source in util.ts (shared with
// search_replace.ts); re-exported here so external imports (`from 'src/tools/edit.js'`) keep working.
export {
  DESTRUCTIVE_NET_DELETE_LINES,
  DESTRUCTIVE_DELETE_FRACTION,
  WHOLE_FILE_REPLACE_MIN_LINES,
  type EditRisk,
} from './util.js';

const EditArgs = z.object({
  path: z.string().min(1).describe('repo-relative file path to edit'),
  diff: z.string().min(1).describe('a unified diff to apply to the file'),
});
type EditArgs = z.infer<typeof EditArgs>;

/** Stable approval/proposal id for a (path, diff) pair. The SAME id is used end-to-end. */
export function editProposalId(path: string, diff: string): string {
  return createHash('sha1').update(`${path}\0${diff}`).digest('hex').slice(0, 16);
}

/**
 * Return the block indices for a unified diff: one block per hunk. Used by the agent loop so the
 * approval request can carry per-block tracking. Returns an empty array when the diff has no hunks
 * (the apply tool will reject such a diff later).
 */
export function diffBlockIndices(diff: string): number[] {
  let patches: ReturnType<typeof parsePatch>;
  try {
    patches = parsePatch(diff);
  } catch {
    return [];
  }
  if (patches.length === 0) return [];
  const hunks = patches[0]?.hunks ?? [];
  return hunks.map((_, i) => i);
}

/**
 * Filter a unified diff to keep only the approved hunks. The file header is preserved; unapproved
 * hunks are dropped. `approvedBlocks` is the set of hunk indices to retain (from `diffBlockIndices`).
 */
export function applyPatchBlocks(diffText: string, approvedBlocks: number[]): string {
  const approved = new Set(approvedBlocks);
  const lines = diffText.split('\n');
  const headers: string[] = [];
  const hunks: { header: string; body: string[] }[] = [];
  let current: { header: string; body: string[] } | null = null;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current) hunks.push(current);
      current = { header: line, body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      headers.push(line);
    }
  }
  if (current) hunks.push(current);

  const out: string[] = [...headers];
  for (let i = 0; i < hunks.length; i++) {
    if (approved.has(i)) {
      const h = hunks[i]!;
      out.push(h.header);
      out.push(...h.body);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// AUTO-MODE DESTRUCTIVE-EDIT BACKSTOP (GAP4).
//
// Even in `auto` approval mode, a HIGH-RISK edit must still go through human approval. The risk is
// assessed CONSERVATIVELY and DETERMINISTICALLY from cheaply-computable diff/target facts (line
// counts the unified-diff parser already gives us), so a small additive in-place patch keeps
// auto-applying while a whole-file rewrite or mass deletion is gated. This caps an injection's blast
// radius in auto mode without changing gated mode at all.
// (Thresholds + EditRisk live in tools/util.ts so the unified-diff and SEARCH/REPLACE engines share
// the same risk assessment. Re-exported above for backward-compat with `from 'tools/edit.js'`.)
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff and assert it is well-formed: exactly one file patch with at least one hunk.
 * `diff`'s parser tolerates garbage by returning an empty (no-hunk) patch which `applyPatch` then
 * silently no-ops; we reject that here so a malformed diff is a loud bad_args, never a silent write.
 * Throws ToolError('bad_args') on any malformed input. Returns the parsed patches (reused for the
 * destructive-edit risk assessment so the diff is parsed once).
 */
function assertWellFormedDiff(diff: string): ReturnType<typeof parsePatch> {
  let patches: ReturnType<typeof parsePatch>;
  try {
    patches = parsePatch(diff);
  } catch {
    throw new ToolError('bad_args', 'malformed unified diff: could not parse');
  }
  if (patches.length === 0) {
    throw new ToolError('bad_args', 'malformed unified diff: no file patch found');
  }
  if (patches.length > 1) {
    throw new ToolError('bad_args', 'apply_patch accepts a single-file diff only');
  }
  const only = patches[0];
  if (only === undefined || only.hunks.length === 0) {
    throw new ToolError('bad_args', 'malformed unified diff: no hunks');
  }
  return patches;
}

/**
 * Count added/removed lines in a parsed unified diff (used by assessEditRisk). Pure + deterministic
 * — operates only on the parsed structure, never re-parses.
 */
function diffLineCounts(patches: ReturnType<typeof parsePatch>): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const p of patches) {
    for (const h of p.hunks) {
      for (const line of h.lines) {
        // unified-diff line markers: '+' added, '-' removed, ' ' context, '\' (no-newline) ignored.
        if (line.startsWith('+')) added += 1;
        else if (line.startsWith('-')) removed += 1;
      }
    }
  }
  return { added, removed };
}

/**
 * Assess whether applying `diff` to a file with `originalLineCount` lines is a HIGH-RISK
 * (destructive) edit that must be gated even in auto mode. Pure + deterministic. Delegates the
 * threshold checks to the shared `assessLineRisk` so apply_patch and search_replace agree on the
 * rules (and the constants stay in one place).
 *
 * High-risk if ANY of:
 *  - whole-file wipe: the hunks remove (nearly) the entire existing file and add nothing back;
 *  - whole-file rewrite: removes (nearly) the entire file AND rewrites it with >=
 *    WHOLE_FILE_REPLACE_MIN_LINES new lines (a large in-place rewrite, high blast radius);
 *  - mass deletion: net removed lines exceed DESTRUCTIVE_NET_DELETE_LINES;
 *  - proportional deletion: net removed lines exceed DESTRUCTIVE_DELETE_FRACTION of the file
 *    (only meaningful for a non-trivial existing file).
 *
 * Creating a NEW file (originalLineCount === 0) is NOT high-risk by deletion — there is nothing to
 * destroy — so a /dev/null create still auto-applies. A tiny in-place replace (swap the only line of
 * a small file) is NOT high-risk either — added cancels removed, so no deletion rule fires.
 */
export function assessEditRisk(
  patches: ReturnType<typeof parsePatch>,
  originalLineCount: number,
): EditRisk {
  const { added, removed } = diffLineCounts(patches);
  return assessLineRisk({ added, removed, originalLineCount });
}

export const editTool: ToolDef<EditArgs> = defineTool<EditArgs>({
  name: 'apply_patch',
  description:
    'Propose an edit to a single file as a unified diff. APPROVAL-GATED and sandboxed to the project root: in gated mode the change is applied only after the user approves it.',
  kind: 'gated',
  schema: EditArgs,
  async execute(args: EditArgs, ctx: ToolContext): Promise<ToolResult> {
    if (args.diff.trim() === '') throw new ToolError('bad_args', 'empty diff');

    // (1) Lexical sandbox check FIRST so an out-of-root target is rejected as sandbox_escape, never
    // masked by a later error. No filesystem I/O happens here.
    try {
      assertInsideRoot(ctx.root, args.path);
    } catch (err) {
      if (err instanceof SandboxError) {
        throw new ToolError('sandbox_escape', `path escapes the project root: ${args.path}`, {
          reason: err.reason,
        });
      }
      throw err;
    }

    // (2) Validate the diff shape before touching the filesystem; keep the parsed patch for risk
    // assessment (GAP4) so we count added/removed lines without re-parsing.
    const patches = assertWellFormedDiff(args.diff);

    // (3) Read current content (empty for a new file), defeating symlinked-ancestor escapes.
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

    let original = '';
    let isNewFile = false;
    try {
      original = await fsp.readFile(abs, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        isNewFile = true;
      } else {
        throw new ToolError('not_found', `cannot read file to patch: ${args.path}`);
      }
    }

    // (4) Apply the patch. A context mismatch (the diff does not apply cleanly) returns false.
    const patched = applyPatch(original, args.diff);
    if (patched === false) {
      throw new ToolError('bad_args', `diff does not apply cleanly to ${args.path}`);
    }

    // (5) Approval round-trip. Same id for edit_proposal / approval_request / approve|reject.
    // GAP4 — destructive-edit backstop: assess risk from the parsed diff vs the original file. A
    // HIGH-RISK edit (whole-file rewrite / mass deletion) sets `forceGate`, so the ApprovalGate WAITS
    // for an explicit human even in auto mode; a small additive in-place edit leaves it unset and
    // auto-applies as before. Gated mode is unaffected (it always waits regardless of the flag).
    const risk = assessEditRisk(patches, countLines(original));
    if (risk.highRisk && ctx.approval === 'auto') {
      ctx.log('warn', `apply_patch: destructive edit gated despite auto mode — ${risk.reason}`, {
        path: args.path,
      });
    }
    const id = editProposalId(args.path, args.diff);

    const req: ApprovalRequest = {
      id,
      kind: 'edit',
      path: args.path,
      diff: args.diff,
      forceGate: risk.highRisk,
      blocks: patches[0]?.hunks.map((_, i) => i),
    };

    let resolution: ApprovalResolution | undefined;
    let approved = ctx.preApproved === true;
    if (!approved) {
      resolution = await ctx.requestApproval(req);
      approved = resolution.approved;
    }

    if (!approved) {
      // Reject (or gated-without-approval): pure no-op, nothing written.
      return {
        content: `edit to ${args.path} was not approved; no changes written`,
        isError: false,
      };
    }

    // If the agent loop or a block-level resolution narrowed the approved set, apply only those
    // hunks. Whole-proposal approval (no blocks) keeps the original diff.
    const approvedBlocks =
      ctx.approvedBlocks ?? (resolution?.approved === true ? resolution.blocks : undefined);
    let diffToApply = args.diff;
    if (approvedBlocks !== undefined) {
      if (approvedBlocks.length === 0) {
        return {
          content: `edit to ${args.path} was not approved; no changes written`,
          isError: false,
        };
      }
      diffToApply = applyPatchBlocks(args.diff, approvedBlocks);
    }

    const filteredPatched = applyPatch(original, diffToApply);
    if (filteredPatched === false) {
      throw new ToolError('bad_args', `approved blocks do not apply cleanly to ${args.path}`);
    }

    const rel = toPosix(args.path).replace(/^\.\//, '');

    // (6) Approved -> atomic, sandboxed, TOCTOU-safe write. Snapshot existing files first so the
    // checkpoint can be restored by an undo command.
    if (!isNewFile) {
      const cpPath = checkpointPath(ctx.root, ctx.toolCallId ?? id);
      await fsp.mkdir(path.dirname(cpPath), { recursive: true });
      const snapshot = await writeCheckpoint(ctx.root, ctx.toolCallId ?? id, abs);
      if (snapshot) {
        await appendCheckpointIndex(ctx.root, {
          id: ctx.toolCallId ?? id,
          path: rel,
          ts: Date.now(),
        });
      }
    }

    try {
      await safeWriteFileInRoot(ctx.root, args.path, filteredPatched);
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

    if (!isNewFile && ctx.emit) {
      ctx.emit({ type: 'checkpoint', id: ctx.toolCallId ?? id, path: rel, label: rel });
    }

    return {
      content: `${isNewFile ? 'created' : 'updated'} ${rel}`,
      citations: [{ path: rel, provider: 'local' }],
      isError: false,
    };
  },
});
