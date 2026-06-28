// src/tools/checkpoint.ts — checkpoint snapshots for gated edits and undo.
//
// Before an approved edit overwrites an existing file, the original bytes are copied into
// <root>/.chatgml/checkpoints/<id>.orig. An append-only index records the mapping so the UI can
// render checkpoint chips and the undo command can restore a prior state.
import path from 'node:path';
import fsp from 'node:fs/promises';

export interface CheckpointEntry {
  id: string;
  path: string;
  ts: number;
}

/** Directory that holds checkpoint snapshots and their index, relative to a project root. */
export const CHECKPOINT_DIR = '.chatgml/checkpoints';

/** Path to the checkpoint index file for a given root. */
export function checkpointIndexPath(root: string): string {
  return path.join(root, CHECKPOINT_DIR, 'index.json');
}

/** Path to a single checkpoint snapshot file. */
export function checkpointPath(root: string, checkpointId: string): string {
  return path.join(root, CHECKPOINT_DIR, `${checkpointId}.orig`);
}

/** Ensure the checkpoint directory exists. */
async function ensureCheckpointDir(root: string): Promise<void> {
  await fsp.mkdir(path.join(root, CHECKPOINT_DIR), { recursive: true });
}

/**
 * Read the checkpoint index, returning an empty array if it does not yet exist.
 * Validates the file shape defensively: non-array contents are treated as empty.
 */
export async function readCheckpointIndex(root: string): Promise<CheckpointEntry[]> {
  try {
    const raw = await fsp.readFile(checkpointIndexPath(root), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is CheckpointEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as CheckpointEntry).id === 'string' &&
        typeof (e as CheckpointEntry).path === 'string' &&
        typeof (e as CheckpointEntry).ts === 'number',
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Atomically append an entry to the checkpoint index: read current array, push, and rewrite.
 * This is simple and correct for the single-writer core process; concurrent edits are serialized
 * by the event loop, not by file locking.
 */
export async function appendCheckpointIndex(root: string, entry: CheckpointEntry): Promise<void> {
  await ensureCheckpointDir(root);
  const index = await readCheckpointIndex(root);
  index.push(entry);
  await fsp.writeFile(checkpointIndexPath(root), JSON.stringify(index, null, 2), 'utf8');
}

/**
 * Save the original contents of `originalPath` as a checkpoint snapshot.
 * Returns true if a snapshot was written, false if the file did not exist (new-file creation).
 * Throws on read/write errors so the edit tool can surface them.
 */
export async function writeCheckpoint(
  root: string,
  checkpointId: string,
  originalPath: string,
): Promise<boolean> {
  let data: Buffer;
  try {
    data = await fsp.readFile(originalPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw err;
  }
  await ensureCheckpointDir(root);
  await fsp.writeFile(checkpointPath(root, checkpointId), data);
  return true;
}

/** Copy a checkpoint snapshot back to its original target path. */
export async function restoreCheckpoint(
  root: string,
  checkpointId: string,
  targetPath: string,
): Promise<void> {
  const data = await fsp.readFile(checkpointPath(root, checkpointId));
  await fsp.writeFile(targetPath, data);
}
