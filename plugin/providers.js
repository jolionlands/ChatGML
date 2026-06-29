// plugin/providers.js — OpenAI-compatible provider registry, shared between the GMEdit plugin
// and the chatgml core.
//
// The registry lists every provider/model the user has wired up outside ChatGML (notably
// `~/.pi/agent/providers.json`, which the user manages in their agent tooling). The plugin reads
// it on settings-open and feeds the entries to the panel as `<datalist>` options so model +
// base URL fields autocomplete from the registry while still accepting free-text input.
//
// Two registry files are consulted, in order:
//   1. `<chatgmlUserDir>/providers.json`   — ChatGML-owned copy the user can edit independently.
//                                            Created on first run by bootstrapping from (2).
//   2. `~/.pi/agent/providers.json`        — External agent's registry (read-only on our side).
//
// Both files use the same shape:
//   { "providers": { "<name>": { "kind": "openai_compat", "base_url": "...", "path": "...",
//                                "auth": "none|bearer|env", "models": [{"id": "...", ...}] } } }
//
// The module is pure (no DOM) and dependency-free except for `node:fs`/`node:path`. The same file
// is require()-able from chatgml.js (Electron renderer CJS) and from the test runner (vitest).
(function (root) {
  'use strict';

  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  /**
   * Default path to the chatgml-owned providers.json (writable). `chatgmlUserDir` is normally
   * `$XDG_CONFIG_HOME/chatgml` (~/.config/chatgml on Linux/Mac, %APPDATA%/chatgml on Windows);
   * pass it explicitly so the module stays deterministic under tests.
   */
  function defaultChatgmlProvidersPath(chatgmlUserDir) {
    if (typeof chatgmlUserDir !== 'string' || chatgmlUserDir === '') {
      // Best-effort fallback to XDG/Roaming conventions when no override is supplied.
      const xdg = process.env.XDG_CONFIG_HOME;
      if (xdg && typeof xdg === 'string') return path.join(xdg, 'chatgml', 'providers.json');
      if (process.platform === 'win32') {
        const appdata = process.env.APPDATA;
        if (appdata) return path.join(appdata, 'chatgml', 'providers.json');
      }
      return path.join(os.homedir(), '.config', 'chatgml', 'providers.json');
    }
    return path.join(chatgmlUserDir, 'providers.json');
  }

  /** Default path to the external `~/.pi/agent/providers.json` registry. */
  function defaultPiProvidersPath() {
    return path.join(os.homedir(), '.pi', 'agent', 'providers.json');
  }

  /**
   * Read + parse a providers.json file. Returns `null` for ENOENT, throws for malformed JSON
   * (the caller decides whether to surface that as a warning or fall back to an empty registry).
   */
  function readProvidersFile(filePath) {
    if (typeof filePath !== 'string' || filePath === '') return null;
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      throw e;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error('providers.json at ' + filePath + ' is not valid JSON: ' + (e.message || e));
    }
    if (!parsed || typeof parsed !== 'object') return { providers: {} };
    // Normalize: accept either {providers: {...}} or a flat {<name>: ...} object so users can paste
    // either shape from external tooling.
    const outer =
      parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : parsed;
    return { providers: outer };
  }

  /**
   * Bootstrap the chatgml-owned providers.json from the external ~/.pi/agent/providers.json when
   * the chatgml file is absent. Always returns the parsed chatgml file (either the existing copy
   * or a freshly-written copy from the external registry, or `{providers:{}}` if neither exists).
   *
   * Bootstrap is non-destructive: it NEVER overwrites an existing chatgml providers.json, so
   * manual edits the user made in the chatgml copy are preserved.
   */
  function bootstrapProviders(opts) {
    const o = opts || {};
    const chatgmlPath = o.chatgmlPath || defaultChatgmlProvidersPath(o.chatgmlUserDir);
    const piPath = o.piPath || defaultPiProvidersPath();

    // 1. If the chatgml file already exists, prefer it.
    let existing = null;
    try {
      existing = readProvidersFile(chatgmlPath);
    } catch (e) {
      // Malformed chatgml file — leave it alone, just log; do NOT silently overwrite.
      return {
        path: chatgmlPath,
        data: { providers: {} },
        bootstrapped: false,
        warning: 'could not parse chatgml providers.json: ' + (e.message || e),
      };
    }
    if (existing) {
      return { path: chatgmlPath, data: existing, bootstrapped: false };
    }

    // 2. No chatgml file — copy from the external registry if present.
    let piData = null;
    try {
      piData = readProvidersFile(piPath);
    } catch (e) {
      return {
        path: chatgmlPath,
        data: { providers: {} },
        bootstrapped: false,
        warning: 'could not parse ' + piPath + ': ' + (e.message || e),
      };
    }
    if (!piData) {
      return { path: chatgmlPath, data: { providers: {} }, bootstrapped: false };
    }

    // 3. Write the bootstrap copy so the user can edit it independently going forward.
    try {
      fs.mkdirSync(path.dirname(chatgmlPath), { recursive: true });
      fs.writeFileSync(
        chatgmlPath,
        JSON.stringify({ providers: piData.providers }, null, 2) + '\n',
      );
    } catch (e) {
      // If we can't write, return the parsed external data anyway so the in-memory registry is
      // populated for this session.
      return {
        path: chatgmlPath,
        data: { providers: piData.providers || {} },
        bootstrapped: false,
        warning: 'could not write ' + chatgmlPath + ': ' + (e.message || e),
      };
    }
    return { path: chatgmlPath, data: { providers: piData.providers || {} }, bootstrapped: true };
  }

  /**
   * Merge multiple registry sources into a single `{providers}` map. Later sources win on name
   * collision (the chatgml file overrides the external one), matching the bootstrap precedence.
   */
  function mergeRegistries(sources) {
    const out = { providers: {} };
    if (!Array.isArray(sources)) return out;
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      if (!src || !src.providers || typeof src.providers !== 'object') continue;
      const names = Object.keys(src.providers);
      for (let j = 0; j < names.length; j++) {
        out.providers[names[j]] = src.providers[names[j]];
      }
    }
    return out;
  }

  /**
   * Normalize a single provider entry to the shape we expose to the UI / .env writer. Defensive
   * against partially-populated entries — missing fields become sensible defaults rather than
   * undefined.
   */
  function normalizeProvider(name, raw) {
    if (!raw || typeof raw !== 'object') return null;
    const baseUrl = typeof raw.base_url === 'string' ? raw.base_url : '';
    const kind = typeof raw.kind === 'string' ? raw.kind : 'openai_compat';
    const auth = typeof raw.auth === 'string' ? raw.auth : 'bearer';
    const endpoint =
      typeof raw.path === 'string' && raw.path !== '' ? raw.path : '/chat/completions';
    let models = [];
    if (Array.isArray(raw.models)) {
      models = raw.models
        .filter(function (m) {
          return m && typeof m === 'object' && typeof m.id === 'string';
        })
        .map(function (m) {
          return {
            id: m.id,
            wireModel: typeof m.wire_model === 'string' ? m.wire_model : m.id,
            contextWindow: typeof m.context_window === 'number' ? m.context_window : 0,
          };
        });
    }
    return {
      name: name,
      kind: kind,
      baseUrl: baseUrl,
      endpoint: endpoint,
      auth: auth,
      models: models,
    };
  }

  /**
   * List every provider in a registry, normalized. Stable order = insertion order of the registry
   * map (which matches the file).
   */
  function listProviders(registry) {
    if (!registry || !registry.providers || typeof registry.providers !== 'object') return [];
    const out = [];
    const names = Object.keys(registry.providers);
    for (let i = 0; i < names.length; i++) {
      const norm = normalizeProvider(names[i], registry.providers[names[i]]);
      if (norm) out.push(norm);
    }
    return out;
  }

  /**
   * List every (provider, model) pair as `{providerName, modelId, wireModel, baseUrl, endpoint,
   * auth, contextWindow}`. Used to build `<datalist>` option arrays.
   */
  function listModels(registry) {
    const providers = listProviders(registry);
    const out = [];
    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      for (let j = 0; j < p.models.length; j++) {
        out.push({
          providerName: p.name,
          modelId: p.models[j].id,
          wireModel: p.models[j].wireModel,
          baseUrl: p.baseUrl,
          endpoint: p.endpoint,
          auth: p.auth,
          contextWindow: p.models[j].contextWindow,
        });
      }
    }
    return out;
  }

  /**
   * Find a provider by base URL (exact match, with optional trailing-slash tolerance). Returns
   * the first match or null. Used by the panel to show "this URL is registered as `X`" hint.
   */
  function findProviderByUrl(registry, url) {
    if (typeof url !== 'string' || url === '') return null;
    const trimmed = url.replace(/\/+$/, '');
    const providers = listProviders(registry);
    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      const norm = (p.baseUrl || '').replace(/\/+$/, '');
      if (norm === trimmed) return p;
    }
    return null;
  }

  /**
   * Find a model by its `id`. Returns `{provider, model}` (both normalized) or null.
   */
  function findModel(registry, modelId) {
    if (typeof modelId !== 'string' || modelId === '') return null;
    const providers = listProviders(registry);
    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      for (let j = 0; j < p.models.length; j++) {
        if (p.models[j].id === modelId) return { provider: p, model: p.models[j] };
      }
    }
    return null;
  }

  /**
   * Resolve the wire-level chat endpoint for a (provider, model) pair — `{baseUrl, path}`. The
   * default path is `/chat/completions` for OpenAI-compat providers, but a registry entry can
   * override it (e.g. Ollama uses `/api/chat`).
   */
  function resolveEndpoint(provider, model) {
    if (!provider) return null;
    const path2 = provider.endpoint || '/chat/completions';
    return { baseUrl: provider.baseUrl, path: path2, auth: provider.auth || 'bearer' };
  }

  /**
   * Map a single (provider, model) entry to the chatgml core's config field set. Returns a partial
   * config object (any field can be `null` to indicate "leave as-is" downstream). The plugin
   * feeds this into `chatgml config set <field> <value>` for each non-null leaf.
   *
   * @param {object} entry provider+model pair from `listModels`
   * @returns {{model:string|null, baseURL:string|null, path:string|null, auth:string|null}}
   */
  function providerToConfig(entry) {
    if (!entry) return { model: null, baseURL: null, path: null, auth: null };
    return {
      model: entry.modelId || null,
      baseURL: entry.baseUrl || null,
      path: entry.endpoint || '/chat/completions',
      auth: entry.auth || 'bearer',
    };
  }

  /**
   * Export the registry to a `.env`-style string. Used by the "Export .env" action so the user
   * can pipe chatgml-friendly variables into a `.env` file. Each provider becomes a
   * `CHATGML_PROVIDER_<UPPER_NAME>_BASE_URL` + `..._MODELS=<comma-separated>` pair, plus a
   * `CHATGML_PROVIDERS` summary listing registered provider names.
   *
   * Lines that aren't safe for .env (containing `=`, `#`, or newlines) are skipped.
   */
  function toEnvFormat(registry) {
    const providers = listProviders(registry);
    const lines = [
      '# Generated by ChatGML provider registry',
      '# Source: ' + (registry && registry.__source ? registry.__source : '(merged)'),
      '',
    ];
    const names = [];
    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      const safeName = p.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      const baseKey = 'CHATGML_PROVIDER_' + safeName + '_BASE_URL';
      const modelsKey = 'CHATGML_PROVIDER_' + safeName + '_MODELS';
      const pathKey = 'CHATGML_PROVIDER_' + safeName + '_PATH';
      const authKey = 'CHATGML_PROVIDER_' + safeName + '_AUTH';
      const modelIds = p.models.map(function (m) {
        return m.id;
      });
      if (isSafeEnvValue(p.baseUrl)) lines.push(baseKey + '=' + p.baseUrl);
      if (isSafeEnvValue(p.endpoint)) lines.push(pathKey + '=' + p.endpoint);
      if (isSafeEnvValue(p.auth)) lines.push(authKey + '=' + p.auth);
      if (modelIds.length > 0) lines.push(modelsKey + '=' + modelIds.join(','));
      names.push(p.name);
    }
    if (names.length > 0) lines.push('', 'CHATGML_PROVIDERS=' + names.join(','));
    return lines.join('\n') + '\n';
  }

  function isSafeEnvValue(v) {
    return typeof v === 'string' && v !== '' && !/[\r\n=]/.test(v) && !v.startsWith('#');
  }

  /**
   * Add or update a provider in the registry file. Writes the chatgml-owned file directly. The
   * entry shape is the same as the external registry (`{kind, base_url, path, auth, models}`) so
   * the user can hand-edit either file and the schema matches.
   *
   * Returns `{ok: true}` on success or `{ok: false, error}` on failure. Never throws.
   */
  function registerProvider(opts) {
    const o = opts || {};
    if (typeof o.chatgmlPath !== 'string' || o.chatgmlPath === '') {
      return { ok: false, error: 'chatgmlPath is required' };
    }
    if (typeof o.name !== 'string' || o.name === '') {
      return { ok: false, error: 'provider name is required' };
    }
    let current;
    try {
      current = readProvidersFile(o.chatgmlPath) || { providers: {} };
    } catch (e) {
      return { ok: false, error: 'could not read ' + o.chatgmlPath + ': ' + (e.message || e) };
    }
    const entry = {
      kind: typeof o.kind === 'string' ? o.kind : 'openai_compat',
      base_url: typeof o.baseUrl === 'string' ? o.baseUrl : '',
      path: typeof o.endpoint === 'string' && o.endpoint !== '' ? o.endpoint : '/chat/completions',
      auth: typeof o.auth === 'string' ? o.auth : 'bearer',
      models: Array.isArray(o.models) ? o.models.slice() : [],
    };
    current.providers = current.providers || {};
    current.providers[o.name] = entry;
    try {
      fs.mkdirSync(path.dirname(o.chatgmlPath), { recursive: true });
      fs.writeFileSync(o.chatgmlPath, JSON.stringify(current, null, 2) + '\n');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  /**
   * Build the datalist option arrays for a model/baseURL pair. Each option entry has the shape
   * `{value, label}` where `value` is the model id (so the input accepts the id verbatim) and
   * `label` is the human-readable suggestion (`"<id>  —  <provider> (<baseUrl>)"`). Used by the
   * panel to populate `<datalist><option/></datalist>` for the Model/Base URL inputs.
   */
  function buildDatalistOptions(registry) {
    const models = listModels(registry);
    const seen = { model: {}, baseURL: {} };
    const modelOpts = [];
    const baseUrlOpts = [];
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      if (!seen.model[m.modelId]) {
        seen.model[m.modelId] = true;
        modelOpts.push({
          value: m.modelId,
          label: m.modelId + '  —  ' + m.providerName + (m.baseUrl ? ' (' + m.baseUrl + ')' : ''),
        });
      }
      if (m.baseUrl && !seen.baseURL[m.baseUrl]) {
        seen.baseURL[m.baseUrl] = true;
        baseUrlOpts.push({
          value: m.baseUrl,
          label:
            m.baseUrl +
            '  —  ' +
            m.providerName +
            (m.contextWindow ? '  ·  ctx ' + m.contextWindow.toLocaleString() : ''),
        });
      }
    }
    return { modelOptions: modelOpts, baseUrlOptions: baseUrlOpts };
  }

  /**
   * High-level "load everything" entry point. Reads the chatgml file (bootstrapping from the
   * external one if absent), merges the external registry on top, and returns a fully-prepared
   * snapshot for the panel:
   *   `{ registry, providers, models, datalistOptions, bootstrapped, warnings }`
   *
   * The chatgml file wins on collision (user-edits survive), the external registry fills in gaps.
   * The same call is safe to invoke multiple times — files are read each time but no caching
   * happens so the user can edit the file externally and re-open settings to see updates.
   */
  function loadAll(opts) {
    const o = opts || {};
    const chatgmlPath = o.chatgmlPath || defaultChatgmlProvidersPath(o.chatgmlUserDir);
    const piPath = o.piPath || defaultPiProvidersPath();
    const warnings = [];

    const bootstrap = bootstrapProviders({
      chatgmlPath: chatgmlPath,
      piPath: piPath,
    });
    if (bootstrap.warning) warnings.push(bootstrap.warning);

    // Re-read both sources (the bootstrap only returns one — we may still want to merge both
    // even when the chatgml file exists, since the external file may have entries the chatgml
    // file doesn't).
    let chatgmlData = bootstrap.data;
    let piData = null;
    try {
      piData = readProvidersFile(piPath);
    } catch (e) {
      warnings.push('could not read ' + piPath + ': ' + (e.message || e));
    }
    const merged = mergeRegistries([piData, chatgmlData]);
    merged.__source = chatgmlPath;

    return {
      path: chatgmlPath,
      piPath: piPath,
      registry: merged,
      providers: listProviders(merged),
      models: listModels(merged),
      datalistOptions: buildDatalistOptions(merged),
      bootstrapped: bootstrap.bootstrapped,
      warnings: warnings,
    };
  }

  const api = {
    defaultChatgmlProvidersPath: defaultChatgmlProvidersPath,
    defaultPiProvidersPath: defaultPiProvidersPath,
    readProvidersFile: readProvidersFile,
    bootstrapProviders: bootstrapProviders,
    mergeRegistries: mergeRegistries,
    normalizeProvider: normalizeProvider,
    listProviders: listProviders,
    listModels: listModels,
    findProviderByUrl: findProviderByUrl,
    findModel: findModel,
    resolveEndpoint: resolveEndpoint,
    providerToConfig: providerToConfig,
    toEnvFormat: toEnvFormat,
    registerProvider: registerProvider,
    buildDatalistOptions: buildDatalistOptions,
    loadAll: loadAll,
  };

  root.ChatGmlProviders = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
