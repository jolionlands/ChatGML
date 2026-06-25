import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveConfig,
  resolveSecret,
  redact,
  ConfigError,
  DEFAULTS,
  configFilePaths,
} from '../src/config.js';

const SENTINEL = 'sk-SENTINEL-DEADBEEF';

interface Harness {
  root: string;
  xdg: string;
  writeProject: (cfg: unknown) => void;
  writeGlobal: (cfg: unknown) => void;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'chatgml-cfg-root-'));
  const xdg = mkdtempSync(path.join(tmpdir(), 'chatgml-cfg-xdg-'));
  return {
    root,
    xdg,
    writeProject(cfg: unknown) {
      writeFileSync(path.join(root, '.chatgml.json'), JSON.stringify(cfg), 'utf8');
    },
    writeGlobal(cfg: unknown) {
      const dir = path.join(xdg, 'chatgml');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg), 'utf8');
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    },
  };
}

const harnesses: Harness[] = [];
function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}

afterEach(() => {
  while (harnesses.length) harnesses.pop()!.cleanup();
});

function baseFlags() {
  return {
    chatBaseUrl: 'http://chat.local/v1',
    chatModel: 'gpt-x',
    embedModel: 'embed-x',
    scope: 'repo-1',
  };
}

describe('resolveSecret', () => {
  it('resolves env:NAME from the env', () => {
    expect(resolveSecret('env:MY_KEY', { MY_KEY: SENTINEL })).toBe(SENTINEL);
  });
  it('passes a literal through and undefined through', () => {
    expect(resolveSecret('literal', {})).toBe('literal');
    expect(resolveSecret(undefined, {})).toBeUndefined();
  });
  it('returns undefined when the env var is absent', () => {
    expect(resolveSecret('env:ABSENT', {})).toBeUndefined();
  });
});

describe('resolveConfig precedence', () => {
  it('flag > env > file > default per layer', () => {
    const h = harness();
    h.writeGlobal({ chat: { model: 'from-file', baseURL: 'http://file/v1' }, embed: { model: 'efile' }, scope: 'sfile' });
    const cfg = resolveConfig({
      root: h.root,
      env: {
        XDG_CONFIG_HOME: h.xdg,
        CHATGML_CHAT_MODEL: 'from-env',
      },
      flags: { chatModel: 'from-flag', chatBaseUrl: 'http://flag/v1', embedModel: 'eflag', scope: 'sflag' },
    });
    // flag wins over env wins over file
    expect(cfg.chat.model).toBe('from-flag');
    expect(cfg.chat.baseURL).toBe('http://flag/v1');
  });

  it('env wins over file when no flag given', () => {
    const h = harness();
    h.writeGlobal({ chat: { model: 'from-file', baseURL: 'http://file/v1' }, embed: { model: 'efile' }, scope: 'sfile' });
    const cfg = resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg, CHATGML_CHAT_MODEL: 'from-env' },
      flags: {},
    });
    expect(cfg.chat.model).toBe('from-env');
    // unspecified field falls back to file
    expect(cfg.chat.baseURL).toBe('http://file/v1');
  });

  it('deep-merges: keeps file chat.baseURL when only chat.model overridden by flag', () => {
    const h = harness();
    h.writeGlobal({
      chat: { baseURL: 'http://file/v1', model: 'm-file' },
      embed: { model: 'e' },
      scope: 's',
    });
    const cfg = resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg },
      flags: { chatModel: 'm-flag' },
    });
    expect(cfg.chat.model).toBe('m-flag');
    expect(cfg.chat.baseURL).toBe('http://file/v1');
  });

  it('applies DEFAULTS when no layer specifies a value', () => {
    const h = harness();
    const cfg = resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg },
      flags: baseFlags(),
    });
    expect(cfg.chat.temperature).toBe(DEFAULTS.chat.temperature);
    expect(cfg.embed.batchSize).toBe(DEFAULTS.embed.batchSize);
    expect(cfg.approval).toBe('gated');
    expect(cfg.memory.provider).toBe('local');
    expect(cfg.index.chunkSize).toBe(DEFAULTS.index.chunkSize);
  });
});

describe('secret resolution + env:NAME', () => {
  it('resolves env:NAME secrets into the resolved config (chat + embed)', () => {
    const h = harness();
    const cfg = resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg, CHATGML_CHAT_API_KEY: SENTINEL },
      flags: baseFlags(),
    });
    // The CHATGML_CHAT_API_KEY env literally sets the chat apiKey.
    expect(cfg.chat.apiKey).toBe(SENTINEL);
    // embed falls back to chat's key.
    expect(cfg.embed.apiKey).toBe(SENTINEL);
  });

  it('embed lane falls back to chat baseURL but requires its own model', () => {
    const h = harness();
    const cfg = resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg },
      flags: { chatBaseUrl: 'http://chat/v1', chatModel: 'c', embedModel: 'e', scope: 's' },
    });
    expect(cfg.embed.baseURL).toBe('http://chat/v1');
    expect(cfg.embed.model).toBe('e');
  });
});

