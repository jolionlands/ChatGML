// src/memory/bm25.ts — a simple BM25 keyword index, code-aware tokenization.
//
// Tokenization splits on punctuation/whitespace and further splits camelCase and snake_case so a
// query for `playerHealth` matches `player_health`/`PlayerHealth`. add/remove are idempotent on a
// document id. Scoring uses the standard BM25 formula (k1=1.2, b=0.75) with a deterministic id
// tie-break. The index serializes to/from plain JSON (no pickle).

const K1 = 1.2;
const B = 0.75;

/** Split text into lowercased code-aware tokens (camelCase + snake_case aware). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  // First split on anything that is not a letter/number/underscore.
  for (const raw of text.split(/[^A-Za-z0-9_]+/)) {
    if (raw === '') continue;
    // Split snake_case.
    for (const seg of raw.split('_')) {
      if (seg === '') continue;
      // Split camelCase / digit boundaries.
      const parts = seg
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Za-z])([0-9])/g, '$1 $2')
        .replace(/([0-9])([A-Za-z])/g, '$1 $2')
        .split(/\s+/);
      for (const p of parts) {
        if (p !== '') out.push(p.toLowerCase());
      }
    }
  }
  return out;
}

interface DocEntry {
  id: string;
  length: number;
  tf: Map<string, number>;
}

export interface Bm25Json {
  docs: Array<{ id: string; length: number; tf: Record<string, number> }>;
}

export class Bm25Index {
  private docs = new Map<string, DocEntry>();
  private df = new Map<string, number>(); // document frequency per term
  private totalLength = 0;

  get size(): number {
    return this.docs.size;
  }

  /** Add or replace a document. Idempotent: re-adding the same id replaces it (no double tf). */
  add(id: string, text: string): void {
    this.remove(id);
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const entry: DocEntry = { id, length: tokens.length, tf };
    this.docs.set(id, entry);
    this.totalLength += entry.length;
    for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
  }

  /** Remove a document by id (no-op if absent). */
  remove(id: string): void {
    const existing = this.docs.get(id);
    if (!existing) return;
    this.totalLength -= existing.length;
    for (const term of existing.tf.keys()) {
      const next = (this.df.get(term) ?? 1) - 1;
      if (next <= 0) this.df.delete(term);
      else this.df.set(term, next);
    }
    this.docs.delete(id);
  }

  /** Score documents for a query; returns `{id,score}` sorted desc with a deterministic id tie-break. */
  search(query: string, k?: number): Array<{ id: string; score: number }> {
    const n = this.docs.size;
    if (n === 0) return [];
    const avgdl = this.totalLength / n;
    const qTerms = [...new Set(tokenize(query))];

    const results: Array<{ id: string; score: number }> = [];
    for (const doc of this.docs.values()) {
      let score = 0;
      for (const term of qTerms) {
        const f = doc.tf.get(term);
        if (!f) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const denom = f + K1 * (1 - B + (B * doc.length) / (avgdl || 1));
        score += idf * ((f * (K1 + 1)) / (denom || 1));
      }
      if (score > 0) results.push({ id: doc.id, score });
    }
    results.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return k !== undefined && k >= 0 ? results.slice(0, k) : results;
  }

  toJSON(): Bm25Json {
    return {
      docs: [...this.docs.values()].map((d) => ({
        id: d.id,
        length: d.length,
        tf: Object.fromEntries(d.tf),
      })),
    };
  }

  static fromJSON(json: Bm25Json): Bm25Index {
    const idx = new Bm25Index();
    for (const d of json.docs ?? []) {
      const tf = new Map<string, number>(Object.entries(d.tf));
      const entry: DocEntry = { id: d.id, length: d.length, tf };
      idx.docs.set(d.id, entry);
      idx.totalLength += d.length;
      for (const term of tf.keys()) idx.df.set(term, (idx.df.get(term) ?? 0) + 1);
    }
    return idx;
  }
}
