// test/http.test.ts — direct unit tests for the shared HTTP helpers in src/http.ts
// (scrubBody, resolveFetch, trimTrailingSlash). Used by llm.ts, embeddings.ts, and hippo.ts so
// having a direct spec catches regressions in one place.
import { describe, it, expect } from 'vitest';
import { scrubBody, trimTrailingSlash, ERROR_BODY_MAX, resolveFetch } from '../src/http.js';

describe('scrubBody', () => {
  it('masks Bearer tokens (any token chars)', () => {
    expect(scrubBody('Authorization: Bearer abcDEF.123_-xxx')).toContain('Bearer ***');
    expect(scrubBody('Authorization: Bearer abcDEF.123_-xxx')).not.toContain('abcDEF.123_-xxx');
  });

  it('masks sk-... API keys', () => {
    expect(scrubBody('error: sk-proj-AbCdEf1234567890XYZ.abcdef')).toContain('sk-***');
    expect(scrubBody('error: sk-proj-AbCdEf1234567890XYZ.abcdef')).not.toContain(
      'AbCdEf1234567890XYZ',
    );
  });

  it('leaves a body that contains neither untouched', () => {
    const body = 'plain text error message';
    expect(scrubBody(body)).toBe(body);
  });

  it('truncates bodies longer than ERROR_BODY_MAX with an ellipsis', () => {
    const big = 'x'.repeat(ERROR_BODY_MAX * 2);
    const out = scrubBody(big);
    expect(out.length).toBeLessThanOrEqual(ERROR_BODY_MAX + 1); // +1 for the ellipsis char
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('trimTrailingSlash', () => {
  it('strips one trailing slash', () => {
    expect(trimTrailingSlash('http://x/')).toBe('http://x');
  });

  it('strips multiple trailing slashes', () => {
    expect(trimTrailingSlash('http://x///')).toBe('http://x');
  });

  it('leaves a string with no trailing slash unchanged', () => {
    expect(trimTrailingSlash('http://x')).toBe('http://x');
  });

  it('leaves an empty string unchanged', () => {
    expect(trimTrailingSlash('')).toBe('');
  });
});

describe('resolveFetch', () => {
  it('returns the injected fetch when supplied', async () => {
    const calls: Array<unknown> = [];
    const fake = ((input: unknown) => {
      calls.push(input);
      return Promise.resolve(new Response('{}'));
    }) as unknown as typeof fetch;
    const f = (await import('../src/http.js')).resolveFetch({ fetch: fake });
    await f('http://example/');
    expect(calls).toEqual(['http://example/']);
  });

  it('throws a clear error when no fetch is available (global stripped)', () => {
    const saved = (globalThis as { fetch?: unknown }).fetch;
    try {
      delete (globalThis as { fetch?: unknown }).fetch;
      expect(() => resolveFetch()).toThrow(/no fetch implementation available/);
    } finally {
      if (saved !== undefined) (globalThis as { fetch?: unknown }).fetch = saved;
    }
  });
});
