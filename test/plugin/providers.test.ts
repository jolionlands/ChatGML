// test/plugin/providers.test.ts — provider registry module (plugin/providers.js).
//
// The registry is the bridge between `~/.pi/agent/providers.json` (the user's external agent
// tooling's provider list — read-only on our side) and `~/.config/chatgml/providers.json` (the
// chatgml-owned copy the user can edit independently). These tests cover:
//
//   1. File-shape normalization: both `{providers: {...}}` and the flat `{<name>: ...}` shapes
//      must be accepted so the user can paste either one.
//   2. Bootstrap behavior: the chatgml file is created from the external file when absent;
//      existing chatgml files are NEVER overwritten.
//   3. Merge precedence: chatgml wins on collision (user-edits survive), external fills gaps.
//   4. Listing, model lookup, URL lookup, datalist option building — all the data shaping the
//      panel consumes.
//   5. `toEnvFormat`: produces a deterministic, .env-safe snippet.
//   6. `registerProvider`: round-trips through the chatgml file (no clobber).
//   7. `loadAll`: end-to-end pipeline with a tmp directory.
//
// All file I/O is sandboxed to a per-test tmp dir under `os.tmpdir()` so the tests can run
// without touching the user's actual config.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Providers = require(path.join(HERE, '../../plugin/providers.js')) as {
  defaultChatgmlProvidersPath: (dir?: string) => string;
  defaultPiProvidersPath: () => string;
  readProvidersFile: (p: string) => { providers: Record<string, unknown> } | null;
  bootstrapProviders: (opts: { chatgmlPath: string; piPath: string }) => {
    path: string;
    data: { providers: Record<string, unknown> };
    bootstrapped: boolean;
    warning?: string;
  };
  mergeRegistries: (sources: Array<{ providers?: Record<string, unknown> } | null>) => {
    providers: Record<string, unknown>;
  };
  normalizeProvider: (
    name: string,
    raw: unknown,
  ) => {
    name: string;
    kind: string;
    baseUrl: string;
    endpoint: string;
    auth: string;
    models: Array<{ id: string; wireModel: string; contextWindow: number }>;
  } | null;
  listProviders: (registry: { providers?: Record<string, unknown> }) => Array<{
    name: string;
    baseUrl: string;
    models: Array<{ id: string; wireModel: string; contextWindow: number }>;
  }>;
  listModels: (registry: { providers?: Record<string, unknown> }) => Array<{
    providerName: string;
    modelId: string;
    baseUrl: string;
    contextWindow: number;
  }>;
  findProviderByUrl: (registry: { providers?: Record<string, unknown> }, url: string) => unknown;
  findModel: (
    registry: { providers?: Record<string, unknown> },
    id: string,
  ) => { provider: unknown; model: unknown } | null;
  resolveEndpoint: (
    provider: { baseUrl: string; endpoint?: string } | null,
  ) => { baseUrl: string; path: string; auth: string } | null;
  providerToConfig: (entry: unknown) => {
    model: string | null;
    baseURL: string | null;
    path: string | null;
    auth: string | null;
  };
  toEnvFormat: (registry: { providers?: Record<string, unknown>; __source?: string }) => string;
  registerProvider: (opts: {
    chatgmlPath: string;
    name: string;
    baseUrl: string;
    endpoint?: string;
    auth?: string;
    models?: Array<{ id: string }>;
  }) => { ok: boolean; error?: string };
  buildDatalistOptions: (registry: { providers?: Record<string, unknown> }) => {
    modelOptions: Array<{ value: string; label: string }>;
    baseUrlOptions: Array<{ value: string; label: string }>;
  };
  loadAll: (opts: { chatgmlPath?: string; piPath?: string; chatgmlUserDir?: string }) => {
    path: string;
    piPath: string;
    registry: { providers: Record<string, unknown>; __source?: string };
    providers: Array<{ name: string; models: unknown[] }>;
    models: Array<{ providerName: string; modelId: string }>;
    datalistOptions: {
      modelOptions: Array<{ value: string; label: string }>;
      baseUrlOptions: Array<{ value: string; label: string }>;
    };
    bootstrapped: boolean;
    warnings: string[];
  };
};

let tmpRoot: string;
let chatgmlDir: string;
let piDir: string;
let chatgmlPath: string;
let piPath: string;

