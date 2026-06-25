import { describe, it, expect } from 'vitest';
import { LlmClient, LlmError } from '../src/llm.js';
import {
  installFetchMock,
  jsonResponse,
  errorResponse,
  sseResponse,
  openAiTextStream,
  FetchRecorder,
} from './helpers/mock-fetch.js';
import type { ChatLane } from '../src/types.js';

const SENTINEL = 'sk-SENTINEL-DEADBEEF';

function lane(overrides?: Partial<ChatLane>): ChatLane {
  return {
    baseURL: 'http://llm.local/v1',
    apiKey: SENTINEL,
    model: 'test-model',
    temperature: 0.2,
    ...overrides,
  };
}

async function collectStream(
  gen: AsyncGenerator<{ kind: string }, unknown, void>,
): Promise<{ deltas: Array<{ kind: string }>; result: unknown }> {
  const deltas: Array<{ kind: string }> = [];
  let next = await gen.next();
  while (!next.done) {
    deltas.push(next.value as { kind: string });
    next = await gen.next();
  }
  return { deltas, result: next.value };
}

describe('LlmClient.chatStream', () => {
  it('streams text deltas and a finish, assembling the final message (split mid-JSON)', async () => {
    const { recorder, fetch } = installFetchMock([
      { match: '/chat/completions', responder: () => openAiTextStream(['Hello ', 'world'], { splitAt: 7 }) },
    ]);
    const client = new LlmClient(lane(), { fetch });
    const gen = client.chatStream({ messages: [{ role: 'user', content: 'hi' }] });
    const { deltas, result } = await collectStream(gen);

    const textDeltas = deltas.filter((d) => d.kind === 'text');
    expect(textDeltas).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'text', text: 'world' },
    ]);
    const res = result as { message: { content: string | null }; finishReason: string };
    expect(res.message.content).toBe('Hello world');
    expect(res.finishReason).toBe('stop');

    // request hit the chat endpoint with the model + bearer auth.
    expect(recorder.calls[0]!.url).toBe('http://llm.local/v1/chat/completions');
    expect(recorder.calls[0]!.headers['authorization']).toBe(`Bearer ${SENTINEL}`);
    const body = JSON.parse(recorder.calls[0]!.body!);
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(true);
  });

  it('assembles a streamed tool call (fragments by index)', async () => {
    const events = [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: 'glob', arguments: '{"pat' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'tern":"*.gml"}' } }] }, finish_reason: null },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    const { fetch } = installFetchMock([
      { match: '/chat/completions', responder: () => sseResponse(events, { splitAt: 11 }) },
    ]);
    const client = new LlmClient(lane(), { fetch });
    const gen = client.chatStream({
      messages: [{ role: 'user', content: 'find gml' }],
      tools: [
        {
          type: 'function',
          function: { name: 'glob', description: 'glob', parameters: { type: 'object' } },
        },
      ],
    });
    const { result } = await collectStream(gen);
    const res = result as {
      message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      finishReason: string;
    };
    expect(res.finishReason).toBe('tool_calls');
    expect(res.message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*.gml"}' } },
    ]);
  });

  it('omits Authorization when no apiKey is configured', async () => {
    const { recorder, fetch } = installFetchMock([
      { match: '/chat/completions', responder: () => openAiTextStream(['hi']) },
    ]);
    const noKeyLane = lane();
    delete (noKeyLane as { apiKey?: string }).apiKey;
    const client = new LlmClient(noKeyLane, { fetch });
    await collectStream(client.chatStream({ messages: [{ role: 'user', content: 'x' }] }));
    expect(recorder.calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('normalizes a trailing slash in baseURL', async () => {
    const { recorder, fetch } = installFetchMock([
      { match: '/chat/completions', responder: () => openAiTextStream(['hi']) },
    ]);
    const client = new LlmClient(lane({ baseURL: 'http://llm.local/v1/' }), { fetch });
    await collectStream(client.chatStream({ messages: [{ role: 'user', content: 'x' }] }));
    expect(recorder.calls[0]!.url).toBe('http://llm.local/v1/chat/completions');
  });
});

describe('LlmClient.chat (non-stream)', () => {
  it('maps a non-stream response to a ChatResult', async () => {
    const { fetch } = installFetchMock([
      {
        match: '/chat/completions',
        responder: () =>
          jsonResponse({
            choices: [{ message: { content: 'final answer' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          }),
      },
    ]);
    const client = new LlmClient(lane(), { fetch });
    const res = await client.chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(res.message.content).toBe('final answer');
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  });

  it('maps non-stream tool calls', async () => {
    const { fetch } = installFetchMock([
      {
        match: '/chat/completions',
        responder: () =>
          jsonResponse({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [{ id: 't1', function: { name: 'grep', arguments: '{"q":"x"}' } }],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
      },
    ]);
    const client = new LlmClient(lane(), { fetch });
    const res = await client.chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(res.message.tool_calls).toEqual([
      { id: 't1', type: 'function', function: { name: 'grep', arguments: '{"q":"x"}' } },
    ]);
  });
});

describe('LlmClient errors', () => {
  it('throws LlmError(http) with a key-scrubbed body on a 503', async () => {
    const { fetch } = installFetchMock([
      {
        match: '/chat/completions',
        responder: () => errorResponse(503, `upstream said Bearer ${SENTINEL} and sk-${'x'.repeat(20)}`),
      },
    ]);
    const client = new LlmClient(lane(), { fetch });
    let thrown: unknown;
    try {
      await collectStream(client.chatStream({ messages: [{ role: 'user', content: 'x' }] }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LlmError);
    const err = thrown as LlmError;
    expect(err.code).toBe('http');
    expect(err.status).toBe(503);
    expect(err.body).not.toContain(SENTINEL);
    expect(err.body).toContain('Bearer ***');
    // sentinel must not leak through the thrown error at all.
    FetchRecorder.assertNoAuthLeak(SENTINEL, String(err.message), String(err.body), String(err.stack));
  });

  it('maps an aborted request to LlmError(aborted)', async () => {
    const controller = new AbortController();
    const { fetch } = installFetchMock([
      {
        match: '/chat/completions',
        responder: () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        },
      },
    ]);
    controller.abort();
    const client = new LlmClient(lane(), { fetch });
    let thrown: unknown;
    try {
      await collectStream(
        client.chatStream({ messages: [{ role: 'user', content: 'x' }], signal: controller.signal }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LlmError);
    expect((thrown as LlmError).code).toBe('aborted');
  });

  it('maps a network failure to LlmError(network)', async () => {
    const { fetch } = installFetchMock([
      {
        match: '/chat/completions',
        responder: () => {
          throw new TypeError('fetch failed');
        },
      },
    ]);
    const client = new LlmClient(lane(), { fetch });
    await expect(
      collectStream(client.chatStream({ messages: [{ role: 'user', content: 'x' }] })),
    ).rejects.toMatchObject({ code: 'network' });
  });
});
