// test/tools/util.test.ts — direct unit tests for the shared edit-engine helpers in src/tools/util.ts
// (countLines + assessLineRisk). The edit and search_replace tools use these via composition, but
// having a direct spec makes the boundary cases easy to read in one place and gives coverage a
// concrete target.
import { describe, it, expect } from 'vitest';
import {
  countLines,
  assessLineRisk,
  DESTRUCTIVE_NET_DELETE_LINES,
  DESTRUCTIVE_DELETE_FRACTION,
  WHOLE_FILE_REPLACE_MIN_LINES,
} from '../../src/tools/util.js';

describe('countLines', () => {
  it('returns 0 for empty text', () => {
    expect(countLines('')).toBe(0);
  });

  it('does not count a trailing newline as an extra empty line', () => {
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb\nc\n')).toBe(3);
  });

  it('counts a single-line text without newline as 1', () => {
    expect(countLines('hello')).toBe(1);
  });
});

describe('assessLineRisk', () => {
  it('a small additive in-place edit is NOT high-risk', () => {
    const r = assessLineRisk({ added: 1, removed: 0, originalLineCount: 10 });
    expect(r.highRisk).toBe(false);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(0);
  });

  it('creating a new file (originalLineCount=0) is NOT high-risk by deletion', () => {
    const r = assessLineRisk({ added: 100, removed: 0, originalLineCount: 0 });
    expect(r.highRisk).toBe(false);
  });

  it('a whole-file wipe (removed===lines AND added===0) IS high-risk', () => {
    const r = assessLineRisk({ added: 0, removed: 5, originalLineCount: 5 });
    expect(r.highRisk).toBe(true);
    expect(r.reason).toMatch(/whole-file/i);
  });

  it(`a whole-file rewrite (added===${WHOLE_FILE_REPLACE_MIN_LINES}) IS high-risk`, () => {
    const r = assessLineRisk({
      added: WHOLE_FILE_REPLACE_MIN_LINES,
      removed: WHOLE_FILE_REPLACE_MIN_LINES,
      originalLineCount: WHOLE_FILE_REPLACE_MIN_LINES,
    });
    expect(r.highRisk).toBe(true);
    expect(r.reason).toMatch(/whole-file/i);
  });

  it(`net deletion AT ${DESTRUCTIVE_NET_DELETE_LINES} is NOT high-risk (strict >)`, () => {
    const r = assessLineRisk({
      added: 0,
      removed: DESTRUCTIVE_NET_DELETE_LINES,
      originalLineCount: 1000,
    });
    expect(r.highRisk).toBe(false);
  });

  it(`net deletion of ${DESTRUCTIVE_NET_DELETE_LINES + 1} IS high-risk`, () => {
    const r = assessLineRisk({
      added: 0,
      removed: DESTRUCTIVE_NET_DELETE_LINES + 1,
      originalLineCount: 1000,
    });
    expect(r.highRisk).toBe(true);
    expect(r.reason).toMatch(/mass deletion/i);
  });

  it(`proportional deletion AT exactly ${DESTRUCTIVE_DELETE_FRACTION * 100}% is NOT high-risk (strict >)`, () => {
    // 10-line file, remove 5 net -> 50% = floor, NOT high-risk.
    const r = assessLineRisk({ added: 0, removed: 5, originalLineCount: 10 });
    expect(r.highRisk).toBe(false);
  });

  it(`proportional deletion of 52% IS high-risk`, () => {
    // 50-line file, remove 26 net -> 52% > 50%, and net=26 is BELOW the mass-deletion floor of 50
    // so the proportional rule is the one that fires (not the mass-deletion rule).
    const r = assessLineRisk({ added: 0, removed: 26, originalLineCount: 50 });
    expect(r.highRisk).toBe(true);
    expect(r.reason).toMatch(/% of the file/);
  });
});
