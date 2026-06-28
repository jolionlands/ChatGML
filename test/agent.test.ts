import { describe, it, expect, afterEach } from 'vitest';
import {
  runAgent,
  buildSystemPrompt,
  buildUserMessageWithContext,
  createAgentLike,
} from '../src/agent.js';
import { FakeLlm } from './helpers/fake-llm.js';
import { buildToolRegistry, wrapMcpTools } from '../src/tools/index.js';
import { makeTmpRepo, FakeEmbeddings } from './helpers/fakes.js';
import { buildIgnoreFilter } from '../src/index/files.js';
import { LocalMemoryProvider } from '../src/memory/local.js';
import type { AgentEvent, Config } from '../src/types.js';
import type { MemoryProvider } from '../src/memory/provider.js';
import type { IgnoreFilter } from '../src/types.js';
import type { McpClient } from '../src/mcp-client.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

function cfg(root: string, mode: Config['mode'] = 'code'): Config {
  return {
    chat: { baseURL: 'http://x', model: 'm', temperature: 0.2 },
    embed: { baseURL: 'http://x', model: 'e', batchSize: 64 },
    memory: { provider: 'local' },
    scope: 'game',
    mode,
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

async function setup(mode: Config['mode'] = 'code'): Promise<{
  root: string;
  memory: MemoryProvider;
  ignore: IgnoreFilter;
  config: Config;
}> {
  const repo = makeTmpRepo({
    'objects/obj_player/Step_0.gml': 'hp -= 1;\n',
  });
  cleanup = repo.cleanup;
  const ignore = await buildIgnoreFilter(repo.root);
  const memory = new LocalMemoryProvider(
    { provider: 'local', root: repo.root },
    { embeddings: new FakeEmbeddings() },
  );
  return { root: repo.root, memory, ignore, config: cfg(repo.root, mode) };
}

function collect() {
  const events: AgentEvent[] = [];
  return { events, emit: (e: AgentEvent) => events.push(e) };
}

describe('mode tool gating (P1.1)', () => {
  it('Ask mode excludes apply_patch/search_replace/execute_command from tool specs', async () => {
    const { config, memory, ignore } = await setup('ask');
    const llm = new FakeLlm([{ tokens: ['Just reading.'] }]);
    const { emit } = collect();
    await runAgent('hi', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: {
        request: async () => ({ approved: false }),
        resolve: () => {},
        rejectAll: () => {},
      },
      ignore,
    });
    const tools = llm.requests[0]?.tools ?? [];
    const names = tools.map((t) => t.function.name).sort();
    expect(names).toContain('read_file');
    expect(names).not.toContain('apply_patch');
    expect(names).not.toContain('search_replace');
    expect(names).not.toContain('execute_command');
  });

  it('Debug mode excludes edit tools but keeps commands', async () => {
    const { config, memory, ignore } = await setup('debug');
    const llm = new FakeLlm([{ tokens: ['Debugging.'] }]);
    const { emit } = collect();
    await runAgent('hi', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: {
        request: async () => ({ approved: false }),
        resolve: () => {},
        rejectAll: () => {},
      },
      ignore,
    });
    const tools = llm.requests[0]?.tools ?? [];
    const names = tools.map((t) => t.function.name).sort();
    expect(names).toContain('read_file');
    expect(names).toContain('execute_command');
    expect(names).not.toContain('apply_patch');
    expect(names).not.toContain('search_replace');
  });
});

describe('mode system prompt rules (P1.1)', () => {
  it('loads rules from .chatgml/rules-{mode}/ in alphabetical order', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'chatgml-mode-rules-'));
    cleanup = () => rmSync(root, { recursive: true, force: true });
    const rulesDir = path.join(root, '.chatgml', 'rules-ask');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(path.join(rulesDir, '01-first.md'), 'Be concise.', 'utf8');
    writeFileSync(path.join(rulesDir, '02-second.md'), 'Cite lines.', 'utf8');

    const prompt = buildSystemPrompt(cfg(root, 'ask'), buildToolRegistry({ readOnly: true }));
    expect(prompt).toContain('Mode-specific rules (ask):');
    expect(prompt.indexOf('Be concise.')).toBeLessThan(prompt.indexOf('Cite lines.'));
  });

  it('falls back to legacy .chatgml-rules-{mode}.md when rules dir is absent', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'chatgml-mode-legacy-'));
    cleanup = () => rmSync(root, { recursive: true, force: true });
    writeFileSync(path.join(root, '.chatgml-rules-debug.md'), 'Use logs.', 'utf8');

    const prompt = buildSystemPrompt(cfg(root, 'debug'), buildToolRegistry({ readOnly: true }));
    expect(prompt).toContain('Mode-specific rules (debug):');
    expect(prompt).toContain('Use logs.');
  });

  it('does nothing when no rules exist for the mode', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'chatgml-mode-none-'));
    cleanup = () => rmSync(root, { recursive: true, force: true });

    const prompt = buildSystemPrompt(cfg(root, 'code'), buildToolRegistry({ readOnly: true }));
    expect(prompt).not.toContain('Mode-specific rules');
  });
});

