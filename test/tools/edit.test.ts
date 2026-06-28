import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import {
  editTool,
  editProposalId,
  assessEditRisk,
  applyPatchBlocks,
  diffBlockIndices,
  DESTRUCTIVE_NET_DELETE_LINES,
  WHOLE_FILE_REPLACE_MIN_LINES,
} from '../../src/tools/edit.js';
import { parsePatch } from 'diff';
import { makeToolContext } from '../helpers/tool-context.js';
import type { ApprovalRequest } from '../../src/types.js';

const DIFF = '--- a\n+++ b\n@@ -1 +1 @@\n-hp -= 1;\n+hp -= dmg;\n';
const ORIGINAL = 'hp -= 1;\n';
const PATCHED = 'hp -= dmg;\n';

/** A real temp repo with one file; returns the root + cleanup. */
async function makeRepo(
  files: Record<string, string> = {},
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'edit-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
  }
  return { root, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

const approve = async (): Promise<import('../../src/types.js').ApprovalResolution> => ({
  approved: true,
});
const reject = async (): Promise<import('../../src/types.js').ApprovalResolution> => ({
  approved: false,
});

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
      // a checkpoint event is emitted after a successful edit of an existing file
      const checkpoint = events.find((e) => e.type === 'checkpoint');
      expect(checkpoint).toBeDefined();
      expect(checkpoint && checkpoint.type === 'checkpoint' && checkpoint.path).toBe(
        'objects/obj_player/Step_0.gml',
      );
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
          new Promise<import('../../src/types.js').ApprovalResolution>((resolve) => {
            seenReq = req;
            resolveApproval = (ok: boolean) => resolve({ approved: ok });
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
      const req = seenReq!;
      expect(req.kind).toBe('edit');
      expect(req.id).toBe(editProposalId('a.gml', DIFF));
      if (req.kind === 'edit') {
        expect(req.diff).toBe(DIFF);
      }
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
  async function trySymlink(
    target: string,
    linkPath: string,
    type: 'dir' | 'file',
  ): Promise<boolean> {
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
      const ok = await trySymlink(
        path.join(outside, 'secret.gml'),
        path.join(root, 'a.gml'),
        'file',
      );
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
      const ok = await trySymlink(
        path.join(outside, 'secret.gml'),
        path.join(root, 'a.gml'),
        'file',
      );
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

// ---------------------------------------------------------------------------
// GAP4 — auto-mode destructive-edit backstop: assessEditRisk classification + the edit tool sets
// forceGate for high-risk diffs (so the gate waits even in auto mode).
// ---------------------------------------------------------------------------
describe('assessEditRisk — destructive-edit classification', () => {
  const risk = (diff: string, lines: number) => assessEditRisk(parsePatch(diff), lines);

  it('a small additive in-place edit is NOT high-risk', () => {
    const small = '--- a\n+++ b\n@@ -1,1 +1,2 @@\n hp -= 1;\n+hp = max(hp, 0);\n';
    const r = risk(small, 1);
    expect(r.highRisk).toBe(false);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(0);
  });

  it('a one-line in-place replace is NOT high-risk', () => {
    expect(risk(DIFF, 1).highRisk).toBe(false);
  });

  it('a whole-file wipe (removes every existing line, adds nothing) IS high-risk', () => {
    const wipe = '--- a\n+++ b\n@@ -1,2 +0,0 @@\n-line one;\n-line two;\n';
    const r = risk(wipe, 2);
    expect(r.highRisk).toBe(true);
    expect(r.reason).toMatch(/whole-file/i);
  });

  it('net deletion beyond the line threshold IS high-risk', () => {
    // Build a hunk that removes N+5 lines and adds none, over a big file.
    const removed = DESTRUCTIVE_NET_DELETE_LINES + 5;
    const body = Array.from({ length: removed }, (_, i) => `-old line ${i}`).join('\n');
    const diff = `--- a\n+++ b\n@@ -1,${removed} +0,0 @@\n${body}\n`;
    const r = risk(diff, 1000); // huge file so the FRACTION rule doesn't also fire — isolate the count rule
    expect(r.highRisk).toBe(true);
    expect(r.reason).toMatch(/mass deletion/i);
  });

  it('deleting more than half of a file IS high-risk (proportional rule)', () => {
    // 10-line file, remove 6 net -> 60% > 50%.
    const body = Array.from({ length: 6 }, (_, i) => `-line ${i}`).join('\n');
    const diff = `--- a\n+++ b\n@@ -1,6 +0,0 @@\n${body}\n`;
    const r = risk(diff, 10);
    expect(r.highRisk).toBe(true);
    expect(r.reason).toMatch(/% of the file/);
  });

  it('creating a NEW file (no original) is NOT high-risk by deletion', () => {
    const create = '--- /dev/null\n+++ b/new.gml\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n';
    expect(risk(create, 0).highRisk).toBe(false);
  });
});

describe('assessEditRisk — boundary cases at the thresholds', () => {
  const risk = (diff: string, lines: number) => assessEditRisk(parsePatch(diff), lines);

  // WHOLE_FILE_REPLACE_MIN_LINES boundary
  it(`at the whole-file-rewrite floor: removed===lines AND added===${WHOLE_FILE_REPLACE_MIN_LINES} IS high-risk`, () => {
    const n = WHOLE_FILE_REPLACE_MIN_LINES;
    // Header declares "remove n starting at line 1, add n starting at line 1".
    // Hunk body: n '-' lines (the old file) then n '+' lines (the new file).
    const removedPart = Array.from({ length: n }, (_, i) => `-old ${i}`).join('\n');
    const addedPart = Array.from({ length: n }, (_, i) => `+new ${i}`).join('\n');
    const diff = `--- a\n+++ b\n@@ -1,${n} +1,${n} @@\n${removedPart}\n${addedPart}\n`;
    expect(risk(diff, n).highRisk).toBe(true);
  });

  it(`one below the whole-file-rewrite floor: added===${WHOLE_FILE_REPLACE_MIN_LINES - 1} is NOT high-risk`, () => {
    const lines = WHOLE_FILE_REPLACE_MIN_LINES;
    const added = WHOLE_FILE_REPLACE_MIN_LINES - 1;
    const removed = lines; // ==originalLineCount so the wipe rule doesn't fire (added > 0)
    const removedPart = Array.from({ length: removed }, (_, i) => `-old ${i}`).join('\n');
    const addedPart = Array.from({ length: added }, (_, i) => `+new ${i}`).join('\n');
    const diff = `--- a\n+++ b\n@@ -1,${removed} +1,${added} @@\n${removedPart}\n${addedPart}\n`;
    const r = risk(diff, lines);
    expect(r.added).toBe(added);
    expect(r.removed).toBe(removed);
    // Below the rewrite floor, NOT high-risk (the net-deletion rules also don't fire: net = removed
    // - added = 1, lines = 20 so net/lines = 0.05 well under the 0.5 fraction floor).
    expect(r.highRisk).toBe(false);
  });

  // DESTRUCTIVE_NET_DELETE_LINES boundary (uses >, so AT is safe, AT+1 fires)
  it(`net deletion AT exactly ${DESTRUCTIVE_NET_DELETE_LINES} lines is NOT high-risk (boundary uses strict >)`, () => {
    const lines = 1000; // large file so the fraction rule doesn't fire
    const removed = DESTRUCTIVE_NET_DELETE_LINES;
    const body = Array.from({ length: removed }, (_, i) => `-old ${i}`).join('\n');
    const diff = `--- a\n+++ b\n@@ -1,${removed} +0,0 @@\n${body}\n`;
    expect(risk(diff, lines).highRisk).toBe(false);
  });

  it(`net deletion of ${DESTRUCTIVE_NET_DELETE_LINES + 1} lines IS high-risk`, () => {
    const lines = 1000;
    const removed = DESTRUCTIVE_NET_DELETE_LINES + 1;
    const body = Array.from({ length: removed }, (_, i) => `-old ${i}`).join('\n');
    const diff = `--- a\n+++ b\n@@ -1,${removed} +0,0 @@\n${body}\n`;
    expect(risk(diff, lines).highRisk).toBe(true);
  });

  // DESTRUCTIVE_DELETE_FRACTION boundary (uses >, so AT is safe, AT+epsilon fires)
  it(`proportional deletion AT exactly 50% is NOT high-risk (boundary uses strict >)`, () => {
    // 10-line file, remove 5 net -> exactly 50%, NOT high-risk.
    const lines = 10;
    const removed = 5;
    const body = Array.from({ length: removed }, (_, i) => `-line ${i}`).join('\n');
    const diff = `--- a\n+++ b\n@@ -1,${removed} +0,0 @@\n${body}\n`;
    expect(risk(diff, lines).highRisk).toBe(false);
  });

  it(`proportional deletion of 51% IS high-risk`, () => {
    // 100-line file, remove 51 net.
    const lines = 100;
    const removed = 51;
    const body = Array.from({ length: removed }, (_, i) => `-line ${i}`).join('\n');
    const diff = `--- a\n+++ b\n@@ -1,${removed} +0,0 @@\n${body}\n`;
    expect(risk(diff, lines).highRisk).toBe(true);
  });

  // Whole-file wipe boundary (uses >=, so AT removed===lines IS high-risk even with added=0)
  it(`whole-file wipe boundary: removed===lines AND added===0 IS high-risk (>= rule)`, () => {
    const lines = 5;
    const body = Array.from({ length: lines }, (_, i) => `-line ${i}`).join('\n');
    const diff = `--- a\n+++ b\n@@ -1,${lines} +0,0 @@\n${body}\n`;
    expect(risk(diff, lines).highRisk).toBe(true);
  });
});

describe('apply_patch — auto-mode backstop sets forceGate for destructive edits', () => {
  it('auto mode: a SMALL additive edit auto-applies (forceGate false) and writes', async () => {
    const { root, cleanup } = await makeRepo({ 'a.gml': 'hp -= 1;\n' });
    try {
      const seen: ApprovalRequest[] = [];
      const { ctx } = makeToolContext({
        root,
        approval: 'auto',
        requestApproval: async (req) => {
          seen.push(req);
          return { approved: true }; // emulate the auto gate: a non-forced request resolves true
        },
      });
      const additive = '--- a\n+++ b\n@@ -1,1 +1,2 @@\n hp -= 1;\n+hp = max(hp, 0);\n';
      const res = await editTool.execute({ path: 'a.gml', diff: additive }, ctx);
      expect(res.isError).not.toBe(true);
      expect(seen[0]?.kind === 'edit' ? seen[0]?.forceGate : undefined).toBe(false);
      expect(await fsp.readFile(path.join(root, 'a.gml'), 'utf8')).toBe(
        'hp -= 1;\nhp = max(hp, 0);\n',
      );
    } finally {
      await cleanup();
    }
  });

  it('auto mode: a WHOLE-FILE wipe sets forceGate true (the gate must ask a human)', async () => {
    const { root, cleanup } = await makeRepo({ 'a.gml': 'line one;\nline two;\n' });
    try {
      const seen: ApprovalRequest[] = [];
      const { ctx } = makeToolContext({
        root,
        approval: 'auto',
        // Decline to prove no write happens when the human is asked.
        requestApproval: async (req) => {
          seen.push(req);
          return { approved: false };
        },
      });
      const wipe = '--- a\n+++ b\n@@ -1,2 +0,0 @@\n-line one;\n-line two;\n';
      const res = await editTool.execute({ path: 'a.gml', diff: wipe }, ctx);
      expect(seen[0]?.kind === 'edit' ? seen[0]?.forceGate : undefined).toBe(true);
      expect(res.content).toMatch(/not approved/i);
      // The file is UNCHANGED — the destructive edit did not auto-apply.
      expect(await fsp.readFile(path.join(root, 'a.gml'), 'utf8')).toBe('line one;\nline two;\n');
    } finally {
      await cleanup();
    }
  });
});

describe('applyPatchBlocks — per-hunk filtering', () => {
  const MULTI =
    '--- a\n+++ b\n@@ -1,2 +1,2 @@\n-hp -= 1;\n+hp -= 999;\n if (hp <= 0) instance_destroy();\n@@ -4,2 +4,3 @@\n x;\n y;\n+z;\n';

  it('diffBlockIndices returns one index per hunk', () => {
    expect(diffBlockIndices(MULTI)).toEqual([0, 1]);
    expect(diffBlockIndices(DIFF)).toEqual([0]);
    expect(diffBlockIndices('not a diff')).toEqual([]);
  });

  it('keeps only approved hunks', () => {
    const filtered = applyPatchBlocks(MULTI, [1]);
    expect(filtered).toContain('@@ -4,2 +4,3 @@');
    expect(filtered).not.toContain('hp -= 1;');
    expect(filtered).toContain('--- a');
    expect(filtered).toContain('+++ b');
  });

  it('approving all hunks returns the equivalent full diff', () => {
    expect(applyPatchBlocks(MULTI, [0, 1])).toBe(MULTI);
  });
});

describe('apply_patch — partial hunk approval applies only approved blocks', () => {
  const ORIGINAL_MULTI = 'hp -= 1;\nif (hp <= 0) instance_destroy();\na;\nb;\n';
  const MULTI_DIFF =
    '--- a\n+++ b\n@@ -1,2 +1,2 @@\n-hp -= 1;\n+hp -= 999;\n if (hp <= 0) instance_destroy();\n@@ -4,2 +4,3 @@\n a;\n b;\n+z;\n';

  it('approving only hunk 0 writes only that change', async () => {
    const { root, cleanup } = await makeRepo({ 'a.gml': ORIGINAL_MULTI });
    try {
      const { ctx } = makeToolContext({
        root,
        approval: 'auto',
        requestApproval: async () => ({ approved: true, blocks: [0] }),
      });
      const res = await editTool.execute({ path: 'a.gml', diff: MULTI_DIFF }, ctx);
      expect(res.isError).not.toBe(true);
      expect(await fsp.readFile(path.join(root, 'a.gml'), 'utf8')).toBe(
        'hp -= 999;\nif (hp <= 0) instance_destroy();\na;\nb;\n',
      );
    } finally {
      await cleanup();
    }
  });

  it('approving only hunk 1 writes only that change', async () => {
    const { root, cleanup } = await makeRepo({ 'a.gml': ORIGINAL_MULTI });
    try {
      const { ctx } = makeToolContext({
        root,
        approval: 'auto',
        requestApproval: async () => ({ approved: true, blocks: [1] }),
      });
      const res = await editTool.execute({ path: 'a.gml', diff: MULTI_DIFF }, ctx);
      expect(res.isError).not.toBe(true);
      expect(await fsp.readFile(path.join(root, 'a.gml'), 'utf8')).toBe(
        'hp -= 1;\nif (hp <= 0) instance_destroy();\na;\nb;\nz;\n',
      );
    } finally {
      await cleanup();
    }
  });

  it('approving an empty block list writes nothing', async () => {
    const { root, cleanup } = await makeRepo({ 'a.gml': ORIGINAL_MULTI });
    try {
      const { ctx } = makeToolContext({
        root,
        approval: 'auto',
        requestApproval: async () => ({ approved: true, blocks: [] }),
      });
      const res = await editTool.execute({ path: 'a.gml', diff: MULTI_DIFF }, ctx);
      expect(res.content).toMatch(/not approved/i);
      expect(await fsp.readFile(path.join(root, 'a.gml'), 'utf8')).toBe(ORIGINAL_MULTI);
    } finally {
      await cleanup();
    }
  });
});
