// test/helpers/fake-llm.ts — a scripted LlmLike for agent-loop tests (no network, no SSE).
import type { LlmLike } from '../../src/agent.js';
import type { ChatRequest, StreamDelta, ChatResult } from '../../src/llm.js';
import type { ChatMessage, ToolCall, Usage } from '../../src/types.js';

export interface ScriptTurn {
  /** Text tokens streamed in order. */
  tokens?: string[];
  /** Tool calls to emit on this turn (final message gets tool_calls). */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: string;
  usage?: Usage;
}

/**
 * A model that replays scripted turns. Each call to chatStream consumes the next turn, yields its
 * text deltas, and returns a ChatResult whose message has tool_calls iff the turn declared them.
 * Records the requests it received (for assertions on history / role:'tool' messages).
 */
export class FakeLlm implements LlmLike {
  readonly requests: ChatRequest[] = [];
  private cursor = 0;
  constructor(private readonly turns: ScriptTurn[]) {}

  get callCount(): number {
    return this.cursor;
  }

  // eslint-disable-next-line require-yield
  async *chatStream(req: ChatRequest): AsyncGenerator<StreamDelta, ChatResult, void> {
    this.requests.push(req);
    const turn = this.turns[this.cursor];
    if (!turn) throw new Error(`FakeLlm: no scripted turn #${this.cursor}`);
    this.cursor++;

    let text = '';
    for (const tok of turn.tokens ?? []) {
      text += tok;
      yield { kind: 'text', text: tok };
    }
    const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));
    const finishReason = turn.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop');
    const finish: StreamDelta = turn.usage
      ? { kind: 'finish', reason: finishReason, usage: turn.usage }
      : { kind: 'finish', reason: finishReason };
    yield finish;

    const message: ChatMessage = { role: 'assistant', content: text.length > 0 ? text : null };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    const result: ChatResult = { message, finishReason };
    if (turn.usage) result.usage = turn.usage;
    return result;
  }
}

/** An LlmLike whose chatStream throws an LlmError on the Nth call (default 1st). */
export class ThrowingLlm implements LlmLike {
  constructor(private readonly err: Error) {}
  // eslint-disable-next-line require-yield
  async *chatStream(): AsyncGenerator<StreamDelta, ChatResult, void> {
    throw this.err;
  }
}
