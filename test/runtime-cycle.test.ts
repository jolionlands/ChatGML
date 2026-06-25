// test/runtime-cycle.test.ts — prove there is no runtime require/TDZ cycle through src/types.ts.
//
// Importing a deep module (memory/local) FIRST must not leave ToolError undefined: types.ts is pure
// types (erased at runtime) and the runtime ToolError/defineTool live in tool-error.ts, so the
// graph has no value cycle. We import memory/local first, then tool-error, and assert ToolError is
// a usable constructor.
import { describe, it, expect } from 'vitest';
import { LocalMemoryProvider } from '../src/memory/local.js';
import { ToolError, defineTool } from '../src/tool-error.js';
import { editTool } from '../src/tools/edit.js';

describe('no runtime type cycle', () => {
  it('ToolError is defined after importing memory/local first', () => {
    expect(typeof LocalMemoryProvider).toBe('function');
    const e = new ToolError('bad_args', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('bad_args');
    expect(typeof defineTool).toBe('function');
  });

  it('a tool that throws ToolError is wired and runnable', () => {
    expect(editTool.name).toBe('apply_patch');
    expect(editTool.kind).toBe('gated');
  });
});
