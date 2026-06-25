// src/serve.ts — NDJSON-over-stdio transport for the agent (the editor integration surface).
//
// `runServe(agent, opts)` reads NDJSON client commands from the input stream (via NdjsonDecoder),
// validates each line against InEventSchema, and routes:
//   user / reindex -> agent.run(command, signal)  (one async-iterable per command; events streamed)
//   approve/reject  -> agent.resolveApproval(id, approved)  (out-of-band; settles the in-flight gate)
//   cancel          -> agent.cancel()  (aborts the in-flight run's signal)
//
// stdout carries PROTOCOL JSON ONLY; all diagnostics go to stderr. A malformed inbound line emits a
// single `error` event and the loop continues (one bad line never crashes the session). On start the
// server writes exactly one `status:ready` handshake. EOF flushes the decoder and ends the loop.
import { Readable } from 'node:stream';
import {
  NdjsonDecoder,
  InEventSchema,
  encodeEvent,
  ProtocolError,
  PROTOCOL_VERSION,
  type InEvent,
} from './protocol.js';
import type { AgentEvent } from './types.js';
import type { AgentLike } from './agent.js';

export interface Transport {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Optional diagnostics sink (defaults to process.stderr); NEVER the protocol output stream. */
  diagnostics?: NodeJS.WritableStream;
}

export function createStdioTransport(): Transport {
  return { input: process.stdin, output: process.stdout, diagnostics: process.stderr };
}

export interface ServeOptions {
  transport: Transport;
}

/** Write a single outbound event as a framed NDJSON line to the protocol output stream. */
function writeOut(out: NodeJS.WritableStream, e: AgentEvent): void {
  out.write(encodeEvent(e));
}

/**
 * Run the NDJSON server loop over a Transport until the input stream ends. Returns when EOF is
 * reached (and the active run, if any, has drained).
 */
export async function runServe(agent: AgentLike, opts: ServeOptions): Promise<void> {
  const { input, output } = opts.transport;
  const diag = opts.transport.diagnostics ?? process.stderr;
  const decoder = new NdjsonDecoder();

  // Handshake first.
  writeOut(output, { type: 'status', phase: 'ready', protocolVersion: PROTOCOL_VERSION });

  // Serialize runs: a `user`/`reindex` command starts a run; subsequent run commands queue behind it.
  let activeRun: Promise<void> = Promise.resolve();
  let activeController: AbortController | null = null;

  const handleCommand = (cmd: InEvent): void => {
    switch (cmd.type) {
      case 'user':
      case 'reindex': {
        const controller = new AbortController();
        activeController = controller;
        const prior = activeRun;
        activeRun = (async () => {
          await prior.catch(() => {});
          try {
            for await (const e of agent.run(cmd, controller.signal)) {
              writeOut(output, e);
            }
          } catch (err) {
            writeOut(output, {
              type: 'error',
              message: err instanceof Error ? err.message : 'run failed',
            });
          } finally {
            if (activeController === controller) activeController = null;
          }
        })();
        break;
      }
      case 'approve':
        agent.resolveApproval(cmd.id, true);
        break;
      case 'reject':
        agent.resolveApproval(cmd.id, false);
        break;
      case 'cancel':
        agent.cancel();
        activeController?.abort();
        break;
    }
  };

  const processLine = (raw: unknown): void => {
    const result = InEventSchema.safeParse(raw);
    if (!result.success) {
      const firstPath = result.error.issues[0]?.path.join('.') ?? '(root)';
      writeOut(output, {
        type: 'error',
        message: `invalid command (bad field '${firstPath}')`,
        code: 'protocol',
      });
      return;
    }
    handleCommand(result.data);
  };

  const feed = (chunk: Buffer | string): void => {
    // Feed the chunk once, then drain remaining buffered lines. A malformed line throws a
    // ProtocolError whose .parsed holds the good lines that preceded it; we process those, emit ONE
    // error, and keep draining with push('') so following valid lines are still handled.
    let input: string | Buffer = chunk;
    for (;;) {
      try {
        const values = decoder.push(input);
        for (const v of values) processLine(v);
        break; // returned normally => no more malformed lines buffered
      } catch (err) {
        if (err instanceof ProtocolError) {
          for (const v of err.parsed) processLine(v);
          writeOut(output, { type: 'error', message: 'malformed JSON line', code: 'protocol' });
          input = ''; // continue draining the buffer past the bad line
          continue;
        }
        throw err;
      }
    }
  };

  // Drive the input stream. We use async iteration so a string OR Buffer stream both work.
  const readable = input instanceof Readable ? input : Readable.from(input);
  try {
    for await (const chunk of readable) {
      feed(chunk as Buffer | string);
    }
    // EOF: flush any trailing line.
    try {
      for (const v of decoder.flush()) processLine(v);
    } catch (err) {
      if (err instanceof ProtocolError) {
        writeOut(output, { type: 'error', message: 'malformed trailing line', code: 'protocol' });
      } else throw err;
    }
  } catch (err) {
    diag.write(`serve: input stream error: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // A disconnect settles any pending approvals as rejected (no hung turn).
  agent.cancel();
  await activeRun.catch(() => {});
}
