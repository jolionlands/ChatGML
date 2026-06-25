// test/helpers/fakes.ts — offline fakes for tests (no network, deterministic).
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Embeddings } from '../../src/index/embeddings.js';

/**
 * Deterministic, L2-normalized vector seeded from a string via sha256. Same input -> same vector,
 * across processes. Default dim 64. Never touches the network.
 */
export function hashVector(text: string, dim = 64): Float32Array {
  const vec = new Float32Array(dim);
  let counter = 0;
  let filled = 0;
  while (filled < dim) {
    const h = createHash('sha256').update(`${text}#${counter++}`).digest();
    for (let i = 0; i < h.length && filled < dim; i += 4) {
      // Map 4 bytes to a float in [-1, 1).
      const u = h.readUInt32BE(i);
      vec[filled++] = u / 0x80000000 - 1;
    }
  }
  // L2-normalize.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] = vec[i]! / norm;
  }
  return vec;
}

/** Offline Embeddings: sha256-seeded, L2-normalized vectors. Never fetches. */
export class FakeEmbeddings implements Embeddings {
  readonly dim: number;
  readonly id: string;

  constructor(opts?: { dim?: number; id?: string }) {
    this.dim = opts?.dim ?? 64;
    this.id = opts?.id ?? `fake:${this.dim}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => hashVector(t, this.dim));
  }
}

/** A scripted assistant turn (text and/or tool calls) for a FakeChatModel replay. */
export interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: string;
}

/** Replays scripted assistant turns; used to drive the agent loop without a real model. */
export class FakeChatModel {
  private turns: ScriptedTurn[];
  private cursor = 0;

  constructor(turns: ScriptedTurn[]) {
    this.turns = turns;
  }

  next(): ScriptedTurn {
    const turn = this.turns[this.cursor];
    if (!turn) throw new Error('FakeChatModel ran out of scripted turns');
    this.cursor++;
    return turn;
  }

  get remaining(): number {
    return this.turns.length - this.cursor;
  }
}

/** Create a temporary repo directory with the given files (relative paths -> contents). */
export function makeTmpRepo(
  files: Record<string, string>,
  opts?: { gitignore?: string },
): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'chatgml-test-'));
  const all: Record<string, string> = { ...files };
  if (opts?.gitignore !== undefined) all['.gitignore'] = opts.gitignore;
  for (const [rel, content] of Object.entries(all)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}
