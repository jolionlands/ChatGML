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
  authAliasesForProvider: (name: string, raw?: unknown) => string[];
  providerEnvVarHint: (name: string, raw?: unknown) => string;
  findProviderForConfig: (
    registry: { providers?: Record<string, unknown> },
    config: { model?: string; baseURL?: string; providerName?: string },
  ) => { name: string; raw: unknown; score: number } | null;
  resolveAuthForConfig: (
    registry: { providers?: Record<string, unknown> },
    config: { model?: string; baseURL?: string; apiKey?: string },
    env?: Record<string, string>,
  ) => {
    providerName: string;
    authState: string;
    authSource: string;
    envVar: string;
    envVars: string[];
    extraEnv: Record<string, string>;
  };
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
  loadAll: (opts: {
    chatgmlPath?: string;
    piPath?: string;
    opencodePath?: string;
    crushPath?: string;
    authPath?: string;
    catalogPath?: string;
    chatgmlUserDir?: string;
  }) => {
    path: string;
    piPath: string;
    opencodePath: string;
    crushPath: string;
    authPath: string;
    catalogPath: string;
    registry: { providers: Record<string, unknown>; __source?: string };
    providers: Array<{ name: string; models: unknown[] }>;
    models: Array<{ providerName: string; modelId: string }>;
    datalistOptions: {
      modelOptions: Array<{ value: string; label: string }>;
      baseUrlOptions: Array<{ value: string; label: string }>;
    };
    sources: Array<{ name: string; path: string; count: number }>;
    providerCount: number;
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

  it('strips a leading UTF-8 BOM (common on hand-edited Windows files)', () => {
    // Write BOM (0xEF 0xBB 0xBF) + valid JSON.
    fs.writeFileSync(
      chatgmlPath,
      '﻿' + JSON.stringify({ providers: { x: { base_url: 'http://x' } } }),
    );
    const out = Providers.readProvidersFile(chatgmlPath);
    expect(out).not.toBeNull();
    expect((out as { providers: Record<string, unknown> }).providers.x).toBeDefined();
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
      authState: 'none',
      envVar: '',
      envVars: [],
      source: '',
      usable: true,
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
      authState: 'missing',
      envVar: '',
      envVars: [],
      source: '',
      usable: true,
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
      authState: 'missing',
      envVar: '',
      envVars: [],
      usable: true,
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

  it('findProviderForConfig matches by selected base URL and model', () => {
    const hit = Providers.findProviderForConfig(reg, {
      baseURL: 'https://api.openai.com/v1/',
      model: 'gpt-4o',
    });
    expect(hit?.name).toBe('openai');
  });

  it('resolveAuthForConfig uses provider env vars for the selected Kimi Code provider', () => {
    const registry = {
      providers: {
        'kimi-coding': {
          base_url: 'https://api.kimi.com/coding/v1',
          auth: 'env',
          envVar: 'KIMI_API_KEY',
          envVars: ['KIMI_API_KEY', 'KIMI_CODE_API_KEY'],
          models: [{ id: 'kimi-for-coding' }],
        },
      },
    };
    const auth = Providers.resolveAuthForConfig(
      registry,
      { baseURL: 'https://api.kimi.com/coding/v1', model: 'kimi-for-coding' },
      { KIMI_API_KEY: 'secret' },
    );
    expect(auth.providerName).toBe('kimi-coding');
    expect(auth.authState).toBe('env ref');
    expect(auth.authSource).toBe('env:KIMI_API_KEY');
    expect(auth.extraEnv.CHATGML_CHAT_API_KEY).toBe('secret');
  });

  it('resolveAuthForConfig bridges literal local auth only through extra env', () => {
    const registry = {
      providers: {
        'kimi-coding': {
          base_url: 'https://api.kimi.com/coding/v1',
          auth: 'bearer',
          apiKey: 'pi-secret',
          models: [{ id: 'kimi-for-coding' }],
        },
      },
    };
    const auth = Providers.resolveAuthForConfig(registry, {
      baseURL: 'https://api.kimi.com/coding/v1',
      model: 'kimi-for-coding',
    });
    expect(auth.authState).toBe('key found');
    expect(auth.envVar).toBe('KIMI_API_KEY');
    expect(auth.extraEnv.KIMI_API_KEY).toBe('pi-secret');
    expect(auth.extraEnv.CHATGML_CHAT_API_KEY).toBe('pi-secret');
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
  // Helper: pass explicit empty paths for every external source so these legacy tests stay
  // isolated from the user's real config files on disk.
  function isolatedLoad(overrides: { chatgmlPath: string; piPath: string; [k: string]: string }) {
    const noPath = (p: string) => path.join(tmpRoot, p);
    return Providers.loadAll({
      chatgmlPath: overrides.chatgmlPath,
      piPath: overrides.piPath,
      opencodePath: overrides.opencodePath ?? noPath('no-opencode.json'),
      crushPath: overrides.crushPath ?? noPath('no-crush.json'),
      authPath: overrides.authPath ?? noPath('no-auth.json'),
      catalogPath: overrides.catalogPath ?? noPath('no-catalog.json'),
    });
  }

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
    const out = isolatedLoad({ chatgmlPath, piPath });
    expect(out.bootstrapped).toBe(true);
    expect(out.providers.map((p) => p.name)).toEqual(
      expect.arrayContaining(['maveros', 'kimi-coding', 'openrouter']),
    );
    expect(out.models.map((m) => m.modelId)).toContain('qwen3-27b');
    expect(out.datalistOptions.modelOptions.map((o) => o.value)).toContain('qwen3-27b');
    expect(out.datalistOptions.baseUrlOptions.map((o) => o.value)).toContain(
      'http://192.168.1.206:18091/v1',
    );
    expect(fs.existsSync(chatgmlPath)).toBe(true);
  });

  it('does not bootstrap when chatgml file already exists', () => {
    fs.writeFileSync(piPath, JSON.stringify({ providers: { ext: { base_url: 'http://ext' } } }));
    fs.writeFileSync(
      chatgmlPath,
      JSON.stringify({ providers: { own: { base_url: 'http://own' } } }),
    );
    const out = isolatedLoad({ chatgmlPath, piPath });
    expect(out.bootstrapped).toBe(false);
    // Merged registry contains BOTH providers — chatgml takes precedence on collision but
    // external entries with unique names survive.
    expect(Object.keys(out.registry.providers)).toEqual(
      expect.arrayContaining(['ext', 'own', 'kimi-coding', 'openrouter']),
    );
  });

  it('chatgml entries win on collision during merge', () => {
    fs.writeFileSync(piPath, JSON.stringify({ providers: { shared: { base_url: 'http://ext' } } }));
    fs.writeFileSync(
      chatgmlPath,
      JSON.stringify({ providers: { shared: { base_url: 'http://own' } } }),
    );
    const out = isolatedLoad({ chatgmlPath, piPath });
    const providers = out.registry.providers as { shared: { base_url: string } };
    expect(providers.shared.base_url).toBe('http://own');
  });

  it('returns warnings when a source file is malformed but keeps the load alive', () => {
    fs.writeFileSync(chatgmlPath, JSON.stringify({ providers: { ok: { base_url: 'http://x' } } }));
    fs.writeFileSync(piPath, '{ broken');
    const out = isolatedLoad({ chatgmlPath, piPath });
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(out.providers[0]?.name).toBe('ok');
  });

  it('empty registries return curated providers + datalists + no warnings', () => {
    const out = isolatedLoad({
      chatgmlPath: path.join(tmpRoot, 'no-chatgml.json'),
      piPath: path.join(tmpRoot, 'no-pi.json'),
    });
    expect(out.bootstrapped).toBe(false);
    expect(out.providers.map((p) => p.name)).toEqual(
      expect.arrayContaining([
        'kimi-coding',
        'kimi-moonshot',
        'opencode-go',
        'openrouter',
        'minimax-openai',
        'maveros-lan',
      ]),
    );
    expect(out.models.map((m) => m.modelId)).toContain('minimax/minimax-m3');
    expect(out.datalistOptions.modelOptions.map((o) => o.value)).toContain('MiniMax-M3');
    expect(out.datalistOptions.baseUrlOptions.map((o) => o.value)).toContain(
      'https://openrouter.ai/api/v1',
    );
    expect(out.warnings).toEqual([]);
  });
});

describe('plugin/providers.js — readOpencodeConfig', () => {
  let opencodePath: string;
  beforeEach(() => {
    opencodePath = path.join(tmpRoot, 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodePath), { recursive: true });
  });

  it('normalizes opencode provider entries to the chatgml shape', () => {
    fs.writeFileSync(
      opencodePath,
      JSON.stringify({
        provider: {
          nvidia: {
            npm: '@ai-sdk/openai-compatible',
            name: 'NVIDIA NIM',
            options: {
              baseURL: 'https://integrate.api.nvidia.com/v1',
              apiKey: 'nvapi-secret',
            },
            models: {
              'meta/llama-3.1-70b': { name: 'Llama 3.1 70B' },
              'baai/bge-m3': { name: 'BGE M3' },
            },
          },
          kimi: {
            npm: '@ai-sdk/openai-compatible',
            options: {
              baseURL: 'https://api.kimi.com/coding/v1',
            },
            models: {
              'kimi-for-coding': { name: 'Kimi K2.6' },
            },
          },
        },
      }),
    );
    const out = Providers.readOpencodeConfig(opencodePath);
    expect(out.warning).toBeNull();
    expect(Object.keys(out.providers)).toEqual(['nvidia', 'kimi']);
    const nvidia = out.providers.nvidia as {
      kind: string;
      base_url: string;
      auth: string;
      models: Array<{ id: string; wire_model: string }>;
    };
    expect(nvidia.kind).toBe('openai_compat');
    expect(nvidia.base_url).toBe('https://integrate.api.nvidia.com/v1');
    expect(nvidia.auth).toBe('bearer'); // had inline key
    expect(nvidia.models).toHaveLength(2);
    expect(nvidia.models[0]?.id).toBe('meta/llama-3.1-70b');
    expect(nvidia.models[0]?.wire_model).toBe('Llama 3.1 70B');
    const kimi = out.providers.kimi as { auth: string };
    expect(kimi.auth).toBe('env'); // no inline key → env reference
  });

  it('skips providers with empty baseURL', () => {
    fs.writeFileSync(
      opencodePath,
      JSON.stringify({
        provider: {
          good: { options: { baseURL: 'http://x' }, models: {} },
          bad: { options: {}, models: {} },
        },
      }),
    );
    const out = Providers.readOpencodeConfig(opencodePath);
    expect(Object.keys(out.providers)).toEqual(['good']);
  });

  it('marks anthropic-style providers separately', () => {
    fs.writeFileSync(
      opencodePath,
      JSON.stringify({
        provider: {
          claude: {
            npm: '@ai-sdk/anthropic',
            options: { baseURL: 'https://api.anthropic.com' },
            models: {},
          },
        },
      }),
    );
    const out = Providers.readOpencodeConfig(opencodePath);
    expect((out.providers.claude as { kind: string }).kind).toBe('anthropic');
  });

  it('returns empty + no warning for missing file (silent skip)', () => {
    const out = Providers.readOpencodeConfig(path.join(tmpRoot, 'nope.json'));
    expect(out).toEqual({ providers: {}, warning: null });
  });

  it('returns warning + empty for malformed JSON', () => {
    fs.writeFileSync(opencodePath, '{ broken');
    const out = Providers.readOpencodeConfig(opencodePath);
    expect(out.providers).toEqual({});
    expect(out.warning).toMatch(/not valid JSON/);
  });

  it('returns empty + no warning when there is no `provider` key', () => {
    fs.writeFileSync(opencodePath, JSON.stringify({ someOtherKey: true }));
    const out = Providers.readOpencodeConfig(opencodePath);
    expect(out).toEqual({ providers: {}, warning: null });
  });

  it('strips a leading UTF-8 BOM', () => {
    fs.writeFileSync(
      opencodePath,
      '﻿' + JSON.stringify({ provider: { x: { options: { baseURL: 'http://x' }, models: {} } } }),
    );
    const out = Providers.readOpencodeConfig(opencodePath);
    expect(out.providers.x).toBeDefined();
  });
});

