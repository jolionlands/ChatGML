// src/tools/util.ts — small shared helpers for tool implementations.
//
// Both the unified-diff edit tool (edit.ts) and the SEARCH/REPLACE tool (search_replace.ts) need
// the same line-counting convention (a trailing newline does NOT introduce an extra empty line)
// and the same destructive-edit risk assessment. To avoid drift, those helpers AND the threshold
// constants + the EditRisk shape live here as the single source of truth.

/** Net-deletion line threshold: a diff that removes more than this many lines net is high-risk. */
export const DESTRUCTIVE_NET_DELETE_LINES = 50;
/** Net-deletion fraction threshold: removing more than this share of the original file is high-risk. */
export const DESTRUCTIVE_DELETE_FRACTION = 0.5;
/**
 * Whole-file-REPLACE threshold: a diff that removes (nearly) the entire file AND rewrites it with at
 * least this many added lines is treated as a whole-file rewrite (high blast radius) even though it
 * is not a net deletion. A tiny in-place replace (e.g. swapping the only line of a 1-line file) stays
 * BELOW this and is governed only by the net-deletion rules, so normal small edits still auto-apply.
 */
export const WHOLE_FILE_REPLACE_MIN_LINES = 20;

export interface EditRisk {
  /** True ⇒ force human approval even in auto mode. */
  highRisk: boolean;
  /** A short, human-readable reason (surfaced in logs/tests); empty when not high-risk. */
  reason: string;
  added: number;
  removed: number;
}

/**
 * Count the lines in a body of text the way a unified-diff hunk counts them. A trailing newline
 * does NOT introduce an extra (empty) trailing line, so `'a\nb\n'` is 2 lines, not 3. Used by the
 * edit engine to compute the original line count for the destructive-edit risk assessment.
 */
export function countLines(text: string): number {
  if (text === '') return 0;
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n').length;
}

/**
 * The shared destructive-edit risk core. Both `apply_patch` (unified diff) and `search_replace`
 * (SEARCH/REPLACE blocks) feed their own `added` / `removed` line counts in here so the
 * whole-file / mass-deletion rules live in one place. The thresholds (whole-file-rewrite floor,
 * mass-deletion floor, proportional-deletion floor) are re-exported from edit.ts as the single
 * tunable home.
 */
export interface RiskInput {
  /** Number of lines the edit adds (post-patch). */
  added: number;
  /** Number of lines the edit removes (pre-patch). */
  removed: number;
  /** Line count of the ORIGINAL file the diff is applied to (0 for new-file creates). */
  originalLineCount: number;
}

export function assessLineRisk(input: RiskInput): EditRisk {
  const { added, removed, originalLineCount } = input;
  const net = removed - added;

  if (originalLineCount > 0 && removed >= originalLineCount && added === 0) {
    return {
      highRisk: true,
      reason: 'whole-file deletion (removes the entire file)',
      added,
      removed,
    };
  }
  if (
    originalLineCount > 0 &&
    removed >= originalLineCount &&
    added >= WHOLE_FILE_REPLACE_MIN_LINES
  ) {
    return {
      highRisk: true,
      reason: 'whole-file rewrite (rewrites the entire file)',
      added,
      removed,
    };
  }
  if (net > DESTRUCTIVE_NET_DELETE_LINES) {
    return {
      highRisk: true,
      reason: `mass deletion (net -${net} lines > ${DESTRUCTIVE_NET_DELETE_LINES})`,
      added,
      removed,
    };
  }
  if (originalLineCount > 0 && net > 0 && net / originalLineCount > DESTRUCTIVE_DELETE_FRACTION) {
    const pct = Math.round((net / originalLineCount) * 100);
    return {
      highRisk: true,
      reason: `deletes ${pct}% of the file (> ${Math.round(DESTRUCTIVE_DELETE_FRACTION * 100)}%)`,
      added,
      removed,
    };
  }
  return { highRisk: false, reason: '', added, removed };
}
