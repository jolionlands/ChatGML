import { describe, it, expect, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { buildIgnoreFilter, walkFiles, EXCLUDE_DIRS } from '../../src/index/files.js';
import { makeTmpRepo } from '../helpers/fakes.js';

async function collect(
  root: string,
  isIgnored: (p: string) => boolean,
  opts?: { allExtensions?: boolean },
): Promise<string[]> {
  const out: string[] = [];
  for await (const f of walkFiles(root, isIgnored, opts ?? {})) out.push(f.relPath);
  return out.sort();
}

describe('buildIgnoreFilter', () => {
  it('honors gitignore directory and glob patterns; does not ignore source', async () => {
    const repo = makeTmpRepo(
      {
        'src/a.gml': 'a',
        'build/out.gml': 'b',
        'debug.log': 'log',
        'keep.txt': 'k',
      },
      { gitignore: 'build/\n*.log\n' },
    );
    try {
      const ig = await buildIgnoreFilter(repo.root);
      expect(ig.ignores('build/out.gml')).toBe(true);
      expect(ig.ignores('debug.log')).toBe(true);
      expect(ig.ignores('src/a.gml')).toBe(false);
      expect(ig.ignores('keep.txt')).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('with no gitignore, nothing is ignored', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'x' });
    try {
      const ig = await buildIgnoreFilter(repo.root);
      expect(ig.ignores('a.gml')).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('reads each .gitignore exactly once (matcher built once)', async () => {
    const repo = makeTmpRepo(
      { 'a.gml': 'x', 'sub/b.gml': 'y', 'sub/.gitignore': '*.tmp\n' },
      { gitignore: '*.log\n' },
    );
    try {
      const spy = vi.spyOn(fsp, 'readFile');
      await buildIgnoreFilter(repo.root);
      const gitignoreReads = spy.mock.calls.filter((c) => String(c[0]).endsWith('.gitignore'));
      expect(gitignoreReads.length).toBe(2); // root + sub, once each
    } finally {
      repo.cleanup();
    }
  });
});

describe('walkFiles', () => {
  it('walks GM resource dirs and skips datafiles/build noise', async () => {
    const repo = makeTmpRepo({
      'objects/obj_player/Step_0.gml': 'step',
      'scripts/scr_util/scr_util.gml': 'fn',
      'datafiles/blob.gml': 'noise', // datafiles is an EXCLUDE_DIR
      'build/gen.gml': 'noise', // build is an EXCLUDE_DIR
      'node_modules/pkg/index.gml': 'noise',
    });
    try {
      const ig = await buildIgnoreFilter(repo.root);
      const files = await collect(repo.root, (p) => ig.ignores(p));
      expect(files).toContain('objects/obj_player/Step_0.gml');
      expect(files).toContain('scripts/scr_util/scr_util.gml');
      expect(files).not.toContain('datafiles/blob.gml');
      expect(files).not.toContain('build/gen.gml');
      expect(files).not.toContain('node_modules/pkg/index.gml');
    } finally {
      repo.cleanup();
    }
  });

  it('applies the extension filter (default set)', async () => {
    const repo = makeTmpRepo({
      'a.gml': 'x',
      'b.png': 'binary', // excluded extension
      'notes.md': 'doc',
      'archive.yyz': 'gm-output', // excluded extension
    });
    try {
      const files = await collect(repo.root, () => false);
      expect(files).toContain('a.gml');
      expect(files).toContain('notes.md');
      expect(files).not.toContain('b.png');
      expect(files).not.toContain('archive.yyz');
    } finally {
      repo.cleanup();
    }
  });

  it('respects ignored files and directories', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'x', 'secret/b.gml': 'y' }, { gitignore: 'secret/\n' });
    try {
      const ig = await buildIgnoreFilter(repo.root);
      const files = await collect(repo.root, (p) => ig.ignores(p));
      expect(files).toEqual(['a.gml']);
    } finally {
      repo.cleanup();
    }
  });

  it("never walks ChatGML's own project-local .chatgml.json — F7", async () => {
    const repo = makeTmpRepo({ 'a.gml': 'x', '.chatgml.json': '{"chat":{"model":"m"}}' });
    try {
      // Even with allExtensions, the config dotfile (a .json) must be excluded.
      const files = await collect(repo.root, () => false, { allExtensions: true });
      expect(files).toContain('a.gml');
      expect(files).not.toContain('.chatgml.json');
    } finally {
      repo.cleanup();
    }
  });

  it('allExtensions:true includes files outside the default extension set', async () => {
    const repo = makeTmpRepo({ 'a.weirdext': 'x', 'b.gml': 'y' });
    try {
      const files = await collect(repo.root, () => false, { allExtensions: true });
      expect(files).toContain('a.weirdext');
      expect(files).toContain('b.gml');
    } finally {
      repo.cleanup();
    }
  });

  it('still excludes binary extensions even with allExtensions', async () => {
    const repo = makeTmpRepo({ 'img.png': 'x', 'a.gml': 'y' });
    try {
      const files = await collect(repo.root, () => false, { allExtensions: true });
      expect(files).not.toContain('img.png');
    } finally {
      repo.cleanup();
    }
  });

  it('walking a non-existent root yields nothing (no throw)', async () => {
    const files = await collect('C:/definitely/not/a/real/path/xyzzy', () => false);
    expect(files).toEqual([]);
  });

  it('a nested .gitignore is scoped under its directory', async () => {
    const repo = makeTmpRepo({
      'top.tmp': 'kept', // root .gitignore does NOT ignore *.tmp; nested one does, only under sub/
      'sub/inner.tmp': 'ignored',
      'sub/keep.gml': 'kept',
      'sub/.gitignore': '*.tmp\n',
    });
    try {
      const ig = await buildIgnoreFilter(repo.root);
      expect(ig.ignores('sub/inner.tmp')).toBe(true);
      expect(ig.ignores('top.tmp')).toBe(false);
      expect(ig.ignores('sub/keep.gml')).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('a nested .gitignore negation is scoped under its directory', async () => {
    const repo = makeTmpRepo({
      'sub/a.log': 'x',
      'sub/keep.log': 'y',
      '.gitignore': '*.log\n',
      'sub/.gitignore': '!keep.log\n',
    });
    try {
      const ig = await buildIgnoreFilter(repo.root);
      expect(ig.ignores('sub/a.log')).toBe(true);
      expect(ig.ignores('sub/keep.log')).toBe(false); // un-ignored by the nested negation
    } finally {
      repo.cleanup();
    }
  });

  it('an empty repo-relative path is never ignored', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'x' });
    try {
      const ig = await buildIgnoreFilter(repo.root);
      expect(ig.ignores('')).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('EXCLUDE_DIRS includes the known GM + node noise', () => {
    expect(EXCLUDE_DIRS).toContain('node_modules');
    expect(EXCLUDE_DIRS).toContain('datafiles');
    expect(EXCLUDE_DIRS).toContain('vector_store');
    expect(EXCLUDE_DIRS).toContain('.chatgml');
  });
});
