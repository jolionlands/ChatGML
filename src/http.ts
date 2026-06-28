// src/http.ts — shared HTTP helpers used by the chat client (llm.ts), the embeddings client
// (embeddings.ts), and the hippo memory client (hippo.ts).
//
// Centralizing these prevents drift: every endpoint that talks to an OpenAI-compatible server must
// (1) refuse to log a secret, (2) truncate error bodies, (3) use a sane fetch fallback.
import type { FetchLike } from './llm.js';

/** Maximum size of an error body that escapes into an exception message (truncated with `…`). */
export const ERROR_BODY_MAX = 2048;

/** Truncate + key-scrub an arbitrary error/response body. Removes Bearer tokens and `sk-…` keys so
 * a leaked endpoint response can never carry a secret into a thrown error. */
export function scrubBody(text: string): string {
  const scrubbed = text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-***');
  return scrubbed.length > ERROR_BODY_MAX ? `${scrubbed.slice(0, ERROR_BODY_MAX)}…` : scrubbed;
}

/**
 * Resolve the fetch implementation: prefer an injected one (tests), else the global fetch
 * (Node >= 24 has it natively; we don't fall back to `node-fetch`/`undici`).
 * Throws an error with a clear message when neither is available.
 */
export function resolveFetch(deps?: { fetch?: FetchLike }): FetchLike {
  const f = deps?.fetch ?? (globalThis.fetch as FetchLike | undefined);
  if (!f) throw new Error('no fetch implementation available');
  return f;
}

/** Trim trailing slashes from a baseURL. Used by every endpoint builder so `/v1//foo` doesn't slip in. */
export function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}
