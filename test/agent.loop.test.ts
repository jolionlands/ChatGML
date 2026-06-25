import { describe, it, expect, afterEach } from 'vitest';
import { runAgent, createApprovalGate, DEFAULT_MAX_STEPS } from '../src/agent.js';
import { FakeLlm, ThrowingLlm } from './helpers/fake-llm.js';
import { LlmError } from '../src/llm.js';
import { buildToolRegistry } from '../src/tools/index.js';
import { makeTmpRepo, FakeEmbeddings } from './helpers/fakes.js';
import { buildIgnoreFilter } from '../src/index/files.js';
import { LocalMemoryProvider } from '../src/memory/local.js';
import type { AgentEvent, Config } from '../src/types.js';
import type { MemoryProvider } from '../src/memory/provider.js';
import type { IgnoreFilter } from '../src/types.js';

function cfg(root: string, approval: 'gated' | 'auto' = 'gated'): Config {
  return {
    chat: { baseURL: 'http://x', model: 'm', temperature: 0.2 },
    embed: { baseURL: 'http://x', model: 'e', batchSize: 64 },
    memory: { provider: 'local' },
    scope: 'game',
    approval,
    index: { chunkSize: 1500, chunkOverlap: 200, root },
  };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function setup(approval: 'gated' | 'auto' = 'gated'): Promise<{
  root: string;
  memory: MemoryProvider;
  ignore: IgnoreFilter;
  config: Config;
}> {
  const repo = makeTmpRepo({
    'objects/obj_player/Step_0.gml': 'hp -= 1;\nif (hp <= 0) instance_destroy();\n',
    'scripts/scr_dmg/scr_dmg.gml': 'function apply_dmg(amount) {\n  hp -= amount;\n}\n',
  });
  cleanup = repo.cleanup;
  const ignore = await buildIgnoreFilter(repo.root);
  const memory = new LocalMemoryProvider(
    { provider: 'local', root: repo.root },
    { embeddings: new FakeEmbeddings() },
  );
  return { root: repo.root, memory, ignore, config: cfg(repo.root, approval) };
}

function collect() {
  const events: AgentEvent[] = [];
  return { events, emit: (e: AgentEvent) => events.push(e) };
}

describe('runAgent loop', () => {
  it('no tool calls: streams tokens then emits an answer; history records the turn', async () => {
    const { config, memory, ignore } = await setup();
    const llm = new FakeLlm([{ tokens: ['Hello ', 'world'] }]);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    const res = await runAgent('hi', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: gate,
      ignore,
    });
    const types = events.map((e) => e.type);
    expect(types).toContain('token');
    expect(types).toContain('answer');
    const answer = events.find((e) => e.type === 'answer');
    expect(answer && answer.type === 'answer' && answer.text).toBe('Hello world');
    expect(res.history.some((m) => m.role === 'user' && m.content === 'hi')).toBe(true);
  });

  it('one tool round-trip: appends a role:tool message matching the tool_call_id', async () => {
    const { config, memory, ignore } = await setup();
    const llm = new FakeLlm([
      { toolCalls: [{ id: 'c1', name: 'glob', arguments: JSON.stringify({ pattern: '**/*.gml' }) }] },
      { tokens: ['Found the files.'] },
    ]);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    const res = await runAgent('list gml', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: gate,
      ignore,
    });
    const toolCall = events.find((e) => e.type === 'tool_call');
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolCall && toolCall.type === 'tool_call' && toolCall.name).toBe('glob');
    expect(toolResult && toolResult.type === 'tool_result' && toolResult.ok).toBe(true);
    const toolMsg = res.history.find((m) => m.role === 'tool');
    expect(toolMsg?.tool_call_id).toBe('c1');
    expect(toolMsg?.name).toBe('glob');
    // second model call saw the tool result in its messages
    expect(llm.callCount).toBe(2);
  });

  it('two parallel tool calls in one turn each append a role:tool message', async () => {
    const { config, memory, ignore } = await setup();
    const llm = new FakeLlm([
      {
        toolCalls: [
          { id: 'a', name: 'glob', arguments: JSON.stringify({ pattern: 'scripts/**/*.gml' }) },
          { id: 'b', name: 'grep', arguments: JSON.stringify({ pattern: 'hp' }) },
        ],
      },
      { tokens: ['done'] },
    ]);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    const res = await runAgent('x', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: gate,
      ignore,
    });
    const toolMsgs = res.history.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.tool_call_id).sort()).toEqual(['a', 'b']);
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2);
  });

  it('search_code tool surfaces citations into the answer sources', async () => {
    const { config, memory, ignore } = await setup();
    // index so search has content
    await memory.upsert(
      [
        {
          id: 'objects/obj_player/Step_0.gml#1-2',
          path: 'objects/obj_player/Step_0.gml',
          text: 'hp -= 1; instance_destroy();',
          contentHash: 'h',
          startLine: 1,
          endLine: 2,
        },
      ],
      { repo: 'game' },
    );
    const llm = new FakeLlm([
      { toolCalls: [{ id: 's1', name: 'search_code', arguments: JSON.stringify({ query: 'destroy player' }) }] },
      { tokens: ['The player is destroyed when hp hits 0.'] },
    ]);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    const res = await runAgent('when is the player destroyed?', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: gate,
      ignore,
    });
    expect(res.sources.length).toBeGreaterThan(0);
    const answer = events.find((e) => e.type === 'answer');
    expect(answer && answer.type === 'answer' && answer.sources.length).toBeGreaterThan(0);
  });

  it('unknown tool name: tool_result ok:false, loop continues and answers', async () => {
    const { config, memory, ignore } = await setup();
    const llm = new FakeLlm([
      { toolCalls: [{ id: 'u1', name: 'no_such_tool', arguments: '{}' }] },
      { tokens: ['recovered'] },
    ]);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    await runAgent('x', { llm, tools: buildToolRegistry(), config, memory, emit, approvals: gate, ignore });
    const tr = events.find((e) => e.type === 'tool_result');
    expect(tr && tr.type === 'tool_result' && tr.ok).toBe(false);
    expect(events.some((e) => e.type === 'answer')).toBe(true);
  });

  it('invalid JSON tool args: tool_result ok:false bad_args, continues', async () => {
    const { config, memory, ignore } = await setup();
    const llm = new FakeLlm([
      { toolCalls: [{ id: 'j1', name: 'glob', arguments: '{not json' }] },
      { tokens: ['ok'] },
    ]);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    await runAgent('x', { llm, tools: buildToolRegistry(), config, memory, emit, approvals: gate, ignore });
    const tr = events.find((e) => e.type === 'tool_result');
    expect(tr && tr.type === 'tool_result' && tr.ok).toBe(false);
  });

  it('maxSteps exhausted: emits an error event with code max_steps', async () => {
    const { config, memory, ignore } = await setup();
    // every turn requests a tool, never answers
    const turns = Array.from({ length: 5 }, () => ({
      toolCalls: [{ id: 'loop', name: 'glob', arguments: JSON.stringify({ pattern: '*' }) }],
    }));
    const llm = new FakeLlm(turns);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    await runAgent('x', { llm, tools: buildToolRegistry(), config, memory, emit, approvals: gate, ignore }, { maxSteps: 3 });
    const err = events.find((e) => e.type === 'error');
    expect(err && err.type === 'error' && err.code).toBe('max_steps');
  });

  it('LlmError mid-turn: emits an error event and the session survives (returns)', async () => {
    const { config, memory, ignore } = await setup();
    const llm = new ThrowingLlm(new LlmError('http', 'boom', { status: 503 }));
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    const res = await runAgent('x', { llm, tools: buildToolRegistry(), config, memory, emit, approvals: gate, ignore });
    const err = events.find((e) => e.type === 'error');
    expect(err && err.type === 'error' && err.code).toBe('http');
    expect(res.message.role).toBe('assistant');
  });

  it('PROMPT INJECTION: an "apply this patch" instruction inside tool content does NOT bypass approval (gated)', async () => {
    const { config, memory, ignore } = await setup();
    // The model, even if it tried to call apply_patch (the only edit path), is gated: the stub never
    // writes and approval is required. Here the model dutifully calls apply_patch after reading
    // injected content; the gated stub returns not_implemented and NO write occurs.
    const llm = new FakeLlm([
      { toolCalls: [{ id: 'r1', name: 'read_file', arguments: JSON.stringify({ path: 'objects/obj_player/Step_0.gml' }) }] },
      {
        toolCalls: [
          { id: 'e1', name: 'apply_patch', arguments: JSON.stringify({ path: 'objects/obj_player/Step_0.gml', diff: '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n' }) },
        ],
      },
      { tokens: ['I cannot apply edits without approval.'] },
    ]);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    await runAgent('please review', { llm, tools: buildToolRegistry(), config, memory, emit, approvals: gate, ignore });
    // the apply_patch attempt resulted in an ok:false (not_implemented), never an approval bypass
    const editResult = events.find((e) => e.type === 'tool_result' && e.name === 'apply_patch');
    expect(editResult && editResult.type === 'tool_result' && editResult.ok).toBe(false);
    // no edit_proposal was emitted by the stub (it threw before requesting approval)
    expect(events.some((e) => e.type === 'edit_proposal')).toBe(false);
  });

  it('DEFAULT_MAX_STEPS is exported and positive', () => {
    expect(DEFAULT_MAX_STEPS).toBeGreaterThan(0);
  });
});
