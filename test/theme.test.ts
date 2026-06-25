import { describe, it, expect } from 'vitest';
import { supportsColor, styles, diffLine, colorizeDiff, Spinner } from '../src/cli/theme.js';

describe('supportsColor', () => {
  it('true for a TTY with no overrides', () => {
    expect(supportsColor({ isTTY: true, env: {} })).toBe(true);
  });
  it('false for a non-TTY', () => {
    expect(supportsColor({ isTTY: false, env: {} })).toBe(false);
  });
  it('NO_COLOR disables even on a TTY', () => {
    expect(supportsColor({ isTTY: true, env: { NO_COLOR: '1' } })).toBe(false);
  });
  it('FORCE_COLOR overrides a non-TTY', () => {
    expect(supportsColor({ isTTY: false, env: { FORCE_COLOR: '1' } })).toBe(true);
  });
  it('FORCE_COLOR=0 does not force', () => {
    expect(supportsColor({ isTTY: false, env: { FORCE_COLOR: '0' } })).toBe(false);
  });
});

describe('styles', () => {
  it('disabled styler is the identity (no SGR codes)', () => {
    const st = styles(false);
    expect(st.red('x')).toBe('x');
    expect(st.bold('y')).toBe('y');
  });
  it('enabled styler wraps with SGR codes', () => {
    const st = styles(true);
    expect(st.red('x')).toContain('[31m');
    expect(st.red('x')).toContain('[0m');
  });
});

describe('diffLine', () => {
  it('classifies each line kind', () => {
    expect(diffLine('+added')).toBe('add');
    expect(diffLine('-removed')).toBe('del');
    expect(diffLine('@@ -1 +1 @@')).toBe('hunk');
    expect(diffLine('--- a')).toBe('meta');
    expect(diffLine('+++ b')).toBe('meta');
    expect(diffLine(' context')).toBe('context');
  });

  it('colorizeDiff with disabled styles is identity', () => {
    const d = '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n ctx';
    expect(colorizeDiff(d, styles(false))).toBe(d);
  });

  it('colorizeDiff with enabled styles adds SGR', () => {
    const out = colorizeDiff('+y', styles(true));
    expect(out).toContain('[32m');
  });
});

describe('styles full surface', () => {
  it('every enabled styler emits an SGR sequence and every disabled one is identity', () => {
    const on = styles(true);
    const off = styles(false);
    const keys = ['bold', 'dim', 'red', 'green', 'yellow', 'blue', 'cyan', 'gray'] as const;
    for (const k of keys) {
      const styled = on[k]('z');
      expect(styled).not.toBe('z'); // wrapped
      expect(styled).toContain('z');
      expect(styled.endsWith('[0m')).toBe(true); // reset suffix
      expect(off[k]('z')).toBe('z');
    }
  });
});

describe('Spinner', () => {
  it('cycles frames', () => {
    const s = new Spinner();
    const frames = [s.frame(), s.frame(), s.frame(), s.frame(), s.frame()];
    expect(frames.slice(0, 4)).toEqual(['|', '/', '-', '\\']);
    expect(frames[4]).toBe('|'); // wraps
  });

  it('reset() restarts the cycle', () => {
    const s = new Spinner();
    s.frame();
    s.frame();
    s.reset();
    expect(s.frame()).toBe('|');
  });
});
