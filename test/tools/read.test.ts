import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeTmpRepo } from '../helpers/fakes.js';
import { makeToolContext } from '../helpers/tool-context.js';
import { readTool } from '../../src/tools/read.js';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('read_file tool', () => {
  it('reads a full file with line numbers and a citation', async () => {
    const repo = makeTmpRepo({ 'objects/obj_player/Step_0.gml': 'a\nb\nc\n' });
    cleanup = repo.cleanup;
    const { ctx } = makeToolContext({ root: repo.root });
    const res = await readTool.execute({ path: 'objects/obj_player/Step_0.gml' }, ctx);
    expect(res.content).toContain('1\ta');
    expect(res.content).toContain('3\tc');
    expect(res.citations?.[0]?.path).toBe('objects/obj_player/Step_0.gml');
    expect(res.citations?.[0]?.gml?.kind).toBe('event');
  });

  it('reads a line range (1-based inclusive)', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'l1\nl2\nl3\nl4\nl5\n' });
    cleanup = repo.cleanup;
    const { ctx } = makeToolContext({ root: repo.root });
    const res = await readTool.execute({ path: 'a.gml', startLine: 2, endLine: 4 }, ctx);
    expect(res.content).toBe('2\tl2\n3\tl3\n4\tl4');
    expect(res.citations?.[0]?.startLine).toBe(2);
    expect(res.citations?.[0]?.endLine).toBe(4);
  });

  it('clamps an out-of-range endLine to the file length', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'l1\nl2\n' });
    cleanup = repo.cleanup;
    const { ctx } = makeToolContext({ root: repo.root });
    const res = await readTool.execute({ path: 'a.gml', startLine: 1, endLine: 99 }, ctx);
    expect(res.citations?.[0]?.endLine).toBe(3); // 'l1','l2','' -> 3 lines from trailing \n
  });

  it('rejects endLine < startLine as bad_args', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'x\n' });
    cleanup = repo.cleanup;
    const { ctx } = makeToolContext({ root: repo.root });
    await expect(
      readTool.execute({ path: 'a.gml', startLine: 5, endLine: 2 }, ctx),
    ).rejects.toMatchObject({ name: 'ToolError', code: 'bad_args' });
  });

  it('rejects a ../ escape as sandbox_escape', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'x\n' });
    cleanup = repo.cleanup;
    const { ctx } = makeToolContext({ root: repo.root });
    await expect(readTool.execute({ path: '../outside.gml' }, ctx)).rejects.toMatchObject({
      name: 'ToolError',
      code: 'sandbox_escape',
    });
  });

  it('returns not_found for a missing file', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'x\n' });
    cleanup = repo.cleanup;
    const { ctx } = makeToolContext({ root: repo.root });
    await expect(readTool.execute({ path: 'nope.gml' }, ctx)).rejects.toMatchObject({
      name: 'ToolError',
      code: 'not_found',
    });
  });

  it('refuses a binary file', async () => {
    const repo = makeTmpRepo({});
    cleanup = repo.cleanup;
    writeFileSync(path.join(repo.root, 'blob.bin.gml'), Buffer.from([0x00, 0x01, 0x02]));
    const { ctx } = makeToolContext({ root: repo.root });
    await expect(readTool.execute({ path: 'blob.bin.gml' }, ctx)).rejects.toMatchObject({
      name: 'ToolError',
      code: 'binary',
    });
  });

  it('rejects a file over the 1MB cap as too_large', async () => {
    const repo = makeTmpRepo({});
    cleanup = repo.cleanup;
    writeFileSync(path.join(repo.root, 'big.gml'), 'a'.repeat(1024 * 1024 + 1));
    const { ctx } = makeToolContext({ root: repo.root });
    await expect(readTool.execute({ path: 'big.gml' }, ctx)).rejects.toMatchObject({
      name: 'ToolError',
      code: 'too_large',
    });
  });
});
