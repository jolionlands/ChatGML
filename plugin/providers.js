// plugin/providers.js — OpenAI-compatible provider registry, shared between the GMEdit plugin
// and the chatgml core.
//
// The registry lists every provider/model the user has wired up across the various agent tools
// they have installed. On settings-open we consult ALL of the following sources and merge them
// into a single canonical `{providers: {...}}` map:
//
//   1. `<chatgmlUserDir>/providers.json`   — ChatGML-owned copy the user can edit independently.
//                                            Highest priority: wins on name collision so manual
//                                            edits survive across loads.
//   2. `~/.pi/agent/providers.json`        — Pi/agent external registry (the canonical one).
//   3. `~/.config/opencode/opencode.json`  — opencode's `provider` map. Schema is different
//                                            (uses `options.baseURL` + `options.apiKey` + a
//                                            `models: {<id>: {name}}` keyed map), so we normalize.
//   4. `~/.config/crush/providers.json`    — crush's `providers` array. Each entry has rich
//                                            model metadata (cost, reasoning levels, etc.) and
//                                            uses `api_endpoint` + `api_key` instead of our
//                                            `base_url` + `auth` fields.
//   5. `~/.pi/agent/auth.json`             — API key + OAuth credentials per provider. We never
//                                            treat this as a standalone source — keys are
//                                            INJECTED into matching providers by name.
//   6. `~/.pi/agent/model_catalog.json`    — Extra model metadata (context window, costs,
//                                            reasoning flags) merged by model id into providers
//                                            we already know about.
//
// The merged registry is exposed to the panel as `<datalist>` options so model + base URL fields
// autocomplete from the full union while still accepting free-text input.
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

  /** Default path to opencode's config. Opencode follows XDG-style conventions, so on every
   * platform the primary location is `~/.config/opencode/opencode.json`. On Windows we also
   * probe `%APPDATA%/opencode/opencode.json` since some npm-installed versions write there.
   * The first existing path is returned. */
  function defaultOpencodeConfigPath() {
    const candidates = [];
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) candidates.push(path.join(xdg, 'opencode', 'opencode.json'));
    candidates.push(path.join(os.homedir(), '.config', 'opencode', 'opencode.json'));
    if (process.platform === 'win32') {
      const appdata = process.env.APPDATA;
      if (appdata) candidates.push(path.join(appdata, 'opencode', 'opencode.json'));
    }
    for (let i = 0; i < candidates.length; i++) {
      try {
        if (fs.existsSync(candidates[i])) return candidates[i];
      } catch (e) {
        /* best-effort */
      }
    }
    return candidates[0];
  }

  /** Default path to crush's `providers.json` (array shape). Crush follows XDG conventions
   * too, so the same dual-location pattern applies. */
  function defaultCrushProvidersPath() {
    const candidates = [];
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) candidates.push(path.join(xdg, 'crush', 'providers.json'));
    candidates.push(path.join(os.homedir(), '.config', 'crush', 'providers.json'));
    if (process.platform === 'win32') {
      const appdata = process.env.APPDATA;
      if (appdata) candidates.push(path.join(appdata, 'crush', 'providers.json'));
    }
    for (let i = 0; i < candidates.length; i++) {
      try {
        if (fs.existsSync(candidates[i])) return candidates[i];
      } catch (e) {
        /* best-effort */
      }
    }
    return candidates[0];
  }

  /** Default path to the auth.json credentials store. */
  function defaultAuthJsonPath() {
    return path.join(os.homedir(), '.pi', 'agent', 'auth.json');
  }

  /** Default path to the model_catalog.json metadata registry. */
  function defaultModelCatalogPath() {
    return path.join(os.homedir(), '.pi', 'agent', 'model_catalog.json');
  }

  /**
   * Read + parse a providers.json file. Returns `null` for ENOENT, throws for malformed JSON
   * (the caller decides whether to surface that as a warning or fall back to an empty registry).
   * Strips a UTF-8 BOM if present (common when files are hand-edited on Windows or written by
   * tools that prepend `﻿`).
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
    // Strip UTF-8 BOM if present so JSON.parse doesn't choke on the leading 0xEF 0xBB 0xBF.
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
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

  // -------------------------------------------------------------------------
  // External source loaders
  //
  // Each loader reads its file and normalizes the schema into the canonical
  // `{providers: {<name>: {kind, base_url, path, auth, models: [...]}}}` shape.
  // They are pure-ish (file I/O only) and never throw — they return an empty
  // object on missing files and accumulate a `warning` string on parse errors
  // so `loadAll()` can surface them to the panel.
  // -------------------------------------------------------------------------

  /**
   * Read opencode's `opencode.json` and extract its `provider` map.
   *
   * Opencode schema:
   *   { "provider": { "<name>": { "npm": "@ai-sdk/openai-compatible",
   *                                "name": "<display>",
   *                                "options": { "baseURL": "...", "apiKey": "..." },
   *                                "models": { "<id>": { "name": "<display>", ... } } } } }
   *
   * We normalize to our shape, inferring `kind` from the `npm` field, treating any model with
   * a `provider` map entry as having `base_url = options.baseURL`. API keys are intentionally
   * NOT persisted in the registry — they're surfaced via the auth-source merge instead so they
   * stay in one place.
   *
   * Returns `{providers, warning}`. `providers` may be empty if the file is absent or has no
   * `provider` key.
   */
  function readOpencodeConfig(filePath) {
    if (typeof filePath !== 'string' || filePath === '') {
      return { providers: {}, warning: null };
    }
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { providers: {}, warning: null };
      return { providers: {}, warning: 'could not read ' + filePath + ': ' + (e.message || e) };
    }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        providers: {},
        warning: 'opencode.json at ' + filePath + ' is not valid JSON: ' + (e.message || e),
      };
    }
    if (!parsed || typeof parsed !== 'object') return { providers: {}, warning: null };
    const provMap = parsed.provider;
    if (!provMap || typeof provMap !== 'object') return { providers: {}, warning: null };

    const out = {};
    const names = Object.keys(provMap);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const entry = provMap[name];
      if (!entry || typeof entry !== 'object') continue;
      const opts = entry.options && typeof entry.options === 'object' ? entry.options : {};
      const baseUrl = typeof opts.baseURL === 'string' ? opts.baseURL : '';
      if (baseUrl === '') continue;
      // Anthropic-style providers use a different protocol — skip them in the OpenAI-compat
      // registry. They can still be configured manually via the free-text fields.
      const npm = typeof entry.npm === 'string' ? entry.npm : '';
      const kind = npm.indexOf('anthropic') >= 0 ? 'anthropic' : 'openai_compat';
      // API key may be a string OR a `{env: NAME}` reference — both stay as the literal value
      // here; the auth-source loader handles the env reference at usage time.
      const apiKey =
        typeof opts.apiKey === 'string' && opts.apiKey !== '' ? opts.apiKey : undefined;
      const models = [];
      if (entry.models && typeof entry.models === 'object' && !Array.isArray(entry.models)) {
        const modelIds = Object.keys(entry.models);
        for (let j = 0; j < modelIds.length; j++) {
          const id = modelIds[j];
          const m = entry.models[id];
          // opencode model entries are `{name, ...}` — we use the id as the wire id and the
          // name as the wire_model (since opencode doesn't distinguish).
          if (m && typeof m === 'object') {
            models.push({
              id: id,
              wire_model: typeof m.name === 'string' ? m.name : id,
              context_window:
                typeof m.limit === 'object' && m.limit && typeof m.limit.context === 'number'
                  ? m.limit.context
                  : 0,
            });
          } else {
            models.push({ id: id });
          }
        }
      }
      out[name] = {
        kind: kind,
        base_url: baseUrl,
        path: '/chat/completions',
        // If the user has the literal key inline, prefer it; otherwise fall back to `env` so
        // the .env export can show `auth=env`. We never leak the literal key into the file.
        auth: apiKey ? 'bearer' : 'env',
        models: models,
        _source: 'opencode',
      };
    }
    return { providers: out, warning: null };
  }

  /**
   * Read crush's `providers.json` (array schema).
   *
   * Crush schema:
   *   [ { "name": "<display>", "id": "<key>", "api_key": "$ENV_VAR",
   *       "api_endpoint": "https://...", "type": "openai-compat|anthropic|google",
   *       "default_large_model_id": "...", "default_small_model_id": "...",
   *       "models": [ { "id": "...", "name": "...", "context_window": N,
   *                      "can_reason": bool, "supports_attachments": bool, ... } ] } ]
   *
   * The `api_key` is usually a `$ENV_VAR` reference — we extract the env var name and stash it
   * so the auth-source loader can resolve it. Literal keys (rare in crush) are preserved as
   * bearer tokens.
   *
   * Returns `{providers, warning}`. Crush may also have a top-level `{providers: [...]}` wrapper
   * in some versions; we accept both.
   */
  function readCrushProviders(filePath) {
    if (typeof filePath !== 'string' || filePath === '') {
      return { providers: {}, warning: null };
    }
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { providers: {}, warning: null };
      return { providers: {}, warning: 'could not read ' + filePath + ': ' + (e.message || e) };
    }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        providers: {},
        warning: 'crush providers.json at ' + filePath + ' is not valid JSON: ' + (e.message || e),
      };
    }
    let arr;
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (parsed && Array.isArray(parsed.providers)) {
      arr = parsed.providers;
    } else {
      return { providers: {}, warning: null };
    }

    const out = {};
    for (let i = 0; i < arr.length; i++) {
      const entry = arr[i];
      if (!entry || typeof entry !== 'object') continue;
      const key = typeof entry.id === 'string' && entry.id !== '' ? entry.id : entry.name;
      if (typeof key !== 'string' || key === '') continue;
      const endpoint = typeof entry.api_endpoint === 'string' ? entry.api_endpoint : '';
      if (endpoint === '') continue;
      const typeStr = typeof entry.type === 'string' ? entry.type : 'openai-compat';
      const kind = typeStr.indexOf('anthropic') >= 0 ? 'anthropic' : 'openai_compat';
      // api_key is typically `$ENV_VAR`. If it doesn't start with $, it's a literal key
      // (uncommon — crush treats literal keys as anti-patterns).
      const apiKeyField = typeof entry.api_key === 'string' ? entry.api_key : '';
      const envMatch = /^\$([A-Z_][A-Z0-9_]*)$/.exec(apiKeyField);
      const auth =
        envMatch !== null
          ? 'env'
          : apiKeyField !== ''
            ? 'bearer'
            : 'env';
      const envVar = envMatch !== null ? envMatch[1] : '';
      const models = [];
      if (Array.isArray(entry.models)) {
        for (let j = 0; j < entry.models.length; j++) {
          const m = entry.models[j];
          if (!m || typeof m !== 'object' || typeof m.id !== 'string') continue;
          models.push({
            id: m.id,
            wire_model: typeof m.name === 'string' ? m.name : m.id,
            context_window: typeof m.context_window === 'number' ? m.context_window : 0,
            can_reason: m.can_reason === true,
            supports_attachments: m.supports_attachments === true,
            cost_per_1m_in: typeof m.cost_per_1m_in === 'number' ? m.cost_per_1m_in : undefined,
            cost_per_1m_out:
              typeof m.cost_per_1m_out === 'number' ? m.cost_per_1m_out : undefined,
          });
        }
      }
      const providerObj = {
        kind: kind,
        base_url: endpoint,
        path: '/chat/completions',
        auth: auth,
        models: models,
        _source: 'crush',
      };
      if (envVar !== '') providerObj._envVar = envVar;
      out[key] = providerObj;
    }
    return { providers: out, warning: null };
  }

  /**
   * Read the auth.json credentials store and produce a `{<name>: {apiKey, envVar, authType}}`
   * map keyed by provider name. The same loader handles both `api_key` and `oauth` entries:
   *   - `api_key`  → `{auth: 'bearer', apiKey, envVar?}` (envVar set when key starts with `env:`)
   *   - `oauth`    → `{auth: 'oauth', apiKey: <access_token>}` (we don't refresh tokens here)
   *
   * The map is consumed by `enrichWithAuth(registry, authMap)` which copies the credentials
   * onto provider entries that share the same name.
   *
   * Returns `{auth, warning}`. `auth` is always an object (possibly empty) so callers don't
   * need to null-check.
   */
  function readAuthFile(filePath) {
    if (typeof filePath !== 'string' || filePath === '') {
      return { auth: {}, warning: null };
    }
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { auth: {}, warning: null };
      return { auth: {}, warning: 'could not read ' + filePath + ': ' + (e.message || e) };
    }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        auth: {},
        warning: 'auth.json at ' + filePath + ' is not valid JSON: ' + (e.message || e),
      };
    }
    if (!parsed || typeof parsed !== 'object') return { auth: {}, warning: null };

    const out = {};
    const names = Object.keys(parsed);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const entry = parsed[name];
      if (!entry || typeof entry !== 'object') continue;
      const type = typeof entry.type === 'string' ? entry.type : '';
      if (type === 'api_key') {
        const key = typeof entry.key === 'string' ? entry.key : '';
        if (key === '') continue;
        const envMatch = /^env:([A-Z_][A-Z0-9_]*)$/.exec(key);
        out[name] = {
          auth: 'bearer',
          apiKey: envMatch !== null ? undefined : key,
          envVar: envMatch !== null ? envMatch[1] : '',
        };
      } else if (type === 'oauth') {
        const access = typeof entry.access === 'string' ? entry.access : '';
        if (access === '') continue;
        out[name] = {
          auth: 'oauth',
          apiKey: access,
          envVar: '',
          refresh: typeof entry.refresh === 'string' ? entry.refresh : '',
          expires: typeof entry.expires === 'number' ? entry.expires : 0,
        };
      }
    }
    return { auth: out, warning: null };
  }

  /**
   * Read model_catalog.json and produce a `<modelId> → metadata` map. The catalog's shape is
   * a top-level array (or `{models: [...]}` wrapper) where each entry has at minimum
   * `{id, name, context_window}` and may also have cost / reasoning metadata.
   *
   * This map is consumed by `enrichWithCatalog(registry, catalog)` which looks up each
   * provider's models and stamps the richer metadata onto them. Models that the catalog knows
   * about but we don't (yet) get added as orphan entries for surfacing in the panel.
   */
  function readModelCatalog(filePath) {
    if (typeof filePath !== 'string' || filePath === '') {
      return { catalog: {}, warning: null };
    }
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { catalog: {}, warning: null };
      return { catalog: {}, warning: 'could not read ' + filePath + ': ' + (e.message || e) };
    }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        catalog: {},
        warning: 'model_catalog.json at ' + filePath + ' is not valid JSON: ' + (e.message || e),
      };
    }
    let arr;
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (parsed && Array.isArray(parsed.models)) {
      arr = parsed.models;
    } else if (parsed && typeof parsed === 'object') {
      // Some catalogs key by id directly: `{<id>: {name, ...}}`.
      arr = Object.keys(parsed)
        .filter(function (k) {
          return parsed[k] && typeof parsed[k] === 'object';
        })
        .map(function (k) {
          const e = parsed[k];
          return Object.assign({ id: k }, e);
        });
    } else {
      return { catalog: {}, warning: null };
    }
    const out = {};
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i];
      if (!m || typeof m !== 'object' || typeof m.id !== 'string') continue;
      out[m.id] = {
        name: typeof m.name === 'string' ? m.name : m.id,
        contextWindow: typeof m.context_window === 'number' ? m.context_window : 0,
        canReason: m.can_reason === true,
        supportsAttachments: m.supports_attachments === true,
      };
    }
    return { catalog: out, warning: null };
  }

  /**
   * Inject API-key + auth metadata from the auth-file map into provider entries. Keys are matched
   * by provider NAME (case-sensitive). When a provider has both an entry in the auth map and an
   * entry in the registry, the registry entry's `auth` field is upgraded:
   *
   *   - `auth: 'oauth'` if the auth entry is oauth (no apiKey persisted; `auth: oauth` flag)
   *   - `auth: 'bearer'` + `apiKey` set if the auth entry has a literal key
   *   - `auth: 'env'` + `envVar` set if the auth entry references an env var
   *
   * Returns the enriched registry (the input is also mutated in place — convenience for callers
   * that prefer that style).
   */
  function enrichWithAuth(registry, authMap) {
    if (!registry || !registry.providers || typeof registry.providers !== 'object') return registry;
    if (!authMap || typeof authMap !== 'object') return registry;
    const names = Object.keys(registry.providers);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const entry = authMap[name];
      if (!entry) continue;
      const prov = registry.providers[name];
      if (!prov || typeof prov !== 'object') continue;
      if (entry.auth === 'oauth') {
        prov.auth = 'oauth';
        if (entry.apiKey) prov.apiKey = entry.apiKey;
        if (entry.refresh) prov.refreshToken = entry.refresh;
        if (entry.expires) prov.tokenExpires = entry.expires;
      } else if (entry.auth === 'bearer') {
        if (entry.apiKey) {
          prov.auth = 'bearer';
          prov.apiKey = entry.apiKey;
        } else if (entry.envVar) {
          prov.auth = 'env';
          prov.envVar = entry.envVar;
        }
      }
    }
    return registry;
  }

  /**
   * Enrich model entries with catalog metadata. For each (provider, model) pair we look up the
   * model id in the catalog and copy `contextWindow` (if missing), `canReason`, and
   * `supportsAttachments` onto the model object. We also add orphan catalog entries (models the
   * catalog knows about but no provider currently exposes) into a synthetic `_orphan` provider
   * so the panel surfaces them but they're clearly not actionable without an explicit URL.
   *
   * @param {object} registry the registry to enrich
   * @param {object} catalog map of `<modelId> → metadata`
   * @returns {object} the enriched registry
   */
  function enrichWithCatalog(registry, catalog) {
    if (!registry || !registry.providers || typeof registry.providers !== 'object') return registry;
    if (!catalog || typeof catalog !== 'object') return registry;

    // 1. Enrich existing models.
    const names = Object.keys(registry.providers);
    const knownIds = new Set();
    for (let i = 0; i < names.length; i++) {
      const prov = registry.providers[names[i]];
      if (!prov || !Array.isArray(prov.models)) continue;
      for (let j = 0; j < prov.models.length; j++) {
        const m = prov.models[j];
        if (!m || typeof m !== 'object' || typeof m.id !== 'string') continue;
        knownIds.add(m.id);
        const meta = catalog[m.id];
        if (!meta) continue;
        if (typeof m.context_window !== 'number' || m.context_window === 0) {
          if (meta.contextWindow > 0) m.context_window = meta.contextWindow;
        }
        if (meta.canReason) m.can_reason = true;
        if (meta.supportsAttachments) m.supports_attachments = true;
      }
    }

    // 2. Surface orphan catalog entries (no matching provider) so the user can see what's
    //    available even when their registry isn't fully populated.
    const catalogIds = Object.keys(catalog);
    const orphanIds = catalogIds.filter(function (id) {
      return !knownIds.has(id);
    });
    if (orphanIds.length > 0) {
      registry.providers._orphan = {
        kind: 'openai_compat',
        base_url: '',
        path: '/chat/completions',
        auth: 'env',
        models: orphanIds
          .sort()
          .slice(0, 100) // hard cap so a noisy catalog doesn't dump 1000 rows
          .map(function (id) {
            const m = catalog[id];
            return {
              id: id,
              wire_model: m.name || id,
              context_window: m.contextWindow || 0,
              can_reason: m.canReason || false,
              supports_attachments: m.supportsAttachments || false,
            };
          }),
        _source: 'catalog-orphan',
        _orphan: true,
      };
    }
    return registry;
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
   *   `{ registry, providers, models, datalistOptions, sources, bootstrapped, warnings }`
   *
   * Merge precedence (lowest → highest):
   *   1. `~/.pi/agent/providers.json`          (canonical pi registry)
   *   2. `~/.config/opencode/opencode.json`    (opencode provider map)
   *   3. `~/.config/crush/providers.json`      (crush providers array)
   *   4. `~/.pi/agent/model_catalog.json`      (model metadata enrichment + orphan surfacing)
   *   5. `~/.pi/agent/auth.json`               (API key + oauth injection)
   *   6. `<chatgmlUserDir>/providers.json`     (chatgml-owned, user-edits win)
   *
   * The chatgml file wins on collision (user-edits survive), every external source fills in gaps.
   * The same call is safe to invoke multiple times — files are read each time but no caching
   * happens so the user can edit the file externally and re-open settings to see updates.
   *
   * The returned `sources` array records which external files contributed entries, so the panel
   * can show a "Bootstrapped from: pi, opencode, crush" badge for transparency.
   */
  function loadAll(opts) {
    const o = opts || {};
    const chatgmlPath = o.chatgmlPath || defaultChatgmlProvidersPath(o.chatgmlUserDir);
    const piPath = o.piPath || defaultPiProvidersPath();
    const opencodePath = o.opencodePath || defaultOpencodeConfigPath();
    const crushPath = o.crushPath || defaultCrushProvidersPath();
    const authPath = o.authPath || defaultAuthJsonPath();
    const catalogPath = o.catalogPath || defaultModelCatalogPath();
    const warnings = [];
    const sources = [];

    // 1. Bootstrap the chatgml file from pi.json if absent (preserves any existing chatgml copy).
    const bootstrap = bootstrapProviders({
      chatgmlPath: chatgmlPath,
      piPath: piPath,
    });
    if (bootstrap.warning) warnings.push(bootstrap.warning);

    // 2. Load each external source independently.
    let pi = null;
    try {
      pi = readProvidersFile(piPath);
    } catch (e) {
      warnings.push('could not read ' + piPath + ': ' + (e.message || e));
    }
    if (pi) sources.push({ name: 'pi', path: piPath, count: Object.keys(pi.providers || {}).length });

    const oc = readOpencodeConfig(opencodePath);
    if (oc.warning) warnings.push(oc.warning);
    if (oc.providers && Object.keys(oc.providers).length > 0) {
      sources.push({
        name: 'opencode',
        path: opencodePath,
        count: Object.keys(oc.providers).length,
      });
    }

    const cr = readCrushProviders(crushPath);
    if (cr.warning) warnings.push(cr.warning);
    if (cr.providers && Object.keys(cr.providers).length > 0) {
      sources.push({
        name: 'crush',
        path: crushPath,
        count: Object.keys(cr.providers).length,
      });
    }

    const cat = readModelCatalog(catalogPath);
    if (cat.warning) warnings.push(cat.warning);

    const auth = readAuthFile(authPath);
    if (auth.warning) warnings.push(auth.warning);

    // 3. Merge in priority order: pi → opencode → crush → chatgml (chatgml wins).
    const merged = mergeRegistries([pi, oc, cr, bootstrap.data]);
    merged.__source = chatgmlPath;

    // 4. Enrich with auth (in-place; never overwrites an existing `auth: 'none'`).
    enrichWithAuth(merged, auth.auth);

    // 5. Enrich with catalog metadata + surface orphan models.
    enrichWithCatalog(merged, cat.catalog);

    // 6. Compute the provider count for the panel badge (excluding the synthetic _orphan row).
    const allNames = Object.keys(merged.providers);
    const realCount = allNames.filter(function (n) {
      return n !== '_orphan';
    }).length;

    return {
      path: chatgmlPath,
      piPath: piPath,
      opencodePath: opencodePath,
      crushPath: crushPath,
      authPath: authPath,
      catalogPath: catalogPath,
      registry: merged,
      providers: listProviders(merged),
      models: listModels(merged),
      datalistOptions: buildDatalistOptions(merged),
      sources: sources,
      providerCount: realCount,
      bootstrapped: bootstrap.bootstrapped,
      warnings: warnings,
    };
  }

  const api = {
    defaultChatgmlProvidersPath: defaultChatgmlProvidersPath,
    defaultPiProvidersPath: defaultPiProvidersPath,
    defaultOpencodeConfigPath: defaultOpencodeConfigPath,
    defaultCrushProvidersPath: defaultCrushProvidersPath,
    defaultAuthJsonPath: defaultAuthJsonPath,
    defaultModelCatalogPath: defaultModelCatalogPath,
    readProvidersFile: readProvidersFile,
    bootstrapProviders: bootstrapProviders,
    mergeRegistries: mergeRegistries,
    readOpencodeConfig: readOpencodeConfig,
    readCrushProviders: readCrushProviders,
    readAuthFile: readAuthFile,
    readModelCatalog: readModelCatalog,
    enrichWithAuth: enrichWithAuth,
    enrichWithCatalog: enrichWithCatalog,
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