describe('mentions context assembly (P1.2)', () => {
  it('renders file/folder/problems/terminal/url/image mentions before user text', () => {
    const ctx = {
      mentions: [
        { type: 'file' as const, target: 'scripts/AI.gml', content: 'x = 1;' },
        { type: 'folder' as const, target: 'objects/', content: 'obj_player/\nobj_enemy/' },
        {
          type: 'problems' as const,
          target: 'problems',
          label: '3 errors',
          content: 'Type mismatch',
        },
        { type: 'terminal' as const, target: 'recent output', content: 'Build OK' },
        { type: 'url' as const, target: 'https://example.com', content: 'docs' },
        { type: 'image' as const, target: 'paste.png', label: 'screenshot' },
      ],
    };
    const out = buildUserMessageWithContext('explain', ctx);
    expect(out).toContain('[Context attached by user]');
    expect(out).toContain('[End context]');
    expect(out).toContain('- file: scripts/AI.gml');
    expect(out).toContain('```gml\nx = 1;\n```');
    expect(out).toContain('- folder: objects/');
    expect(out).toContain('- problems: problems (3 errors)');
    expect(out).toContain('- terminal: recent output');
    expect(out).toContain('- url: https://example.com');
    expect(out).toContain('- image: paste.png (screenshot)');
    expect(out).toContain('explain');
    expect(out.indexOf('[Context attached by user]')).toBeLessThan(out.indexOf('explain'));
  });

  it('keeps bare user text when context has no usable fields', () => {
    expect(buildUserMessageWithContext('hello', { mentions: [] })).toBe('hello');
    expect(buildUserMessageWithContext('hello', {})).toBe('hello');
  });

  it('caps total mention content to ~16k chars', () => {
    const long = 'x'.repeat(20000);
    const ctx = {
      mentions: [
        { type: 'file' as const, target: 'a.gml', content: long },
        { type: 'file' as const, target: 'b.gml', content: 'short' },
      ],
    };
    const out = buildUserMessageWithContext('ok', ctx);
    expect(out.length).toBeLessThan(17000);
    expect(out).toContain('a.gml');
    expect(out).not.toContain('b.gml');
  });

  it('passes mentions through runAgent into the user message', async () => {
    const { config, memory, ignore } = await setup('ask');
    const llm = new FakeLlm([{ tokens: ['Got it.'] }]);
    const { emit } = collect();
    await runAgent(
      'explain this',
      {
        llm,
        tools: buildToolRegistry({ readOnly: true }),
        config,
        memory,
        emit,
        approvals: {
          request: async () => ({ approved: false }),
          resolve: () => {},
          rejectAll: () => {},
        },
        ignore,
      },
      {
        context: {
          mentions: [{ type: 'file' as const, target: 'README.md', content: '# ChatGML' }],
        },
      },
    );
    const userContent = llm.requests[0]?.messages.find((m) => m.role === 'user')?.content as string;
    expect(userContent).toContain('[Context attached by user]');
    expect(userContent).toContain('# ChatGML');
    expect(userContent).toContain('explain this');
  });
});

