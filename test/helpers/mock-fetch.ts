// test/helpers/mock-fetch.ts — fetch mocking + auth-leak assertions for tests.
import { expect, vi } from 'vitest';
import type { FetchLike } from '../../src/llm.js';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>;

export class FetchRecorder {
  readonly calls: RecordedCall[] = [];

  /**
   * Assert a sentinel secret never appears on ANY logged/printed/thrown surface:
   * console.{log,info,warn,error,debug}, process.stdout.write, process.stderr.write.
   * Use a distinctive sentinel like `sk-SENTINEL-DEADBEEF`.
   */
  static assertNoAuthLeak(sentinel: string, ...extraStrings: string[]): void {
    const surfaces: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const spy = console[method] as unknown as { mock?: { calls: unknown[][] } };
      if (spy?.mock) {
        for (const args of spy.mock.calls) surfaces.push(args.map(String).join(' '));
      }
    }
    const stdout = process.stdout.write as unknown as { mock?: { calls: unknown[][] } };
    if (stdout?.mock) for (const args of stdout.mock.calls) surfaces.push(String(args[0]));
    const stderr = process.stderr.write as unknown as { mock?: { calls: unknown[][] } };
    if (stderr?.mock) for (const args of stderr.mock.calls) surfaces.push(String(args[0]));
    surfaces.push(...extraStrings);
    for (const s of surfaces) {
      expect(s).not.toContain(sentinel);
    }
  }
}

async function readBody(init?: RequestInit): Promise<string | undefined> {
  if (!init || init.body == null) return undefined;
  if (typeof init.body === 'string') return init.body;
  return String(init.body);
}

function headersToObject(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k.toLowerCase()] = v));
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
  } else {
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

/**
 * Install a fetch mock (via vi.stubGlobal) that routes by URL substring and records calls.
 * Returns the recorder; the installed function is also returned for direct injection (deps.fetch).
 */
export function installFetchMock(
  routes: Array<{ match: string | RegExp; responder: Responder }>,
): { recorder: FetchRecorder; fetch: FetchLike } {
  const recorder = new FetchRecorder();
  const impl: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: RecordedCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: headersToObject(init),
      body: await readBody(init),
    };
    recorder.calls.push(call);
    for (const route of routes) {
      const hit =
        typeof route.match === 'string' ? url.includes(route.match) : route.match.test(url);
      if (hit) return route.responder(call);
    }
    throw new Error(`no fetch route matched: ${url}`);
  };
  vi.stubGlobal('fetch', impl as unknown as typeof fetch);
  return { recorder, fetch: impl };
}

/** Build a plain JSON Response. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Build an error Response with a text body (e.g. to exercise the scrubbed-body path). */
export function errorResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

/**
 * Build a streaming SSE Response from a list of event objects. Each event becomes a
 * `data: {json}\n\n` frame, then a terminating `data: [DONE]\n\n`. If `splitAt` is given, the full
 * byte stream is chopped into chunks of that size to force mid-JSON splits across enqueues, so the
 * SSE buffering path is genuinely exercised.
 */
export function sseResponse(events: unknown[], opts?: { splitAt?: number; done?: boolean }): Response {
  const done = opts?.done ?? true;
  const frames = events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
  if (done) frames.push('data: [DONE]\n\n');
  const full = frames.join('');
  const bytes = new TextEncoder().encode(full);
  const splitAt = opts?.splitAt && opts.splitAt > 0 ? opts.splitAt : bytes.length;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += splitAt) {
        controller.enqueue(bytes.slice(i, i + splitAt));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Convenience: a single OpenAI-style streaming text + finish event set. */
export function openAiTextStream(texts: string[], opts?: { splitAt?: number }): Response {
  const events: unknown[] = texts.map((t) => ({
    choices: [{ delta: { content: t }, finish_reason: null }],
  }));
  events.push({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  events.push({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
  return sseResponse(events, opts ? { splitAt: opts.splitAt } : undefined);
}
