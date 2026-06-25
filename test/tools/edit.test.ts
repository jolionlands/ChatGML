import { describe, it, expect, vi, afterEach } from 'vitest';
import { editTool, editProposalId } from '../../src/tools/edit.js';
import { makeToolContext } from '../helpers/tool-context.js';

// Spy on fs writes at the module boundary; the M3 stub must NEVER call any of these.
// vi.hoisted lets the fns be referenced from the hoisted vi.mock factory.
const { writeFile, open, rename } = vi.hoisted(() => ({
  writeFile: vi.fn(),
  open: vi.fn(),
  rename: vi.fn(),
}));
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return { ...actual, default: { ...actual, writeFile, open, rename }, writeFile, open, rename };
});

afterEach(() => {
  vi.clearAllMocks();
});

const DIFF = '--- a\n+++ b\n@@ -1 +1 @@\n-hp -= 1;\n+hp -= dmg;\n';

describe('apply_patch (M3 stub)', () => {
  it('is a gated tool', () => {
    expect(editTool.kind).toBe('gated');
    expect(editTool.name).toBe('apply_patch');
  });

  it('rejects a ../ escape as sandbox_escape', async () => {
    const { ctx } = makeToolContext({ root: '/proj/root' });
    await expect(
      editTool.execute({ path: '../outside.gml', diff: DIFF }, ctx),
    ).rejects.toMatchObject({ name: 'ToolError', code: 'sandbox_escape' });
  });

  it('returns not_implemented for a valid in-root target AND never writes', async () => {
    const { ctx } = makeToolContext({ root: '/proj/root' });
    await expect(
      editTool.execute({ path: 'objects/obj_player/Step_0.gml', diff: DIFF }, ctx),
    ).rejects.toMatchObject({ name: 'ToolError', code: 'not_implemented' });
    expect(writeFile).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('rejects an empty diff as bad_args', async () => {
    const { ctx } = makeToolContext({ root: '/proj/root' });
    await expect(editTool.execute({ path: 'a.gml', diff: '   ' }, ctx)).rejects.toMatchObject({
      code: 'bad_args',
    });
  });

  it('mints a stable, deterministic proposal id', () => {
    const a = editProposalId('a.gml', DIFF);
    const b = editProposalId('a.gml', DIFF);
    const c = editProposalId('b.gml', DIFF);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