describe('task/workspace abstraction (P1.3)', () => {
  it('turn_end echoes the taskId from the user command', async () => {
    const { config, memory, ignore } = await setup('ask');
    const llm = new FakeLlm([{ tokens: ['OK.'] }]);
    const agent = createAgentLike({
      llm,
      tools: buildToolRegistry({ readOnly: true }),
      config,
      memory,
      ignore,
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.run(
      { type: 'user', text: 'hi', taskId: 'workspace/task-A' },
      new AbortController().signal,
    )) {
      events.push(e);
    }
    const turnEnd = events.find((e) => e.type === 'turn_end');
    expect(turnEnd).toBeDefined();
    expect(turnEnd).toMatchObject({
      type: 'turn_end',
      userText: 'hi',
      taskId: 'workspace/task-A',
    });
  });
});

describe('MCP client surfacing (P1.4)', () => {
  function fakeMcpClient(): McpClient {
    return {
      config: { name: 'mock' },
      initialize: async () => {},
      toolsList: async () => [
        {
          name: 'echo',
          description: 'echo text',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
      ],
      resourcesList: async () => [],
      callTool: async (_name: string, args: unknown) => {
        const text = (args as Record<string, unknown> | undefined)?.text as string | undefined;
        return { content: `echo:${text ?? ''}`, isError: false };
      },
      readResource: async () => '',
      close: () => {},
    } as unknown as McpClient;
  }

  async function buildMcpRegistry(): Promise<Map<string, import('../src/types.js').Tool>> {
    const client = fakeMcpClient();
    const mcpTools = await wrapMcpTools(new Map([['mock', client]]));
    const registry = new Map(buildToolRegistry());
    for (const t of mcpTools) registry.set(t.name, t);
    return registry;
  }

  it('includes MCP tools in tool specs and emits mcp_tool_call/mcp_tool_result', async () => {
    const { config, memory, ignore } = await setup('code');
    const registry = await buildMcpRegistry();
    const llm = new FakeLlm([
      {
        toolCalls: [{ id: 't1', name: 'mcp_mock_echo', arguments: JSON.stringify({ text: 'hi' }) }],
      },
      { tokens: ['Done.'] },
    ]);
    const { events, emit } = collect();
    await runAgent('call echo', {
      llm,
      tools: registry,
      config: { ...config, approval: 'auto' },
      memory,
      emit,
      approvals: {
        request: async () => ({ approved: false }),
        resolve: () => {},
        rejectAll: () => {},
      },
      ignore,
    });

    const tools = llm.requests[0]?.tools ?? [];
    expect(tools.some((t) => t.function.name === 'mcp_mock_echo')).toBe(true);
    const echoSpec = tools.find((t) => t.function.name === 'mcp_mock_echo');
    expect(echoSpec?.function.parameters).toMatchObject({
      properties: { text: { type: 'string' } },
    });

    const call = events.find((e) => e.type === 'mcp_tool_call');
    expect(call).toMatchObject({
      type: 'mcp_tool_call',
      id: 't1',
      server: 'mock',
      name: 'mcp_mock_echo',
    });
    const result = events.find((e) => e.type === 'mcp_tool_result');
    expect(result).toMatchObject({
      type: 'mcp_tool_result',
      id: 't1',
      server: 'mock',
      name: 'mcp_mock_echo',
      ok: true,
    });
    expect(result && result.type === 'mcp_tool_result' ? result.content : '').toContain('echo:hi');
  });

  it('gated MCP tool obeys per-tool approval policy', async () => {
    const { config, memory, ignore } = await setup('code');
    const registry = await buildMcpRegistry();
    const llm = new FakeLlm([
      {
        toolCalls: [{ id: 't2', name: 'mcp_mock_echo', arguments: JSON.stringify({ text: 'hi' }) }],
      },
      { tokens: ['Rejected.'] },
    ]);
    const { events, emit } = collect();
    await runAgent('call echo', {
      llm,
      tools: registry,
      config: { ...config, approval: 'auto', toolApproval: { mcp_mock_echo: 'gated' } },
      memory,
      emit,
      approvals: {
        request: async (req) => {
          if (req.kind === 'exec') {
            emit({ type: 'command_request', id: req.id, command: req.command, cwd: req.cwd });
          }
          return { approved: false };
        },
        resolve: () => {},
        rejectAll: () => {},
      },
      ignore,
    });

    expect(events.some((e) => e.type === 'command_request')).toBe(true);
    const result = events.find((e) => e.type === 'mcp_tool_result');
    expect(result).toMatchObject({ type: 'mcp_tool_result', id: 't2', ok: true });
    expect(result && result.type === 'mcp_tool_result' ? result.content : '').toContain(
      'not approved',
    );
  });
});