describe('plugin/providers.js — readCrushProviders', () => {
  let crushPath: string;
  beforeEach(() => {
    crushPath = path.join(tmpRoot, 'crush', 'providers.json');
    fs.mkdirSync(path.dirname(crushPath), { recursive: true });
  });

  it('normalizes crush array entries to the chatgml shape', () => {
    fs.writeFileSync(
      crushPath,
      JSON.stringify([
        {
          name: 'Google Gemini',
          id: 'gemini',
          api_key: '$GEMINI_API_KEY',
          api_endpoint: 'https://generativelanguage.googleapis.com/v1beta',
          type: 'google',
          models: [
            {
              id: 'gemini-3.1-pro-preview',
              name: 'Gemini 3.1 Pro',
              context_window: 1048576,
              can_reason: true,
              supports_attachments: true,
            },
          ],
        },
        {
          name: 'OpenAI',
          id: 'openai',
          api_key: 'sk-literal-key',
          api_endpoint: 'https://api.openai.com/v1',
          type: 'openai-compat',
          models: [{ id: 'gpt-5', name: 'GPT-5', context_window: 400000 }],
        },
      ]),
    );
    const out = Providers.readCrushProviders(crushPath);
    expect(Object.keys(out.providers).sort()).toEqual(['gemini', 'openai']);
    const gemini = out.providers.gemini as {
      kind: string;
      auth: string;
      _envVar: string;
      models: Array<{ id: string; context_window: number; can_reason: boolean }>;
    };
    expect(gemini.kind).toBe('openai_compat'); // 'google' isn't 'anthropic', so treated as openai_compat
    expect(gemini.auth).toBe('env'); // $ENV_VAR pattern
    expect(gemini._envVar).toBe('GEMINI_API_KEY');
    expect(gemini.models[0]?.context_window).toBe(1048576);
    expect(gemini.models[0]?.can_reason).toBe(true);
    const openai = out.providers.openai as { auth: string };
    expect(openai.auth).toBe('bearer'); // literal key
  });

  it('accepts the {providers: [...]} wrapper shape too', () => {
    fs.writeFileSync(
      crushPath,
      JSON.stringify({
        providers: [{ id: 'x', api_endpoint: 'http://x', api_key: '$X', models: [] }],
      }),
    );
    const out = Providers.readCrushProviders(crushPath);
    expect(out.providers.x).toBeDefined();
  });

  it('skips entries with empty api_endpoint', () => {
    fs.writeFileSync(
      crushPath,
      JSON.stringify([
        { id: 'good', api_endpoint: 'http://g', api_key: '$G', models: [] },
        { id: 'bad', api_endpoint: '', api_key: '$B', models: [] },
      ]),
    );
    const out = Providers.readCrushProviders(crushPath);
    expect(Object.keys(out.providers)).toEqual(['good']);
  });

  it('returns empty + no warning for missing file', () => {
    const out = Providers.readCrushProviders(path.join(tmpRoot, 'nope.json'));
    expect(out).toEqual({ providers: {}, warning: null });
  });

  it('returns warning for malformed JSON', () => {
    fs.writeFileSync(crushPath, '[] broken');
    const out = Providers.readCrushProviders(crushPath);
    expect(out.warning).toMatch(/not valid JSON/);
  });

  it('strips a leading UTF-8 BOM', () => {
    fs.writeFileSync(crushPath, '﻿' + JSON.stringify([{ id: 'x', api_endpoint: 'http://x' }]));
    const out = Providers.readCrushProviders(crushPath);
    expect(out.providers.x).toBeDefined();
  });
});

