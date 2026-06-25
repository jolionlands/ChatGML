// src/llm.ts — OpenAI-compatible chat client over global fetch.
//
// Supports streaming token iteration and tool/function-call assembly against any
// OpenAI-compatible /chat/completions endpoint. baseURL/apiKey/model are configurable per
// ChatLane. The fetch implementation is injectable (deps.fetch) so tests never touch the network;
// it defaults to the global fetch (Node 25). Secrets are never logged and error bodies are
// truncated + key-scrubbed.
import type { ChatLane, ChatMessage, ToolSpec, Usage } from './types.js';

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type StreamDelta =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; index: number; id?: string; name?: string; argsFragment?: string }
  | { kind: 'finish'; reason: string; usage?: Usage };

export interface ChatResult {
  message: ChatMessage;
  finishReason: string;
  usage?: Usage;
}

export type LlmErrorCode = 'http' | 'network' | 'parse' | 'aborted' | 'config';

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly status?: number;
  readonly body?: string; // truncated 2KB, key-scrubbed

  constructor(code: LlmErrorCode, message: string, opts?: { status?: number; body?: string }) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.body !== undefined) this.body = opts.body;
  }
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface LlmDeps {
  fetch?: FetchLike;
}

const BODY_MAX = 2048;

/** Build the /chat/completions URL from a baseURL, normalizing a trailing slash. */
function completionsUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  return `${trimmed}/chat/completions`;
}

/**
 * Truncate + key-scrub an arbitrary error/response body. Removes Bearer tokens and `sk-...` keys
 * so a leaked endpoint response can never carry a secret into a thrown error.
 */
function scrubBody(text: string): string {
  const scrubbed = text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-***');
  return scrubbed.length > BODY_MAX ? `${scrubbed.slice(0, BODY_MAX)}…` : scrubbed;
}

interface RawDelta {
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface RawChoice {
  delta?: RawDelta;
  message?: { content?: string | null; tool_calls?: unknown };
  finish_reason?: string | null;
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface RawChunk {
  choices?: RawChoice[];
  usage?: RawUsage | null;
}

function mapUsage(raw: RawUsage | null | undefined): Usage | undefined {
  if (!raw) return undefined;
  const usage: Usage = {};
  if (typeof raw.prompt_tokens === 'number') usage.promptTokens = raw.prompt_tokens;
  if (typeof raw.completion_tokens === 'number') usage.completionTokens = raw.completion_tokens;
  if (typeof raw.total_tokens === 'number') usage.totalTokens = raw.total_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Line-buffered SSE parser. Splits a raw text feed into `data:` payloads, tolerating `\r\n`,
 * keep-alive blank lines, and JSON objects split across feed boundaries. Yields the parsed
 * JSON values (or the literal string '[DONE]' sentinel handled by the caller).
 *
 * `push(chunk)` returns the complete payloads found so far; partial trailing lines are buffered.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const out: unknown[] = [];
    let nl: number;
    // SSE frames are separated by blank lines, but most OpenAI-compatible servers emit one
    // `data:` line per event. We process complete lines and treat each `data:` line independently.
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const trimmed = line.trim();
      if (trimmed === '') continue; // keep-alive / frame separator
      if (!trimmed.startsWith('data:')) continue; // ignore comments / event: lines
      const payload = trimmed.slice('data:'.length).trim();
      if (payload === '[DONE]') {
        out.push(DONE);
        continue;
      }
      try {
        out.push(JSON.parse(payload));
      } catch {
        // A JSON object split across the data: prefix is unusual; if a server splits a single
        // JSON object across multiple `data:` lines we cannot recover, but the standard contract
        // is one JSON object per data: line. Re-buffer to be safe is not possible here; skip.
        throw new LlmError('parse', 'failed to parse SSE data payload');
      }
    }
    return out;
  }

  flush(): unknown[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest === '') return [];
    if (!rest.startsWith('data:')) return [];
    const payload = rest.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]') return [];
    try {
      return [JSON.parse(payload)];
    } catch {
      throw new LlmError('parse', 'failed to parse trailing SSE data payload');
    }
  }
}

