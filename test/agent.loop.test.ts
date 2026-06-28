import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  runAgent,
  createApprovalGate,
  DEFAULT_MAX_STEPS,
  STUCK_TOOL_LIMIT,
  IDLE_MS,
} from '../src/agent.js';
import { FakeLlm, ThrowingLlm, SlowLlm } from './helpers/fake-llm.js';
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
    mode: 'code',
    approval,
    index: { chunkSize: 1500, chunkOverlap: 200, root },
    search: {},
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
      {
        toolCalls: [{ id: 'c1', name: 'glob', arguments: JSON.stringify({ pattern: '**/*.gml' }) }],
      },
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
      {
        toolCalls: [
          { id: 's1', name: 'search_code', arguments: JSON.stringify({ query: 'destroy player' }) },
        ],
      },
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
    await runAgent('x', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: gate,
      ignore,
    });
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
    await runAgent('x', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: gate,
      ignore,
    });
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
    await runAgent(
      'x',
      { llm, tools: buildToolRegistry(), config, memory, emit, approvals: gate, ignore },
      { maxSteps: 3 },
    );
    const err = events.find((e) => e.type === 'error');
    expect(err && err.type === 'error' && err.code).toBe('max_steps');
  });

  it('LlmError mid-turn: emits an error event and the session survives (returns)', async () => {
    const { config, memory, ignore } = await setup();
    const llm = new ThrowingLlm(new LlmError('http', 'boom', { status: 503 }));
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
    const err = events.find((e) => e.type === 'error');
    expect(err && err.type === 'error' && err.code).toBe('http');
    expect(res.message.role).toBe('assistant');
  });

  it('TEST 6 PROMPT INJECTION: an "apply this patch" instruction inside tool content does NOT bypass gated approval', async () => {
    const { config, memory, ignore, root } = await setup();
    // A real Step_0.gml exists; the diff DOES apply cleanly. The danger is the model being coerced by
    // injected file content into calling apply_patch. With the M4 real engine the edit is gated: the
    // ApprovalGate emits edit_proposal + approval_request and BLOCKS for a human decision. We simulate
    // a user who DECLINES (resolve false) the moment an approval_request appears. The write must NOT
    // happen — prompt injection cannot bypass the gate.
    const before = readFileSync(`${root}/objects/obj_player/Step_0.gml`, 'utf8');
    const cleanDiff =
      '--- a\n+++ b\n@@ -1,2 +1,2 @@\n-hp -= 1;\n+hp -= 999;\n if (hp <= 0) instance_destroy();\n';
    const llm = new FakeLlm([
      {
        toolCalls: [
          {
            id: 'r1',
            name: 'read_file',
            arguments: JSON.stringify({ path: 'objects/obj_player/Step_0.gml' }),
          },
        ],
      },
      {
        toolCalls: [
          {
            id: 'e1',
            name: 'apply_patch',
            arguments: JSON.stringify({ path: 'objects/obj_player/Step_0.gml', diff: cleanDiff }),
          },
        ],
      },
      { tokens: ['The edit was declined, so nothing changed.'] },
    ]);
    const events: AgentEvent[] = [];
    // Decline every approval — but OUT-OF-BAND (a later tick), exactly as a real client's reject
    // message arrives. (Resolving synchronously inside emit would race the gate's own pending-map
    // registration; serve/REPL always deliver approve/reject on a subsequent event-loop turn.) The
    // holder breaks the gate<->emit cycle without an unassigned `let`.
    const holder: { gate?: ReturnType<typeof createApprovalGate> } = {};
    const emit = (e: AgentEvent): void => {
      events.push(e);
      if (e.type === 'approval_request') {
        const id = e.id;
        queueMicrotask(() => holder.gate?.resolve(id, false));
      }
    };
    const gate = createApprovalGate({ autoApprove: false, emit });
    holder.gate = gate;
    await runAgent('please review', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: gate,
      ignore,
    });

    // The gate DID surface the proposal (the model called apply_patch) but it was rejected ...
    expect(events.some((e) => e.type === 'edit_proposal')).toBe(true);
    expect(events.some((e) => e.type === 'approval_request')).toBe(true);
    // ... so the apply_patch tool_result is ok:true with a "not approved" message (no error, no write),
    const editResult = events.find((e) => e.type === 'tool_result' && e.name === 'apply_patch');
    expect(
      editResult && editResult.type === 'tool_result' && /not approved/i.test(editResult.content),
    ).toBe(true);
    // and the file on disk is UNCHANGED — the injection produced no write.
    expect(readFileSync(`${root}/objects/obj_player/Step_0.gml`, 'utf8')).toBe(before);
  });

  it('DEFAULT_MAX_STEPS is exported and positive', () => {
    expect(DEFAULT_MAX_STEPS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Terminal-event contract: EVERY turn ends with EXACTLY ONE of {answer, error}, and a non-answer
// exit never trails a non-terminal status after its terminal error. (GAP1/GAP2/GAP3)
// ---------------------------------------------------------------------------

/** The set of types that may be a turn TERMINATOR. */
const TERMINALS = new Set(['answer', 'error']);

/** Assert the event stream ends with exactly one terminal and that it is the LAST event. */
function expectSingleTerminal(events: AgentEvent[], expected: 'answer' | 'error'): AgentEvent {
  const terminals = events.filter((e) => TERMINALS.has(e.type));
  expect(terminals).toHaveLength(1);
  const last = events[events.length - 1]!;
  expect(last.type).toBe(expected);
  // Nothing (not even a status) follows the terminator.
  expect(TERMINALS.has(last.type)).toBe(true);
  return last;
}

describe('runAgent terminal-event contract', () => {
  it('SUCCESS path still ends with exactly one answer (terminator unchanged)', async () => {
    const { config, memory, ignore } = await setup();
    const llm = new FakeLlm([{ tokens: ['done'] }]);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    await runAgent('hi', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: gate,
      ignore,
    });
    expectSingleTerminal(events, 'answer');
  });

  it('LlmError(http) exit ends with exactly one terminal error{http} and no trailing status', async () => {
    const { config, memory, ignore } = await setup();
    const llm = new ThrowingLlm(new LlmError('http', 'boom', { status: 503 }));
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    await runAgent('x', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: gate,
      ignore,
    });
    const term = expectSingleTerminal(events, 'error');
    expect(term.type === 'error' && term.code).toBe('http');
  });

  it('maxSteps exit ends with exactly one terminal error{max_steps} and no trailing status', async () => {
    const { config, memory, ignore } = await setup();
    const turns = Array.from({ length: 5 }, () => ({
      toolCalls: [{ id: 'loop', name: 'glob', arguments: JSON.stringify({ pattern: '*' }) }],
    }));
    const llm = new FakeLlm(turns);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    await runAgent(
      'x',
      { llm, tools: buildToolRegistry(), config, memory, emit, approvals: gate, ignore },
      { maxSteps: 3 },
    );
    const term = expectSingleTerminal(events, 'error');
    expect(term.type === 'error' && term.code).toBe('max_steps');
  });

  it('pre-aborted signal: ends with exactly one terminal error{aborted}; cancelled appears EXACTLY ONCE and is NOT the terminator', async () => {
    const { config, memory, ignore } = await setup();
    const llm = new FakeLlm([{ tokens: ['unused'] }]);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    const ac = new AbortController();
    ac.abort();
    await runAgent('x', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: gate,
      signal: ac.signal,
      ignore,
    });
    const term = expectSingleTerminal(events, 'error');
    expect(term.type === 'error' && term.code).toBe('aborted');
    // GAP2: the cancelled status is emitted at most once (was duplicated before the fix).
    const cancelledCount = events.filter(
      (e) => e.type === 'status' && e.phase === 'cancelled',
    ).length;
    expect(cancelledCount).toBe(1);
  });

  it('abort mid-run (after the first tool call) ends with one terminal error{aborted}; cancelled once', async () => {
    const { config, memory, ignore } = await setup();
    const llm = new FakeLlm([
      {
        toolCalls: [{ id: 't1', name: 'glob', arguments: JSON.stringify({ pattern: '**/*.gml' }) }],
      },
      { tokens: ['should not reach'] },
    ]);
    const events: AgentEvent[] = [];
    const ac = new AbortController();
    // Abort the moment the first tool_result is emitted (mid-run), as a real cancel would arrive.
    const emit = (e: AgentEvent): void => {
      events.push(e);
      if (e.type === 'tool_result') ac.abort();
    };
    const gate = createApprovalGate({ autoApprove: false, emit });
    await runAgent('go', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: gate,
      signal: ac.signal,
      ignore,
    });
    const term = expectSingleTerminal(events, 'error');
    expect(term.type === 'error' && term.code).toBe('aborted');
    const cancelledCount = events.filter(
      (e) => e.type === 'status' && e.phase === 'cancelled',
    ).length;
    expect(cancelledCount).toBe(1);
    // The second model turn never ran (we aborted before answering).
    expect(events.some((e) => e.type === 'answer')).toBe(false);
  });

  it('stuck tool: the SAME failing tool call N times breaks early with terminal error{stuck_tool} BEFORE maxSteps', async () => {
    const { config, memory, ignore } = await setup();
    // read_file of a nonexistent path returns ok:false deterministically; the model re-issues the
    // IDENTICAL call every turn. maxSteps is generous (10) so the stuck-guard (N=3), not maxSteps,
    // must be what stops the loop.
    const args = JSON.stringify({ path: 'does/not/exist.gml' });
    const turns = Array.from({ length: 10 }, () => ({
      toolCalls: [{ id: 'r', name: 'read_file', arguments: args }],
    }));
    const llm = new FakeLlm(turns);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    await runAgent(
      'x',
      { llm, tools: buildToolRegistry(), config, memory, emit, approvals: gate, ignore },
      { maxSteps: 10 },
    );
    const term = expectSingleTerminal(events, 'error');
    expect(term.type === 'error' && term.code).toBe('stuck_tool');
    expect(term.type === 'error' && /read_file/.test(term.message)).toBe(true);
    // It stopped at the limit, not at maxSteps: exactly STUCK_TOOL_LIMIT failing tool_results ran.
    const failures = events.filter((e) => e.type === 'tool_result' && !e.ok);
    expect(failures).toHaveLength(STUCK_TOOL_LIMIT);
    // The model was NOT polled all 10 times.
    expect(llm.callCount).toBeLessThan(10);
  });

  it('stuck guard resets on a DIFFERENT (or succeeding) call: two distinct fails do not trip it', async () => {
    const { config, memory, ignore } = await setup();
    // Alternate two DISTINCT failing calls then answer. Never 3 of the SAME in a row -> no stuck error.
    const llm = new FakeLlm([
      {
        toolCalls: [
          { id: 'a', name: 'read_file', arguments: JSON.stringify({ path: 'nope-a.gml' }) },
        ],
      },
      {
        toolCalls: [
          { id: 'b', name: 'read_file', arguments: JSON.stringify({ path: 'nope-b.gml' }) },
        ],
      },
      {
        toolCalls: [
          { id: 'c', name: 'read_file', arguments: JSON.stringify({ path: 'nope-a.gml' }) },
        ],
      },
      { tokens: ['gave up cleanly'] },
    ]);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    await runAgent(
      'x',
      { llm, tools: buildToolRegistry(), config, memory, emit, approvals: gate, ignore },
      { maxSteps: 10 },
    );
    // It answered, not stuck_tool — alternating fingerprints never reached 3-in-a-row.
    expectSingleTerminal(events, 'answer');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GAP4 — AUTO-MODE DESTRUCTIVE-EDIT BACKSTOP (end-to-end through runAgent + the real ApprovalGate).
// In auto mode a small additive patch auto-applies (NO approval_request); a whole-file-delete patch
// emits approval_request and does NOT write until approved. Gated mode is unchanged.
// ---------------------------------------------------------------------------
const STEP_TARGET = 'objects/obj_player/Step_0.gml';
const STEP_ORIGINAL = 'hp -= 1;\nif (hp <= 0) instance_destroy();\n';
// Small additive: insert a line after line 1 (net +1, in-place) -> NOT high-risk.
const ADDITIVE_DIFF =
  '--- a\n+++ b\n@@ -1,2 +1,3 @@\n hp -= 1;\n+hp = max(hp, 0);\n if (hp <= 0) instance_destroy();\n';
const STEP_ADDITIVE_APPLIED = 'hp -= 1;\nhp = max(hp, 0);\nif (hp <= 0) instance_destroy();\n';
// Whole-file wipe: remove every existing line, add nothing -> HIGH-RISK (forceGate).
const WIPE_DIFF = '--- a\n+++ b\n@@ -1,2 +0,0 @@\n-hp -= 1;\n-if (hp <= 0) instance_destroy();\n';

describe('runAgent auto-mode destructive-edit backstop (GAP4)', () => {
  it('auto mode: a SMALL additive apply_patch auto-applies with NO approval_request and writes', async () => {
    const { config, memory, ignore, root } = await setup('auto');
    const llm = new FakeLlm([
      {
        toolCalls: [
          {
            id: 'e1',
            name: 'apply_patch',
            arguments: JSON.stringify({ path: STEP_TARGET, diff: ADDITIVE_DIFF }),
          },
        ],
      },
      { tokens: ['Applied the guard.'] },
    ]);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: true, emit });
    await runAgent('add an hp guard', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: gate,
      ignore,
    });
    // Auto-applied: edit_proposal is emitted, but NO approval_request (no human prompted).
    expect(events.some((e) => e.type === 'edit_proposal')).toBe(true);
    expect(events.some((e) => e.type === 'approval_request')).toBe(false);
    // The write actually happened.
    expect(readFileSync(`${root}/${STEP_TARGET}`, 'utf8')).toBe(STEP_ADDITIVE_APPLIED);
    expect(events.some((e) => e.type === 'answer')).toBe(true);
  });

  it('auto mode: a WHOLE-FILE-DELETE apply_patch emits approval_request and does NOT write until approved', async () => {
    const { config, memory, ignore, root } = await setup('auto');
    const before = readFileSync(`${root}/${STEP_TARGET}`, 'utf8');
    expect(before).toBe(STEP_ORIGINAL);
    const llm = new FakeLlm([
      {
        toolCalls: [
          {
            id: 'e1',
            name: 'apply_patch',
            arguments: JSON.stringify({ path: STEP_TARGET, diff: WIPE_DIFF }),
          },
        ],
      },
      { tokens: ['Wiped the file.'] },
    ]);
    const events: AgentEvent[] = [];
    // The backstop forces the gate to WAIT even in auto mode. Capture the request id and, to PROVE the
    // file is untouched while pending, approve out-of-band on a later tick.
    const holder: { gate?: ReturnType<typeof createApprovalGate> } = {};
    let sawApprovalRequest = false;
    const emit = (e: AgentEvent): void => {
      events.push(e);
      if (e.type === 'approval_request') {
        sawApprovalRequest = true;
        const id = e.id;
        // The destructive edit must NOT have been written at the moment the human is asked.
        expect(readFileSync(`${root}/${STEP_TARGET}`, 'utf8')).toBe(before);
        queueMicrotask(() => holder.gate?.resolve(id, true)); // now approve
      }
    };
    const gate = createApprovalGate({ autoApprove: true, emit });
    holder.gate = gate;
    await runAgent('delete everything', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: gate,
      ignore,
    });

    // Even in AUTO mode the destructive edit was gated: an approval_request WAS emitted ...
    expect(sawApprovalRequest).toBe(true);
    expect(events.some((e) => e.type === 'approval_request')).toBe(true);
    // ... and only after the (out-of-band) approve did the write land.
    expect(readFileSync(`${root}/${STEP_TARGET}`, 'utf8')).toBe('');
  });

  it('auto mode: a WHOLE-FILE-DELETE that the human REJECTS is not written (blast radius capped)', async () => {
    const { config, memory, ignore, root } = await setup('auto');
    const before = readFileSync(`${root}/${STEP_TARGET}`, 'utf8');
    const llm = new FakeLlm([
      {
        toolCalls: [
          {
            id: 'e1',
            name: 'apply_patch',
            arguments: JSON.stringify({ path: STEP_TARGET, diff: WIPE_DIFF }),
          },
        ],
      },
      { tokens: ['Edit was declined.'] },
    ]);
    const events: AgentEvent[] = [];
    const holder: { gate?: ReturnType<typeof createApprovalGate> } = {};
    const emit = (e: AgentEvent): void => {
      events.push(e);
      if (e.type === 'approval_request') {
        const id = e.id;
        queueMicrotask(() => holder.gate?.resolve(id, false)); // reject
      }
    };
    const gate = createApprovalGate({ autoApprove: true, emit });
    holder.gate = gate;
    await runAgent('delete everything', {
      llm,
      tools: buildToolRegistry(),
      config,
      memory,
      emit,
      approvals: gate,
      ignore,
    });
    expect(events.some((e) => e.type === 'approval_request')).toBe(true);
    // Rejected -> the file is UNCHANGED. An injection-driven wipe applied nothing in auto mode.
    expect(readFileSync(`${root}/${STEP_TARGET}`, 'utf8')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// GAP5 — SLOW-UPSTREAM IDLE HEARTBEAT. A slow stream (first token after > IDLE_MS, IDLE_MS shrunk for
// the test) emits >= 1 status:streaming heartbeat BEFORE the token, then the token + answer. A fast
// stream emits NO heartbeat. The heartbeat is gated on REAL idle time and injectable, so the
// docs-conformance fixture + existing fast-stream tests are unaffected.
// ---------------------------------------------------------------------------
describe('runAgent slow-upstream idle heartbeat (GAP5)', () => {
  it('IDLE_MS is exported and a sane positive default', () => {
    expect(IDLE_MS).toBeGreaterThan(0);
  });

  it('a slow stream emits >=1 status:streaming heartbeat BEFORE the first token, then token + answer', async () => {
    const { config, memory, ignore } = await setup();
    // Stall 80ms before the first token; shrink IDLE_MS to 20ms so the watchdog trips ~3x during the gap.
    const llm = new SlowLlm('slow answer', 80);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    await runAgent(
      'hi',
      { llm, tools: buildToolRegistry(), config, memory, emit, approvals: gate, ignore },
      { idleMs: 20 },
    );

    const types = events.map((e) => e.type);
    const firstStreaming = types.findIndex(
      (t, i) =>
        t === 'status' &&
        events[i]!.type === 'status' &&
        (events[i] as { phase?: string }).phase === 'streaming',
    );
    const firstToken = types.indexOf('token');
    const heartbeats = events.filter((e) => e.type === 'status' && e.phase === 'streaming');
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    // The heartbeat(s) arrived BEFORE the first token (during the idle stall).
    expect(firstStreaming).toBeGreaterThanOrEqual(0);
    expect(firstStreaming).toBeLessThan(firstToken);
    // The token + final answer still arrive normally after the stall.
    expect(types).toContain('token');
    const answer = events.find((e) => e.type === 'answer');
    expect(answer && answer.type === 'answer' && answer.text).toBe('slow answer');
  });

  it('a FAST stream emits NO heartbeat (real-idle gating; fixture/fast tests unaffected)', async () => {
    const { config, memory, ignore } = await setup();
    const llm = new FakeLlm([{ tokens: ['Hello ', 'world'] }]);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    // Even with a small idleMs, a synchronous (no-stall) FakeLlm never idles long enough to trip it.
    await runAgent(
      'hi',
      { llm, tools: buildToolRegistry(), config, memory, emit, approvals: gate, ignore },
      { idleMs: 20 },
    );
    expect(events.some((e) => e.type === 'status' && e.phase === 'streaming')).toBe(false);
    // It still streams tokens and answers.
    expect(events.some((e) => e.type === 'token')).toBe(true);
    expect(events.some((e) => e.type === 'answer')).toBe(true);
  });

  it('the watchdog stops at turn end (no heartbeat fires after the answer)', async () => {
    const { config, memory, ignore } = await setup();
    const llm = new SlowLlm('done', 50);
    const { events, emit } = collect();
    const gate = createApprovalGate({ autoApprove: false, emit });
    await runAgent(
      'hi',
      { llm, tools: buildToolRegistry(), config, memory, emit, approvals: gate, ignore },
      { idleMs: 15 },
    );
    const answerIdx = events.findIndex((e) => e.type === 'answer');
    expect(answerIdx).toBeGreaterThanOrEqual(0);
    // Nothing after the answer (the interval was cleared in the finally).
    const after = events.slice(answerIdx + 1);
    expect(after).toHaveLength(0);
    // Give any leaked interval a chance to fire; assert none did.
    await new Promise((r) => setTimeout(r, 50));
    expect(events.slice(answerIdx + 1)).toHaveLength(0);
  });
});
