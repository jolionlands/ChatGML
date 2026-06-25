import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  AgentEvent,
  Citation,
  ChatMessage,
  MemoryConfig,
  Scope,
  ToolResult,
} from '../src/types.js';
import { ToolError, defineTool } from '../src/tool-error.js';
import { z } from 'zod';

describe('shared types', () => {
  it('AgentEvent narrows exhaustively by type', () => {
    const ev: AgentEvent = { type: 'token', text: 'hi' };
    if (ev.type === 'token') {
      expectTypeOf(ev.text).toEqualTypeOf<string>();
    }
    // exhaustive switch compiles (never branch reached only for unknown type)
    function render(e: AgentEvent): string {
      switch (e.type) {
        case 'status':
          return e.phase;
        case 'token':
          return e.text;
        case 'tool_call':
          return e.name;
        case 'tool_result':
          return e.content;
        case 'edit_proposal':
          return e.path;
        case 'approval_request':
          return e.path;
        case 'answer':
          return e.text;
        case 'error':
          return e.message;
        default: {
          const _exhaustive: never = e;
          return _exhaustive;
        }
      }
    }
    expect(render(ev)).toBe('hi');
  });

  it('Citation.path is optional (hippo memory nodes have no path)', () => {
    const c: Citation = { snippet: 'x', provider: 'hippo' };
    expect(c.path).toBeUndefined();
    expectTypeOf<Citation['path']>().toEqualTypeOf<string | undefined>();
  });

  it('MemoryConfig is a discriminated union', () => {
    const local: MemoryConfig = { provider: 'local' };
    const hippo: MemoryConfig = { provider: 'hippo', url: 'http://127.0.0.1:1' };
    expect(local.provider).toBe('local');
    if (hippo.provider === 'hippo') {
      expectTypeOf(hippo.url).toEqualTypeOf<string>();
    }
  });

  it('ToolDef<A>.execute always returns Promise<ToolResult>', () => {
    const schema = z.object({ pattern: z.string() });
    const tool = defineTool({
      name: 'demo',
      description: 'demo',
      schema,
      kind: 'read',
      async execute(args) {
        expectTypeOf(args.pattern).toEqualTypeOf<string>();
        return { content: 'ok' };
      },
    });
    expectTypeOf(tool.execute).returns.resolves.toEqualTypeOf<ToolResult>();
    expect(tool.name).toBe('demo');
  });

  it('ToolError carries a typed code and meta', () => {
    const err = new ToolError('bad_args', 'nope', { field: 'x' });
    expect(err.code).toBe('bad_args');
    expect(err.meta).toEqual({ field: 'x' });
    expect(err).toBeInstanceOf(Error);
  });

  it('a tool message type allows tool_call_id', () => {
    const msg: ChatMessage = { role: 'tool', content: 'result', tool_call_id: 't1' };
    expect(msg.tool_call_id).toBe('t1');
  });

  it('Scope is {repo, sub?}', () => {
    const s: Scope = { repo: 'r' };
    expectTypeOf<Scope['repo']>().toEqualTypeOf<string>();
    expectTypeOf<Scope['sub']>().toEqualTypeOf<string | undefined>();
    expect(s.repo).toBe('r');
  });
});
