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
  setUserGlobalConfigField,
  userGlobalConfigPath,
} from '../src/config.js';
import { readFileSync, existsSync } from 'node:fs';

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

// D1 — the opt-in search relevance floor (search.minScore). Default OFF (undefined); resolves with the
// usual flag > env > file precedence; redaction surfaces it only when set; config set persists it.
describe('search.minScore (D1 relevance floor)', () => {
  it('defaults to undefined (no floor) when no layer sets it', () => {
    const h = harness();
    const cfg = resolveConfig({ root: h.root, env: { XDG_CONFIG_HOME: h.xdg }, flags: baseFlags() });
    expect(cfg.search.minScore).toBeUndefined();
  });

  it('reads minScore from the config file', () => {
    const h = harness();
    h.writeGlobal({
      chat: { baseURL: 'http://c/v1', model: 'c' },
      embed: { model: 'e' },
      scope: 's',
      search: { minScore: 0.3 },
    });
    const cfg = resolveConfig({ root: h.root, env: { XDG_CONFIG_HOME: h.xdg }, flags: {} });
    expect(cfg.search.minScore).toBe(0.3);
  });

  it('flag > env > file for minScore', () => {
    const h = harness();
    h.writeGlobal({
      chat: { baseURL: 'http://c/v1', model: 'c' },
      embed: { model: 'e' },
      scope: 's',
      search: { minScore: 0.1 },
    });
    const cfg = resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg, CHATGML_SEARCH_MIN_SCORE: '0.2' },
      flags: { minScore: 0.4 },
    });
    expect(cfg.search.minScore).toBe(0.4);
    // env wins over file when no flag:
    const cfg2 = resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg, CHATGML_SEARCH_MIN_SCORE: '0.2' },
      flags: {},
    });
    expect(cfg2.search.minScore).toBe(0.2);
  });

  it('rejects an out-of-range minScore in the config file', () => {
    const h = harness();
    h.writeGlobal({
      chat: { baseURL: 'http://c/v1', model: 'c' },
      embed: { model: 'e' },
      scope: 's',
      search: { minScore: 1.5 },
    });
    expect(() => resolveConfig({ root: h.root, env: { XDG_CONFIG_HOME: h.xdg }, flags: {} })).toThrow(
      ConfigError,
    );
  });

  it('redact omits the search lane by default and surfaces it when minScore is set', () => {
    const h = harness();
    const off = resolveConfig({ root: h.root, env: { XDG_CONFIG_HOME: h.xdg }, flags: baseFlags() });
    expect((redact(off) as Record<string, unknown>).search).toBeUndefined();

    const on = resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg },
      flags: { ...baseFlags(), minScore: 0.35 },
    });
    expect((redact(on) as { search?: { minScore?: number } }).search?.minScore).toBe(0.35);
  });

  it('config set persists search.minScore (coerced to a number)', () => {
    const h = harness();
    const res = setUserGlobalConfigField('search.minScore', '0.25', { XDG_CONFIG_HOME: h.xdg });
    const written = JSON.parse(readFileSync(res.filePath, 'utf8'));
    expect(written.search.minScore).toBe(0.25);
    expect(typeof written.search.minScore).toBe('number');
  });

  it('config set rejects an out-of-range search.minScore', () => {
    const h = harness();
    expect(() =>
      setUserGlobalConfigField('search.minScore', '2', { XDG_CONFIG_HOME: h.xdg }),
    ).toThrow(ConfigError);
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

  // F18: an unrecognized top-level key NAMES the offending key (not '(root)').
  it('an unknown top-level config key is NAMED in the error — F18', () => {
    const h = harness();
    h.writeGlobal({ chatt: { model: 'x' }, scope: 's' }); // typo: "chatt"
    let msg = '';
    try {
      resolveConfig({ root: h.root, env: { XDG_CONFIG_HOME: h.xdg }, flags: baseFlags() });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('chatt');
    expect(msg).not.toContain('(root)');
  });

  // F18: an enum failure lists the allowed values.
  it('an invalid approval enum lists the allowed values — F18', () => {
    const h = harness();
    h.writeGlobal({ approval: 'sometimes', scope: 's' });
    let msg = '';
    try {
      resolveConfig({ root: h.root, env: { XDG_CONFIG_HOME: h.xdg }, flags: baseFlags() });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('approval');
    expect(msg).toContain('gated');
    expect(msg).toContain('auto');
  });
});

// F14: a literal plaintext secret in the UNTRUSTED project file emits a redacted warning.
describe('literal-secret warning on the untrusted project file — F14', () => {
  it('warns (redacted) when chat.apiKey is a literal in .chatgml.json', () => {
    const h = harness();
    h.writeProject({ chat: { apiKey: SENTINEL } });
    const warnings: string[] = [];
    resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg },
      flags: baseFlags(),
      warn: (m) => warnings.push(m),
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('chat.apiKey');
    expect(warnings[0]).toContain('.chatgml.json');
    expect(warnings[0]).not.toContain(SENTINEL); // redacted
  });

  it('does NOT warn when the project secret is an env: reference', () => {
    const h = harness();
    h.writeProject({ chat: { apiKey: 'env:SOME_KEY' } });
    const warnings: string[] = [];
    resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg, SOME_KEY: SENTINEL },
      flags: baseFlags(),
      warn: (m) => warnings.push(m),
    });
    expect(warnings.length).toBe(0);
  });

  it('does NOT warn for a literal secret in the TRUSTED global file', () => {
    const h = harness();
    h.writeGlobal({ chat: { apiKey: SENTINEL }, scope: 's' });
    const warnings: string[] = [];
    resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg },
      flags: baseFlags(),
      warn: (m) => warnings.push(m),
    });
    expect(warnings.length).toBe(0);
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

