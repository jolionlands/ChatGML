import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import {
  checkpointPath,
  checkpointIndexPath,
  writeCheckpoint,
  restoreCheckpoint,
  readCheckpointIndex,
  appendCheckpointIndex,
} from '../../src/tools/checkpoint.js';

async function makeRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cp-test-'));
  return { root, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

describe('checkpoint helpers', () => {
  it('computes checkpoint paths inside .chatgml/checkpoints', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      expect(checkpointPath(root, 'abc')).toBe(path.join(root, '.chatgml/checkpoints/abc.orig'));
      expect(checkpointIndexPath(root)).toBe(path.join(root, '.chatgml/checkpoints/index.json'));
    } finally {
      await cleanup();
    }
  });

  it('writeCheckpoint saves original bytes and returns true for existing files', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const target = path.join(root, 'a.gml');
      await fsp.writeFile(target, 'original\n');
      const ok = await writeCheckpoint(root, 'cp-1', target);
      expect(ok).toBe(true);
      expect(await fsp.readFile(checkpointPath(root, 'cp-1'), 'utf8')).toBe('original\n');
    } finally {
      await cleanup();
    }
  });

  it('writeCheckpoint returns false when the target file does not exist', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const ok = await writeCheckpoint(root, 'cp-1', path.join(root, 'missing.gml'));
      expect(ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('restoreCheckpoint copies checkpoint bytes back to the target path', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const target = path.join(root, 'a.gml');
      await fsp.writeFile(target, 'original\n');
      await writeCheckpoint(root, 'cp-1', target);
      await fsp.writeFile(target, 'modified\n');
      await restoreCheckpoint(root, 'cp-1', target);
      expect(await fsp.readFile(target, 'utf8')).toBe('original\n');
    } finally {
      await cleanup();
    }
  });

  it('readCheckpointIndex returns an empty array when no index exists', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      expect(await readCheckpointIndex(root)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('appendCheckpointIndex round-trips entries', async () => {
    const { root, cleanup } = await makeRoot();
    try {
      await appendCheckpointIndex(root, { id: 'cp-1', path: 'a.gml', ts: 1000 });
      await appendCheckpointIndex(root, { id: 'cp-2', path: 'b.gml', ts: 2000 });
      const index = await readCheckpointIndex(root);
      expect(index).toEqual([
        { id: 'cp-1', path: 'a.gml', ts: 1000 },
        { id: 'cp-2', path: 'b.gml', ts: 2000 },
      ]);
    } finally {
      await cleanup();
    }
  });
});