describe('plugin/providers.js — readAuthFile', () => {
  let authPath: string;
  beforeEach(() => {
    authPath = path.join(tmpRoot, 'auth.json');
  });

  it('parses api_key entries (literal + env references)', () => {
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        nvidia: { type: 'api_key', key: 'nvapi-literal' },
        kimi: { type: 'api_key', key: 'env:KIMI_CODING_API_KEY' },
      }),
    );
    const out = Providers.readAuthFile(authPath);
    expect((out.auth.nvidia as { apiKey: string }).apiKey).toBe('nvapi-literal');
    expect((out.auth.kimi as { envVar: string; apiKey?: string }).envVar).toBe(
      'KIMI_CODING_API_KEY',
    );
    expect((out.auth.kimi as { apiKey?: string }).apiKey).toBeUndefined();
  });

  it('parses oauth entries (access + refresh + expires)', () => {
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        'google-gemini-cli': {
          type: 'oauth',
          access: 'ya29.ACCESS',
          refresh: '1//REFRESH',
          expires: 1780069941859,
        },
      }),
    );
    const out = Providers.readAuthFile(authPath);
    const entry = out.auth['google-gemini-cli'] as {
      auth: string;
      apiKey: string;
      refresh: string;
      expires: number;
    };
    expect(entry.auth).toBe('oauth');
    expect(entry.apiKey).toBe('ya29.ACCESS');
    expect(entry.refresh).toBe('1//REFRESH');
    expect(entry.expires).toBe(1780069941859);
  });

  it('skips entries with empty key / empty access', () => {
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        empty: { type: 'api_key', key: '' },
        noAccess: { type: 'oauth', access: '' },
      }),
    );
    const out = Providers.readAuthFile(authPath);
    expect(out.auth).toEqual({});
  });

  it('returns empty + no warning for missing file', () => {
    const out = Providers.readAuthFile(path.join(tmpRoot, 'nope.json'));
    expect(out).toEqual({ auth: {}, warning: null });
  });
});

