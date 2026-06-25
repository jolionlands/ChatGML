// src/cli/theme.ts — terminal color/styling helpers (zero deps).
//
// `supportsColor` follows the de-facto rules: NO_COLOR disables, FORCE_COLOR forces, otherwise on
// iff the stream is a TTY. `styles(enabled)` returns a styler set that is the identity function when
// color is off (so transcript tests assert exact, SGR-free output). `diffLine` classifies a unified
// diff line for coloring.
export interface ColorEnv {
  NO_COLOR?: string | undefined;
  FORCE_COLOR?: string | undefined;
}

export function supportsColor(opts: {
  isTTY?: boolean | undefined;
  env?: ColorEnv;
}): boolean {
  const env = opts.env ?? {};
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') {
    return true;
  }
  return opts.isTTY === true;
}

const SGR = (code: number, s: string): string => `[${code}m${s}[0m`;

export interface Styles {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  blue(s: string): string;
  cyan(s: string): string;
  gray(s: string): string;
}

const IDENTITY: Styles = {
  bold: (s) => s,
  dim: (s) => s,
  red: (s) => s,
  green: (s) => s,
  yellow: (s) => s,
  blue: (s) => s,
  cyan: (s) => s,
  gray: (s) => s,
};

export function styles(enabled: boolean): Styles {
  if (!enabled) return IDENTITY;
  return {
    bold: (s) => SGR(1, s),
    dim: (s) => SGR(2, s),
    red: (s) => SGR(31, s),
    green: (s) => SGR(32, s),
    yellow: (s) => SGR(33, s),
    blue: (s) => SGR(34, s),
    cyan: (s) => SGR(36, s),
    gray: (s) => SGR(90, s),
  };
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

/** Classify a single unified-diff line for coloring. */
export function diffLine(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

/** Color a whole unified diff according to diffLine classification. */
export function colorizeDiff(diff: string, st: Styles): string {
  return diff
    .split('\n')
    .map((l) => {
      switch (diffLine(l)) {
        case 'add':
          return st.green(l);
        case 'del':
          return st.red(l);
        case 'hunk':
          return st.cyan(l);
        case 'meta':
          return st.dim(l);
        default:
          return l;
      }
    })
    .join('\n');
}

/** A tiny ASCII spinner (no timers — caller advances it). */
export class Spinner {
  private static readonly FRAMES = ['|', '/', '-', '\\'];
  private i = 0;
  frame(): string {
    const f = Spinner.FRAMES[this.i % Spinner.FRAMES.length]!;
    this.i++;
    return f;
  }
  reset(): void {
    this.i = 0;
  }
}