/** Sentinel for the SSE `[DONE]` terminator. */
export const DONE = Symbol('sse-done');

interface ToolCallAccumulator {
  index: number;
  id?: string;
  name?: string;
  args: string;
}

/**
 * Assemble streamed tool-call deltas (keyed by index) into final ToolCall objects. The first-seen
 * id/name for an index is sticky; argument fragments are concatenated as raw JSON strings.
 */
export function assembleToolCalls(
  deltas: Array<{ index: number; id?: string; name?: string; argsFragment?: string }>,
): { id: string; type: 'function'; function: { name: string; arguments: string } }[] {
  const byIndex = new Map<number, ToolCallAccumulator>();
  for (const d of deltas) {
    let acc = byIndex.get(d.index);
    if (!acc) {
      acc = { index: d.index, args: '' };
      byIndex.set(d.index, acc);
    }
    if (acc.id === undefined && d.id !== undefined) acc.id = d.id;
    if (acc.name === undefined && d.name !== undefined) acc.name = d.name;
    if (d.argsFragment !== undefined) acc.args += d.argsFragment;
  }
  return [...byIndex.values()]
    .sort((a, b) => a.index - b.index)
    .map((acc) => ({
      id: acc.id ?? `call_${acc.index}`,
      type: 'function' as const,
      function: { name: acc.name ?? '', arguments: acc.args },
    }));
}

export class LlmClient {
  private readonly lane: ChatLane;
  private readonly fetchImpl: FetchLike;

  constructor(lane: ChatLane, deps?: LlmDeps) {
    this.lane = lane;
    const f = deps?.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) {
      throw new LlmError('config', 'no fetch implementation available');
    }
    this.fetchImpl = f;
  }

  private buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.lane.model,
      messages: req.messages,
      stream,
      temperature: req.temperature ?? this.lane.temperature,
    };
    const maxTokens = req.maxTokens ?? this.lane.maxTokens;
    if (maxTokens !== undefined) body['max_tokens'] = maxTokens;
    if (req.tools && req.tools.length > 0) {
      body['tools'] = req.tools;
      body['tool_choice'] = req.toolChoice ?? 'auto';
    }
    if (stream) {
      body['stream_options'] = { include_usage: true };
    }
    return body;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.lane.apiKey !== undefined && this.lane.apiKey !== '') {
      headers['authorization'] = `Bearer ${this.lane.apiKey}`;
    }
    return headers;
  }

  private async send(req: ChatRequest, stream: boolean): Promise<Response> {
    const url = completionsUrl(this.lane.baseURL);
    const init: RequestInit = {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(this.buildBody(req, stream)),
    };
    if (req.signal) init.signal = req.signal;
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      if (isAbortError(err) || req.signal?.aborted) {
        throw new LlmError('aborted', 'request aborted');
      }
      throw new LlmError('network', `network error contacting chat endpoint`);
    }
    if (!res.ok) {
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch {
        bodyText = '';
      }
      throw new LlmError('http', `chat endpoint returned HTTP ${res.status}`, {
        status: res.status,
        body: scrubBody(bodyText),
      });
    }
    return res;
  }

  /** Non-streaming chat completion. */
  async chat(req: ChatRequest): Promise<ChatResult> {
    const res = await this.send(req, false);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new LlmError('parse', 'failed to parse chat completion response');
    }
    const chunk = json as RawChunk;
    const choice = chunk.choices?.[0];
    const rawMessage = choice?.message;
    const message: ChatMessage = {
      role: 'assistant',
      content: typeof rawMessage?.content === 'string' ? rawMessage.content : null,
    };
    if (Array.isArray(rawMessage?.tool_calls) && rawMessage.tool_calls.length > 0) {
      message.tool_calls = normalizeToolCalls(rawMessage.tool_calls);
    }
    const result: ChatResult = {
      message,
      finishReason: choice?.finish_reason ?? 'stop',
    };
    const usage = mapUsage(chunk.usage);
    if (usage) result.usage = usage;
    return result;
  }

  /**
   * Streaming chat completion. Yields StreamDelta tokens/tool-call fragments and returns the
   * fully-assembled ChatResult.
   */
  async *chatStream(req: ChatRequest): AsyncGenerator<StreamDelta, ChatResult, void> {
    const res = await this.send(req, true);
    const body = res.body;
    if (!body) {
      throw new LlmError('parse', 'chat endpoint returned no response body for stream');
    }

    const parser = new SseParser();
    const toolDeltas: Array<{ index: number; id?: string; name?: string; argsFragment?: string }> =
      [];
    let textBuffer = '';
    let finishReason = 'stop';
    let usage: Usage | undefined;
    const decoder = new TextDecoder();

    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (isAbortError(err) || req.signal?.aborted) {
            throw new LlmError('aborted', 'stream aborted');
          }
          throw new LlmError('network', 'network error reading chat stream');
        }
        if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        for (const evt of parser.push(text)) {
          if (evt === DONE) continue;
          for (const delta of consumeChunk(evt as RawChunk, toolDeltas)) {
            if (delta.kind === 'text') textBuffer += delta.text;
            if (delta.kind === 'finish') {
              finishReason = delta.reason;
              if (delta.usage) usage = delta.usage;
            }
            yield delta;
          }
        }
      }
      for (const evt of parser.flush()) {
        if (evt === DONE) continue;
        for (const delta of consumeChunk(evt as RawChunk, toolDeltas)) {
          if (delta.kind === 'text') textBuffer += delta.text;
          if (delta.kind === 'finish') {
            finishReason = delta.reason;
            if (delta.usage) usage = delta.usage;
          }
          yield delta;
        }
      }
    } finally {
      reader.releaseLock();
    }

    const message: ChatMessage = { role: 'assistant', content: textBuffer.length > 0 ? textBuffer : null };
    if (toolDeltas.length > 0) {
      message.tool_calls = assembleToolCalls(toolDeltas);
    }
    const result: ChatResult = { message, finishReason };
    if (usage) result.usage = usage;
    return result;
  }
}

