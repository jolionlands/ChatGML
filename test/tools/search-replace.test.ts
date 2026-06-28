import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { searchReplaceTool, applySearchReplaceBlocks } from '../../src/tools/search_replace.js';
import { makeToolContext } from '../helpers/tool-context.js';
import type { ApprovalRequest } from '../../src/types.js';
import { makeTmpRepo } from '../helpers/fakes.js';

const approve = async (): Promise<import('../../src/types.js').ApprovalResolution> => ({
  approved: true,
});
const reject = async (): Promise<import('../../src/types.js').ApprovalResolution> => ({
  approved: false,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('search_replace — tool identity & validation', () => {
  it('is a gated tool named search_replace', () => {
    expect(searchReplaceTool.kind).toBe('gated');
    expect(searchReplaceTool.name).toBe('search_replace');
  });

  it('applies a single SEARCH/REPLACE block successfully', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'hp -= 1;\n' });
    try {
      const { ctx, events } = makeToolContext({
        root: repo.root,
        approval: 'auto',
        requestApproval: approve,
      });
      const res = await searchReplaceTool.execute(
        { path: 'a.gml', blocks: [{ search: 'hp -= 1;\n', replace: 'hp -= dmg;\n' }] },
        ctx,
      );
      expect(res.isError).not.toBe(true);
      expect(res.content).toBe('updated a.gml');
      expect(res.citations?.[0]).toEqual({ path: 'a.gml', provider: 'local' });
      expect(await fsp.readFile(path.join(repo.root, 'a.gml'), 'utf8')).toBe('hp -= dmg;\n');
      const checkpoint = events.find((e) => e.type === 'checkpoint');
      expect(checkpoint).toBeDefined();
      expect(checkpoint && checkpoint.type === 'checkpoint' && checkpoint.path).toBe('a.gml');
    } finally {
      repo.cleanup();
    }
  });

  it('returns bad_patch when search text is not found', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'hp -= 1;\n' });
    try {
      const { ctx } = makeToolContext({ root: repo.root, requestApproval: approve });
      await expect(
        searchReplaceTool.execute(
          { path: 'a.gml', blocks: [{ search: 'not present', replace: 'x' }] },
          ctx,
        ),
      ).rejects.toMatchObject({ name: 'ToolError', code: 'bad_patch' });
    } finally {
      repo.cleanup();
    }
  });

  it('returns bad_patch when search text appears multiple times', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'a\na\n' });
    try {
      const { ctx } = makeToolContext({ root: repo.root, requestApproval: approve });
      await expect(
        searchReplaceTool.execute(
          { path: 'a.gml', blocks: [{ search: 'a\n', replace: 'b\n' }] },
          ctx,
        ),
      ).rejects.toMatchObject({ name: 'ToolError', code: 'bad_patch' });
    } finally {
      repo.cleanup();
    }
  });

  it('returns bad_patch when SEARCH/REPLACE blocks overlap', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'alpha beta gamma\n' });
    try {
      const { ctx } = makeToolContext({ root: repo.root, requestApproval: approve });
      await expect(
        searchReplaceTool.execute(
          {
            path: 'a.gml',
            blocks: [
              { search: 'alpha beta', replace: 'X' },
              { search: 'beta gamma', replace: 'Y' },
            ],
          },
          ctx,
        ),
      ).rejects.toMatchObject({ name: 'ToolError', code: 'bad_patch' });
    } finally {
      repo.cleanup();
    }
  });

  it('rejects a ../ escape as sandbox_escape before any I/O', async () => {
    const repo = makeTmpRepo({});
    try {
      const { ctx } = makeToolContext({ root: repo.root, requestApproval: approve });
      await expect(
        searchReplaceTool.execute(
          { path: '../outside.gml', blocks: [{ search: 'x', replace: 'y' }] },
          ctx,
        ),
      ).rejects.toMatchObject({ name: 'ToolError', code: 'sandbox_escape' });
    } finally {
      repo.cleanup();
    }
  });
});

describe('search_replace — applying multiple blocks', () => {
  it('applies several non-overlapping blocks in one call', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'alpha\nbeta\ngamma\n' });
    try {
      const { ctx } = makeToolContext({
        root: repo.root,
        approval: 'auto',
        requestApproval: approve,
      });
      const res = await searchReplaceTool.execute(
        {
          path: 'a.gml',
          blocks: [
            { search: 'alpha\n', replace: 'one\n' },
            { search: 'gamma\n', replace: 'three\n' },
          ],
        },
        ctx,
      );
      expect(res.isError).not.toBe(true);
      expect(await fsp.readFile(path.join(repo.root, 'a.gml'), 'utf8')).toBe('one\nbeta\nthree\n');
    } finally {
      repo.cleanup();
    }
  });
});