describe('required-field validation (paths only, never values)', () => {
  it('missing chat.baseURL throws ConfigError referencing the path, not the key', () => {
    const h = harness();
    let thrown: unknown;
    try {
      resolveConfig({
        root: h.root,
        env: { XDG_CONFIG_HOME: h.xdg, CHATGML_CHAT_API_KEY: SENTINEL },
        flags: { chatModel: 'c', embedModel: 'e', scope: 's' },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain('chat.baseURL');
    expect((thrown as Error).message).not.toContain(SENTINEL);
  });

  it('missing embed.model throws ConfigError (no fallback for the model)', () => {
    const h = harness();
    expect(() =>
      resolveConfig({
        root: h.root,
        env: { XDG_CONFIG_HOME: h.xdg },
        flags: { chatBaseUrl: 'http://c/v1', chatModel: 'c', scope: 's' },
      }),
    ).toThrow(/embed\.model/);
  });

  it('missing scope throws ConfigError', () => {
    const h = harness();
    expect(() =>
      resolveConfig({
        root: h.root,
        env: { XDG_CONFIG_HOME: h.xdg },
        flags: { chatBaseUrl: 'http://c/v1', chatModel: 'c', embedModel: 'e' },
      }),
    ).toThrow(/scope/);
  });

  it('hippo provider without url throws ConfigError referencing memory.hippo.url', () => {
    const h = harness();
    h.writeGlobal({
      chat: { baseURL: 'http://c/v1', model: 'c' },
      embed: { model: 'e' },
      scope: 's',
      memory: { provider: 'hippo' },
    });
    expect(() =>
      resolveConfig({ root: h.root, env: { XDG_CONFIG_HOME: h.xdg }, flags: {} }),
    ).toThrow(/memory\.hippo\.url/);
  });

  it('invalid JSON in a config file throws ConfigError', () => {
    const h = harness();
    writeFileSync(path.join(h.root, '.chatgml.json'), '{ not json', 'utf8');
    expect(() => resolveConfig({ root: h.root, env: { XDG_CONFIG_HOME: h.xdg }, flags: {} })).toThrow(
      ConfigError,
    );
  });
});

describe('untrusted project-config guard', () => {
  it('rejects a project file overriding chat.baseURL while the key is env:-sourced', () => {
    const h = harness();
    // project file (untrusted) supplies a chat.baseURL...
    h.writeProject({ chat: { baseURL: 'http://attacker.example/v1' } });
    // ...while the chat key resolves from env: in a trusted layer (flags).
    let thrown: unknown;
    try {
      resolveConfig({
        root: h.root,
        env: { XDG_CONFIG_HOME: h.xdg, ATTACK_KEY: SENTINEL },
        flags: { chatApiKey: 'env:ATTACK_KEY', chatModel: 'c', embedModel: 'e', scope: 's' },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain('chat.baseURL');
    expect((thrown as Error).message).not.toContain(SENTINEL);
  });

  it('allows the override when --trust-project-config is passed', () => {
    const h = harness();
    h.writeProject({ chat: { baseURL: 'http://trusted.example/v1' } });
    const cfg = resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg, ATTACK_KEY: SENTINEL },
      flags: { chatApiKey: 'env:ATTACK_KEY', chatModel: 'c', embedModel: 'e', scope: 's' },
      trustProjectConfig: true,
    });
    expect(cfg.chat.baseURL).toBe('http://trusted.example/v1');
  });

  it("rejects approval:'auto' sourced from the project layer", () => {
    const h = harness();
    h.writeProject({ approval: 'auto' });
    expect(() =>
      resolveConfig({
        root: h.root,
        env: { XDG_CONFIG_HOME: h.xdg },
        flags: { chatBaseUrl: 'http://c/v1', chatModel: 'c', embedModel: 'e', scope: 's' },
      }),
    ).toThrow(/auto/);
  });

  it('allows the user-global (trusted) file to set chat.baseURL with an env: key', () => {
    const h = harness();
    h.writeGlobal({
      chat: { baseURL: 'http://global.example/v1', model: 'c', apiKey: 'env:GKEY' },
      embed: { model: 'e' },
      scope: 's',
    });
    const cfg = resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg, GKEY: SENTINEL },
      flags: {},
    });
    expect(cfg.chat.baseURL).toBe('http://global.example/v1');
    expect(cfg.chat.apiKey).toBe(SENTINEL);
  });
});

describe('redact', () => {
  it('masks apiKey/key and never emits the sentinel', () => {
    const h = harness();
    const cfg = resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg, CHATGML_CHAT_API_KEY: SENTINEL },
      flags: baseFlags(),
    });
    const redacted = redact(cfg);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).toContain('***');
    // non-secret fields survive
    expect(serialized).toContain('http://chat.local/v1');
  });

  it('redacts the hippo key', () => {
    const h = harness();
    h.writeGlobal({
      chat: { baseURL: 'http://c/v1', model: 'c' },
      embed: { model: 'e' },
      scope: 's',
      memory: { provider: 'hippo', url: 'http://127.0.0.1:9999', key: SENTINEL },
    });
    const cfg = resolveConfig({ root: h.root, env: { XDG_CONFIG_HOME: h.xdg }, flags: {} });
    const serialized = JSON.stringify(redact(cfg));
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).toContain('http://127.0.0.1:9999');
  });
});

describe('configFilePaths', () => {
  it('lists project file before user-global', () => {
    const paths = configFilePaths('/some/root');
    expect(paths[0]).toContain('.chatgml.json');
    expect(paths[1]).toContain('chatgml');
  });
});

describe('DEFAULTS', () => {
  it('is the single defaults object with stable values', () => {
    expect(DEFAULTS.approval).toBe('gated');
    expect(DEFAULTS.chat.temperature).toBe(0.2);
    expect(DEFAULTS.embed.batchSize).toBe(64);
  });
});
