import { describe, it, expect } from 'vitest';

describe('test harness', () => {
  it('runs a trivial test', () => {
    expect(1 + 1).toBe(2);
  });

  it('default fetch stub throws on an unmocked call', () => {
    expect(() => fetch('http://example.test')).toThrow(/unmocked fetch/);
  });
});