describe('search_replace — approval gating', () => {
  it('writes ONLY on approve; no write on reject', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'hp -= 1;\n' });
    try {
      const openSpy = vi.spyOn(fsp, 'open');
      const renameSpy = vi.spyOn(fsp, 'rename');
      const { ctx: rejectCtx } = makeToolContext({ root: repo.root, requestApproval: reject });
      const rejectRes = await searchReplaceTool.execute(
        { path: 'a.gml', blocks: [{ search: 'hp -= 1;\n', replace: 'hp -= dmg;\n' }] },
        rejectCtx,
      );
      expect(rejectRes.isError).not.toBe(true);
      expect(rejectRes.content).toMatch(/not approved/i);
      expect(openSpy).not.toHaveBeenCalled();
      expect(renameSpy).not.toHaveBeenCalled();
      expect(await fsp.readFile(path.join(repo.root, 'a.gml'), 'utf8')).toBe('hp -= 1;\n');
    } finally {
      repo.cleanup();
    }
  });

  it('gated mode BLOCKS on requestApproval until resolved, then writes on approve', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'hp -= 1;\n' });
    try {
      let resolveApproval: ((ok: boolean) => void) | null = null;
      let seenReq: ApprovalRequest | null = null;
      const { ctx } = makeToolContext({
        root: repo.root,
        approval: 'gated',
        requestApproval: (req) =>
          new Promise<import('../../src/types.js').ApprovalResolution>((resolve) => {
            seenReq = req;
            resolveApproval = (ok: boolean) => resolve({ approved: ok });
          }),
      });

      let settled = false;
      const runPromise = searchReplaceTool
        .execute(
          { path: 'a.gml', blocks: [{ search: 'hp -= 1;\n', replace: 'hp -= dmg;\n' }] },
          ctx,
        )
        .then((r) => {
          settled = true;
          return r;
        });

      for (let i = 0; i < 100 && seenReq === null; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(seenReq).not.toBeNull();
      const req = seenReq!;
      expect(req.kind).toBe('edit');
      if (req.kind === 'edit') {
        expect(req.path).toBe('a.gml');
        expect(req.diff).toContain('<<<<<<< SEARCH');
        expect(req.diff).toContain('hp -= 1;');
        expect(req.diff).toContain('hp -= dmg;');
      }

      expect(settled).toBe(false);
      expect(await fsp.readFile(path.join(repo.root, 'a.gml'), 'utf8')).toBe('hp -= 1;\n');

      resolveApproval!(true);
      await runPromise;
      expect(await fsp.readFile(path.join(repo.root, 'a.gml'), 'utf8')).toBe('hp -= dmg;\n');
    } finally {
      repo.cleanup();
    }
  });
});

describe('search_replace — partial block approval', () => {
  it('applySearchReplaceBlocks keeps only approved block indices', () => {
    const blocks = [
      { search: 'alpha\n', replace: 'one\n' },
      { search: 'beta\n', replace: 'two\n' },
      { search: 'gamma\n', replace: 'three\n' },
    ];
    expect(applySearchReplaceBlocks(blocks, [0, 2])).toEqual([
      { search: 'alpha\n', replace: 'one\n' },
      { search: 'gamma\n', replace: 'three\n' },
    ]);
    expect(applySearchReplaceBlocks(blocks, [99])).toEqual([]);
  });

  it('approving only block 0 applies only that change', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'alpha\nbeta\ngamma\n' });
    try {
      const { ctx } = makeToolContext({
        root: repo.root,
        approval: 'auto',
        requestApproval: async () => ({ approved: true, blocks: [0] }),
      });
      const res = await searchReplaceTool.execute(
        {
          path: 'a.gml',
          blocks: [
            { search: 'alpha\n', replace: 'one\n' },
            { search: 'gamma\n', replace: 'three\n' },
          ],
        },
        ctx,
      );
      expect(res.isError).not.toBe(true);
      expect(await fsp.readFile(path.join(repo.root, 'a.gml'), 'utf8')).toBe('one\nbeta\ngamma\n');
    } finally {
      repo.cleanup();
    }
  });

  it('approving only block 1 applies only that change', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'alpha\nbeta\ngamma\n' });
    try {
      const { ctx } = makeToolContext({
        root: repo.root,
        approval: 'auto',
        requestApproval: async () => ({ approved: true, blocks: [1] }),
      });
      const res = await searchReplaceTool.execute(
        {
          path: 'a.gml',
          blocks: [
            { search: 'alpha\n', replace: 'one\n' },
            { search: 'gamma\n', replace: 'three\n' },
          ],
        },
        ctx,
      );
      expect(res.isError).not.toBe(true);
      expect(await fsp.readFile(path.join(repo.root, 'a.gml'), 'utf8')).toBe(
        'alpha\nbeta\nthree\n',
      );
    } finally {
      repo.cleanup();
    }
  });

  it('approving an empty block list writes nothing', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'alpha\nbeta\ngamma\n' });
    try {
      const { ctx } = makeToolContext({
        root: repo.root,
        approval: 'auto',
        requestApproval: async () => ({ approved: true, blocks: [] }),
      });
      const res = await searchReplaceTool.execute(
        {
          path: 'a.gml',
          blocks: [
            { search: 'alpha\n', replace: 'one\n' },
            { search: 'gamma\n', replace: 'three\n' },
          ],
        },
        ctx,
      );
      expect(res.content).toMatch(/not approved/i);
      expect(await fsp.readFile(path.join(repo.root, 'a.gml'), 'utf8')).toBe(
        'alpha\nbeta\ngamma\n',
      );
    } finally {
      repo.cleanup();
    }
  });
});
