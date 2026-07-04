// plugin/agent-packs.js - local installable coding-agent prompt packs.
(function (root) {
  'use strict';

  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const Providers = root.ChatGmlProviders || require('./providers.js');

  const BUILTIN_PACKS = [
    {
      id: 'ponytail',
      name: 'Ponytail',
      kind: 'agent-pack',
      description: 'Smallest correct code change: stdlib first, no speculative abstractions.',
      prompt:
        'Use Ponytail mode: make the smallest correct change, prefer existing code and platform features, and call out anything intentionally skipped.',
    },
    {
      id: 'superpowers',
      name: 'Superpowers',
      kind: 'agent-pack',
      description: 'Spec/plan/check workflow for larger coding tasks.',
      prompt:
        'Use the Superpowers workflow: clarify the target, keep a short implementation plan, make focused edits, and verify with concrete checks.',
    },
    {
      id: 'cline-roo',
      name: 'Cline/Roo style',
      kind: 'agent-pack',
      description: 'Plan/Act/Review coding assistant behavior with explicit context and changes.',
      prompt:
        'Work like a Cline/Roo coding agent: state the plan, use project context and tools, propose concrete edits, then summarize tests and remaining risk.',
    },
    {
      id: 'gmedit-gml',
      name: 'GMEdit GML',
      kind: 'agent-pack',
      description: 'GameMaker-focused review/debug/edit behavior.',
      prompt:
        'Use the GMEdit GML pack: inspect current object/event context, prefer safe GML edits, mention missing resources/events, and include GMEdit/GMLoop checks when useful.',
    },
  ];

  const BUILTIN_SKILLS = [
    {
      id: 'review-current-file',
      name: 'Review current file',
      kind: 'skill',
      description: 'Focused bug/risk review using current editor context.',
      prompt: 'Review the current file and call out concrete bugs, risks, and missing tests.',
    },
    {
      id: 'debug-gml-event',
      name: 'Debug GML event',
      kind: 'skill',
      description: 'GameMaker event debugger for active object/event code.',
      prompt: 'Debug the current GameMaker event using the attached file, cursor, and selection.',
    },
    {
      id: 'write-tests',
      name: 'Write focused tests',
      kind: 'skill',
      description: 'Add the smallest useful test for a code change.',
      prompt: 'Add or update the smallest focused test that would catch this change regressing.',
    },
  ];

  const BUILTIN_PLUGINS = [
    {
      id: 'chatgml-gmloop',
      name: 'GMLoop companion',
      kind: 'plugin',
      folder: 'plugin-gmloop',
      description: 'GMEdit context-menu companion for GMLoop and GMLive checks.',
      prompt:
        'Use the GMLoop companion plugin for lint, format-check, live reload, and runner checks.',
    },
    {
      id: 'chatgml-inline',
      name: 'Inline edit companion',
      kind: 'plugin',
      folder: 'plugin-inline',
      description: 'GMEdit inline edit/review companion.',
      prompt: 'Use the inline companion flow for small selected-code edits.',
    },
    {
      id: 'chatgml-explain',
      name: 'Explain companion',
      kind: 'plugin',
      folder: 'plugin-explain',
      description: 'GMEdit selected-code explanation companion.',
      prompt: 'Use the explain companion flow for selected GameMaker code.',
    },
  ];

  const BUILTIN_PROVIDERS = [
    {
      id: 'provider-kimi-coding',
      name: 'Kimi Code',
      kind: 'provider',
      description: 'Kimi coding endpoint with the kimi-for-coding model.',
      providerName: 'kimi-coding',
      provider: {
        kind: 'openai_compat',
        baseUrl: 'https://api.kimi.com/coding/v1',
        endpoint: '/chat/completions',
        auth: 'bearer',
        models: [{ id: 'kimi-for-coding' }],
      },
      prompt:
        'Use the Kimi Code provider: model kimi-for-coding at https://api.kimi.com/coding/v1.',
    },
    {
      id: 'provider-openrouter-minimax-m3',
      name: 'OpenRouter MiniMax M3',
      kind: 'provider',
      description: 'OpenRouter route for MiniMax M3.',
      providerName: 'openrouter',
      provider: {
        kind: 'openai_compat',
        baseUrl: 'https://openrouter.ai/api/v1',
        endpoint: '/chat/completions',
        auth: 'bearer',
        models: [{ id: 'minimax/minimax-m3' }],
      },
      prompt:
        'Use OpenRouter MiniMax M3: model minimax/minimax-m3 via https://openrouter.ai/api/v1.',
    },
  ];

  function configDir() {
    if (process.env.CHATGML_CONFIG_DIR) return process.env.CHATGML_CONFIG_DIR;
    if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'chatgml');
    if (process.platform === 'win32' && process.env.APPDATA)
      return path.join(process.env.APPDATA, 'chatgml');
    return path.join(os.homedir(), '.config', 'chatgml');
  }

  function userDir() {
    if (process.env.CHATGML_AGENT_PACKS_DIR) return process.env.CHATGML_AGENT_PACKS_DIR;
    return path.join(configDir(), 'agent-packs');
  }

  function manifestDir(kind, dir) {
    if (dir) return dir;
    if (kind === 'agent-pack') return userDir();
    return path.join(configDir(), 'marketplace', kind + 's');
  }

  function defaultPluginsDir() {
    if (process.env.CHATGML_GMEDIT_PLUGINS_DIR) return process.env.CHATGML_GMEDIT_PLUGINS_DIR;
    if (process.platform === 'win32') {
      return path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'AceGM',
        'GMEdit',
        'plugins',
      );
    }
    if (process.platform === 'darwin') {
      return path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'AceGM',
        'GMEdit',
        'plugins',
      );
    }
    return path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
      'AceGM',
      'GMEdit',
      'plugins',
    );
  }

  function bundledPluginSource(entry) {
    const folder = entry.folder || entry.id;
    const candidates = [
      path.resolve(__dirname, '..', folder),
      path.resolve(__dirname, '..', '..', folder),
      path.resolve(process.cwd(), folder),
    ];
    for (let i = 0; i < candidates.length; i++) {
      if (fs.existsSync(path.join(candidates[i], 'config.json'))) return candidates[i];
    }
    return '';
  }

  function pluginInstalled(entry, opts) {
    const dir = (opts && opts.pluginsDir) || defaultPluginsDir();
    return fs.existsSync(path.join(dir, entry.id, 'config.json'));
  }

  function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (let i = 0; i < entries.length; i++) {
      const ent = entries[i];
      const from = path.join(src, ent.name);
      const to = path.join(dest, ent.name);
      if (ent.isDirectory()) copyDir(from, to);
      else if (ent.isFile()) fs.copyFileSync(from, to);
    }
  }

  function sameRealPath(a, b) {
    try {
      return fs.realpathSync(a) === fs.realpathSync(b);
    } catch (_) {
      return false;
    }
  }

  function installGmeditPlugin(entry, opts) {
    const pluginsDir = (opts && opts.pluginsDir) || defaultPluginsDir();
    const src = bundledPluginSource(entry);
    if (!src) throw new Error('bundled plugin source not found: ' + (entry.folder || entry.id));
    const dest = path.join(pluginsDir, entry.id);
    fs.mkdirSync(pluginsDir, { recursive: true });
    if (fs.existsSync(dest)) {
      if (!sameRealPath(src, dest) && !fs.existsSync(path.join(dest, 'config.json'))) {
        throw new Error('target exists but is not a GMEdit plugin: ' + dest);
      }
      return Object.assign({}, entry, { installed: true, installMessage: 'already installed' });
    }
    try {
      fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
      return Object.assign({}, entry, {
        installed: true,
        installMessage: 'linked; restart GMEdit',
      });
    } catch (_) {
      copyDir(src, dest);
      return Object.assign({}, entry, {
        installed: true,
        installMessage: 'copied; restart GMEdit',
      });
    }
  }

  function packById(id) {
    return BUILTIN_PACKS.find(function (p) {
      return p.id === id;
    });
  }

  function installedIds(dir) {
    const out = Object.create(null);
    const base = dir || userDir();
    try {
      const files = fs.readdirSync(base);
      for (let i = 0; i < files.length; i++) {
        if (!/\.json$/i.test(files[i])) continue;
        try {
          const raw = fs.readFileSync(path.join(base, files[i]), 'utf8');
          const json = JSON.parse(raw);
          if (json && typeof json.id === 'string') out[json.id] = true;
        } catch (_) {
          /* ignore one bad manifest */
        }
      }
    } catch (_) {
      /* no installed packs yet */
    }
    return out;
  }

  function listPacks(dir) {
    const installed = installedIds(dir);
    return BUILTIN_PACKS.map(function (p) {
      return Object.assign({}, p, { installed: !!installed[p.id] });
    });
  }

  function marketplaceEntries() {
    return BUILTIN_PACKS.concat(BUILTIN_SKILLS, BUILTIN_PLUGINS, BUILTIN_PROVIDERS);
  }

  function marketplaceById(id) {
    return marketplaceEntries().find(function (p) {
      return p.id === id;
    });
  }

  function hasManifest(entry, opts) {
    if (entry.kind === 'plugin') return pluginInstalled(entry, opts);
    if (entry.kind === 'agent-pack') return !!installedIds(opts && opts.agentPacksDir)[entry.id];
    const base = manifestDir(entry.kind, opts && opts.manifestDir);
    return fs.existsSync(path.join(base, entry.id + '.json'));
  }

  function providerInstalled(entry, opts) {
    const providerName = entry.providerName || entry.id;
    const p =
      (opts && opts.providersPath) ||
      Providers.defaultChatgmlProvidersPath(opts && opts.configDir ? opts.configDir : configDir());
    try {
      const data = Providers.readProvidersFile(p);
      return !!(data && data.providers && data.providers[providerName]);
    } catch (_) {
      return false;
    }
  }

  function listMarketplace(opts) {
    return marketplaceEntries().map(function (entry) {
      const installed =
        entry.kind === 'provider' ? providerInstalled(entry, opts) : hasManifest(entry, opts);
      return Object.assign({}, entry, { installed: installed });
    });
  }

  function installPack(id, dir) {
    const pack = packById(id);
    if (!pack) throw new Error('unknown agent pack: ' + id);
    const base = dir || userDir();
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(
      path.join(base, pack.id + '.json'),
      JSON.stringify(
        {
          id: pack.id,
          name: pack.name,
          description: pack.description,
          prompt: pack.prompt,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    return Object.assign({}, pack, { installed: true });
  }

  function writeManifest(entry, dir) {
    const base = manifestDir(entry.kind, dir);
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(
      path.join(base, entry.id + '.json'),
      JSON.stringify(
        {
          id: entry.id,
          name: entry.name,
          kind: entry.kind,
          description: entry.description,
          prompt: entry.prompt,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    );
  }

  function installMarketplace(id, opts) {
    const entry = marketplaceById(id);
    if (!entry) throw new Error('unknown marketplace entry: ' + id);
    if (entry.kind === 'agent-pack') return installPack(id, opts && opts.agentPacksDir);
    if (entry.kind === 'plugin') return installGmeditPlugin(entry, opts);
    if (entry.kind === 'provider') {
      const p =
        (opts && opts.providersPath) ||
        Providers.defaultChatgmlProvidersPath(
          opts && opts.configDir ? opts.configDir : configDir(),
        );
      const provider = entry.provider || {};
      const result = Providers.registerProvider({
        chatgmlPath: p,
        name: entry.providerName || entry.id,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        endpoint: provider.endpoint,
        auth: provider.auth,
        models: provider.models || [],
      });
      if (!result.ok) throw new Error(result.error || 'provider install failed');
      return Object.assign({}, entry, { installed: true });
    }
    writeManifest(entry, opts && opts.manifestDir);
    return Object.assign({}, entry, { installed: true });
  }

  const api = {
    BUILTIN_PACKS,
    BUILTIN_SKILLS,
    BUILTIN_PLUGINS,
    BUILTIN_PROVIDERS,
    configDir,
    userDir,
    listPacks,
    installPack,
    installedIds,
    defaultPluginsDir,
    listMarketplace,
    installMarketplace,
  };
  root.ChatGmlAgentPacks = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