beforeEach(() => {
  // Per-test isolated tmp dir so concurrent runs and re-runs don't collide.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgml-providers-test-'));
  chatgmlDir = path.join(tmpRoot, 'chatgml');
  piDir = path.join(tmpRoot, 'pi', 'agent');
  fs.mkdirSync(chatgmlDir, { recursive: true });
  fs.mkdirSync(piDir, { recursive: true });
  chatgmlPath = path.join(chatgmlDir, 'providers.json');
  piPath = path.join(piDir, 'providers.json');
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) {
    /* best-effort */
  }
});

describe('plugin/providers.js — path helpers', () => {
  it('defaultChatgmlProvidersPath honors an explicit override', () => {
    const p = Providers.defaultChatgmlProvidersPath('/tmp/custom');
    expect(p).toBe(path.join('/tmp/custom', 'providers.json'));
  });

  it('defaultChatgmlProvidersPath falls back to ~/.config/chatgml when no override', () => {
    const p = Providers.defaultChatgmlProvidersPath();
    expect(p).toContain('providers.json');
    expect(p).toContain('chatgml');
  });

  it('defaultPiProvidersPath returns ~/.pi/agent/providers.json', () => {
    const p = Providers.defaultPiProvidersPath();
    expect(p).toContain(path.join('.pi', 'agent', 'providers.json'));
  });
});

describe('plugin/providers.js — readProvidersFile shape normalization', () => {
  it('accepts the canonical {providers: {<name>: {...}}} shape', () => {
    fs.writeFileSync(
      chatgmlPath,
      JSON.stringify({ providers: { foo: { kind: 'openai_compat', base_url: 'http://x' } } }),
    );
    const out = Providers.readProvidersFile(chatgmlPath);
    expect(out).not.toBeNull();
    expect((out as { providers: Record<string, unknown> }).providers.foo).toBeDefined();
  });

  it('accepts the flat {<name>: {...}} shape (no `providers` wrapper)', () => {
    fs.writeFileSync(
      chatgmlPath,
      JSON.stringify({ foo: { kind: 'openai_compat', base_url: 'http://x' } }),
    );
    const out = Providers.readProvidersFile(chatgmlPath);
    expect(out).not.toBeNull();
    expect((out as { providers: Record<string, unknown> }).providers.foo).toBeDefined();
  });

  it('returns null for ENOENT', () => {
    expect(Providers.readProvidersFile(path.join(tmpRoot, 'nope.json'))).toBeNull();
  });

  it('throws on malformed JSON', () => {
    fs.writeFileSync(chatgmlPath, '{ this is not valid JSON');
    expect(() => Providers.readProvidersFile(chatgmlPath)).toThrow();
  });

  it('returns {providers:{}} for a top-level scalar/null', () => {
    fs.writeFileSync(chatgmlPath, 'null');
    const out = Providers.readProvidersFile(chatgmlPath);
    expect(out).toEqual({ providers: {} });
  });
});

