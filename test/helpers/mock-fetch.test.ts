import { describe, it, expect, vi, afterEach } from 'vitest';
import { installFetchMock, jsonResponse, sseResponse, FetchRecorder } from './mock-fetch.js';

describe('mock-fetch helper', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('installFetchMock records a routed call', async () => {
    const { recorder } = installFetchMock([
      { match: '/chat/completions', responder: () => jsonResponse({ ok: true }) },
    ]);
    const res = await fetch('http://host/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-x' },
      body: '{"a":1}',
    });
    expect(res.status).toBe(200);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.method).toBe('POST');
    expect(recorder.calls[0]!.headers['authorization']).toBe('Bearer sk-x');
    expect(recorder.calls[0]!.body).toBe('{"a":1}');
  });

  it('sseResponse round-trips chunks split mid-JSON', async () => {
    const res = sseResponse([{ n: 1 }, { n: 2 }], { splitAt: 3 });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let acc = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
    }
    expect(acc).toContain('data: {"n":1}');
    expect(acc).toContain('data: {"n":2}');
    expect(acc).toContain('data: [DONE]');
  });

  it('assertNoAuthLeak passes when sentinel absent and fails when present', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    console.log('a clean line');
    expect(() => FetchRecorder.assertNoAuthLeak('sk-SENTINEL-DEADBEEF')).not.toThrow();
    console.log('leaked sk-SENTINEL-DEADBEEF here');
    expect(() => FetchRecorder.assertNoAuthLeak('sk-SENTINEL-DEADBEEF')).toThrow();
    spy.mockRestore();
  });
});
