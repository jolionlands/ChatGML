// src/protocol.ts — NDJSON framing for the agent API.
//
// One JSON object per line, '\n'-terminated, UTF-8. Outbound events are the single `AgentEvent`
// union from src/types.ts; inbound commands are validated by `InEventSchema` (a zod
// discriminated union). The codec is round-trippable: encodeEvent(e) then NdjsonDecoder.push(...)
// reproduces e. Malformed inbound lines surface as a `ProtocolError` (the caller emits an `error`
// event and keeps the loop alive — a single bad line never crashes the session).
import { z } from 'zod';
import type { AgentEvent } from './types.js';

export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Inbound command schema. The type is INFERRED from the schema (no annotation) so the schema
// and the type can never drift.
// ---------------------------------------------------------------------------
export const InEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), text: z.string() }),
  z.object({ type: z.literal('approve'), id: z.string() }),
  z.object({ type: z.literal('reject'), id: z.string() }),
  z.object({ type: z.literal('reindex') }),
  z.object({ type: z.literal('cancel') }),
]);
export type InEvent = z.infer<typeof InEventSchema>;
export type ClientCommand = InEvent;
export const ClientCommandSchema = InEventSchema;

/**
 * A line that could not be parsed as JSON or did not validate as an InEvent. When thrown from
 * `NdjsonDecoder.push`, `parsed` carries the values for the COMPLETE valid lines that preceded the
 * bad one in the same call (so a caller can process them and keep going). The decoder's buffer is
 * left positioned PAST the bad line, so a follow-up `push('')` continues with the next line.
 */
export class ProtocolError extends Error {
  readonly line: string;
  readonly parsed: unknown[];
  constructor(message: string, line: string, parsed: unknown[] = []) {
    super(message);
    this.name = 'ProtocolError';
    this.line = line;
    this.parsed = parsed;
  }
}

/** Serialize an outbound event to a single '\n'-terminated NDJSON line. */
export function encodeEvent(e: AgentEvent): string {
  return `${JSON.stringify(e)}\n`;
}

/** Parse + validate a single inbound line into an InEvent, or throw ProtocolError. */
export function parseInEvent(line: string): InEvent {
  const trimmed = line.trim();
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new ProtocolError('malformed JSON in inbound line', line);
  }
  const result = InEventSchema.safeParse(json);
  if (!result.success) {
    const firstPath = result.error.issues[0]?.path.join('.') ?? '(root)';
    throw new ProtocolError(`invalid inbound command (bad field '${firstPath}')`, line);
  }
  return result.data;
}

/**
 * Stateful NDJSON line decoder. `push(chunk)` returns the complete lines parsed so far (as raw
 * JSON values); a trailing partial line is buffered across calls. Blank lines are skipped. A line
 * that is not valid JSON throws a `ProtocolError` (the buffer past it is preserved so the caller
 * can keep going).
 */
export class NdjsonDecoder {
  private buffer = '';

  /**
   * Feed a chunk; returns parsed JSON values for every complete line found. On a malformed line it
   * throws a ProtocolError whose `.parsed` holds the good values that preceded it; the buffer is
   * left positioned past the bad line so a follow-up push('') resumes with the next line.
   */
  push(chunk: string | Buffer): unknown[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim() === '') continue; // skip blank lines
      let value: unknown;
      try {
        value = JSON.parse(line.trim());
      } catch {
        throw new ProtocolError('malformed JSON in inbound line', line, out);
      }
      out.push(value);
    }
    return out;
  }

  /** Flush any trailing buffered partial line (no terminating '\n'). */
  flush(): unknown[] {
    const rest = this.buffer;
    this.buffer = '';
    const line = rest.endsWith('\r') ? rest.slice(0, -1) : rest;
    if (line.trim() === '') return [];
    return [parseJsonLine(line)];
  }
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line.trim());
  } catch {
    throw new ProtocolError('malformed JSON in inbound line', line);
  }
}

/** Write an outbound event to a writable stream as a framed NDJSON line. */
export function writeEvent(out: NodeJS.WritableStream, e: AgentEvent): void {
  out.write(encodeEvent(e));
}

const AGENT_EVENT_TYPES = new Set([
  'status',
  'token',
  'tool_call',
  'tool_result',
  'edit_proposal',
  'approval_request',
  'answer',
  'error',
]);

/** Narrow an unknown to an AgentEvent (structural, by `type` discriminant). */
export function isAgentEvent(x: unknown): x is AgentEvent {
  if (typeof x !== 'object' || x === null) return false;
  const t = (x as { type?: unknown }).type;
  return typeof t === 'string' && AGENT_EVENT_TYPES.has(t);
}