describe('plugin/providers.js — bootstrapProviders', () => {
  it('copies the external registry to the chatgml file when chatgml file is absent', () => {
    const piData = { providers: { maveros: { kind: 'openai_compat', base_url: 'http://x' } } };
    fs.writeFileSync(piPath, JSON.stringify(piData));
    const result = Providers.bootstrapProviders({ chatgmlPath, piPath });
    expect(result.bootstrapped).toBe(true);
    expect(result.data.providers).toEqual(piData.providers);
    expect(fs.existsSync(chatgmlPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(chatgmlPath, 'utf8'));
    expect(written.providers.maveros).toEqual(piData.providers.maveros);
  });

  it('does NOT overwrite an existing chatgml file (preserves user edits)', () => {
    const piData = { providers: { external: { base_url: 'http://ext' } } };
    const chatgmlData = { providers: { custom: { base_url: 'http://cust' } } };
    fs.writeFileSync(piPath, JSON.stringify(piData));
    fs.writeFileSync(chatgmlPath, JSON.stringify(chatgmlData));
    const result = Providers.bootstrapProviders({ chatgmlPath, piPath });
    expect(result.bootstrapped).toBe(false);
    expect(result.data.providers).toEqual(chatgmlData.providers);
    // The on-disk chatgml file is unchanged.
    const written = JSON.parse(fs.readFileSync(chatgmlPath, 'utf8'));
    expect(written.providers.custom).toEqual(chatgmlData.providers.custom);
    expect(written.providers.external).toBeUndefined();
  });

  it('returns empty registry when neither file exists', () => {
    const result = Providers.bootstrapProviders({
      chatgmlPath: path.join(tmpRoot, 'no-chatgml.json'),
      piPath: path.join(tmpRoot, 'no-pi.json'),
    });
    expect(result.bootstrapped).toBe(false);
    expect(result.data).toEqual({ providers: {} });
  });

  it('returns empty registry + warning when external file is malformed', () => {
    fs.writeFileSync(piPath, '{ broken');
    const result = Providers.bootstrapProviders({
      chatgmlPath: path.join(tmpRoot, 'no-chatgml.json'),
      piPath,
    });
    expect(result.bootstrapped).toBe(false);
    expect(result.data).toEqual({ providers: {} });
    expect(result.warning).toMatch(/could not parse/);
  });

  it('returns existing chatgml data + warning when chatgml file is malformed', () => {
    // Malformed chatgml file is treated as "leave it alone, just warn" — we do NOT silently
    // overwrite the user's broken file with a fresh bootstrap copy.
    fs.writeFileSync(chatgmlPath, '{ broken');
    const result = Providers.bootstrapProviders({ chatgmlPath, piPath });
    expect(result.bootstrapped).toBe(false);
    expect(result.data).toEqual({ providers: {} });
    expect(result.warning).toMatch(/could not parse/);
  });
});

describe('plugin/providers.js — mergeRegistries', () => {
  it('later sources win on collision', () => {
    const a = { providers: { x: { base_url: 'A' }, y: { base_url: 'A-y' } } };
    const b = { providers: { x: { base_url: 'B' }, z: { base_url: 'B-z' } } };
    const merged = Providers.mergeRegistries([a, b]);
    expect(merged.providers.x).toEqual({ base_url: 'B' });
    expect(merged.providers.y).toEqual({ base_url: 'A-y' });
    expect(merged.providers.z).toEqual({ base_url: 'B-z' });
  });

  it('handles empty/null inputs gracefully', () => {
    const merged = Providers.mergeRegistries([null, undefined, {}, { providers: {} }]);
    expect(merged).toEqual({ providers: {} });
  });
});

describe('plugin/providers.js — normalizeProvider', () => {
  it('normalizes a complete entry', () => {
    const norm = Providers.normalizeProvider('maveros', {
      kind: 'openai_compat',
      base_url: 'http://x/v1',
      path: '/api/chat',
      auth: 'none',
      models: [
        { id: 'qwen3-27b', wire_model: 'Qwen3.gguf', context_window: 65536 },
        { id: 'no-wire', context_window: 1024 },
      ],
    });
    expect(norm).toEqual({
      name: 'maveros',
      kind: 'openai_compat',
      baseUrl: 'http://x/v1',
      endpoint: '/api/chat',
      auth: 'none',
      models: [
        { id: 'qwen3-27b', wireModel: 'Qwen3.gguf', contextWindow: 65536 },
        { id: 'no-wire', wireModel: 'no-wire', contextWindow: 1024 },
      ],
    });
  });

  it('defaults missing fields (no path, no auth, no models)', () => {
    const norm = Providers.normalizeProvider('p', { base_url: 'http://x' });
    expect(norm).toEqual({
      name: 'p',
      kind: 'openai_compat',
      baseUrl: 'http://x',
      endpoint: '/chat/completions',
      auth: 'bearer',
      models: [],
    });
  });

  it('returns null for a non-object raw entry', () => {
    expect(Providers.normalizeProvider('p', null)).toBeNull();
    expect(Providers.normalizeProvider('p', 'string')).toBeNull();
    expect(Providers.normalizeProvider('p', 42)).toBeNull();
  });

  it('drops malformed model entries (missing id) but keeps the good ones', () => {
    const norm = Providers.normalizeProvider('p', {
      base_url: 'http://x',
      models: [{ id: 'good' }, { no_id: true }, null, 'string-model'],
    });
    expect(norm?.models).toHaveLength(1);
    expect(norm?.models[0]?.id).toBe('good');
  });
});

describe('plugin/providers.js — listProviders / listModels', () => {
  const reg = {
    providers: {
      a: {
        base_url: 'http://a/v1',
        kind: 'openai_compat',
        models: [{ id: 'm1' }, { id: 'm2', wire_model: 'M2.gguf', context_window: 8192 }],
      },
      b: { base_url: 'http://b/v1', models: [] },
    },
  };

  it('listProviders returns one entry per provider in insertion order', () => {
    const ps = Providers.listProviders(reg);
    expect(ps.map((p) => p.name)).toEqual(['a', 'b']);
  });

  it('listModels flattens to one row per (provider, model) pair', () => {
    const ms = Providers.listModels(reg);
    expect(ms).toHaveLength(2);
    expect(ms[0]).toEqual({
      providerName: 'a',
      modelId: 'm1',
      wireModel: 'm1',
      baseUrl: 'http://a/v1',
      endpoint: '/chat/completions',
      auth: 'bearer',
      contextWindow: 0,
    });
    expect(ms[1]?.wireModel).toBe('M2.gguf');
    expect(ms[1]?.contextWindow).toBe(8192);
  });
});

describe('plugin/providers.js — findProviderByUrl / findModel', () => {
  const reg = {
    providers: {
      maveros: { base_url: 'http://192.168.1.206:18091/v1', models: [{ id: 'qwen3' }] },
      openai: { base_url: 'https://api.openai.com/v1', models: [{ id: 'gpt-4o' }] },
    },
  };

  it('finds a provider by exact base URL', () => {
    const p = Providers.findProviderByUrl(reg, 'http://192.168.1.206:18091/v1');
    expect(p).toBeTruthy();
    expect((p as { name: string }).name).toBe('maveros');
  });

  it('is tolerant of trailing slashes', () => {
    const p = Providers.findProviderByUrl(reg, 'https://api.openai.com/v1/');
    expect((p as { name: string })?.name).toBe('openai');
  });

  it('returns null when no provider matches', () => {
    expect(Providers.findProviderByUrl(reg, 'http://nope')).toBeNull();
  });

  it('findModel returns {provider, model} for a known id', () => {
    const hit = Providers.findModel(reg, 'gpt-4o');
    expect(hit).not.toBeNull();
    expect((hit as { provider: { name: string } }).provider.name).toBe('openai');
    expect((hit as { model: { id: string } }).model.id).toBe('gpt-4o');
  });

  it('findModel returns null for an unknown id', () => {
    expect(Providers.findModel(reg, 'claude')).toBeNull();
  });
});

describe('plugin/providers.js — resolveEndpoint / providerToConfig', () => {
  it('resolveEndpoint returns {baseUrl, path, auth} with defaults', () => {
    const ep = Providers.resolveEndpoint({ baseUrl: 'http://x', endpoint: '/api/chat' });
    expect(ep).toEqual({ baseUrl: 'http://x', path: '/api/chat', auth: 'bearer' });
  });

  it('resolveEndpoint defaults path to /chat/completions', () => {
    const ep = Providers.resolveEndpoint({ baseUrl: 'http://x' });
    expect(ep?.path).toBe('/chat/completions');
  });

  it('resolveEndpoint returns null for a null provider', () => {
    expect(Providers.resolveEndpoint(null)).toBeNull();
  });

  it('providerToConfig maps a listModels entry to the core config shape', () => {
    const cfg = Providers.providerToConfig({
      providerName: 'maveros',
      modelId: 'qwen3',
      wireModel: 'Qwen3.gguf',
      baseUrl: 'http://x',
      endpoint: '/chat/completions',
      auth: 'bearer',
      contextWindow: 0,
    });
    expect(cfg).toEqual({
      model: 'qwen3',
      baseURL: 'http://x',
      path: '/chat/completions',
      auth: 'bearer',
    });
  });

  it('providerToConfig returns all-null for a null entry (defensive)', () => {
    expect(Providers.providerToConfig(null)).toEqual({
      model: null,
      baseURL: null,
      path: null,
      auth: null,
    });
  });
});

describe('plugin/providers.js — toEnvFormat', () => {
  it('emits one CHATGML_PROVIDER_<NAME>_* block per provider', () => {
    const env = Providers.toEnvFormat({
      providers: {
        maveros: {
          base_url: 'http://192.168.1.206:18091/v1',
          path: '/chat/completions',
          auth: 'none',
          models: [{ id: 'qwen3-27b' }, { id: 'qwen3-7b' }],
        },
      },
    });
    expect(env).toContain('CHATGML_PROVIDER_MAVEROS_BASE_URL=http://192.168.1.206:18091/v1');
    expect(env).toContain('CHATGML_PROVIDER_MAVEROS_PATH=/chat/completions');
    expect(env).toContain('CHATGML_PROVIDER_MAVEROS_AUTH=none');
    expect(env).toContain('CHATGML_PROVIDER_MAVEROS_MODELS=qwen3-27b,qwen3-7b');
    expect(env).toContain('CHATGML_PROVIDERS=maveros');
  });

  it('skips values that are unsafe for .env (contain `=`, `#`, or newlines)', () => {
    const env = Providers.toEnvFormat({
      providers: {
        bad: { base_url: 'http://x?key=secret#frag\nEVIL', models: [] },
      },
    });
    expect(env).not.toContain('CHATGML_PROVIDER_BAD_BASE_URL');
    // The summary line should still appear (provider NAME has no unsafe chars).
    expect(env).toContain('CHATGML_PROVIDERS=bad');
  });

  it('handles an empty registry without throwing', () => {
    const env = Providers.toEnvFormat({ providers: {} });
    expect(env).toContain('# Generated by ChatGML provider registry');
    expect(env).not.toContain('CHATGML_PROVIDERS=');
  });
});

describe('plugin/providers.js — registerProvider', () => {
  it('writes a new entry to the chatgml file', () => {
    const result = Providers.registerProvider({
      chatgmlPath,
      name: 'custom',
      baseUrl: 'http://custom',
      models: [{ id: 'm1' }, { id: 'm2' }],
    });
    expect(result.ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(chatgmlPath, 'utf8'));
    expect(written.providers.custom).toEqual({
      kind: 'openai_compat',
      base_url: 'http://custom',
      path: '/chat/completions',
      auth: 'bearer',
      models: [{ id: 'm1' }, { id: 'm2' }],
    });
  });

  it('updates an existing entry in place (preserves other providers)', () => {
    fs.writeFileSync(
      chatgmlPath,
      JSON.stringify({ providers: { existing: { base_url: 'http://e' } } }),
    );
    Providers.registerProvider({
      chatgmlPath,
      name: 'custom',
      baseUrl: 'http://custom',
      models: [{ id: 'm1' }],
    });
    const written = JSON.parse(fs.readFileSync(chatgmlPath, 'utf8'));
    expect(written.providers.existing).toEqual({ base_url: 'http://e' });
    expect(written.providers.custom.base_url).toBe('http://custom');
  });

  it('rejects missing chatgmlPath / name with a structured error', () => {
    const r1 = Providers.registerProvider({ chatgmlPath: '', name: 'x', baseUrl: 'y' });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/chatgmlPath/);
    const r2 = Providers.registerProvider({ chatgmlPath: '/x', name: '', baseUrl: 'y' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/name/);
  });
});

describe('plugin/providers.js — buildDatalistOptions', () => {
  it('deduplicates by value and produces one entry per unique model + baseUrl', () => {
    const reg = {
      providers: {
        a: {
          base_url: 'http://a',
          models: [{ id: 'shared', wire_model: 'X' }, { id: 'unique-a' }],
        },
        b: {
          base_url: 'http://b',
          models: [
            { id: 'shared' }, // dedup by model id
            { id: 'unique-b' },
          ],
        },
      },
    };
    const out = Providers.buildDatalistOptions(reg);
    expect(out.modelOptions.map((o) => o.value)).toEqual(['shared', 'unique-a', 'unique-b']);
    expect(out.baseUrlOptions.map((o) => o.value)).toEqual(['http://a', 'http://b']);
    // Labels include the provider name so the user knows where each entry came from.
    expect(out.modelOptions[0]?.label).toContain('a');
    expect(out.modelOptions[2]?.label).toContain('b');
  });
});

describe('plugin/providers.js — loadAll end-to-end', () => {
  it('bootstraps from external file when chatgml file is absent', () => {
    fs.writeFileSync(
      piPath,
      JSON.stringify({
        providers: {
          maveros: {
            kind: 'openai_compat',
            base_url: 'http://192.168.1.206:18091/v1',
            models: [{ id: 'qwen3-27b', wire_model: 'Qwen3.gguf', context_window: 65536 }],
          },
        },
      }),
    );
    const out = Providers.loadAll({ chatgmlPath, piPath });
    expect(out.bootstrapped).toBe(true);
    expect(out.providers).toHaveLength(1);
    expect(out.providers[0]?.name).toBe('maveros');
    expect(out.models).toHaveLength(1);
    expect(out.datalistOptions.modelOptions[0]?.value).toBe('qwen3-27b');
    expect(out.datalistOptions.baseUrlOptions[0]?.value).toBe('http://192.168.1.206:18091/v1');
    expect(fs.existsSync(chatgmlPath)).toBe(true);
  });

  it('does not bootstrap when chatgml file already exists', () => {
    fs.writeFileSync(piPath, JSON.stringify({ providers: { ext: { base_url: 'http://ext' } } }));
    fs.writeFileSync(
      chatgmlPath,
      JSON.stringify({ providers: { own: { base_url: 'http://own' } } }),
    );
    const out = Providers.loadAll({ chatgmlPath, piPath });
    expect(out.bootstrapped).toBe(false);
    // Merged registry contains BOTH providers — chatgml takes precedence on collision but
    // external entries with unique names survive.
    expect(Object.keys(out.registry.providers).sort()).toEqual(['ext', 'own']);
  });

  it('chatgml entries win on collision during merge', () => {
    fs.writeFileSync(piPath, JSON.stringify({ providers: { shared: { base_url: 'http://ext' } } }));
    fs.writeFileSync(
      chatgmlPath,
      JSON.stringify({ providers: { shared: { base_url: 'http://own' } } }),
    );
    const out = Providers.loadAll({ chatgmlPath, piPath });
    const providers = out.registry.providers as { shared: { base_url: string } };
    expect(providers.shared.base_url).toBe('http://own');
  });

  it('returns warnings when a source file is malformed but keeps the load alive', () => {
    fs.writeFileSync(chatgmlPath, JSON.stringify({ providers: { ok: { base_url: 'http://x' } } }));
    fs.writeFileSync(piPath, '{ broken');
    const out = Providers.loadAll({ chatgmlPath, piPath });
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.providers[0]?.name).toBe('ok');
  });

  it('empty registries return empty providers + empty datalists + no warnings', () => {
    const out = Providers.loadAll({
      chatgmlPath: path.join(tmpRoot, 'no-chatgml.json'),
      piPath: path.join(tmpRoot, 'no-pi.json'),
    });
    expect(out.bootstrapped).toBe(false);
    expect(out.providers).toEqual([]);
    expect(out.models).toEqual([]);
    expect(out.datalistOptions.modelOptions).toEqual([]);
    expect(out.datalistOptions.baseUrlOptions).toEqual([]);
    expect(out.warnings).toEqual([]);
  });
});

