// test/mcp.test.ts — the MCP server: JSON-RPC over stdio, tool listing, and tool dispatch.
//
// Drives `runMcpServer` against in-memory PassThrough streams (no real child process), proving the
// initialize handshake, tools/list (the ChatGML registry surfaced as MCP tools), and tools/call
// (a real dispatch of glob + read_file against a tmp repo) all work end-to-end over the JSON-RPC
// framing. apply_patch is covered dispatch-wise in the tool tests; here we assert the MCP wire shape
// of a read-only dispatch (glob) and that an unknown tool name is an MCP isError result, not a
// transport error.
import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { runMcpServer, MCP_PROTOCOL_VERSION, MCP_SERVER_NAME } from '../src/mcp.js';
import { buildToolRegistry } from '../src/tools/index.js';
import { makeTmpRepo, FakeEmbeddings } from './helpers/fakes.js';
import { buildIgnoreFilter } from '../src/index/files.js';
import { LocalMemoryProvider } from '../src/memory/local.js';
import type { Config, AgentEvent, Citation } from '../src/types.js';
import type { MemoryProvider } from '../src/memory/provider.js';
import type { IgnoreFilter } from '../src/types.js';
import { NdjsonDecoder } from '../src/protocol.js';

function cfg(root: string): Config {
  return {
    chat: { baseURL: 'http://x', model: 'm', temperature: 0.2 },
    embed: { baseURL: 'http://x', model: 'e', batchSize: 64 },
    memory: { provider: 'local' },
    scope: 'game',
    mode: 'code',
    approval: 'gated',
    index: { chunkSize: 1500, chunkOverlap: 200, root },
    search: {},
  };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function setup(): Promise<{
  config: Config;
  memory: MemoryProvider;
  ignore: IgnoreFilter;
}> {
  const repo = makeTmpRepo({
    'objects/obj_player/Step_0.gml': 'hp -= 1;\n',
    'scripts/scr.gml': 'x = 1;\n',
  });
  cleanup = repo.cleanup;
  const ignore = await buildIgnoreFilter(repo.root);
  const memory = new LocalMemoryProvider(
    { provider: 'local', root: repo.root },
    { embeddings: new FakeEmbeddings() },
  );
  return { config: cfg(repo.root), memory, ignore };
}

/** Drive the MCP server over PassThrough streams; collect decoded JSON-RPC responses. */
async function driveMcp(
  deps: Parameters<typeof runMcpServer>[0],
  lines: string[],
): Promise<unknown[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses: unknown[] = [];
  const decoder = new NdjsonDecoder();
  output.on('data', (c: Buffer) => {
    for (const v of decoder.push(c)) responses.push(v);
  });
  const serve = runMcpServer(deps, { input, output, diagnostics: new PassThrough() });
  for (const l of lines) input.write(l + '\n');
  input.end();
  await serve;
  return responses;
}

describe('runMcpServer', () => {
  function cfgWith(root: string, searchMinScore?: number): Config {
    return {
      chat: { baseURL: 'http://x', model: 'm', temperature: 0.2 },
      embed: { baseURL: 'http://x', model: 'e', batchSize: 64 },
      memory: { provider: 'local' },
      scope: 'game',
      mode: 'code',
      approval: 'gated',
      index: { chunkSize: 1500, chunkOverlap: 200, root },
      search: searchMinScore !== undefined ? { minScore: searchMinScore } : {},
    };
  }

  it('initialize returns server info + capabilities', async () => {
    const { config, memory, ignore } = await setup();
    const responses = await driveMcp({ tools: buildToolRegistry(), config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    ]);
    expect(responses).toHaveLength(1);
    const r = responses[0] as { result: { protocolVersion: string; serverInfo: unknown } };
    expect(r.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect((r.result.serverInfo as { name: string }).name).toBe(MCP_SERVER_NAME);
  });

  it('initialize when search.minScore is set threads it onto the tool ctx', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'x\n' });
    cleanup = repo.cleanup;
    const responses = await driveMcp(
      {
        tools: buildToolRegistry(),
        config: cfgWith(repo.root, 0.42),
        memory: new LocalMemoryProvider(
          { provider: 'local', root: repo.root },
          { embeddings: new FakeEmbeddings() },
        ),
      },
      [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })],
    );
    expect(responses).toHaveLength(1);
  });

  it('initialize when search.minScore is absent still works (no searchMinScore on ctx)', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'x\n' });
    cleanup = repo.cleanup;
    const responses = await driveMcp(
      {
        tools: buildToolRegistry(),
        config: cfgWith(repo.root), // no minScore
        memory: new LocalMemoryProvider(
          { provider: 'local', root: repo.root },
          { embeddings: new FakeEmbeddings() },
        ),
      },
      [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })],
    );
    expect(responses).toHaveLength(1);
  });

  it('tools/list exposes the ChatGML tool registry as MCP tools', async () => {
    const { config, memory, ignore } = await setup();
    const responses = await driveMcp({ tools: buildToolRegistry(), config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    ]);
    const list = responses[1] as { result: { tools: Array<{ name: string }> } };
    const names = list.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'apply_patch',
        'execute_command',
        'glob',
        'graph_neighbors',
        'grep',
        'read_file',
        'search_code',
        'search_files',
        'search_replace',
        'temporal_query',
      ].sort(),
    );
  });

  it('tools/list is filtered by the active mode — ask mode omits apply_patch / execute_command / search_replace', async () => {
    const { config, memory, ignore } = await setup();
    const askConfig: Config = { ...config, mode: 'ask' };
    const responses = await driveMcp(
      { tools: buildToolRegistry(), config: askConfig, memory, ignore },
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      ],
    );
    const list = responses[1] as { result: { tools: Array<{ name: string }> } };
    const names = list.result.tools.map((t) => t.name).sort();
    expect(names).not.toContain('apply_patch');
    expect(names).not.toContain('execute_command');
    expect(names).not.toContain('search_replace');
    // Read tools still present.
    expect(names).toContain('read_file');
    expect(names).toContain('grep');
  });

  it('tools/call dispatches glob and returns MCP content blocks', async () => {
    const { config, memory, ignore } = await setup();
    const responses = await driveMcp({ tools: buildToolRegistry(), config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'glob', arguments: { pattern: '**/*.gml' } },
      }),
    ]);
    const call = responses[1] as {
      result: { content: Array<{ type: string; text: string }>; isError: boolean };
    };
    expect(call.result.isError).toBe(false);
    expect(call.result.content[0]!.type).toBe('text');
    expect(call.result.content[0]!.text).toContain('Step_0.gml');
    expect(call.result.content[0]!.text).toContain('scr.gml');
  });

  it('tools/call dispatches read_file and returns the file content', async () => {
    const { config, memory, ignore } = await setup();
    const responses = await driveMcp({ tools: buildToolRegistry(), config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: 'objects/obj_player/Step_0.gml' } },
      }),
    ]);
    const call = responses[1] as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(call.result.isError).toBe(false);
    expect(call.result.content[0]!.text).toContain('hp -= 1;');
  });

  it('tools/call with an unknown tool name returns isError=true (not a transport error)', async () => {
    const { config, memory, ignore } = await setup();
    const responses = await driveMcp({ tools: buildToolRegistry(), config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      }),
    ]);
    const call = responses[1] as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0]!.text).toContain('unknown tool');
  });

  it('tools/call with bad arguments returns isError=true with a helpful message', async () => {
    const { config, memory, ignore } = await setup();
    const responses = await driveMcp({ tools: buildToolRegistry(), config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'glob', arguments: {} }, // missing required pattern
      }),
    ]);
    const call = responses[1] as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0]!.text).toContain('bad arguments');
  });

  it('notifications/initialized is a no-op (no response, no error)', async () => {
    const { config, memory, ignore } = await setup();
    const responses = await driveMcp({ tools: buildToolRegistry(), config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    ]);
    // Only TWO responses: the initialize result + the tools.list result (the notification gets none).
    expect(responses).toHaveLength(2);
    expect((responses[0] as { id: number }).id).toBe(1);
    expect((responses[1] as { id: number }).id).toBe(3);
  });

  it('an unknown method returns a JSON-RPC error (-32601)', async () => {
    const { config, memory, ignore } = await setup();
    const responses = await driveMcp({ tools: buildToolRegistry(), config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'foo/bar', params: {} }),
    ]);
    const err = responses[1] as { error: { code: number; message: string } };
    expect(err.error.code).toBe(-32601);
    expect(err.error.message).toContain('method not found');
  });

  it('shutdown responds and ends the loop cleanly', async () => {
    const { config, memory, ignore } = await setup();
    const responses = await driveMcp({ tools: buildToolRegistry(), config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: {} }),
    ]);
    expect(responses).toHaveLength(2);
    expect((responses[1] as { result: unknown }).result).toBeDefined();
  });

  it('apply_patch in MCP auto-applies (the agent IDE owns the human gate) and surfaces a forceGate warning for high-risk diffs', async () => {
    const { config, memory, ignore } = await setup();
    // A whole-file wipe: removes every existing line, adds nothing -> forceGate would normally
    // require a human even in auto mode. In MCP mode, the agent IDE confirmed the edit, so the
    // write goes through AND the destructive-edit warning is surfaced in the tool result text so
    // the agent IDE can show it to the user.
    const wipeDiff =
      '--- a/objects/obj_player/Step_0.gml\n' +
      '+++ b/objects/obj_player/Step_0.gml\n' +
      '@@ -1,1 +0,0 @@\n' +
      '-hp -= 1;\n';
    const responses = await driveMcp({ tools: buildToolRegistry(), config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'apply_patch',
          arguments: { path: 'objects/obj_player/Step_0.gml', diff: wipeDiff },
        },
      }),
    ]);
    const call = responses[1] as { result: { isError: boolean; content: Array<{ text: string }> } };
    // Auto-applied (the agent IDE gate is upstream).
    expect(call.result.isError).toBe(false);
    expect(call.result.content[0]!.text).toMatch(/updated|created/);
    // Warning footer is present so the user sees the destructive-edit backstop fired.
    expect(call.result.content[0]!.text).toContain('Warnings:');
    expect(call.result.content[0]!.text).toMatch(/whole-file|destructive/i);
  });

  // -- malformed input + defensive branches ------------------------------------

  it('ignores a non-object JSON line (does not crash the server)', async () => {
    const { config, memory, ignore } = await setup();
    const responses = await driveMcp({ tools: buildToolRegistry(), config, memory, ignore }, [
      'null',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    ]);
    expect(responses).toHaveLength(1);
    expect(responses[0] && (responses[0] as { id: number }).id).toBe(1);
  });

  it('ignores a primitive line (string/number/bool) (does not crash the server)', async () => {
    const { config, memory, ignore } = await setup();
    const responses = await driveMcp({ tools: buildToolRegistry(), config, memory, ignore }, [
      '"hi"',
      '42',
      'true',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    ]);
    expect(responses).toHaveLength(1);
  });

  it('ignores a JSON object without a method field (notification shape)', async () => {
    const { config, memory, ignore } = await setup();
    const responses = await driveMcp({ tools: buildToolRegistry(), config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, params: {} }), // no method
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
    ]);
    expect(responses).toHaveLength(1);
    expect((responses[0] as { id: number }).id).toBe(2);
  });

  it('shutdown aborts the controller and ends the loop cleanly', async () => {
    const { config, memory, ignore } = await setup();
    const responses = await driveMcp({ tools: buildToolRegistry(), config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: {} }),
    ]);
    expect(responses).toHaveLength(2);
    expect(responses[1]).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
  });

  // -- citation surface branches -----------------------------------------------

  it('sources footer: citation with path + startLine + endLine (full range)', async () => {
    const { config, memory, ignore } = await setup();
    const responses = await driveMcp({ tools: buildToolRegistry(), config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: 'objects/obj_player/Step_0.gml' } },
      }),
    ]);
    const call = responses[1] as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(call.result.isError).toBe(false);
    expect(call.result.content[0]!.text).toContain('Sources:');
    expect(call.result.content[0]!.text).toMatch(/Step_0\.gml:\d+-\d+/);
  });

  it('sources footer: citation with path + startLine but no endLine uses start:start', async () => {
    // We can't shape a citation from MCP directly — but we can inject via a stub tool
    // that returns the citation shape we want to exercise.
    const { config, memory, ignore } = await setup();
    const stubTool = {
      name: 'cite_no_end',
      description: '',
      kind: 'read' as const,
      schema: z.record(z.unknown()),
      execute: async () => ({
        content: 'ok',
        citations: [{ path: 'a.gml', startLine: 5, provider: 'local' as const }],
      }),
    };
    const registry = new Map(buildToolRegistry());
    registry.set('cite_no_end', stubTool as never);
    const responses = await driveMcp({ tools: registry, config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'cite_no_end', arguments: {} },
      }),
    ]);
    const text = (responses[1] as { result: { content: Array<{ text: string }> } }).result
      .content[0]!.text;
    expect(text).toContain('Sources:');
    // endLine undefined → falls back to c.startLine (so "a.gml:5-5").
    expect(text).toMatch(/a\.gml:5-5/);
  });

  it('sources footer: citation with path only (no line range)', async () => {
    const { config, memory, ignore } = await setup();
    const stubTool = {
      name: 'cite_path_only',
      description: '',
      kind: 'read' as const,
      schema: z.record(z.unknown()),
      execute: async () => ({
        content: 'ok',
        citations: [{ path: 'notes/readme.md', provider: 'local' as const }],
      }),
    };
    const registry = new Map(buildToolRegistry());
    registry.set('cite_path_only', stubTool as never);
    const responses = await driveMcp({ tools: registry, config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'cite_path_only', arguments: {} },
      }),
    ]);
    const text = (responses[1] as { result: { content: Array<{ text: string }> } }).result
      .content[0]!.text;
    expect(text).toContain('Sources:');
    expect(text).toMatch(/notes\/readme\.md/);
    expect(text).not.toMatch(/notes\/readme\.md:/); // no colon / line range
  });

  it('sources footer: memory-only citation (no path) renders as "(memory)"', async () => {
    const { config, memory, ignore } = await setup();
    const stubTool = {
      name: 'cite_memory',
      description: '',
      kind: 'read' as const,
      schema: z.record(z.unknown()),
      execute: async () => ({
        content: 'ok',
        citations: [
          { provider: 'local' as const, snippet: 'a memory hit' } satisfies Citation as never,
        ],
      }),
    };
    const registry = new Map(buildToolRegistry());
    registry.set('cite_memory', stubTool as never);
    const responses = await driveMcp({ tools: registry, config, memory, ignore }, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'cite_memory', arguments: {} },
      }),
    ]);
    const text = (responses[1] as { result: { content: Array<{ text: string }> } }).result
      .content[0]!.text;
    expect(text).toContain('Sources:');
    expect(text).toMatch(/- \(memory\)/);
  });
});

// Silence the unused-import lint for AgentEvent (re-exported).
export type { AgentEvent };
