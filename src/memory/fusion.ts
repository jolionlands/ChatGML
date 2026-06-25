// src/memory/fusion.ts — cosine similarity and score fusion of two ranked lists.
//
// Vectors are assumed L2-normalized (Embeddings normalize on output), so cosine reduces to a dot
// product, but `cosineSim` divides by norms anyway to stay correct for un-normalized inputs. `fuse`
// combines a vector list and a keyword list into one ranked list via min-max normalization (default)
// or reciprocal-rank fusion (rrf), with guards so a single element / all-equal scores never produce NaN.

/** Cosine similarity of two equal-length vectors. Throws on a length mismatch. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSim length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface Scored {
  id: string;
  score: number;
}

export type FusionMethod = 'minmax' | 'rrf';

export interface FuseOptions {
  method?: FusionMethod;
  /** Weight of the vector list relative to the keyword list (minmax only). Default 0.5. */
  vectorWeight?: number;
  /** RRF damping constant. Default 60. */
  rrfK?: number;
  /** Max results to return. */
  k?: number;
}

/** Min-max normalize a list of scores to [0,1]; all-equal scores map to 1 (no NaN). */
function minmaxNormalize(items: Scored[]): Map<string, number> {
  const out = new Map<string, number>();
  if (items.length === 0) return out;
  let lo = Infinity;
  let hi = -Infinity;
  for (const it of items) {
    if (it.score < lo) lo = it.score;
    if (it.score > hi) hi = it.score;
  }
  const span = hi - lo;
  for (const it of items) {
    out.set(it.id, span > 0 ? (it.score - lo) / span : 1);
  }
  return out;
}

/**
 * Fuse a vector-ranked list and a keyword-ranked list into one ranked list. Items appearing in both
 * lists rank above items strong in only one. Deterministic id tie-break. Respects `k`.
 */
export function fuse(vector: Scored[], keyword: Scored[], opts: FuseOptions = {}): Scored[] {
  const method = opts.method ?? 'minmax';
  const k = opts.k;

  const combined = new Map<string, number>();

  if (method === 'rrf') {
    const rrfK = opts.rrfK ?? 60;
    const addRanks = (list: Scored[]) => {
      const sorted = [...list].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
      sorted.forEach((it, rank) => {
        combined.set(it.id, (combined.get(it.id) ?? 0) + 1 / (rrfK + rank + 1));
      });
    };
    addRanks(vector);
    addRanks(keyword);
  } else {
    const vw = opts.vectorWeight ?? 0.5;
    const kw = 1 - vw;
    const vn = minmaxNormalize(vector);
    const kn = minmaxNormalize(keyword);
    for (const [id, s] of vn) combined.set(id, (combined.get(id) ?? 0) + vw * s);
    for (const [id, s] of kn) combined.set(id, (combined.get(id) ?? 0) + kw * s);
  }

  const ranked: Scored[] = [...combined.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return k !== undefined && k >= 0 ? ranked.slice(0, k) : ranked;
}