describe('plugin/settings-tasks.js — hasProviderSelection / providerDerivedCommands', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SettingsTasks = require(path.join(HERE, '../../plugin/settings-tasks.js')) as {
    hasProviderSelection: (s: Record<string, unknown>) => boolean;
    providerDerivedCommands: (s: Record<string, unknown>) => Array<[string, string]>;
  };

  it('hasProviderSelection: true when the panel stamps providerSelected: true', () => {
    expect(SettingsTasks.hasProviderSelection({ providerSelected: true })).toBe(true);
  });

  it('hasProviderSelection: true when both model and baseURL are non-empty (defensive)', () => {
    expect(SettingsTasks.hasProviderSelection({ model: 'qwen3', baseURL: 'http://x' })).toBe(true);
  });

  it('hasProviderSelection: false when only one of model / baseURL is filled', () => {
    expect(SettingsTasks.hasProviderSelection({ model: 'qwen3' })).toBe(false);
    expect(SettingsTasks.hasProviderSelection({ baseURL: 'http://x' })).toBe(false);
  });

  it('hasProviderSelection: false for null / non-object inputs', () => {
    expect(SettingsTasks.hasProviderSelection(null as unknown as Record<string, unknown>)).toBe(
      false,
    );
    expect(SettingsTasks.hasProviderSelection('string' as unknown as Record<string, unknown>)).toBe(
      false,
    );
  });

  it('providerDerivedCommands emits chat.path + chat.auth when set', () => {
    const cmds = SettingsTasks.providerDerivedCommands({
      providerSelected: true,
      path: '/api/chat',
      auth: 'bearer',
    });
    expect(cmds).toEqual([
      ['chat.path', '/api/chat'],
      ['chat.auth', 'bearer'],
    ]);
  });

  it('providerDerivedCommands skips empty / missing path and auth (no-op writes)', () => {
    expect(SettingsTasks.providerDerivedCommands({ path: '', auth: '  ' })).toEqual([]);
    expect(SettingsTasks.providerDerivedCommands({})).toEqual([]);
    expect(
      SettingsTasks.providerDerivedCommands(null as unknown as Record<string, unknown>),
    ).toEqual([]);
  });
});
