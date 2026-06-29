// test/llm/thinking.test.ts — verifies that LlmClient extracts reasoning text from various
// upstream shapes and surfaces it as `StreamDelta { kind: 'thinking' }` deltas + accumulates it
// onto the final `ChatMessage.thinking` field.
//
// Provider coverage:
//  - OpenAI o-series (DeepSeek R1-compatible): `delta.reasoning_content` (and `delta.reasoning`)
//  - A model with no reasoning field: thinking MUST be absent (no phantom block)
//
// The non-streaming `chat()` method is also tested because it pulls reasoning from the same field
// names on `message.reasoning_content` / `message.reasoning`.
import { describe, it, expect } from 'vitest';
import { LlmClient } from '../../src/llm.js';
import { installFetchMock, sseResponse, jsonResponse } from '../helpers/mock-fetch.js';
import type { ChatLane } from '../../src/types.js';

const SENTINEL = 'sk-THINKING-TEST';
const LANE: ChatLane = {
  baseURL: 'http://llm.local/v1',
  apiKey: SENTINEL,
  model: 'kimi-k2.6-thinking',
  temperature: 0,
};

function buildEventsWithReasoning(reasoningChunks: string[], textChunks: string[]): unknown[] {
  const events: unknown[] = [];
  for (const r of reasoningChunks) {
    events.push({
      choices: [{ delta: { reasoning_content: r }, finish_reason: null }],
    });
  }
  for (const t of textChunks) {
    events.push({ choices: [{ delta: { content: t }, finish_reason: null }] });
  }
  events.push({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  events.push({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  return events;
}

function buildEventsWithReasoningAlt(reasoningChunks: string[]): unknown[] {
  const events: unknown[] = [];
  for (const r of reasoningChunks) {
    events.push({ choices: [{ delta: { reasoning: r }, finish_reason: null }] });
  }
  events.push({ choices: [{ delta: { content: 'final answer' }, finish_reason: null }] });
  events.push({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  events.push({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  return events;
}

async function collectStream(
  gen: AsyncGenerator<{ kind: string; text?: string }, unknown, void>,
): Promise<{ deltas: Array<{ kind: string; text?: string }>; result: unknown }> {
  const deltas: Array<{ kind: string; text?: string }> = [];
  let next = await gen.next();
  while (!next.done) {
    deltas.push(next.value as { kind: string; text?: string });
    next = await gen.next();
  }
  return { deltas, result: next.value };
}

function matchAll() {
  return /.*/;
}

describe('LlmClient - reasoning/thinking extraction (DeepSeek R1 / Kimi k2.6 / OpenAI o-series)', () => {
  it('extracts delta.reasoning_content as thinking deltas and accumulates into message.thinking', async () => {
    const events = buildEventsWithReasoning(
      ['Let me ', 'think about ', 'this...'],
      ['The answer is 42.'],
    );
    const { fetch: fetchMock } = installFetchMock([
      { match: matchAll(), responder: () => Promise.resolve(sseResponse(events, { splitAt: 64 })) },
    ]);
    const client = new LlmClient(LANE, { fetch: fetchMock });
    const gen = client.chatStream({
      messages: [{ role: 'user', content: 'What is the meaning?' }],
    });
    const { deltas, result } = await collectStream(
      gen as AsyncGenerator<{ kind: string; text?: string }, unknown, void>,
    );
    const thinkingTexts = deltas.filter((d) => d.kind === 'thinking').map((d) => d.text ?? '');
    const textTexts = deltas.filter((d) => d.kind === 'text').map((d) => d.text ?? '');
    expect(thinkingTexts.join('')).toBe('Let me think about this...');
    expect(textTexts.join('')).toBe('The answer is 42.');
    const resultWithMessage = result as { message: { content: string | null; thinking?: string } };
    expect(resultWithMessage.message.content).toBe('The answer is 42.');
    expect(resultWithMessage.message.thinking).toBe('Let me think about this...');
  });

  it('extracts delta.reasoning (no underscore) when reasoning_content is absent', async () => {
    const events = buildEventsWithReasoningAlt(['Step 1: ', 'Step 2: ', 'Done.']);
    const { fetch: fetchMock } = installFetchMock([
      { match: matchAll(), responder: () => Promise.resolve(sseResponse(events, { splitAt: 64 })) },
    ]);
    const client = new LlmClient(LANE, { fetch: fetchMock });
    const gen = client.chatStream({
      messages: [{ role: 'user', content: 'Walk me through it.' }],
    });
    const { deltas, result } = await collectStream(
      gen as AsyncGenerator<{ kind: string; text?: string }, unknown, void>,
    );
    const thinkingTexts = deltas.filter((d) => d.kind === 'thinking').map((d) => d.text ?? '');
    expect(thinkingTexts.join('')).toBe('Step 1: Step 2: Done.');
    const resultWithMessage = result as { message: { content: string | null; thinking?: string } };
    expect(resultWithMessage.message.content).toBe('final answer');
    expect(resultWithMessage.message.thinking).toBe('Step 1: Step 2: Done.');
  });

  it('a non-thinking model emits NO thinking deltas and leaves message.thinking undefined', async () => {
    const events = [
      { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
      { choices: [{ delta: { content: ' world' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    const { fetch: fetchMock } = installFetchMock([
      { match: matchAll(), responder: () => Promise.resolve(sseResponse(events, { splitAt: 64 })) },
    ]);
    const client = new LlmClient(LANE, { fetch: fetchMock });
    const gen = client.chatStream({ messages: [{ role: 'user', content: 'hi' }] });
    const { deltas, result } = await collectStream(
      gen as AsyncGenerator<{ kind: string; text?: string }, unknown, void>,
    );
    const thinkingTexts = deltas.filter((d) => d.kind === 'thinking');
    expect(thinkingTexts).toHaveLength(0);
    const resultWithMessage = result as { message: { content: string | null; thinking?: string } };
    expect(resultWithMessage.message.content).toBe('Hello world');
    expect(resultWithMessage.message.thinking).toBeUndefined();
  });

  it('empty-string reasoning_content / reasoning deltas are SKIPPED (no phantom thinking events)', async () => {
    const events = [
      { choices: [{ delta: { reasoning_content: '' }, finish_reason: null }] },
      { choices: [{ delta: { reasoning_content: 'real thought' }, finish_reason: null }] },
      { choices: [{ delta: { reasoning: null }, finish_reason: null }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];
    const { fetch: fetchMock } = installFetchMock([
      { match: matchAll(), responder: () => Promise.resolve(sseResponse(events, { splitAt: 64 })) },
    ]);
    const client = new LlmClient(LANE, { fetch: fetchMock });
    const gen = client.chatStream({ messages: [{ role: 'user', content: 'q' }] });
    const { deltas, result } = await collectStream(
      gen as AsyncGenerator<{ kind: string; text?: string }, unknown, void>,
    );
    const thinkingTexts = deltas.filter((d) => d.kind === 'thinking');
    expect(thinkingTexts).toHaveLength(1);
    expect(thinkingTexts[0]?.text).toBe('real thought');
    const resultWithMessage = result as { message: { content: string | null; thinking?: string } };
    expect(resultWithMessage.message.thinking).toBe('real thought');
  });

  it('non-streaming chat() pulls reasoning_content / reasoning from message body', async () => {
    const body1 = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '42',
            reasoning_content: 'Let me reason about this carefully.',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const body2 = {
      choices: [
        {
          message: { role: 'assistant', content: '43', reasoning: 'Or maybe 43...' },
          finish_reason: 'stop',
        },
      ],
    };
    let call = 0;
    const { fetch: fetchMock } = installFetchMock([
      {
        match: matchAll(),
        responder: () => {
          call += 1;
          return Promise.resolve(jsonResponse(call === 1 ? body1 : body2));
        },
      },
    ]);
    const client = new LlmClient(LANE, { fetch: fetchMock });
    const result = await client.chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(result.message.content).toBe('42');
    expect(result.message.thinking).toBe('Let me reason about this carefully.');

    const result2 = await client.chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(result2.message.content).toBe('43');
    expect(result2.message.thinking).toBe('Or maybe 43...');
  });

  it('non-streaming chat() with NO reasoning leaves message.thinking undefined (no phantom field)', async () => {
    const { fetch: fetchMock } = installFetchMock([
      {
        match: matchAll(),
        responder: () =>
          Promise.resolve(
            jsonResponse({
              choices: [
                {
                  message: { role: 'assistant', content: 'plain answer' },
                  finish_reason: 'stop',
                },
              ],
            }),
          ),
      },
    ]);
    const client = new LlmClient(LANE, { fetch: fetchMock });
    const result = await client.chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(result.message.content).toBe('plain answer');
    expect(result.message.thinking).toBeUndefined();
  });
});
