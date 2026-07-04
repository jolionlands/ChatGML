import { describe, it, expect } from 'vitest';
import { LlmError } from '../src/llm.js';
import type { ChatRequest, ChatResult, StreamDelta } from '../src/llm.js';
import {
  makeFailoverLlm,
  knownProviderFallbackLanes,
  dedupeLanes,
  type LlmLike,
  type NamedChatLane,
} from '../src/llm-failover.js';

function throwBeforeTokens(err: LlmError): AsyncGenerator<StreamDelta, ChatResult, void> {
  return (async function* (emitNever = false): AsyncGenerator<StreamDelta, ChatResult, void> {
    if (emitNever) yield { kind: 'text', text: '' };
    throw err;
  })();
}

class ThrowBeforeTokens implements LlmLike {
  constructor(private readonly status: number) {}
  chatStream(_req: ChatRequest): AsyncGenerator<StreamDelta, ChatResult, void> {
    const err = new LlmError('http', `chat endpoint returned HTTP ${this.status}`, {
      status: this.status,
    });
    return throwBeforeTokens(err);
  }
}

class ThrowAfterToken implements LlmLike {
  async *chatStream(_req: ChatRequest): AsyncGenerator<StreamDelta, ChatResult, void> {
    yield { kind: 'text', text: 'partial' };
    throw new LlmError('http', 'chat endpoint returned HTTP 429', { status: 429 });
  }
}

class ThrowNetworkBeforeTokens implements LlmLike {
  chatStream(_req: ChatRequest): AsyncGenerator<StreamDelta, ChatResult, void> {
    const err = new LlmError('network', 'network error reading chat stream');
    return throwBeforeTokens(err);
  }
}

class ThrowNetworkAfterToken implements LlmLike {
  async *chatStream(_req: ChatRequest): AsyncGenerator<StreamDelta, ChatResult, void> {
    yield { kind: 'text', text: 'partial' };
    throw new LlmError('network', 'network error reading chat stream');
  }
}

class TextLlm implements LlmLike {
  constructor(private readonly text: string) {}
  async *chatStream(_req: ChatRequest): AsyncGenerator<StreamDelta, ChatResult, void> {
    yield { kind: 'text', text: this.text };
    return { message: { role: 'assistant', content: this.text }, finishReason: 'stop' };
  }
}

async function collect(
  llm: LlmLike,
  req: ChatRequest,
): Promise<{ text: string; result: ChatResult }> {
  let text = '';
  const gen = llm.chatStream(req);
  let next = await gen.next();
  while (!next.done) {
    if (next.value.kind === 'text') text += next.value.text;
    next = await gen.next();
  }
  return { text, result: next.value };
}

const primary: NamedChatLane = {
  providerName: 'Kimi',
  baseURL: 'https://api.kimi.com/coding/v1',
  apiKey: 'k',
  model: 'kimi-for-coding',
  temperature: 0.2,
};

const openrouter: NamedChatLane = {
  providerName: 'OpenRouter',
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: 'or',
  model: 'minimax/minimax-m3',
  temperature: 0.2,
};

describe('FailoverLlm', () => {
  it('fails over from a retryable provider error before any tokens are emitted', async () => {
    const notices: unknown[] = [];
    const llm = makeFailoverLlm(primary, [openrouter], (lane) =>
      lane.providerName === 'Kimi' ? new ThrowBeforeTokens(429) : new TextLlm('ok'),
    );
    const out = await collect(llm, {
      messages: [{ role: 'user', content: 'hi' }],
      onFailover: (info) => notices.push(info),
    });
    expect(out.text).toBe('ok');
    expect(out.result.message.content).toBe('ok');
    expect(notices).toMatchObject([
      {
        status: 429,
        fromModel: 'kimi-for-coding',
        toModel: 'minimax/minimax-m3',
        reason: 'Kimi returned HTTP 429',
      },
    ]);
  });

  it('does not fail over after partial output has already streamed', async () => {
    const llm = makeFailoverLlm(primary, [openrouter], (lane) =>
      lane.providerName === 'Kimi' ? new ThrowAfterToken() : new TextLlm('fallback'),
    );
    await expect(
      collect(llm, { messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({
      status: 429,
    });
  });

  it('fails over from a stream network error before any tokens are emitted', async () => {
    const notices: unknown[] = [];
    const llm = makeFailoverLlm(primary, [openrouter], (lane) =>
      lane.providerName === 'Kimi' ? new ThrowNetworkBeforeTokens() : new TextLlm('ok'),
    );
    const out = await collect(llm, {
      messages: [{ role: 'user', content: 'hi' }],
      onFailover: (info) => notices.push(info),
    });
    expect(out.text).toBe('ok');
    expect(notices).toMatchObject([
      {
        fromModel: 'kimi-for-coding',
        toModel: 'minimax/minimax-m3',
        reason: 'Kimi stream failed before output',
      },
    ]);
  });

  it('does not fail over from a stream network error after partial output', async () => {
    const llm = makeFailoverLlm(primary, [openrouter], (lane) =>
      lane.providerName === 'Kimi' ? new ThrowNetworkAfterToken() : new TextLlm('fallback'),
    );
    await expect(
      collect(llm, { messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({
      code: 'network',
    });
  });

  it('builds env fallback lanes for OpenRouter and MiniMax and dedupes the active lane', () => {
    const lanes = knownProviderFallbackLanes(
      {
        OPENROUTER_API_KEY: 'or-key',
        MINIMAX_API_KEY: 'mini-key',
      },
      primary,
    );
    expect(lanes.map((l) => l.providerName)).toEqual(['OpenRouter', 'MiniMax']);
    expect(lanes[0]).toMatchObject({
      baseURL: 'https://openrouter.ai/api/v1',
      model: 'minimax/minimax-m3',
    });
    expect(dedupeLanes(primary, [primary, ...lanes])).toHaveLength(2);
  });
});