describe('resolveConfig — required-field + hippo-key branches', () => {
  it("missing chat.model throws ConfigError referencing 'chat.model'", () => {
    const h = harness();
    expect(() =>
      resolveConfig({
        root: h.root,
        env: {},
        flags: { chatBaseUrl: 'http://chat/v1', embedModel: 'e', scope: 's' },
      }),
    ).toThrow(/chat\.model/);
  });

  it("missing chat.baseURL throws ConfigError referencing 'chat.baseURL'", () => {
    const h = harness();
    expect(() =>
      resolveConfig({
        root: h.root,
        env: {},
        flags: { chatModel: 'm', embedModel: 'e', scope: 's' },
      }),
    ).toThrow(/chat\.baseURL/);
  });

  it("missing scope throws ConfigError referencing 'scope'", () => {
    const h = harness();
    expect(() =>
      resolveConfig({
        root: h.root,
        env: {},
        flags: { chatModel: 'm', chatBaseUrl: 'http://c/v1', embedModel: 'e' },
      }),
    ).toThrow(/scope/);
  });

  it('resolves a hippo key from env:NAME (trusted global file)', () => {
    const h = harness();
    h.writeGlobal({
      chat: { baseURL: 'http://c/v1', model: 'c' },
      embed: { model: 'e' },
      scope: 's',
      memory: { provider: 'hippo', url: 'http://127.0.0.1:7077', key: 'env:HIPPO_KEY' },
    });
    const cfg = resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg, HIPPO_KEY: SENTINEL },
      flags: {},
    });
    expect(cfg.memory.provider).toBe('hippo');
    if (cfg.memory.provider === 'hippo') expect(cfg.memory.key).toBe(SENTINEL);
  });

  it('drops a hippo key whose env:NAME is absent (no key on the lane)', () => {
    const h = harness();
    h.writeGlobal({
      chat: { baseURL: 'http://c/v1', model: 'c' },
      embed: { model: 'e' },
      scope: 's',
      memory: { provider: 'hippo', url: 'http://127.0.0.1:7077', key: 'env:ABSENT_HIPPO' },
    });
    const cfg = resolveConfig({
      root: h.root,
      env: { XDG_CONFIG_HOME: h.xdg },
      flags: {},
    });
    expect(cfg.memory.provider).toBe('hippo');
    if (cfg.memory.provider === 'hippo') expect(cfg.memory.key).toBeUndefined();
  });
});

