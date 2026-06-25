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
import { createHash } from 'node:crypto';
import { applyPatch, parsePatch } from 'diff';
import { defineTool, ToolError } from '../tool-error.js';
import type { ToolDef, ToolResult, ToolContext } from '../types.js';
import { z } from 'zod';
import {
  assertInsideRoot,
  resolveInsideRoot,
  safeWriteFileInRoot,
  toPosix,
  SandboxError,
} from './sandbox.js';

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
 * Parse a unified diff and assert it is well-formed: exactly one file patch with at least one hunk.
 * `diff`'s parser tolerates garbage by returning an empty (no-hunk) patch which `applyPatch` then
 * silently no-ops; we reject that here so a malformed diff is a loud bad_args, never a silent write.
 * Throws ToolError('bad_args') on any malformed input.
 */
function assertWellFormedDiff(diff: string): void {
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

    // (2) Validate the diff shape before touching the filesystem.
    assertWellFormedDiff(args.diff);

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
    const id = editProposalId(args.path, args.diff);
    const approved = await ctx.requestApproval({
      id,
      kind: 'edit',
      path: args.path,
      diff: args.diff,
    });

    if (!approved) {
      // Reject (or gated-without-approval): pure no-op, nothing written.
      return {
        content: `edit to ${args.path} was not approved; no changes written`,
        isError: false,
      };
    }

    // (6) Approved -> atomic, sandboxed, TOCTOU-safe write.
    try {
      await safeWriteFileInRoot(ctx.root, args.path, patched);
    } catch (err) {
      if (err instanceof SandboxError) {
        throw new ToolError('sandbox_escape', `refusing to write outside the project root: ${args.path}`, {
          reason: err.reason,
        });
      }
      throw err;
    }

    const rel = toPosix(args.path).replace(/^\.\//, '');
    return {
      content: `${isNewFile ? 'created' : 'updated'} ${rel}`,
      citations: [{ path: rel, provider: 'local' }],
      isError: false,
    };
  },
});
