// test/plugin/glue-smoke.test.ts — smoke tests for the plugin glue modules' NON-DOM surface.
//
// We cannot run GMEdit/Electron here, so panel.js / diff-view.js / config-bridge.js DOM behavior is
// manual. But each module must (a) load as a CommonJS module without throwing, and (b) expose its
// pure, DOM-free helpers. This catches require-time syntax errors and missing exports so the load
// order in config.json is provably loadable. diffLineClass is unit-tested (pure string -> class).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PLUGIN = path.join(HERE, '../../plugin');

describe('plugin glue modules load as CommonJS', () => {
  it('state.js exposes the pure API', () => {
    const m = require(path.join(PLUGIN, 'state.js'));
    for (const fn of [
      'NdjsonLineBuffer',
      'isReadyHandshake',
      'buildServeArgv',
      'resolveServeBinary',
      'reducePluginState',
      'matchApproval',
    ]) {
      expect(typeof m[fn]).toBe('function');
    }
  });

  it('child-process.js exposes the shared spawn helpers', () => {
    const m = require(path.join(PLUGIN, 'child-process.js'));
    for (const fn of [
      'buildMinimalEnv',
      'wrapCmdForWindows',
      'resolveDistCliPath',
      'resolveBinary',
      'startCore',
    ]) {
      expect(typeof m[fn]).toBe('function');
    }
  });

  it('client.js exposes NdjsonClient', () => {
    const m = require(path.join(PLUGIN, 'client.js'));
    expect(typeof m.NdjsonClient).toBe('function');
  });

  it('config-bridge.js exposes ConfigBridge', () => {
    const m = require(path.join(PLUGIN, 'config-bridge.js'));
    expect(typeof m.ConfigBridge).toBe('function');
  });

  it('diff-view.js exposes EditProposalView + diffLineClass', () => {
    const m = require(path.join(PLUGIN, 'diff-view.js'));
    expect(typeof m.EditProposalView).toBe('function');
    expect(typeof m.diffLineClass).toBe('function');
  });

  it('panel.js exposes ChatPanel', () => {
    const m = require(path.join(PLUGIN, 'panel.js'));
    expect(typeof m.ChatPanel).toBe('function');
  });
});

describe('diffLineClass (pure unified-diff line classifier)', () => {
  const { diffLineClass } = require(path.join(PLUGIN, 'diff-view.js')) as {
    diffLineClass: (line: string) => string;
  };
  it('classifies added/removed/hunk/context lines', () => {
    expect(diffLineClass('+hp -= dmg;')).toBe('chatgml-diff-add');
    expect(diffLineClass('-hp -= 1;')).toBe('chatgml-diff-del');
    expect(diffLineClass('@@ -1 +1 @@')).toBe('chatgml-diff-hunk');
    expect(diffLineClass(' unchanged')).toBe('chatgml-diff-ctx');
  });
  it('does NOT mis-classify the +++/--- file headers as add/del', () => {
    expect(diffLineClass('+++ b/file')).toBe('chatgml-diff-ctx');
    expect(diffLineClass('--- a/file')).toBe('chatgml-diff-ctx');
  });
});
