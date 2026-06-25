// src/tools/sandbox.ts — the single filesystem chokepoint.
//
// Every fs-touching tool routes a caller-supplied path through `assertInsideRoot` (lexical,
// fs-free, Windows-hardened) before opening it. `resolveInsideRoot` additionally realpaths the
// deepest existing ancestor and re-checks containment to defeat symlink escapes (used by `read`;
// the M4 write path will add O_NOFOLLOW at the leaf). The rejections are intentionally strict:
//
//   - `..` traversal escaping the root
//   - absolute paths that resolve outside the root
//   - UNC paths (`//server/share`, `\\server\share`)
//   - Win32 device prefixes (`\\?\`, `\\.\`)
//   - drive-relative paths (`C:foo`, a drive letter with no root separator)
//   - NTFS alternate-data-stream paths (`file.gml:hidden`, any `:` after the drive letter)
//
// Only the DRIVE LETTER is lowercased for comparison; the rest of the path keeps its case so
// case-sensitive filesystems are respected.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';

export type SandboxReason =
  | 'escape'
  | 'absolute'
  | 'unc'
  | 'symlink-escape'
  | 'device'
  | 'drive-relative'
  | 'ads';

export class SandboxError extends Error {
  readonly candidate: string;
  readonly reason: SandboxReason;
  constructor(candidate: string, reason: SandboxReason) {
    super(`path rejected by sandbox (${reason}): ${candidate}`);
    this.name = 'SandboxError';
    this.candidate = candidate;
    this.reason = reason;
  }
}

/** Normalize all separators to forward slashes. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Lowercase only a leading `X:` drive letter for case-insensitive comparison on Windows. */
function normalizeForCompare(absPath: string): string {
  const posix = toPosix(absPath);
  if (/^[A-Za-z]:/.test(posix)) {
    return posix[0]!.toLowerCase() + posix.slice(1);
  }
  return posix;
}

/**
 * Lexically validate that `candidate` (relative to `root`, or absolute) stays inside `root`.
 * Returns the resolved absolute path (native separators). Throws SandboxError otherwise. Does NO
 * filesystem I/O — symlinks are handled by `resolveInsideRoot`.
 */
export function assertInsideRoot(root: string, candidate: string): string {
  if (typeof candidate !== 'string' || candidate === '') {
    throw new SandboxError(String(candidate), 'escape');
  }

  // Reject Win32 device/UNC prefixes outright (\\?\, \\.\, \\server, //server).
  if (/^[\\/]{2}[?.]/.test(candidate)) {
    throw new SandboxError(candidate, 'device');
  }
  if (/^[\\/]{2}[^\\/]/.test(candidate)) {
    throw new SandboxError(candidate, 'unc');
  }

  // Drive-relative `C:foo` (drive letter, no root separator) — ambiguous current-dir-on-drive.
  if (/^[A-Za-z]:(?![\\/])/.test(candidate)) {
    throw new SandboxError(candidate, 'drive-relative');
  }

  // Alternate-data-stream `name:stream` — any `:` that is not the drive-letter colon.
  const driveColonAdjusted = candidate.replace(/^[A-Za-z]:/, '');
  if (driveColonAdjusted.includes(':')) {
    throw new SandboxError(candidate, 'ads');
  }

  const isAbsolute = path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate);
  const resolved = isAbsolute
    ? path.resolve(candidate)
    : path.resolve(root, candidate);

  const rootResolved = path.resolve(root);
  const rootCmp = normalizeForCompare(rootResolved);
  const candCmp = normalizeForCompare(resolved);

  // Inside iff equal to root or under `root + '/'`.
  if (candCmp !== rootCmp && !candCmp.startsWith(`${rootCmp}/`)) {
    throw new SandboxError(candidate, isAbsolute ? 'absolute' : 'escape');
  }
  return resolved;
}