describe('plugin/providers.js — readModelCatalog', () => {
  let catalogPath: string;
  beforeEach(() => {
    catalogPath = path.join(tmpRoot, 'model_catalog.json');
  });

  it('parses top-level array schema', () => {
    fs.writeFileSync(
      catalogPath,
      JSON.stringify([
        {
          id: 'gpt-5',
          name: 'GPT-5',
          context_window: 400000,
          can_reason: true,
          supports_attachments: true,
        },
        { id: 'claude-opus-4.7', name: 'Claude Opus 4.7', context_window: 200000 },
      ]),
    );
    const out = Providers.readModelCatalog(catalogPath);
    expect(out.catalog['gpt-5']?.contextWindow).toBe(400000);
    expect(out.catalog['gpt-5']?.canReason).toBe(true);
    expect(out.catalog['claude-opus-4.7']?.canReason).toBe(false); // defaulted
  });

  it('parses {models: [...]} wrapper schema', () => {
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({ models: [{ id: 'foo', name: 'Foo', context_window: 1024 }] }),
    );
    const out = Providers.readModelCatalog(catalogPath);
    expect(out.catalog.foo).toBeDefined();
  });

  it('parses keyed-by-id schema', () => {
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({ 'qwen3-coder': { name: 'Qwen3 Coder', context_window: 262144 } }),
    );
    const out = Providers.readModelCatalog(catalogPath);
    expect(out.catalog['qwen3-coder']).toBeDefined();
  });

  it('returns empty + no warning for missing file', () => {
    const out = Providers.readModelCatalog(path.join(tmpRoot, 'nope.json'));
    expect(out).toEqual({ catalog: {}, warning: null });
  });

  it('returns warning for malformed JSON', () => {
    fs.writeFileSync(catalogPath, 'not json');
    const out = Providers.readModelCatalog(catalogPath);
    expect(out.warning).toMatch(/not valid JSON/);
  });
});

