// src/memory/persist.ts — JSON persistence primitives. NO pickle, NO eval, NO native deserialization.
//
// Float32 vectors are stored as base64 (bit-exact, NaN/Inf/-0 preserved). Writes are atomic
// (temp-then-rename) so a crash never leaves a half-written store. `readJson` NEVER throws (the store
// is best-effort availability) but logs a redacted, suspicious-vs-missing warning to stderr so a
// silent store reset is observable.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Encode a Float32Array as base64 of its little-endian bytes. Bit-exact (NaN/Inf/-0 preserved). */
export function f32ToBase64(v: Float32Array): string {
  // Buffer.from(uint8Array) copies exactly the typed view's bytes; the explicit Uint8Array cast is
  // required because Buffer.from(float32Array) does NOT do what we want (it iterates the array as
  // if it were UTF-16 code units).
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return Buffer.from(bytes).toString('base64');
}

/** Decode a base64 string back into a Float32Array. Inverse of f32ToBase64 (bit-exact). */
export function base64ToF32(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  // Ensure 4-byte alignment by copying into a fresh ArrayBuffer.
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}

/** Standard envelope persisted at the top of each store file (for schema/version detection). */
export interface StoreEnvelope<T> {
  version: number;
  embeddingsId: string;
  dim: number;
  data: T;
  checksum?: string;
}

/** Write JSON atomically: serialize to a sibling `.tmp` then rename over the target. */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const text = JSON.stringify(value);
  await fsp.writeFile(tmp, text, 'utf8');
  try {
    await fsp.rename(tmp, filePath);
  } catch (err) {
    // On some platforms rename across a pre-existing file can fail; fall back to remove+rename.
    try {
      await fsp.rm(filePath, { force: true });
      await fsp.rename(tmp, filePath);
    } catch {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }
}

export type ReadJsonReason = 'missing' | 'corrupt' | 'schema';

export interface ReadJsonOptions<T> {
  /** Optional validator; returning false routes to a `schema` warning and a null result. */
  validate?: (value: unknown) => value is T;
  /** Override the warning sink (defaults to process.stderr). Used by tests. */
  warn?: (reason: ReadJsonReason, file: string) => void;
}

/**
 * Read + parse a JSON file. Returns null on any failure (missing/corrupt/schema mismatch) so the
 * store degrades to "empty" rather than crashing. Distinguishes a normal `missing` from a suspicious
 * `corrupt`/`schema` and emits a redacted warning (file path only, never contents) for the latter.
 */
export function readJson<T = unknown>(filePath: string, opts: ReadJsonOptions<T> = {}): T | null {
  const warn =
    opts.warn ??
    ((reason: ReadJsonReason, file: string) => {
      if (reason !== 'missing') {
        process.stderr.write(`chatgml: store file ${reason} (resetting): ${file}\n`);
      }
    });

  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    warn('missing', filePath);
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    warn('corrupt', filePath);
    return null;
  }
  if (opts.validate && !opts.validate(value)) {
    warn('schema', filePath);
    return null;
  }
  return value as T;
}
