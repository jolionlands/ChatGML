// plugin/fuzzy.js — pure, dependency-free fuzzy substring matching for the @file autocomplete
// dropdown. Used by plugin/panel.js to filter the project file list as the user types after
// `@file `. Also exposes a tiny case-insensitive prefix/substring scorer so the panel can sort
// the top-N matches by quality (prefix > substring > char-fuzzy > none).
//
// We avoid any npm dep so the plugin stays hermetic — fuzzy matching here is just:
//   1. exact substring match (case-insensitive) is best
//   2. prefix match is best of all
//   3. char-by-char "every typed char appears in order" is acceptable
//   4. no match returns null
//
// This is intentionally simple: a 5000-file project, top-8 shown, debounced 80ms.
(function (root) {
  'use strict';

  /**
   * Score a candidate string against a query (lower is better; null = no match).
   * @param {string} candidate — the file path or name to score
   * @param {string} query — the user-typed text (already lowercased by caller)
   * @returns {number|null} score, or null if candidate doesn't match
   */
  function score(candidate, query) {
    if (!query) return 1; // empty query matches everything with the best neutral score
    if (!candidate) return null;
    const c = candidate.toLowerCase();
    const q = String(query).toLowerCase();
    // 1. Exact substring match (best)
    const subIdx = c.indexOf(q);
    if (subIdx !== -1) {
      // Earlier occurrence = lower score; bonus for being a word-boundary match
      return subIdx + (subIdx === 0 || /[\/\\.]/.test(c[subIdx - 1]) ? 0 : 50);
    }
    // 2. Char-by-char "every typed char appears in order"
    let qi = 0;
    for (let i = 0; i < c.length && qi < q.length; i++) {
      if (c[i] === q[qi]) qi++;
    }
    if (qi === q.length) {
      // Penalize by total length to break ties (shorter = better)
      return 1000 + c.length;
    }
    return null;
  }

  /**
   * Filter + sort a list of strings by best match to the query, returning up to `limit` results.
   * @param {string[]} candidates
   * @param {string} query
   * @param {number} [limit=8]
   * @returns {string[]}
   */
  function filter(candidates, query, limit) {
    limit = limit || 8;
    const q = (query || '').toLowerCase();
    if (!q) return candidates.slice(0, limit);
    const scored = [];
    for (let i = 0; i < candidates.length; i++) {
      const s = score(candidates[i], q);
      if (s != null) scored.push([s, candidates[i]]);
    }
    scored.sort(function (a, b) {
      return a[0] - b[0];
    });
    const out = [];
    for (let i = 0; i < scored.length && i < limit; i++) out.push(scored[i][1]);
    return out;
  }

  const api = { score: score, filter: filter };
  root.ChatGmlFuzzy = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