describe('plugin/providers.js — enrichWithAuth', () => {
  it('injects bearer tokens for matching providers', () => {
    const registry = {
      providers: {
        nvidia: { base_url: 'http://n', auth: 'bearer', models: [] },
      },
    };
    const auth = { nvidia: { auth: 'bearer', apiKey: 'nvapi-XYZ' } };
    Providers.enrichWithAuth(registry, auth);
    expect((registry.providers.nvidia as { apiKey: string }).apiKey).toBe('nvapi-XYZ');
  });

  it('injects env var references when only envVar is set', () => {
    const registry = { providers: { kimi: { base_url: 'http://k', auth: 'bearer', models: [] } } };
    const auth = { kimi: { auth: 'bearer', envVar: 'KIMI_KEY' } };
    Providers.enrichWithAuth(registry, auth);
    expect((registry.providers.kimi as { auth: string; envVar: string }).auth).toBe('env');
    expect((registry.providers.kimi as { envVar: string }).envVar).toBe('KIMI_KEY');
  });

  it('matches local auth aliases for Kimi Code entries', () => {
    const registry = {
      providers: {
        'kimi-coding': {
          base_url: 'https://api.kimi.com/coding/v1',
          auth: 'env',
          models: [{ id: 'kimi-for-coding' }],
        },
      },
    };
    const auth = { kimi: { auth: 'bearer', envVar: 'KIMI_API_KEY' } };
    Providers.enrichWithAuth(registry, auth);
    expect((registry.providers['kimi-coding'] as { auth: string; envVar: string }).auth).toBe(
      'env',
    );
    expect((registry.providers['kimi-coding'] as { envVar: string }).envVar).toBe(
      'KIMI_API_KEY',
    );
  });

  it('marks oauth providers separately + stashes refresh/expires', () => {
    const registry = { providers: { google: { base_url: 'http://g', models: [] } } };
    const auth = {
      google: { auth: 'oauth', apiKey: 'ya29.X', refresh: '1//R', expires: 1234 },
    };
    Providers.enrichWithAuth(registry, auth);
    const g = registry.providers.google as {
      auth: string;
      apiKey: string;
      refreshToken: string;
      tokenExpires: number;
    };
    expect(g.auth).toBe('oauth');
    expect(g.apiKey).toBe('ya29.X');
    expect(g.refreshToken).toBe('1//R');
    expect(g.tokenExpires).toBe(1234);
  });

  it('leaves non-matching providers alone', () => {
    const registry = { providers: { x: { base_url: 'http://x', models: [] } } };
    Providers.enrichWithAuth(registry, { y: { auth: 'bearer', apiKey: 'z' } });
    expect((registry.providers.x as { apiKey?: string }).apiKey).toBeUndefined();
  });

  it('handles null / non-object inputs defensively', () => {
    expect(Providers.enrichWithAuth(null, {})).toBeNull();
    expect(Providers.enrichWithAuth({ providers: {} }, null)).toEqual({ providers: {} });
  });
});

describe('plugin/providers.js — enrichWithCatalog', () => {
  it('fills in contextWindow + canReason on existing models', () => {
    const registry = {
      providers: {
        nvidia: {
          base_url: 'http://n',
          models: [{ id: 'gpt-5' }], // no context_window
        },
      },
    };
    const catalog = { 'gpt-5': { name: 'GPT-5', contextWindow: 400000, canReason: true } };
    Providers.enrichWithCatalog(registry, catalog);
    const m = (
      registry.providers.nvidia as {
        models: Array<{ context_window: number; can_reason: boolean }>;
      }
    ).models[0];
    expect(m?.context_window).toBe(400000);
    expect(m?.can_reason).toBe(true);
  });

  it('does not overwrite an existing context_window (user values win)', () => {
    const registry = {
      providers: { p: { models: [{ id: 'm', context_window: 8192 }] } },
    };
    const catalog = { m: { name: 'M', contextWindow: 999999, canReason: true } };
    Providers.enrichWithCatalog(registry, catalog);
    const m = (registry.providers.p as { models: Array<{ context_window: number }> }).models[0];
    expect(m?.context_window).toBe(8192);
  });

  it('surfaces orphan catalog entries into a synthetic _orphan provider', () => {
    const registry = { providers: { known: { base_url: 'http://x', models: [{ id: 'foo' }] } } };
    const catalog = {
      foo: { name: 'Foo', contextWindow: 1000, canReason: false, supportsAttachments: false },
      bar: { name: 'Bar', contextWindow: 2000, canReason: true, supportsAttachments: true },
      baz: { name: 'Baz', contextWindow: 3000, canReason: false, supportsAttachments: false },
    };
    Providers.enrichWithCatalog(registry, catalog);
    const orphan = registry.providers._orphan as {
      models: Array<{ id: string; can_reason: boolean }>;
      _orphan: boolean;
    };
    expect(orphan._orphan).toBe(true);
    expect(orphan.models).toHaveLength(2); // bar + baz, not foo
    expect(orphan.models.map((m) => m.id).sort()).toEqual(['bar', 'baz']);
    expect(orphan.models[0]?.can_reason).toBe(true);
  });

  it('caps orphan entries at 100 to avoid noisy catalogs spamming the panel', () => {
    const registry = { providers: {} };
    const catalog: Record<string, { name: string; contextWindow: number }> = {};
    for (let i = 0; i < 500; i++) {
      catalog['model-' + i] = { name: 'Model ' + i, contextWindow: 1000 };
    }
    Providers.enrichWithCatalog(registry, catalog);
    const orphan = registry.providers._orphan as { models: unknown[] };
    expect(orphan.models).toHaveLength(100);
  });

  it('handles null / non-object inputs defensively', () => {
    expect(Providers.enrichWithCatalog(null, {})).toBeNull();
    expect(Providers.enrichWithCatalog({ providers: {} }, null)).toEqual({ providers: {} });
  });
});