/** True iff `absPath` is lexically inside `root` (no I/O). */
export function isInsideRoot(root: string, absPath: string): boolean {
  try {
    assertInsideRoot(root, absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lexically validate, then realpath the deepest EXISTING ancestor of the target and re-check that
 * the realpath is still inside `root`. This defeats a symlinked ancestor that points outside the
 * sandbox (e.g. `<root>/link -> /etc` then reading `<root>/link/passwd`). Returns the lexical
 * absolute path (the leaf itself may not exist yet). Throws SandboxError('symlink-escape').
 */
export async function resolveInsideRoot(root: string, candidate: string): Promise<string> {
  const lexical = assertInsideRoot(root, candidate);
  const rootReal = await fsp.realpath(path.resolve(root));

  // Walk up to the deepest existing ancestor.
  let probe = lexical;
  for (;;) {
    try {
      const real = await fsp.realpath(probe);
      const rootCmp = normalizeForCompare(rootReal);
      const realCmp = normalizeForCompare(real);
      if (realCmp !== rootCmp && !realCmp.startsWith(`${rootCmp}/`)) {
        throw new SandboxError(candidate, 'symlink-escape');
      }
      return lexical;
    } catch (err) {
      if (err instanceof SandboxError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) {
        // Reached the filesystem root without finding an existing ancestor inside root.
        throw new SandboxError(candidate, 'symlink-escape');
      }
      probe = parent;
    }
  }
}

// On POSIX, opening with O_NOFOLLOW makes open() fail (ELOOP) if the final path component is a
// symlink — this is the canonical TOCTOU-safe "do not follow the leaf" guarantee. The flag does not
// exist on Windows (undefined), where symlink creation requires privilege; there the leaf-symlink
// guard is the explicit lstat check below (and the POSIX no-follow leg is exercised on ubuntu CI).
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Atomically write `data` to `candidate` (a path inside `root`), TOCTOU-safe:
 *
 *  1. `resolveInsideRoot` lexically validates the path AND realpaths the deepest EXISTING ancestor,
 *     re-checking containment — so a symlinked ANCESTOR dir that escapes root is rejected before any
 *     write occurs (e.g. `<root>/link -> /etc`, target `<root>/link/passwd`).
 *  2. The parent directory's realpath is re-validated to be inside root (closes the window between
 *     ancestor check and write; the parent must already exist — new files are only created inside an
 *     existing, validated directory, never by creating arbitrary parent dirs).
 *  3. If the LEAF already exists and is a symlink, the write is rejected (`symlink-escape`) — we never
 *     overwrite a symlink (which could redirect the write outside root). On POSIX the temp-file open
 *     additionally uses `O_NOFOLLOW` so even a race that swaps in a symlink fails with ELOOP.
 *  4. Data is written to a randomly-named temp file INSIDE the validated parent dir, then `rename`d
 *     onto the leaf within that same dir (atomic, no cross-dir move, no partial file ever visible).
 *
 * Returns the absolute path written. Throws `SandboxError` on any containment/symlink violation and
 * cleans up the temp file on failure.
 */
export async function safeWriteFileInRoot(
  root: string,
  candidate: string,
  data: string,
): Promise<string> {
  // (1) lexical + deepest-existing-ancestor realpath containment.
  const abs = await resolveInsideRoot(root, candidate);
  const dir = path.dirname(abs);

  // (2) The parent dir must exist and its realpath must be inside root. resolveInsideRoot on the dir
  // realpaths it directly (it exists), so a symlinked parent leaving root is caught here too.
  const dirReal = await resolveInsideRoot(root, dir);

  // (3) Reject overwriting an existing symlink leaf (no-follow at the leaf, eager check).
  try {
    const leafStat = await fsp.lstat(abs);
    if (leafStat.isSymbolicLink()) {
      throw new SandboxError(candidate, 'symlink-escape');
    }
  } catch (err) {
    if (err instanceof SandboxError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err; // leaf may not exist yet (new file) — that's fine
  }

  // (4) Write to a temp file in the validated dir, then atomic rename within that dir.
  const tmp = path.join(dirReal, `.chatgml-tmp-${randomBytes(8).toString('hex')}`);
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    // O_NOFOLLOW (POSIX) ensures the temp open never follows a symlink at that name; O_EXCL ensures
    // we created it fresh; O_WRONLY|O_CREAT|O_TRUNC are standard write-create semantics.
    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_TRUNC |
      O_NOFOLLOW;
    handle = await fsp.open(tmp, flags, 0o644);
    await handle.writeFile(data, 'utf8');
    await handle.close();
    handle = undefined;
    await fsp.rename(tmp, abs);
    return abs;
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // ignore close errors during cleanup
      }
    }
    try {
      await fsp.rm(tmp, { force: true });
    } catch {
      // best-effort temp cleanup
    }
    throw err;
  }
}
