// test/plugin/child-process.test.ts — unit tests for the shared process plumbing helpers.
//
// These cover the pure, fs-free helpers (env builder, Windows cmd.exe wrap, distCli resolver).
// The full spawn/stdout-pipe flow is exercised by test/plugin/client.test.ts (which spawns a real
// stub serve binary), so we don't duplicate that here.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PLUGIN = path.join(HERE, '../../plugin');
const cp = require(path.join(PLUGIN, 'child-process.js')) as {
  buildMinimalEnv: (extraEnv?: Record<string, string>) => Record<string, string>;
  parseDotEnv: (text: string) => Record<string, string>;
  shouldCarryProviderEnv: (key: string) => boolean;
  wrapCmdForWindows: (cmd: string, argv: string[]) => { cmd: string; argv: string[] };
  resolveDistCliPath: (pluginDir?: string, ownDistFallback?: string) => string;
};

describe('plugin/child-process.js helpers', () => {
  it('buildMinimalEnv carries PATH, config-locating vars, ChatGML vars, and provider API keys', () => {
    const savedPath = process.env.PATH;
    const savedChat = process.env['CHATGML_TEST_TOKEN'];
    const savedKimi = process.env['KIMI_API_KEY'];
    const savedCustom = process.env['CUSTOM_API_KEY'];
    process.env.PATH = '/usr/bin';
    process.env['CHATGML_TEST_TOKEN'] = 'secret-token';
    process.env['KIMI_API_KEY'] = 'kimi-token';
    process.env['CUSTOM_API_KEY'] = 'custom-token';
    try {
      const env = cp.buildMinimalEnv({ CHATGML_CHAT_API_KEY: 'bridged-token' });
      expect(env.PATH).toBe('/usr/bin');
      expect(env['CHATGML_TEST_TOKEN']).toBe('secret-token');
      expect(env['KIMI_API_KEY']).toBe('kimi-token');
      expect(env['CUSTOM_API_KEY']).toBe('custom-token');
      expect(env['CHATGML_CHAT_API_KEY']).toBe('bridged-token');
      // Must not inherit renderer-only Electron noise.
      expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedChat === undefined) delete process.env['CHATGML_TEST_TOKEN'];
      else process.env['CHATGML_TEST_TOKEN'] = savedChat;
      if (savedKimi === undefined) delete process.env['KIMI_API_KEY'];
      else process.env['KIMI_API_KEY'] = savedKimi;
      if (savedCustom === undefined) delete process.env['CUSTOM_API_KEY'];
      else process.env['CUSTOM_API_KEY'] = savedCustom;
    }
  });

  it('shouldCarryProviderEnv accepts provider key shapes without carrying arbitrary noise', () => {
    expect(cp.shouldCarryProviderEnv('OPENROUTER_API_KEY')).toBe(true);
    expect(cp.shouldCarryProviderEnv('CUSTOM_ACCESS_TOKEN')).toBe(true);
    expect(cp.shouldCarryProviderEnv('ELECTRON_RUN_AS_NODE')).toBe(false);
  });

  it('parseDotEnv supports ChatGML provider key files without leaking comments into values', () => {
    const env = cp.parseDotEnv(`
      # ChatGML local env
      KIMI_API_KEY="kimi-secret"
      KIMI_CODE_API_KEY='code-secret'
      OPENROUTER_API_KEY=router-secret # inline note
      bad-name=nope
    `);
    expect(env.KIMI_API_KEY).toBe('kimi-secret');
    expect(env.KIMI_CODE_API_KEY).toBe('code-secret');
    expect(env.OPENROUTER_API_KEY).toBe('router-secret');
    expect(env['bad-name']).toBeUndefined();
  });

  it('wrapCmdForWindows rewrites a .cmd shim into cmd.exe /c <shim> <args> on win32', () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const wrapped = cp.wrapCmdForWindows('C:/Users/me/AppData/Roaming/npm/chatgml.cmd', [
        'serve',
        'C:/work/proj',
      ]);
      expect(wrapped.cmd).toBe('cmd.exe');
      expect(wrapped.argv).toEqual([
        '/c',
        'C:/Users/me/AppData/Roaming/npm/chatgml.cmd',
        'serve',
        'C:/work/proj',
      ]);
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });

  it('wrapCmdForWindows passes through a non-.cmd binary unchanged on win32', () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const wrapped = cp.wrapCmdForWindows('node', ['serve', '.']);
      expect(wrapped.cmd).toBe('node');
      expect(wrapped.argv).toEqual(['serve', '.']);
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });

  it('wrapCmdForWindows leaves a .cmd binary alone on linux', () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const wrapped = cp.wrapCmdForWindows('chatgml.cmd', ['serve', '.']);
      expect(wrapped.cmd).toBe('chatgml.cmd');
      expect(wrapped.argv).toEqual(['serve', '.']);
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });

  it('resolveDistCliPath returns <pluginDir>/dist/cli.js when the bundled dist exists', () => {
    // The real plugin/ directory has no dist/ in this checkout (we ship source), so probe the
    // "none exist" path: function returns the first candidate it tried.
    const fakePluginDir = path.join(PLUGIN, '__no_such_plugin_dir__');
    const ownDistFallback = path.join(fakePluginDir, '__no_such_dist__', 'cli.js');
    const out = cp.resolveDistCliPath(fakePluginDir, ownDistFallback);
    expect(out).toBe(path.join(fakePluginDir, 'dist', 'cli.js'));
  });
});
