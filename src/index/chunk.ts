// src/index/chunk.ts — line-aware overlapping chunking with content hashes.
//
// Chunks are split on LINE boundaries (never mid-line) into windows of ~chunkSize characters with a
// chunkOverlap-character tail repeated into the next window. Each chunk gets a stable id
// (`${path}#${startLine}-${endLine}`, 1-based inclusive) and a sha256 content hash. For GameMaker 2.3
// multi-function scripts, top-level `function NAME(` boundaries are detected so each function can
// become a symbol-level citation.
import { createHash } from 'node:crypto';
import type { Chunk, SymbolRef } from '../memory/types.js';

/** sha256 hex of a string. Stable across processes; sensitive to a single-byte change. */
export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface ChunkOptions {
  /** Target chunk size in characters (line-aligned; a single long line may exceed this). */
  chunkSize?: number;
  /** Overlap in characters carried from the end of one chunk into the start of the next. */
  chunkOverlap?: number;
}

const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_OVERLAP = 200;

interface RawChunk {
  text: string;
  startLine: number; // 1-based inclusive
  endLine: number; // 1-based inclusive
}

/**
 * Split text into line-aware overlapping windows. Returns `{text,startLine,endLine}` (1-based,
 * inclusive line numbers). Empty/whitespace-only input yields zero chunks; any non-empty input yields
 * at least one chunk. Overlap lines are repeated verbatim between consecutive chunks.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): RawChunk[] {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = Math.max(0, Math.min(opts.chunkOverlap ?? DEFAULT_OVERLAP, chunkSize - 1));

  if (text.trim() === '') return [];

  const lines = text.split('\n');
  // Per-line lengths include the newline that joins them (except a possibly-absent trailing one).
  const lineLen = lines.map((l, i) => l.length + (i < lines.length - 1 ? 1 : 0));

  const chunks: RawChunk[] = [];
  let start = 0; // 0-based line index
  const n = lines.length;

  while (start < n) {
    let size = 0;
    let end = start; // exclusive 0-based bound being grown
    while (end < n && (size === 0 || size + lineLen[end]! <= chunkSize)) {
      size += lineLen[end]!;
      end++;
    }
    // `end` is now the exclusive line bound (at least start+1).
    const slice = lines.slice(start, end).join('\n');
    chunks.push({ text: slice, startLine: start + 1, endLine: end });

    if (end >= n) break;

    // Compute the overlap: walk back from `end` accumulating chars until we reach `overlap`.
    let back = end;
    let acc = 0;
    while (back > start + 1 && acc + lineLen[back - 1]! <= overlap) {
      acc += lineLen[back - 1]!;
      back--;
    }
    const nextStart = overlap > 0 ? back : end;
    // Guarantee forward progress (avoid infinite loop when a single line exceeds chunkSize).
    start = nextStart > start ? nextStart : end;
  }
  return chunks;
}

/**
 * Detect top-level `function NAME(` declarations in GML 2.3 scripts. Returns the 1-based line of each
 * declaration with its name. Only matches at the start of a line (ignoring leading whitespace) so
 * nested/anonymous functions don't create spurious symbols.
 */
export function detectFunctionBoundaries(text: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  const lines = text.split('\n');
  const re = /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (m) out.push({ name: m[1]!, line: i + 1 });
  }
  return out;
}

/**
 * Chunk a file's contents into `Chunk` records with stable ids, content hashes, and (for scripts)
 * symbol refs derived from top-level function boundaries. `path` is the repo-relative POSIX path.
 */
export function chunkFile(
  relPath: string,
  text: string,
  opts: ChunkOptions & { lang?: string } = {},
): Chunk[] {
  const raw = chunkText(text, opts);
  const functions = relPath.toLowerCase().endsWith('.gml') ? detectFunctionBoundaries(text) : [];

  return raw.map((rc) => {
    const id = `${relPath}#${rc.startLine}-${rc.endLine}`;
    const chunk: Chunk = {
      id,
      path: relPath,
      text: rc.text,
      contentHash: hashContent(rc.text),
      startLine: rc.startLine,
      endLine: rc.endLine,
    };
    if (opts.lang !== undefined) chunk.lang = opts.lang;
    const sym = symbolForRange(functions, relPath, rc.startLine, rc.endLine);
    if (sym) chunk.symbol = sym;
    return chunk;
  });
}

/** Pick the function whose declaration line falls within a chunk's range (first match wins). */
function symbolForRange(
  functions: Array<{ name: string; line: number }>,
  relPath: string,
  startLine: number,
  endLine: number,
): SymbolRef | undefined {
  const hit = functions.find((f) => f.line >= startLine && f.line <= endLine);
  if (!hit) return undefined;
  return { name: hit.name, path: relPath, kind: 'function' };
}
