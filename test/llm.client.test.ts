import { describe, it, expect, vi } from 'vitest';
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
      {
        match: '/chat/completions',
        responder: () => openAiTextStream(['Hello ', 'world'], { splitAt: 7 }),
      },
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
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'glob', arguments: '{"pat' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: 'tern":"*.gml"}' } }] },
            finish_reason: null,
          },
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
      message: {
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
      finishReason: string;
    };
    expect(res.finishReason).toBe('tool_calls');
    expect(res.message.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'glob', arguments: '{"pattern":"*.gml"}' },
      },
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
  it('omits temperature for official Kimi K2 code models', async () => {
    const { recorder, fetch } = installFetchMock([
      {
        match: '/chat/completions',
        responder: () =>
          jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      },
    ]);
    const client = new LlmClient(
      lane({ baseURL: 'https://api.moonshot.ai/v1', model: 'kimi-k2.7-code', temperature: 0.2 }),
      { fetch },
    );
    await client.chat({ messages: [{ role: 'user', content: 'q' }] });
    const body = JSON.parse(recorder.calls[0]!.body!);
    expect(body.temperature).toBeUndefined();
  });

  it('omits temperature for Kimi Code CLI OpenAI-compatible endpoint', async () => {
    const { recorder, fetch } = installFetchMock([
      {
        match: '/chat/completions',
        responder: () =>
          jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      },
    ]);
    const client = new LlmClient(
      lane({
        baseURL: 'https://api.kimi.com/coding/v1',
        model: 'kimi-for-coding',
        temperature: 0.2,
      }),
      { fetch },
    );
    await client.chat({ messages: [{ role: 'user', content: 'q' }] });
    const body = JSON.parse(recorder.calls[0]!.body!);
    expect(body.temperature).toBeUndefined();
  });

  it('keeps temperature for ordinary OpenAI-compatible models', async () => {
    const { recorder, fetch } = installFetchMock([
      {
        match: '/chat/completions',
        responder: () =>
          jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      },
    ]);
    const client = new LlmClient(lane({ model: 'test-model', temperature: 0.4 }), { fetch });
    await client.chat({ messages: [{ role: 'user', content: 'q' }] });
    const body = JSON.parse(recorder.calls[0]!.body!);
    expect(body.temperature).toBe(0.4);
  });

  it('drops empty assistant history before sending the provider request', async () => {
    const { recorder, fetch } = installFetchMock([
      {
        match: '/chat/completions',
        responder: () =>
          jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      },
    ]);
    const client = new LlmClient(lane(), { fetch });
    await client.chat({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'prior q' },
        { role: 'assistant', content: null },
        { role: 'assistant', content: '   ' },
        { role: 'user', content: 'next q' },
      ],
    });
    const body = JSON.parse(recorder.calls[0]!.body!);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'prior q' },
      { role: 'user', content: 'next q' },
    ]);
  });

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
  it('retries transient provider overload errors before failing the turn', async () => {
    const retries: Array<{ status: number; attempt: number; maxRetries: number; delayMs: number }> =
      [];
    let calls = 0;
    const { recorder, fetch } = installFetchMock([
      {
        match: '/chat/completions',
        responder: () => {
          calls += 1;
          if (calls === 1) {
            return new Response(
              '{"error":{"message":"The engine is currently overloaded","type":"engine_overloaded_error"}}',
              {
                status: 429,
                headers: { 'retry-after': '0' },
              },
            );
          }
          return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
        },
      },
    ]);
    const client = new LlmClient(lane(), { fetch });
    const res = await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
      onRetry: (info) => {
        retries.push(info);
      },
    });
    expect(res.message.content).toBe('ok');
    expect(recorder.calls).toHaveLength(2);
    expect(retries).toMatchObject([{ status: 429, attempt: 1, maxRetries: 2, delayMs: 0 }]);
  });

  it('debug logs sanitized request/response facts when CHATGML_DEBUG_HTTP is enabled', async () => {
    const prev = process.env.CHATGML_DEBUG_HTTP;
    process.env.CHATGML_DEBUG_HTTP = '1';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { fetch } = installFetchMock([
        {
          match: '/chat/completions',
          responder: () => errorResponse(400, `bad key ${SENTINEL} sk-${'x'.repeat(20)}`),
        },
      ]);
      const client = new LlmClient(lane(), { fetch });
      await expect(
        client.chat({ messages: [{ role: 'user', content: 'secret prompt' }] }),
      ).rejects.toMatchObject({ code: 'http', status: 400 });
      const log = spy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(log).toContain('[chatgml:http] request');
      expect(log).toContain('"auth":"present"');
      expect(log).toContain('"status":400');
      expect(log).not.toContain(SENTINEL);
      expect(log).not.toContain('secret prompt');
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.CHATGML_DEBUG_HTTP;
      else process.env.CHATGML_DEBUG_HTTP = prev;
    }
  });

  it('throws LlmError(http) with a key-scrubbed body on a 503', async () => {
    const { fetch } = installFetchMock([
      {
        match: '/chat/completions',
        responder: () =>
          new Response(`upstream said Bearer ${SENTINEL} and sk-${'x'.repeat(20)}`, {
            status: 503,
            headers: { 'retry-after': '0' },
          }),
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
    expect(err.message).toContain('Bearer ***');
    expect(err.body).not.toContain(SENTINEL);
    expect(err.body).toContain('Bearer ***');
    // sentinel must not leak through the thrown error at all.
    FetchRecorder.assertNoAuthLeak(
      SENTINEL,
      String(err.message),
      String(err.body),
      String(err.stack),
    );
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
        client.chatStream({
          messages: [{ role: 'user', content: 'x' }],
          signal: controller.signal,
        }),
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
