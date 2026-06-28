// test/tools/mcp.test.ts — wrapMcpTools and the resulting wrapped ToolDef.
//
// Uses a stub McpClient (no real child process) so we can drive every branch — the happy
// path, a server that throws on toolsList, a tool with no description, a tool result that
// surfaces isError.
import { describe, it, expect } from 'vitest';
import { wrapMcpTools } from '../../src/tools/mcp.js';
import type { McpClient, McpTool } from '../../src/mcp-client.js';
import type { ToolContext } from '../../src/types.js';

function makeStubClient(opts: {
  name?: string;
  tools?: McpTool[] | Error;
  result?: { content: string; isError?: boolean };
}): McpClient {
  // The wrapper reads `client.config.name ?? serverKey`. To exercise the fallback, we
  // intentionally let `name` be undefined when not supplied (do NOT default to 'stub' here).
  return {
    config: { name: opts.name, command: 'node' } as McpClient['config'],
    initialize: async () => {},
    toolsList: async () => {
      if (opts.tools instanceof Error) throw opts.tools;
      return opts.tools ?? [];
    },
    resourcesList: async () => [],
    callTool: async () => opts.result ?? { content: 'ok', isError: false },
    readResource: async () => '',
    close: () => {},
  } as unknown as McpClient;
}

const baseCtx: ToolContext = {
  root: '/tmp',
  scope: { repo: 'r' },
  memory: {} as ToolContext['memory'],
  approval: 'auto',
  ignore: { ignores: () => false },
  signal: new AbortController().signal,
  emit: () => {},
  requestApproval: async () => ({ approved: true }),
  log: () => {},
};

describe('wrapMcpTools', () => {
  it('returns an empty array when no clients are connected', async () => {
    expect(await wrapMcpTools(new Map())).toEqual([]);
  });

  it('wraps every advertised tool as `mcp_<server>_<tool>` with kind `mcp`', async () => {
    const client = makeStubClient({
      name: 'mock',
      tools: [
        {
          name: 'echo',
          description: 'echo text',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        },
        { name: 'fail', description: 'always fails', inputSchema: {} },
      ],
    });
    const tools = await wrapMcpTools(new Map([['mock', client]]));
    expect(tools.map((t) => t.name)).toEqual(['mcp_mock_echo', 'mcp_mock_fail']);
    for (const t of tools) {
      expect(t.kind).toBe('mcp');
      expect(t.server).toBe('mock');
    }
  });

  it('falls back to the map key when the client config has no name', async () => {
    const client = makeStubClient({
      name: undefined,
      tools: [{ name: 'x', inputSchema: {} }],
    });
    const tools = await wrapMcpTools(new Map([['fallback-key', client]]));
    expect(tools[0]?.name).toBe('mcp_fallback-key_x');
    expect(tools[0]?.server).toBe('fallback-key');
  });

  it('uses a generic description when the server omits one', async () => {
    const client = makeStubClient({
      tools: [{ name: 'noDesc', inputSchema: {} }],
    });
    const tools = await wrapMcpTools(new Map([['srv', client]]));
    expect(tools[0]?.description).toBe('MCP tool noDesc on srv');
  });

  it('logs and skips a server that throws on toolsList', async () => {
    const err = new Error('boom: list failed');
    const client = makeStubClient({ name: 'crash', tools: err });
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const tools = await wrapMcpTools(new Map([['crash', client]]));
      expect(tools).toEqual([]);
      expect(captured.some((s) => s.includes("failed to list tools for server 'crash'"))).toBe(
        true,
      );
      expect(captured.some((s) => s.includes('boom: list failed'))).toBe(true);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('logs and skips a server that throws a non-Error (string) on toolsList', async () => {
    const client = {
      config: { name: 'str', command: 'node' },
      initialize: async () => {},
      toolsList: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'string thrown error';
      },
      resourcesList: async () => [],
      callTool: async () => ({ content: '', isError: false }),
      readResource: async () => '',
      close: () => {},
    } as unknown as McpClient;
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const tools = await wrapMcpTools(new Map([['str', client]]));
      expect(tools).toEqual([]);
      expect(captured.some((s) => s.includes('string thrown error'))).toBe(true);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('wrapped tool execute delegates to callTool and surfaces isError', async () => {
    const client = makeStubClient({
      name: 'mock',
      tools: [{ name: 'echo', inputSchema: {} }],
      result: { content: 'echo:hi', isError: false },
    });
    const tools = await wrapMcpTools(new Map([['mock', client]]));
    const res = await tools[0]!.execute({ text: 'hi' }, baseCtx);
    expect(res.content).toBe('echo:hi');
    expect(res.isError).toBe(false);
  });

  it('wrapped tool execute surfaces isError when the server reports failure', async () => {
    const client = makeStubClient({
      name: 'mock',
      tools: [{ name: 'fail', inputSchema: {} }],
      result: { content: 'boom', isError: true },
    });
    const tools = await wrapMcpTools(new Map([['mock', client]]));
    const res = await tools[0]!.execute({}, baseCtx);
    expect(res.content).toBe('boom');
    expect(res.isError).toBe(true);
  });

  it('wrapped tool execute treats missing isError as not-an-error (defaults false)', async () => {
    const client = makeStubClient({
      name: 'mock',
      tools: [{ name: 'silent', inputSchema: {} }],
      result: { content: 'ok' }, // no isError
    });
    const tools = await wrapMcpTools(new Map([['mock', client]]));
    const res = await tools[0]!.execute({}, baseCtx);
    expect(res.isError).toBe(false);
  });

  it('mixed pass/fail servers — the failing one is skipped, the good one is wrapped', async () => {
    const good = makeStubClient({
      name: 'good',
      tools: [{ name: 'echo', inputSchema: {} }],
    });
    const bad = makeStubClient({ name: 'bad', tools: new Error('nope') });
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((_chunk: unknown) => true) as typeof process.stderr.write;
    try {
      const tools = await wrapMcpTools(
        new Map([
          ['good', good],
          ['bad', bad],
        ]),
      );
      expect(tools.map((t) => t.name)).toEqual(['mcp_good_echo']);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