/** Map a streamed RawChunk choice into zero or more StreamDeltas, recording tool deltas. */
function consumeChunk(
  chunk: RawChunk,
  toolDeltas: Array<{ index: number; id?: string; name?: string; argsFragment?: string }>,
): StreamDelta[] {
  const out: StreamDelta[] = [];
  const choice = chunk.choices?.[0];
  const usage = mapUsage(chunk.usage);
  if (choice) {
    const delta = choice.delta;
    if (delta?.content) {
      out.push({ kind: 'text', text: delta.content });
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const rec: { index: number; id?: string; name?: string; argsFragment?: string } = {
          index: tc.index,
        };
        if (tc.id !== undefined) rec.id = tc.id;
        if (tc.function?.name !== undefined) rec.name = tc.function.name;
        if (tc.function?.arguments !== undefined) rec.argsFragment = tc.function.arguments;
        toolDeltas.push(rec);
        out.push({ kind: 'tool_call', ...rec });
      }
    }
    if (choice.finish_reason) {
      const finish: StreamDelta =
        usage !== undefined
          ? { kind: 'finish', reason: choice.finish_reason, usage }
          : { kind: 'finish', reason: choice.finish_reason };
      out.push(finish);
    }
  } else if (usage !== undefined) {
    // Some servers emit a trailing usage-only chunk with no choices.
    out.push({ kind: 'finish', reason: 'stop', usage });
  }
  return out;
}

/** Normalize a non-stream message.tool_calls array into the wire ToolCall shape. */
function normalizeToolCalls(
  raw: unknown,
): { id: string; type: 'function'; function: { name: string; arguments: string } }[] {
  if (!Array.isArray(raw)) return [];
  const out: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const tc = raw[i] as {
      id?: string;
      function?: { name?: string; arguments?: string };
    };
    out.push({
      id: tc.id ?? `call_${i}`,
      type: 'function',
      function: {
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? '',
      },
    });
  }
  return out;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}
