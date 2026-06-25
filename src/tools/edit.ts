// src/tools/edit.ts — apply_patch (M3 STUB; approval-gated; never writes).
//
// In M3 this is a registered, approval-gated tool that validates its args, lexically sandboxes the
// target path, mints the stable approval id (`sha1(path + '\0' + diff)`), and then throws
// `not_implemented` WITHOUT touching the filesystem. It never calls fs.writeFile. The real
// unified-diff apply engine + the approval round-trip (request -> serve/REPL forward ->
// resolveApproval -> atomic O_NOFOLLOW write) land in M4.
import { createHash } from 'node:crypto';
import { defineTool, ToolError } from '../tool-error.js';
import type { ToolDef, ToolResult, ToolContext } from '../types.js';
import { z } from 'zod';
import { assertInsideRoot, SandboxError } from './sandbox.js';

const EditArgs = z.object({
  path: z.string().min(1).describe('repo-relative file path to edit'),
  diff: z.string().min(1).describe('a unified diff to apply to the file'),
});
type EditArgs = z.infer<typeof EditArgs>;

/** Stable approval/proposal id for a (path, diff) pair. The SAME id is used end-to-end. */
export function editProposalId(path: string, diff: string): string {
  return createHash('sha1').update(`${path}\0${diff}`).digest('hex').slice(0, 16);
}

export const editTool: ToolDef<EditArgs> = defineTool<EditArgs>({
  name: 'apply_patch',
  description:
    'Propose an edit to a file as a unified diff. APPROVAL-GATED and sandboxed to the project root. (Edit application is not yet enabled.)',
  kind: 'gated',
  schema: EditArgs,
  async execute(args: EditArgs, _ctx: ToolContext): Promise<ToolResult> {
    if (args.diff.trim() === '') throw new ToolError('bad_args', 'empty diff');
    // Lexical sandbox check first (so an out-of-root target is rejected as sandbox_escape, not
    // masked by not_implemented). NO filesystem I/O and NO write happens here.
    try {
      assertInsideRoot(_ctx.root, args.path);
    } catch (err) {
      if (err instanceof SandboxError) {
        throw new ToolError('sandbox_escape', `path escapes the project root: ${args.path}`, {
          reason: err.reason,
        });
      }
      throw err;
    }
    // id is computed for parity with the M4 approval round-trip (kept stable, deterministic).
    void editProposalId(args.path, args.diff);
    throw new ToolError('not_implemented', 'edit not yet enabled');
  },
});
