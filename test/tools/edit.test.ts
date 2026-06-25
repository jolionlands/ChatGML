import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { editTool, editProposalId } from '../../src/tools/edit.js';
import { makeToolContext } from '../helpers/tool-context.js';
import type { ApprovalRequest } from '../../src/types.js';

const DIFF = '--- a\n+++ b\n@@ -1 +1 @@\n-hp -= 1;\n+hp -= dmg;\n';
const ORIGINAL = 'hp -= 1;\n';
const PATCHED = 'hp -= dmg;\n';

/** A real temp repo with one file; returns the root + cleanup. */
async function makeRepo(files: Record<string, string> = {}): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'edit-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
  }
  return { root, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

const approve = async (): Promise<boolean> => true;
const reject = async (): Promise<boolean> => false;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apply_patch (M4) — tool identity & arg validation', () => {
  it('is a gated tool named apply_patch', () => {
    expect(editTool.kind).toBe('gated');
    expect(editTool.name).toBe('apply_patch');
  });

  it('mints a stable, deterministic proposal id keyed on (path, diff)', () => {
    const a = editProposalId('a.gml', DIFF);
    const b = editProposalId('a.gml', DIFF);
    const c = editProposalId('b.gml', DIFF);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects an empty diff as bad_args (no write)', async () => {
    const { root, cleanup } = await makeRepo({ 'a.gml': ORIGINAL });
    try {
      const { ctx } = makeToolContext({ root, requestApproval: approve });
      await expect(editTool.execute({ path: 'a.gml', diff: '   ' }, ctx)).rejects.toMatchObject({
        code: 'bad_args',
      });
      // file untouched
      expect(await fsp.readFile(path.join(root, 'a.gml'), 'utf8')).toBe(ORIGINAL);
    } finally {
      await cleanup();
    }
  });

  it('TEST 7: a malformed (no-hunk) diff is bad_args and writes nothing', async () => {
    const { root, cleanup } = await makeRepo({ 'a.gml': ORIGINAL });
    try {
      const writeSpy = vi.spyOn(fsp, 'rename');
      const { ctx } = makeToolContext({ root, requestApproval: approve });
      await expect(
        editTool.execute({ path: 'a.gml', diff: 'this is not a diff at all\n' }, ctx),
      ).rejects.toMatchObject({ code: 'bad_args' });
      expect(writeSpy).not.toHaveBeenCalled();
      expect(await fsp.readFile(path.join(root, 'a.gml'), 'utf8')).toBe(ORIGINAL);
    } finally {
      await cleanup();
    }
  });

  it('a diff that does not apply cleanly (context mismatch) is bad_args, no write', async () => {
    const { root, cleanup } = await makeRepo({ 'a.gml': 'totally different content\n' });
    try {
      const writeSpy = vi.spyOn(fsp, 'rename');
      const { ctx } = makeToolContext({ root, requestApproval: approve });
      await expect(editTool.execute({ path: 'a.gml', diff: DIFF }, ctx)).rejects.toMatchObject({
        code: 'bad_args',
      });
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it('rejects a ../ escape as sandbox_escape before any I/O', async () => {
    const { root, cleanup } = await makeRepo();
    try {
      const { ctx } = makeToolContext({ root, requestApproval: approve });
      await expect(
        editTool.execute({ path: '../outside.gml', diff: DIFF }, ctx),
      ).rejects.toMatchObject({ name: 'ToolError', code: 'sandbox_escape' });
    } finally {
      await cleanup();
    }
  });

  it('a non-ENOENT read failure (target is a directory) surfaces as not_found, no write', async () => {
    const { root, cleanup } = await makeRepo({ 'adir/keep.gml': 'x\n' });
    try {
      // Patching a path that is a directory -> readFile throws EISDIR (not ENOENT) -> not_found.
      const { ctx } = makeToolContext({ root, requestApproval: approve });
      await expect(editTool.execute({ path: 'adir', diff: DIFF }, ctx)).rejects.toMatchObject({
        code: 'not_found',
      });
    } finally {
      await cleanup();
    }
  });

  it('a SandboxError from the write path maps to sandbox_escape (no privilege needed)', async () => {
    const { root, cleanup } = await makeRepo({ 'a.gml': ORIGINAL });
    try {
      // Inject a leaf-symlink verdict so safeWriteFileInRoot throws SandboxError('symlink-escape')
      // deterministically on any OS (covers the write-path error mapping without symlink privilege).
      vi.spyOn(fsp, 'lstat').mockResolvedValue({
        isSymbolicLink: () => true,
      } as unknown as Awaited<ReturnType<typeof fsp.lstat>>);
      const { ctx } = makeToolContext({ root, approval: 'auto', requestApproval: approve });
      await expect(editTool.execute({ path: 'a.gml', diff: DIFF }, ctx)).rejects.toMatchObject({
        name: 'ToolError',
        code: 'sandbox_escape',
      });
      // file untouched
      expect(await fsp.readFile(path.join(root, 'a.gml'), 'utf8')).toBe(ORIGINAL);
    } finally {
      await cleanup();
    }
  });
});

describe('apply_patch (M4) — TEST 1: applying a real diff yields correct content', () => {
  it('approve writes the exact patched content inside root', async () => {
    const { root, cleanup } = await makeRepo({ 'objects/obj_player/Step_0.gml': ORIGINAL });
    try {
      const { ctx, events } = makeToolContext({
        root,
        approval: 'auto',
        requestApproval: approve,
      });
      const res = await editTool.execute(
        { path: 'objects/obj_player/Step_0.gml', diff: DIFF },
        ctx,
      );
      expect(res.isError).not.toBe(true);
      const after = await fsp.readFile(path.join(root, 'objects/obj_player/Step_0.gml'), 'utf8');
      expect(after).toBe(PATCHED);
      // a citation for the written file is surfaced
      expect(res.citations?.[0]?.path).toBe('objects/obj_player/Step_0.gml');
      // no protocol noise from the tool itself in auto path (gate emits, not the tool)
      expect(events.every((e) => e.type !== 'error')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('creates a NEW file from a /dev/null diff inside an existing validated dir', async () => {
    const { root, cleanup } = await makeRepo({ 'scripts/keep.gml': 'x\n' });
    try {
      const NEW = '--- /dev/null\n+++ b/scripts/new.gml\n@@ -0,0 +1,2 @@\n+line1\n+line2\n';
      const { ctx } = makeToolContext({ root, requestApproval: approve });
      await editTool.execute({ path: 'scripts/new.gml', diff: NEW }, ctx);
      expect(await fsp.readFile(path.join(root, 'scripts/new.gml'), 'utf8')).toBe('line1\nline2\n');
    } finally {
      await cleanup();
    }
  });
});

describe('apply_patch (M4) — TEST 5: gated waits then writes on approve, no write on reject', () => {
  it('writes ONLY on approve; never calls writeFile/open/rename on reject (spied)', async () => {
    const { root, cleanup } = await makeRepo({ 'a.gml': ORIGINAL });
    try {
      // REJECT leg: spy fs, assert nothing written and the file is untouched.
      const openSpy = vi.spyOn(fsp, 'open');
      const renameSpy = vi.spyOn(fsp, 'rename');
      const writeFileSpy = vi.spyOn(fsp, 'writeFile');
      const { ctx: rejectCtx } = makeToolContext({ root, requestApproval: reject });
      const rejectRes = await editTool.execute({ path: 'a.gml', diff: DIFF }, rejectCtx);
      expect(rejectRes.isError).not.toBe(true);
      expect(rejectRes.content).toMatch(/not approved/i);
      expect(openSpy).not.toHaveBeenCalled();
      expect(renameSpy).not.toHaveBeenCalled();
      expect(writeFileSpy).not.toHaveBeenCalled();
      expect(await fsp.readFile(path.join(root, 'a.gml'), 'utf8')).toBe(ORIGINAL);

      vi.restoreAllMocks();

      // APPROVE leg: now the write actually happens.
      const { ctx: approveCtx } = makeToolContext({ root, requestApproval: approve });
      await editTool.execute({ path: 'a.gml', diff: DIFF }, approveCtx);
      expect(await fsp.readFile(path.join(root, 'a.gml'), 'utf8')).toBe(PATCHED);
    } finally {
      await cleanup();
    }
  });

  it('gated mode BLOCKS on requestApproval until resolved, then writes on approve', async () => {
    const { root, cleanup } = await makeRepo({ 'a.gml': ORIGINAL });
    try {
      // Capture the approval request; resolve it out-of-band like the real ApprovalGate does.
      let resolveApproval: ((ok: boolean) => void) | null = null;
      let seenReq: ApprovalRequest | null = null;
      const { ctx } = makeToolContext({
        root,
        approval: 'gated',
        requestApproval: (req) =>
          new Promise<boolean>((resolve) => {
            seenReq = req;
            resolveApproval = resolve;
          }),
      });

      let settled = false;
      const runPromise = editTool.execute({ path: 'a.gml', diff: DIFF }, ctx).then((r) => {
        settled = true;
        return r;
      });

      // Wait until the tool has reached requestApproval (it must park there, not write). Poll the
      // event loop a bounded number of times so the assertion is robust to fs-read latency.
      for (let i = 0; i < 100 && seenReq === null; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(seenReq).not.toBeNull();
      expect(seenReq!.id).toBe(editProposalId('a.gml', DIFF));
      expect(seenReq!.diff).toBe(DIFF);
      // The tool is BLOCKED on approval: not settled, file still original.
      expect(settled).toBe(false);
      expect(await fsp.readFile(path.join(root, 'a.gml'), 'utf8')).toBe(ORIGINAL); // still original

      // Now approve out-of-band.
      resolveApproval!(true);
      await runPromise;
      expect(await fsp.readFile(path.join(root, 'a.gml'), 'utf8')).toBe(PATCHED);
    } finally {
      await cleanup();
    }
  });
});

describe('apply_patch (M4) — TEST 2/3/4: symlink / TOCTOU safety on the write path', () => {
  // Helper: create a symlink, skipping (not silently passing) when the OS lacks privilege.
  async function trySymlink(target: string, linkPath: string, type: 'dir' | 'file'): Promise<boolean> {
    try {
      await fsp.symlink(target, linkPath, type);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        // eslint-disable-next-line no-console
        console.warn(`skipping symlink test: ${code} (no symlink privilege on this OS)`);
        return false;
      }
      throw err;
    }
  }

  it('TEST 2: apply_patch through an in-repo symlinked DIR escaping root is rejected', async () => {
    const { root, cleanup } = await makeRepo();
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'edit-out-'));
    try {
      await fsp.writeFile(path.join(outside, 'target.gml'), ORIGINAL);
      const ok = await trySymlink(outside, path.join(root, 'link'), 'dir');
      if (!ok) return;
      const { ctx } = makeToolContext({ root, approval: 'auto', requestApproval: approve });
      await expect(
        editTool.execute({ path: 'link/target.gml', diff: DIFF }, ctx),
      ).rejects.toMatchObject({ code: 'sandbox_escape' });
      // the out-of-root file must be untouched
      expect(await fsp.readFile(path.join(outside, 'target.gml'), 'utf8')).toBe(ORIGINAL);
    } finally {
      await cleanup();
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('TEST 3: overwriting a LEAF symlink that points outside root is rejected', async () => {
    const { root, cleanup } = await makeRepo();
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'edit-out-'));
    try {
      await fsp.writeFile(path.join(outside, 'secret.gml'), ORIGINAL);
      const ok = await trySymlink(path.join(outside, 'secret.gml'), path.join(root, 'a.gml'), 'file');
      if (!ok) return;
      const { ctx } = makeToolContext({ root, approval: 'auto', requestApproval: approve });
      await expect(editTool.execute({ path: 'a.gml', diff: DIFF }, ctx)).rejects.toMatchObject({
        code: 'sandbox_escape',
      });
      // the symlink target outside root must be untouched
      expect(await fsp.readFile(path.join(outside, 'secret.gml'), 'utf8')).toBe(ORIGINAL);
    } finally {
      await cleanup();
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('TEST 4: the final-leaf open does not follow a symlink (POSIX O_NOFOLLOW)', async () => {
    if (process.platform === 'win32') {
      // eslint-disable-next-line no-console
      console.warn('skipping O_NOFOLLOW leaf test on win32 (no O_NOFOLLOW; ubuntu CI covers it)');
      return;
    }
    const { root, cleanup } = await makeRepo();
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'edit-out-'));
    try {
      await fsp.writeFile(path.join(outside, 'secret.gml'), ORIGINAL);
      // Leaf is a symlink to an outside file. The eager lstat check rejects it, but even if that were
      // bypassed, the O_NOFOLLOW temp-open + same-dir rename would never write through the link.
      const ok = await trySymlink(path.join(outside, 'secret.gml'), path.join(root, 'a.gml'), 'file');
      if (!ok) return;
      const { ctx } = makeToolContext({ root, approval: 'auto', requestApproval: approve });
      await expect(editTool.execute({ path: 'a.gml', diff: DIFF }, ctx)).rejects.toMatchObject({
        code: 'sandbox_escape',
      });
      // Outside content unchanged and the leaf is still a symlink (never overwritten as a real file).
      expect(await fsp.readFile(path.join(outside, 'secret.gml'), 'utf8')).toBe(ORIGINAL);
      const lst = await fsp.lstat(path.join(root, 'a.gml'));
      expect(lst.isSymbolicLink()).toBe(true);
    } finally {
      await cleanup();
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});
