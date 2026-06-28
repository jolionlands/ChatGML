// src/tools/read.ts — read a file (or a 1-based line window), sandboxed + symlink-checked.
//
// Routes through `resolveInsideRoot` (lexical + realpath of the deepest existing ancestor) so a
// symlinked dir cannot leak a file outside the root. A shared MAX_FILE_BYTES size cap (`too_large`)
// and a NUL-byte binary sniff (`binary`) bound what is returned. The size cap applies only to a
// WHOLE-file read; a bounded line WINDOW (startLine/endLine) streams the file and caps only the
// returned slice, so a small window of a huge file is still readable (F10/F11). `startLine`/`endLine`
// are 1-based; endLine < startLine is `bad_args`, and a startLine past EOF is `bad_args` (F17). The
// result carries a single Citation for the read region (GML metadata via the enriched deriver, F8).
import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { defineTool, ToolError } from '../tool-error.js';
import type { ToolDef, ToolResult, ToolContext, Citation } from '../types.js';
import { z } from 'zod';
import { resolveInsideRoot, toPosix, SandboxError } from './sandbox.js';
import { gmlDeriverForRoot } from '../index/files.js';
import { MAX_FILE_BYTES } from './limits.js';

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
    if (
      args.startLine !== undefined &&
      args.endLine !== undefined &&
      args.endLine < args.startLine
    ) {
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

    let size: number;
    try {
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) throw new ToolError('not_found', `not a file: ${args.path}`);
      size = stat.size;
    } catch (err) {
      if (err instanceof ToolError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new ToolError('not_found', `file not found: ${args.path}`);
      throw new ToolError('not_found', `cannot read file: ${args.path}`);
    }

    const rel = toPosix(args.path).replace(/^\.\//, '');
    const windowed = args.startLine !== undefined || args.endLine !== undefined;

    // A WHOLE-file read is capped; a bounded WINDOW of a large file is allowed (we stream it). (F10/F11)
    if (size > MAX_FILE_BYTES && !windowed) {
      throw new ToolError('too_large', `file exceeds ${MAX_FILE_BYTES} bytes: ${args.path}`, {
        size,
      });
    }

    const result = windowed
      ? await readWindow(abs, args.path, args.startLine ?? 1, args.endLine)
      : await readWhole(abs, args.path);

    const citation: Citation = {
      path: rel,
      startLine: result.start,
      endLine: result.end,
      provider: 'local',
    };
    const meta = gmlDeriverForRoot(ctx.root)(rel);
    if (meta) citation.gml = meta;

    return {
      content: result.numbered,
      citations: [citation],
    };
  },
});

interface ReadSlice {
  numbered: string;
  start: number;
  end: number;
}

/** Read a whole (already cap-checked) file, sniff for binary, and number every line. */
async function readWhole(abs: string, displayPath: string): Promise<ReadSlice> {
  let buf: Buffer;
  try {
    buf = await fsp.readFile(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ToolError('not_found', `file not found: ${displayPath}`);
    throw new ToolError('not_found', `cannot read file: ${displayPath}`);
  }
  if (looksBinary(buf)) {
    throw new ToolError('binary', `refusing to read binary file: ${displayPath}`);
  }
  const allLines = buf.toString('utf8').split('\n');
  const total = allLines.length;
  const numbered = allLines.map((l, i) => `${i + 1}\t${l}`).join('\n');
  return { numbered, start: 1, end: total };
}

/**
 * Stream `abs` and return only lines [startLine, endLine] (1-based inclusive). Line semantics match
 * `String.split('\n')` exactly (a file ending in `\n` has a trailing empty line), so a windowed read
 * is indistinguishable from a whole-file read of the same range. Caps the RETURNED slice (not the
 * whole file) at MAX_FILE_BYTES of accumulated text, so a small window of a multi-MB file is readable.
 * A NUL byte in the first chunk -> `binary`. A startLine past EOF -> `bad_args` (F17).
 */
async function readWindow(
  abs: string,
  displayPath: string,
  startLine: number,
  endLineArg: number | undefined,
): Promise<ReadSlice> {
  const stream = createReadStream(abs);
  const endLine = endLineArg ?? Number.MAX_SAFE_INTEGER;

  const out: Array<{ n: number; text: string }> = [];
  let lineNo = 0; // 1-based number of the line currently being assembled in `pending`
  let pending = '';
  let acc = 0;
  let sniffed = false;
  let binary = false;

  const emit = (text: string): boolean => {
    lineNo++;
    if (lineNo < startLine) return true;
    if (lineNo > endLine) return false; // past the window: stop
    acc += text.length + 1;
    if (acc > MAX_FILE_BYTES) return false; // window itself is huge: stop accumulating
    out.push({ n: lineNo, text });
    return true;
  };

  try {
    let keepGoing = true;
    for await (const chunk of stream) {
      const s = (chunk as Buffer).toString('utf8');
      if (!sniffed) {
        sniffed = true;
        if (s.includes('\0')) {
          binary = true;
          break;
        }
      }
      let from = 0;
      let nl = s.indexOf('\n', from);
      while (nl !== -1) {
        if (!emit(pending + s.slice(from, nl))) {
          keepGoing = false;
          break;
        }
        pending = '';
        from = nl + 1;
        nl = s.indexOf('\n', from);
      }
      if (!keepGoing) break;
      pending += s.slice(from);
    }
    // Trailing segment after the last newline is always a line (split('\n') semantics: a final `\n`
    // yields a trailing empty line; an empty file yields a single empty line).
    if (keepGoing) emit(pending);
  } finally {
    stream.destroy();
  }

  if (binary) {
    throw new ToolError('binary', `refusing to read binary file: ${displayPath}`);
  }
  // The total line count is known only if we read to EOF; when we stopped early (window satisfied),
  // lineNo already reached at least startLine, so the past-EOF check below is correct either way.
  if (startLine > lineNo) {
    throw new ToolError(
      'bad_args',
      `startLine ${startLine} exceeds file length ${lineNo}: ${displayPath}`,
    );
  }
  const end = out.length > 0 ? out[out.length - 1]!.n : startLine;
  const numbered = out.map((o) => `${o.n}\t${o.text}`).join('\n');
  return { numbered, start: startLine, end };
}
