// test/smoke.test.ts — end-to-end smoke: index a tiny GM fixture with injected deterministic
// embeddings, then run ONE agent turn against a mocked LLM that calls search_code and asserts an
// answer + a citation come back. This exercises the whole M3 spine (index -> memory -> tools ->
// agent -> events) offline.
import { describe, it, expect, afterEach } from 'vitest';
import { makeTmpRepo, FakeEmbeddings } from './helpers/fakes.js';
import { FakeLlm } from './helpers/fake-llm.js';
import { runIndexCommand } from '../src/index/run-index.js';
import { createMemoryProvider } from '../src/memory/provider.js';
import { runAgent, createApprovalGate } from '../src/agent.js';
import { buildToolRegistry } from '../src/tools/index.js';
import { buildIgnoreFilter } from '../src/index/files.js';
import type { AgentEvent, Config } from '../src/types.js';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function cfg(root: string): Config {
  return {
    chat: { baseURL: 'http://chat.local/v1', model: 'm', temperature: 0.2 },
    embed: { baseURL: 'http://embed.local/v1', model: 'e', batchSize: 64 },
    memory: { provider: 'local' },
    scope: 'smoke-game',
    mode: 'code',
    approval: 'gated',
    index: { chunkSize: 1500, chunkOverlap: 200, root },
    search: {},
  };
}

describe('SMOKE: index + one agent turn yields an answer with a citation', () => {
  it('runs offline with injected fake embeddings and a mocked llm', async () => {
    // 1. A tiny fixture repo with 2 .gml files.
    const repo = makeTmpRepo({
      'objects/obj_player/Step_0.gml': 'hp -= 1;\nif (hp <= 0) {\n  instance_destroy();\n}\n',
      'scripts/scr_damage/scr_damage.gml':
        'function scr_damage(amount) {\n  hp -= amount;\n  return hp;\n}\n',
    });
    cleanup = repo.cleanup;
    const config = cfg(repo.root);
    const embeddings = new FakeEmbeddings();

    // 2. Build the local index with INJECTED deterministic embeddings (no network).
    const indexResult = await runIndexCommand(config, { embeddings });
    expect(indexResult.added).toBeGreaterThan(0);

    // 3. Open a fresh memory provider over the now-populated store and run ONE agent turn.
    const memory = await createMemoryProvider(
      { ...config.memory, root: repo.root },
      { embeddings },
    );
    const ignore = await buildIgnoreFilter(repo.root);

    // The mocked model: turn 1 calls search_code, turn 2 produces the final answer.
    const llm = new FakeLlm([
      {
        toolCalls: [
          {
            id: 's1',
            name: 'search_code',
            arguments: JSON.stringify({ query: 'player destroyed hp' }),
          },
        ],
      },
      { tokens: ['The player is destroyed when hp reaches 0 in the Step event.'] },
    ]);

    const events: AgentEvent[] = [];
    const emit = (e: AgentEvent): void => {
      events.push(e);
    };
    const approvals = createApprovalGate({ autoApprove: false, emit });

    const result = await runAgent(
      'When is the player destroyed?',
      { llm, tools: buildToolRegistry(), config, memory, emit, approvals, ignore },
      {},
    );

    // 4. Assertions: an answer event came back, with at least one citation, pointing at a real file.
    const answer = events.find((e) => e.type === 'answer');
    expect(answer).toBeDefined();
    expect(answer && answer.type === 'answer' && answer.text).toContain('destroyed');

    expect(result.sources.length).toBeGreaterThan(0);
    const cited = result.sources.find((c) => c.path !== undefined);
    expect(cited).toBeDefined();
    expect(cited?.path).toMatch(/\.gml$/);
    expect(cited?.provider).toBe('local');

    // the search_code tool actually ran and returned results
    const toolResult = events.find((e) => e.type === 'tool_result' && e.name === 'search_code');
    expect(toolResult && toolResult.type === 'tool_result' && toolResult.ok).toBe(true);

    if (memory.close) await memory.close();
  });
});
