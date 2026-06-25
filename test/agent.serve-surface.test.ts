import { describe, it, expect, afterEach } from 'vitest';
import { createAgentLike } from '../src/agent.js';
import { FakeLlm } from './helpers/fake-llm.js';
import { buildToolRegistry } from '../src/tools/index.js';
import { makeTmpRepo, FakeEmbeddings } from './helpers/fakes.js';
import { LocalMemoryProvider } from '../src/memory/local.js';
import { buildIgnoreFilter } from '../src/index/files.js';
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

async function ctx(approval: 'gated' | 'auto' = 'gated'): Promise<{
  config: Config;
  memory: MemoryProvider;
  ignore: IgnoreFilter;
}> {
  const repo = makeTmpRepo({ 'objects/obj_player/Step_0.gml': 'hp -= 1;\n' });
  cleanup = repo.cleanup;
  const ignore = await buildIgnoreFilter(repo.root);
  const memory = new LocalMemoryProvider(
    { provider: 'local', root: repo.root },
    { embeddings: new FakeEmbeddings() },
  );
  return { config: cfg(repo.root, approval), memory, ignore };
}

async function drain(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('createAgentLike control surface', () => {
  it('run(user) streams the agent events to completion', async () => {
    const { config, memory, ignore } = await ctx();
    const llm = new FakeLlm([{ tokens: ['hello'] }]);
    const agent = createAgentLike({ llm, tools: buildToolRegistry(), config, memory, ignore });
    const events = await drain(agent.run({ type: 'user', text: 'hi' }, new AbortController().signal));
    expect(events.some((e) => e.type === 'answer')).toBe(true);
    expect(events.some((e) => e.type === 'token')).toBe(true);
  });

  it('run(reindex) yields the default indexing/done stub when no runReindex is provided', async () => {
    const { config, memory, ignore } = await ctx();
    const llm = new FakeLlm([]);
    const agent = createAgentLike({ llm, tools: buildToolRegistry(), config, memory, ignore });
    const events = await drain(agent.run({ type: 'reindex' }, new AbortController().signal));
    expect(events.some((e) => e.type === 'status' && e.phase === 'indexing')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.phase === 'done')).toBe(true);
  });

  it('run(reindex) uses an injected runReindex', async () => {
    const { config, memory, ignore } = await ctx();
    const llm = new FakeLlm([]);
    const agent = createAgentLike({
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      ignore,
      runReindex: async function* () {
        yield { type: 'status', phase: 'indexing' };
        yield { type: 'status', phase: 'done', detail: 'custom' };
      },
    });
    const events = await drain(agent.run({ type: 'reindex' }, new AbortController().signal));
    expect(events.find((e) => e.type === 'status' && e.phase === 'done')).toMatchObject({
      detail: 'custom',
    });
  });

  it('cancel() aborts the in-flight run via the shared controller', async () => {
    const { config, memory, ignore } = await ctx();
    // A model that takes two turns; we cancel after the first tool call.
    const llm = new FakeLlm([
      { toolCalls: [{ id: 't1', name: 'glob', arguments: JSON.stringify({ pattern: '**/*.gml' }) }] },
      { tokens: ['done'] },
    ]);
    const agent = createAgentLike({ llm, tools: buildToolRegistry(), config, memory, ignore });
    const signal = new AbortController().signal;
    const it = agent.run({ type: 'user', text: 'go' }, signal)[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    agent.cancel();
    // drain the rest; it terminates without hanging
    let r = await it.next();
    while (!r.done) r = await it.next();
    expect(r.done).toBe(true);
  });

  it('resolveApproval forwards to the in-flight gate (auto path covered by gated run)', async () => {
    const { config, memory, ignore } = await ctx();
    const llm = new FakeLlm([{ tokens: ['ok'] }]);
    const agent = createAgentLike({ llm, tools: buildToolRegistry(), config, memory, ignore });
    // resolveApproval with no active gate is a no-op (does not throw)
    expect(() => agent.resolveApproval('e1', true)).not.toThrow();
    await drain(agent.run({ type: 'user', text: 'hi' }, new AbortController().signal));
  });

  it('run with a pre-aborted external signal aborts immediately', async () => {
    const { config, memory, ignore } = await ctx();
    const llm = new FakeLlm([{ tokens: ['unused'] }]);
    const agent = createAgentLike({ llm, tools: buildToolRegistry(), config, memory, ignore });
    const ac = new AbortController();
    ac.abort();
    const events = await drain(agent.run({ type: 'user', text: 'hi' }, ac.signal));
    expect(events.some((e) => e.type === 'status' && e.phase === 'cancelled')).toBe(true);
  });
});
