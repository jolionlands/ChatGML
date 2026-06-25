import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  f32ToBase64,
  base64ToF32,
  writeJsonAtomic,
  readJson,
  type ReadJsonReason,
} from '../../src/memory/persist.js';
import { makeTmpRepo } from '../helpers/fakes.js';

describe('f32 <-> base64', () => {
  it('round-trips ordinary values bit-exactly', () => {
    const v = new Float32Array([0, 1, -1, 0.5, 123.456, -0.0001]);
    const back = base64ToF32(f32ToBase64(v));
    expect(Array.from(back)).toEqual(Array.from(v));
  });

  it('preserves NaN, Infinity, -Infinity, and -0', () => {
    const v = new Float32Array([NaN, Infinity, -Infinity, -0]);
    const back = base64ToF32(f32ToBase64(v));
    expect(Number.isNaN(back[0]!)).toBe(true);
    expect(back[1]).toBe(Infinity);
    expect(back[2]).toBe(-Infinity);
    expect(Object.is(back[3], -0)).toBe(true);
  });

  it('handles an empty vector', () => {
    expect(base64ToF32(f32ToBase64(new Float32Array(0))).length).toBe(0);
  });
});

describe('writeJsonAtomic', () => {
  it('writes the value and leaves no .tmp behind', async () => {
    const repo = makeTmpRepo({});
    try {
      const target = path.join(repo.root, 'sub', 'store.json');
      await writeJsonAtomic(target, { a: 1 });
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ a: 1 });
      const siblings = fs.readdirSync(path.dirname(target));
      expect(siblings.some((f) => f.includes('.tmp'))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('overwrites an existing file', async () => {
    const repo = makeTmpRepo({});
    try {
      const target = path.join(repo.root, 'store.json');
      await writeJsonAtomic(target, { v: 1 });
      await writeJsonAtomic(target, { v: 2 });
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ v: 2 });
    } finally {
      repo.cleanup();
    }
  });
});

describe('readJson', () => {
  it('returns null and warns "missing" silently for an absent file', () => {
    const repo = makeTmpRepo({});
    try {
      const reasons: ReadJsonReason[] = [];
      const out = readJson(path.join(repo.root, 'nope.json'), {
        warn: (r) => reasons.push(r),
      });
      expect(out).toBeNull();
      expect(reasons).toEqual(['missing']);
    } finally {
      repo.cleanup();
    }
  });

  it('returns null and warns "corrupt" on invalid JSON', () => {
    const repo = makeTmpRepo({ 'bad.json': '{ not json' });
    try {
      const reasons: ReadJsonReason[] = [];
      const out = readJson(path.join(repo.root, 'bad.json'), { warn: (r) => reasons.push(r) });
      expect(out).toBeNull();
      expect(reasons).toEqual(['corrupt']);
    } finally {
      repo.cleanup();
    }
  });

  it('returns null and warns "schema" when the validator rejects', () => {
    const repo = makeTmpRepo({ 'x.json': '{"wrong":true}' });
    try {
      const reasons: ReadJsonReason[] = [];
      const out = readJson<{ ok: boolean }>(path.join(repo.root, 'x.json'), {
        validate: (v): v is { ok: boolean } =>
          typeof v === 'object' && v !== null && 'ok' in v,
        warn: (r) => reasons.push(r),
      });
      expect(out).toBeNull();
      expect(reasons).toEqual(['schema']);
    } finally {
      repo.cleanup();
    }
  });

  it('returns the parsed value for a valid file', () => {
    const repo = makeTmpRepo({ 'ok.json': '{"a":1}' });
    try {
      expect(readJson(path.join(repo.root, 'ok.json'))).toEqual({ a: 1 });
    } finally {
      repo.cleanup();
    }
  });
});
