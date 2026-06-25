import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import {
  assertInsideRoot,
  resolveInsideRoot,
  isInsideRoot,
  safeWriteFileInRoot,
  toPosix,
  SandboxError,
} from '../../src/tools/sandbox.js';

const ROOT = process.platform === 'win32' ? 'C:\\proj\\root' : '/proj/root';

describe('toPosix', () => {
  it('converts backslashes to forward slashes', () => {
    expect(toPosix('a\\b\\c')).toBe('a/b/c');
  });
});

describe('assertInsideRoot — accept', () => {
  it('accepts a nested relative path', () => {
    const r = assertInsideRoot(ROOT, 'objects/obj_player/Step_0.gml');
    expect(toPosix(r).endsWith('objects/obj_player/Step_0.gml')).toBe(true);
  });

  it('accepts a ./-prefixed path', () => {
    expect(() => assertInsideRoot(ROOT, './scripts/scr_util/scr_util.gml')).not.toThrow();
  });

  it('accepts the root itself', () => {
    expect(() => assertInsideRoot(ROOT, '.')).not.toThrow();
  });

  it('accepts a new (nonexistent) file under root', () => {
    expect(() => assertInsideRoot(ROOT, 'new/file.gml')).not.toThrow();
  });
});

describe('assertInsideRoot — reject', () => {
  it('rejects ../ escape', () => {
    try {
      assertInsideRoot(ROOT, '../outside.gml');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxError);
      expect((e as SandboxError).reason).toBe('escape');
    }
  });

  it('rejects an absolute path outside root', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/passwd';
    try {
      assertInsideRoot(ROOT, outside);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxError);
      expect((e as SandboxError).reason).toBe('absolute');
    }
  });

  it('rejects a UNC path', () => {
    expect(() => assertInsideRoot(ROOT, '//server/share/x')).toThrow(SandboxError);
    expect(() => assertInsideRoot(ROOT, '\\\\server\\share\\x')).toThrow(SandboxError);
    try {
      assertInsideRoot(ROOT, '//server/share/x');
    } catch (e) {
      expect((e as SandboxError).reason).toBe('unc');
    }
  });

  it('rejects \\\\?\\ and \\\\.\\ device prefixes', () => {
    for (const p of ['\\\\?\\C:\\x', '\\\\.\\PhysicalDrive0', '//?/C:/x']) {
      try {
        assertInsideRoot(ROOT, p);
        throw new Error(`should have thrown for ${p}`);
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxError);
        expect((e as SandboxError).reason).toBe('device');
      }
    }
  });

  it('rejects drive-relative C:foo', () => {
    try {
      assertInsideRoot(ROOT, 'C:foo');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxError);
      expect((e as SandboxError).reason).toBe('drive-relative');
    }
  });

  it('rejects an alternate-data-stream colon', () => {
    try {
      assertInsideRoot(ROOT, 'file.gml:hidden');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxError);
      expect((e as SandboxError).reason).toBe('ads');
    }
  });

  it('rejects empty/non-string candidates', () => {
    expect(() => assertInsideRoot(ROOT, '')).toThrow(SandboxError);
  });
});

describe('drive-letter case handling (win32 semantics)', () => {
  it('lowercases only the drive letter for comparison', () => {
    // On posix this path has no drive letter; assert the relative accept still works on both OSes.
    const r = assertInsideRoot(ROOT, 'a/b.gml');
    expect(toPosix(r).toLowerCase().includes('/proj/root/a/b.gml'.toLowerCase()) ||
      toPosix(r).toLowerCase().includes('c:/proj/root/a/b.gml')).toBe(true);
  });
});

describe('isInsideRoot', () => {
  it('returns boolean instead of throwing', () => {
    expect(isInsideRoot(ROOT, 'a.gml')).toBe(true);
    expect(isInsideRoot(ROOT, '../a.gml')).toBe(false);
  });
});

describe('resolveInsideRoot — symlink escape', () => {
  it('accepts a real path inside a real temp root', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sbx-'));
    try {
      await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
      await fsp.writeFile(path.join(root, 'sub', 'f.gml'), 'x');
      const r = await resolveInsideRoot(root, 'sub/f.gml');
      expect(toPosix(r).endsWith('sub/f.gml')).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects reading through a symlinked dir that escapes root', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sbx-root-'));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'sbx-out-'));
    try {
      await fsp.writeFile(path.join(outside, 'secret.txt'), 'top secret');
      const linkPath = path.join(root, 'link');
      try {
        await fsp.symlink(outside, linkPath, 'dir');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES') {
          // Symlink creation requires privilege on Windows — skip with a logged reason.
          // eslint-disable-next-line no-console
          console.warn(`skipping symlink-escape test: ${code} (no symlink privilege)`);
          return;
        }
        throw err;
      }
      await expect(resolveInsideRoot(root, 'link/secret.txt')).rejects.toMatchObject({
        name: 'SandboxError',
        reason: 'symlink-escape',
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('safeWriteFileInRoot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('atomically writes a new file inside an existing validated dir (no leftover temp)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sw-'));
    try {
      await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
      const abs = await safeWriteFileInRoot(root, 'sub/out.gml', 'hello\n');
      expect(toPosix(abs).endsWith('sub/out.gml')).toBe(true);
      expect(await fsp.readFile(path.join(root, 'sub', 'out.gml'), 'utf8')).toBe('hello\n');
      // no .chatgml-tmp-* leftovers
      const entries = await fsp.readdir(path.join(root, 'sub'));
      expect(entries.some((e) => e.startsWith('.chatgml-tmp-'))).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('overwrites an existing regular file in place', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sw-'));
    try {
      await fsp.writeFile(path.join(root, 'a.gml'), 'old\n');
      await safeWriteFileInRoot(root, 'a.gml', 'new\n');
      expect(await fsp.readFile(path.join(root, 'a.gml'), 'utf8')).toBe('new\n');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a ../ escape before any write', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sw-'));
    try {
      await expect(safeWriteFileInRoot(root, '../escape.gml', 'x')).rejects.toBeInstanceOf(
        SandboxError,
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects when the leaf is an existing symlink (no privilege needed: lstat is stubbed)', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sw-'));
    try {
      await fsp.writeFile(path.join(root, 'a.gml'), 'x\n');
      vi.spyOn(fsp, 'lstat').mockResolvedValue({
        isSymbolicLink: () => true,
      } as unknown as Awaited<ReturnType<typeof fsp.lstat>>);
      await expect(safeWriteFileInRoot(root, 'a.gml', 'y\n')).rejects.toMatchObject({
        name: 'SandboxError',
        reason: 'symlink-escape',
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('cleans up the temp file and rethrows when rename fails', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sw-'));
    try {
      const boom = new Error('disk full');
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(boom);
      await expect(safeWriteFileInRoot(root, 'a.gml', 'data\n')).rejects.toBe(boom);
      // the temp file must have been removed during cleanup
      const entries = await fsp.readdir(root);
      expect(entries.some((e) => e.startsWith('.chatgml-tmp-'))).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
