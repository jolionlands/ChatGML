// src/index/files.ts — directory walking, .gitignore filtering, and GML metadata.
//
// `buildIgnoreFilter` reads every `.gitignore` under the root EXACTLY ONCE (no per-file git reopen,
// which was the original tool's O(n) bug). `walkFiles` yields repo-relative paths, skips EXCLUDE_DIRS
// and ignored paths, applies an extension filter, and is symlink/loop safe.
//
// GML metadata derivation is re-exported here (the indexer wants both files + meta from one place).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import type { IgnoreFilter } from '../types.js';

export type { IgnoreFilter };
export { deriveGmlMeta } from './gml.js';
export type { GmlMeta } from './gml.js';

/**
 * Directories never walked. Node-style noise + GameMaker output/noise + ChatGML's own store.
 * `datafiles/` holds bundled binary assets; `vector_store/` is the legacy Python store.
 */
export const EXCLUDE_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'build',
  'dist',
  'out',
  'tmp',
  'temp',
  'coverage',
  '.cache',
  'datafiles',
  'vector_store',
  '.chatgml',
];

/**
 * File extensions excluded from indexing (GameMaker binary/output + common binaries).
 * `.yy`/`.yyp` are project JSON we do NOT index in v1 (path-only domain; trailing commas).
 */
export const EXCLUDE_EXTENSIONS: readonly string[] = [
  '.yyz',
  '.yydebug',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.wav',
  '.mp3',
  '.ogg',
  '.ttf',
  '.otf',
  '.zip',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
];

/** Default set of extensions actually indexed when no explicit filter is supplied. */
export const DEFAULT_INDEX_EXTENSIONS: readonly string[] = [
  '.gml',
  '.js',
  '.ts',
  '.json',
  '.md',
  '.txt',
  '.shader',
  '.vsh',
  '.fsh',
  '.html',
  '.css',
];

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Build an IgnoreFilter from every `.gitignore` under `root`. Each `.gitignore` is read once during
 * construction; the returned filter does no further I/O. Patterns from nested `.gitignore` files are
 * applied relative to the repo root by prefixing the file's directory (a simplification that is
 * correct for the common "anchored" patterns; the indexer also hard-skips EXCLUDE_DIRS).
 */
export async function buildIgnoreFilter(root: string): Promise<IgnoreFilter> {
  const ig = ignore();
  const gitignorePaths = await collectGitignores(root);
  for (const gi of gitignorePaths) {
    let text: string;
    try {
      text = await fsp.readFile(gi.absPath, 'utf8');
    } catch {
      continue;
    }
    const dirRel = toPosix(path.relative(root, path.dirname(gi.absPath)));
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      ig.add(prefixPattern(line, dirRel));
    }
  }
  return {
    ignores(repoRelPosixPath: string): boolean {
      const rel = toPosix(repoRelPosixPath).replace(/^\/+/, '');
      if (rel === '') return false;
      return ig.ignores(rel);
    },
  };
}

/** Re-anchor a nested-.gitignore pattern under its directory, preserving negation. */
function prefixPattern(pattern: string, dirRel: string): string {
  if (dirRel === '' || dirRel === '.') return pattern;
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  // A pattern containing a slash (other than a trailing one) is already path-anchored to its file's
  // directory; a bare name matches anywhere below it. Either way, scoping under dirRel is safe.
  const anchored = body.startsWith('/') ? body.slice(1) : body;
  const combined = `${dirRel}/${anchored}`;
  return negated ? `!${combined}` : combined;
}

/** Find every `.gitignore` under root, skipping EXCLUDE_DIRS so we never descend into node_modules. */
async function collectGitignores(root: string): Promise<Array<{ absPath: string }>> {
  const found: Array<{ absPath: string }> = [];
  const stack: string[] = [root];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let real: string;
    try {
      real = await fsp.realpath(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.includes(e.name)) continue;
        stack.push(abs);
      } else if (e.isFile() && e.name === '.gitignore') {
        found.push({ absPath: abs });
      }
    }
  }
  return found;
}

export interface WalkOptions {
  /** Extensions to include (lowercase, with dot). Defaults to DEFAULT_INDEX_EXTENSIONS. */
  extensions?: readonly string[];
  /** When true, include ALL non-excluded extensions (the `extensions` filter is ignored). */
  allExtensions?: boolean;
}

export interface WalkedFile {
  absPath: string;
  relPath: string; // repo-relative, POSIX separators
}

/**
 * Asynchronously walk `root`, yielding non-ignored files that pass the extension filter. Skips
 * EXCLUDE_DIRS and any directory/file the ignore filter rejects. Symlink-loop safe via a realpath
 * visited-set; symlinked files are emitted but symlinked directories are not re-descended.
 */
export async function* walkFiles(
  root: string,
  isIgnored: (relPosix: string) => boolean,
  opts: WalkOptions = {},
): AsyncIterable<WalkedFile> {
  const exts = (opts.extensions ?? DEFAULT_INDEX_EXTENSIONS).map((e) => e.toLowerCase());
  const allExt = opts.allExtensions === true;
  const visited = new Set<string>();
  yield* walkDir(root, root, isIgnored, exts, allExt, visited);
}

async function* walkDir(
  root: string,
  dir: string,
  isIgnored: (relPosix: string) => boolean,
  exts: string[],
  allExt: boolean,
  visited: Set<string>,
): AsyncIterable<WalkedFile> {
  let real: string;
  try {
    real = await fsp.realpath(dir);
  } catch {
    return;
  }
  if (visited.has(real)) return; // symlink/loop guard
  visited.add(real);

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // Stable order for deterministic walks.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = toPosix(path.relative(root, abs));

    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.includes(e.name)) continue;
      if (isIgnored(`${rel}/`) || isIgnored(rel)) continue;
      yield* walkDir(root, abs, isIgnored, exts, allExt, visited);
    } else if (e.isFile()) {
      if (isIgnored(rel)) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (EXCLUDE_EXTENSIONS.includes(ext)) continue;
      if (!allExt && !exts.includes(ext)) continue;
      yield { absPath: abs, relPath: rel };
    }
  }
}
