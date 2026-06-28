import { describe, it, expect } from 'vitest';
import * as api from '../src/index.js';

describe('public API barrel', () => {
  it('exports the M3 surface (agent, protocol, tools, serve, cli)', () => {
    // agent
    expect(typeof api.runAgent).toBe('function');
    expect(typeof api.createAgentLike).toBe('function');
    expect(typeof api.buildSystemPrompt).toBe('function');
    expect(api.DEFAULT_MAX_STEPS).toBeGreaterThan(0);
    // protocol
    expect(api.PROTOCOL_VERSION).toBe(3);
    expect(typeof api.encodeEvent).toBe('function');
    expect(typeof api.NdjsonDecoder).toBe('function');
    // tools
    expect(typeof api.buildToolRegistry).toBe('function');
    expect(typeof api.toOpenAiToolSpecs).toBe('function');
    expect(typeof api.dispatchTool).toBe('function');
    expect(typeof api.assertInsideRoot).toBe('function');
    expect(typeof api.editProposalId).toBe('function');
    // serve
    expect(typeof api.runServe).toBe('function');
    // mcp
    expect(typeof api.runMcpServer).toBe('function');
    expect(api.MCP_PROTOCOL_VERSION).toBe('2024-11-05');
    expect(api.MCP_SERVER_NAME).toBe('chatgml');
    // cli
    expect(typeof api.runCli).toBe('function');
    expect(typeof api.EventRenderer).toBe('function');
    expect(typeof api.supportsColor).toBe('function');
    // pre-existing M1/M2 surface still present
    expect(typeof api.resolveConfig).toBe('function');
    expect(typeof api.LlmClient).toBe('function');
    expect(typeof api.LocalMemoryProvider).toBe('function');
  });

  it('a registry built through the barrel has the expected tool names', () => {
    const reg = api.buildToolRegistry();
    expect([...reg.keys()].sort()).toEqual(
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
});