describe('plugin/providers.js — loadAll multi-source merge', () => {
  let opencodePath: string;
  let crushPath: string;
  let authPath: string;
  let catalogPath: string;

  beforeEach(() => {
    opencodePath = path.join(tmpRoot, 'opencode', 'opencode.json');
    crushPath = path.join(tmpRoot, 'crush', 'providers.json');
    authPath = path.join(tmpRoot, 'auth.json');
    catalogPath = path.join(tmpRoot, 'model_catalog.json');
    fs.mkdirSync(path.dirname(opencodePath), { recursive: true });
    fs.mkdirSync(path.dirname(crushPath), { recursive: true });
  });

  it('merges pi + opencode + crush into a single registry', () => {
    fs.writeFileSync(piPath, JSON.stringify({ providers: { maveros: { base_url: 'http://m' } } }));
    fs.writeFileSync(
      opencodePath,
      JSON.stringify({
        provider: { nvidia: { options: { baseURL: 'http://n' }, models: { 'gpt-5': {} } } },
      }),
    );
    fs.writeFileSync(
      crushPath,
      JSON.stringify([{ id: 'gemini', api_endpoint: 'http://g', models: [{ id: 'gemini-3' }] }]),
    );
    const noPath = (p: string) => path.join(tmpRoot, p);
    const out = Providers.loadAll({
      chatgmlPath,
      piPath,
      opencodePath,
      crushPath,
      authPath: noPath('no-auth.json'),
      catalogPath: noPath('no-catalog.json'),
    });
    expect(Object.keys(out.registry.providers)).toEqual(
      expect.arrayContaining(['gemini', 'maveros', 'nvidia', 'kimi-coding', 'openrouter']),
    );
    expect(out.sources.map((s) => s.name).sort()).toEqual(['crush', 'opencode', 'pi']);
    expect(out.providerCount).toBe(9);
  });

  it('chatgml file wins over every external source on name collision', () => {
    fs.writeFileSync(piPath, JSON.stringify({ providers: { nvidia: { base_url: 'http://pi' } } }));
    fs.writeFileSync(
      opencodePath,
      JSON.stringify({
        provider: { nvidia: { options: { baseURL: 'http://oc' }, models: {} } },
      }),
    );
    fs.writeFileSync(
      chatgmlPath,
      JSON.stringify({ providers: { nvidia: { base_url: 'http://mine' } } }),
    );
    const noPath = (p: string) => path.join(tmpRoot, p);
    const out = Providers.loadAll({
      chatgmlPath,
      piPath,
      opencodePath,
      crushPath: noPath('no-crush.json'),
      authPath: noPath('no-auth.json'),
      catalogPath: noPath('no-catalog.json'),
    });
    expect((out.registry.providers.nvidia as { base_url: string }).base_url).toBe('http://mine');
  });

  it('injects API keys from auth.json into matching providers', () => {
    fs.writeFileSync(piPath, JSON.stringify({ providers: { nvidia: { base_url: 'http://n' } } }));
    fs.writeFileSync(authPath, JSON.stringify({ nvidia: { type: 'api_key', key: 'nvapi-XYZ' } }));
    const noPath = (p: string) => path.join(tmpRoot, p);
    const out = Providers.loadAll({
      chatgmlPath,
      piPath,
      opencodePath: noPath('no-opencode.json'),
      crushPath: noPath('no-crush.json'),
      authPath,
      catalogPath: noPath('no-catalog.json'),
    });
    expect((out.registry.providers.nvidia as { apiKey: string }).apiKey).toBe('nvapi-XYZ');
    // Ensure the auth-source isn't itself listed in sources (it's metadata, not a registry).
    expect(out.sources.find((s) => s.name === 'auth')).toBeUndefined();
  });

  it('fills context_window from model_catalog.json for known models', () => {
    fs.writeFileSync(
      piPath,
      JSON.stringify({ providers: { x: { base_url: 'http://x', models: [{ id: 'gpt-5' }] } } }),
    );
    fs.writeFileSync(
      catalogPath,
      JSON.stringify([{ id: 'gpt-5', name: 'GPT-5', context_window: 400000 }]),
    );
    const noPath = (p: string) => path.join(tmpRoot, p);
    const out = Providers.loadAll({
      chatgmlPath,
      piPath,
      opencodePath: noPath('no-opencode.json'),
      crushPath: noPath('no-crush.json'),
      authPath: noPath('no-auth.json'),
      catalogPath,
    });
    const m = (out.registry.providers.x as { models: Array<{ context_window: number }> }).models[0];
    expect(m?.context_window).toBe(400000);
  });

  it('surfaces orphan catalog models in a synthetic _orphan provider', () => {
    fs.writeFileSync(
      piPath,
      JSON.stringify({ providers: { known: { base_url: 'http://k', models: [{ id: 'foo' }] } } }),
    );
    fs.writeFileSync(
      catalogPath,
      JSON.stringify([
        { id: 'foo', name: 'Foo', context_window: 1000 },
        { id: 'orphan-model', name: 'Orphan', context_window: 2000 },
      ]),
    );
    const noPath = (p: string) => path.join(tmpRoot, p);
    const out = Providers.loadAll({
      chatgmlPath,
      piPath,
      opencodePath: noPath('no-opencode.json'),
      crushPath: noPath('no-crush.json'),
      authPath: noPath('no-auth.json'),
      catalogPath,
    });
    expect(out.registry.providers._orphan).toBeDefined();
    // providerCount excludes the synthetic orphan row so the badge shows real provider count.
    expect(out.providerCount).toBe(7);
  });

  it('returns warnings for malformed external files but keeps the load alive', () => {
    fs.writeFileSync(piPath, JSON.stringify({ providers: { ok: { base_url: 'http://x' } } }));
    fs.writeFileSync(opencodePath, '{ broken');
    fs.writeFileSync(crushPath, '[] broken');
    const noPath = (p: string) => path.join(tmpRoot, p);
    const out = Providers.loadAll({
      chatgmlPath,
      piPath,
      opencodePath,
      crushPath,
      authPath: noPath('no-auth.json'),
      catalogPath: noPath('no-catalog.json'),
    });
    expect(out.warnings.length).toBeGreaterThan(0);
    expect((out.registry.providers.ok as { base_url: string }).base_url).toBe('http://x');
  });

  it('all sources missing → curated fallbacks, no warnings, no errors', () => {
    const out = Providers.loadAll({
      chatgmlPath: path.join(tmpRoot, 'no-chatgml.json'),
      piPath: path.join(tmpRoot, 'no-pi.json'),
      opencodePath: path.join(tmpRoot, 'no-opencode.json'),
      crushPath: path.join(tmpRoot, 'no-crush.json'),
      authPath: path.join(tmpRoot, 'no-auth.json'),
      catalogPath: path.join(tmpRoot, 'no-catalog.json'),
    });
    expect(Object.keys(out.registry.providers).sort()).toEqual([
      'kimi-coding',
      'kimi-moonshot',
      'maveros-lan',
      'minimax-openai',
      'opencode-go',
      'openrouter',
    ]);
    expect(
      (out.registry.providers.openrouter as { models: Array<{ id: string }> }).models.map(
        (m) => m.id,
      ),
    ).toContain('minimax/minimax-m3');
    expect(
      (out.registry.providers['minimax-openai'] as { models: Array<{ id: string }> }).models.map(
        (m) => m.id,
      ),
    ).toContain('MiniMax-M3');
    expect(
      (out.registry.providers['kimi-moonshot'] as { models: Array<{ id: string }> }).models.map(
        (m) => m.id,
      ),
    ).toContain('kimi-k2.7-code');
    expect((out.registry.providers['kimi-coding'] as { envVar: string }).envVar).toBe(
      'KIMI_API_KEY',
    );
    expect((out.registry.providers['kimi-moonshot'] as { envVar: string }).envVar).toBe(
      'MOONSHOT_API_KEY',
    );
    expect(out.sources).toEqual([]);
    expect(out.providerCount).toBe(6);
    expect(out.warnings).toEqual([]);
  });

  it('marks the Kimi Code CLI API as usable by the OpenAI-compatible core', () => {
    const provider = Providers.normalizeProvider('kimi-coding', {
      kind: 'openai_compat',
      base_url: 'https://api.kimi.com/coding/v1',
      auth: 'env',
      models: [{ id: 'kimi-for-coding' }],
    });
    expect(provider?.usable).toBe(true);
    expect(provider?.models[0]?.wireModel).toBe('Kimi K2.7 Code (Kimi Code CLI alias)');

    const moonshot = Providers.normalizeProvider('kimi-moonshot', {
      kind: 'openai_compat',
      base_url: 'https://api.moonshot.ai/v1',
      auth: 'env',
      models: [{ id: 'kimi-k2.7-code' }],
    });
    expect(moonshot?.usable).toBe(true);
  });

  it('opencode Kimi keeps /coding/v1 when crush has a colliding name', () => {
    fs.writeFileSync(
      opencodePath,
      JSON.stringify({
        provider: {
          'kimi-coding': {
            options: { baseURL: 'https://api.kimi.com/coding/v1' },
            models: { 'kimi-for-coding': { name: 'Kimi for Coding' } },
          },
        },
      }),
    );
    fs.writeFileSync(
      crushPath,
      JSON.stringify([
        {
          id: 'kimi-coding',
          api_endpoint: 'https://api.kimi.com/coding',
          models: [{ id: 'kimi-for-coding' }],
        },
      ]),
    );
    const noPath = (p: string) => path.join(tmpRoot, p);
    const out = Providers.loadAll({
      chatgmlPath,
      piPath: noPath('no-pi.json'),
      opencodePath,
      crushPath,
      authPath: noPath('no-auth.json'),
      catalogPath: noPath('no-catalog.json'),
    });
    expect((out.registry.providers['kimi-coding'] as { base_url: string }).base_url).toBe(
      'https://api.kimi.com/coding/v1',
    );
  });

  it('crush collision enriches missing model metadata without overriding opencode URL', () => {
    fs.writeFileSync(
      opencodePath,
      JSON.stringify({
        provider: {
          shared: {
            options: { baseURL: 'https://opencode.example/v1' },
            models: { m1: { name: 'M1' } },
          },
        },
      }),
    );
    fs.writeFileSync(
      crushPath,
      JSON.stringify([
        {
          id: 'shared',
          api_endpoint: 'https://crush.example/v1',
          models: [
            { id: 'm1', context_window: 1234, can_reason: true },
            { id: 'm2', context_window: 5678 },
          ],
        },
      ]),
    );
    const noPath = (p: string) => path.join(tmpRoot, p);
    const out = Providers.loadAll({
      chatgmlPath,
      piPath: noPath('no-pi.json'),
      opencodePath,
      crushPath,
      authPath: noPath('no-auth.json'),
      catalogPath: noPath('no-catalog.json'),
    });
    const shared = out.registry.providers.shared as {
      base_url: string;
      models: Array<{ id: string; context_window?: number; can_reason?: boolean }>;
    };
    expect(shared.base_url).toBe('https://opencode.example/v1');
    expect(shared.models.find((m) => m.id === 'm1')?.context_window).toBe(1234);
    expect(shared.models.find((m) => m.id === 'm1')?.can_reason).toBe(true);
    expect(shared.models.find((m) => m.id === 'm2')?.context_window).toBe(5678);
  });

  it('chatgml file still wins over opencode and curated fallbacks', () => {
    fs.writeFileSync(
      chatgmlPath,
      JSON.stringify({ providers: { openrouter: { base_url: 'https://mine.example/v1' } } }),
    );
    const noPath = (p: string) => path.join(tmpRoot, p);
    const out = Providers.loadAll({
      chatgmlPath,
      piPath: noPath('no-pi.json'),
      opencodePath: noPath('no-opencode.json'),
      crushPath: noPath('no-crush.json'),
      authPath: noPath('no-auth.json'),
      catalogPath: noPath('no-catalog.json'),
    });
    expect((out.registry.providers.openrouter as { base_url: string }).base_url).toBe(
      'https://mine.example/v1',
    );
  });

  it('sources array reports counts per source for transparency in the panel badge', () => {
    fs.writeFileSync(
      piPath,
      JSON.stringify({ providers: { a: { base_url: 'http://a' }, b: { base_url: 'http://b' } } }),
    );
    fs.writeFileSync(
      opencodePath,
      JSON.stringify({
        provider: { c: { options: { baseURL: 'http://c' }, models: {} } },
      }),
    );
    const noPath = (p: string) => path.join(tmpRoot, p);
    const out = Providers.loadAll({
      chatgmlPath,
      piPath,
      opencodePath,
      crushPath: noPath('no-crush.json'),
      authPath: noPath('no-auth.json'),
      catalogPath: noPath('no-catalog.json'),
    });
    const pi = out.sources.find((s) => s.name === 'pi');
    const oc = out.sources.find((s) => s.name === 'opencode');
    expect(pi?.count).toBe(2);
    expect(oc?.count).toBe(1);
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

  it('providerDerivedCommands does not emit unsupported chat.path/chat.auth writes', () => {
    const cmds = SettingsTasks.providerDerivedCommands({
      providerSelected: true,
      path: '/api/chat',
      auth: 'bearer',
    });
    expect(cmds).toEqual([]);
  });

  it('providerDerivedCommands skips empty / missing path and auth (no-op writes)', () => {
    expect(SettingsTasks.providerDerivedCommands({ path: '', auth: '  ' })).toEqual([]);
    expect(SettingsTasks.providerDerivedCommands({})).toEqual([]);
    expect(
      SettingsTasks.providerDerivedCommands(null as unknown as Record<string, unknown>),
    ).toEqual([]);
  });
});