describe('setUserGlobalConfigField (durable config set)', () => {
  it('writes a non-secret field to the user-global file and creates the dir', () => {
    const h = harness();
    const env = { XDG_CONFIG_HOME: h.xdg };
    const before = userGlobalConfigPath(env);
    expect(existsSync(before)).toBe(false);
    const res = setUserGlobalConfigField('chat.model', 'm-1', env);
    expect(res.filePath).toBe(before);
    const written = JSON.parse(readFileSync(res.filePath, 'utf8'));
    expect(written.chat.model).toBe('m-1');
  });

  it('coerces numeric fields', () => {
    const h = harness();
    const res = setUserGlobalConfigField('index.chunkSize', '4096', { XDG_CONFIG_HOME: h.xdg });
    const written = JSON.parse(readFileSync(res.filePath, 'utf8'));
    expect(written.index.chunkSize).toBe(4096);
    expect(typeof written.index.chunkSize).toBe('number');
  });

  it('rejects a non-numeric value for a numeric field', () => {
    const h = harness();
    expect(() =>
      setUserGlobalConfigField('chat.temperature', 'hot', { XDG_CONFIG_HOME: h.xdg }),
    ).toThrow(ConfigError);
  });

  it('merges into an existing file rather than clobbering it', () => {
    const h = harness();
    const env = { XDG_CONFIG_HOME: h.xdg };
    h.writeGlobal({ chat: { model: 'old', baseURL: 'http://c/v1' }, scope: 's' });
    setUserGlobalConfigField('chat.apiKey', 'env:KEYREF', env);
    const written = JSON.parse(readFileSync(userGlobalConfigPath(env), 'utf8'));
    expect(written.chat.model).toBe('old'); // preserved
    expect(written.chat.baseURL).toBe('http://c/v1'); // preserved
    expect(written.chat.apiKey).toBe('env:KEYREF'); // added
    expect(written.scope).toBe('s'); // preserved
  });

  it('REFUSES a literal secret (never writes the file) for each secret field', () => {
    for (const field of ['chat.apiKey', 'embed.apiKey', 'memory.hippo.key']) {
      const h = harness();
      const env = { XDG_CONFIG_HOME: h.xdg };
      expect(() => setUserGlobalConfigField(field, SENTINEL, env)).toThrow(/literal secret/);
      // Nothing was written.
      expect(existsSync(userGlobalConfigPath(env))).toBe(false);
    }
  });

  it('accepts an env: reference for a secret field and writes the REFERENCE only', () => {
    const h = harness();
    const env = { XDG_CONFIG_HOME: h.xdg };
    setUserGlobalConfigField('embed.apiKey', 'env:EMBED_KEY', env);
    const text = readFileSync(userGlobalConfigPath(env), 'utf8');
    expect(text).toContain('env:EMBED_KEY');
    expect(text).not.toContain(SENTINEL);
  });

  it('throws on an unknown field', () => {
    const h = harness();
    expect(() =>
      setUserGlobalConfigField('chat.nope', 'x', { XDG_CONFIG_HOME: h.xdg }),
    ).toThrow(/unknown config field/);
  });

  it('rejects a value that would make the merged config invalid', () => {
    const h = harness();
    expect(() =>
      setUserGlobalConfigField('approval', 'maybe', { XDG_CONFIG_HOME: h.xdg }),
    ).toThrow(ConfigError);
  });

  it('refuses to overwrite a corrupt existing config file', () => {
    const h = harness();
    const env = { XDG_CONFIG_HOME: h.xdg };
    // Write invalid JSON to the user-global file.
    const dir = path.join(h.xdg, 'chatgml');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'config.json'), '{ not json', 'utf8');
    expect(() => setUserGlobalConfigField('scope', 's', env)).toThrow(ConfigError);
  });
});
