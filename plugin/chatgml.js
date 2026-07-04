// chatgml.js — GMEdit plugin lifecycle glue (Electron renderer, CommonJS, Node integration on).
//
// Modernizes the old `show-codebase` plugin onto `chatgml serve` (NDJSON over stdio). Replaces the
// Python venv / git-pull / talk-codebase.git clone / YAML config / `...END` + RECREATE_VECTOR_STORE
// protocol entirely. The plugin spawns the ESM core as a SEPARATE child process (it cannot require
// the ESM core) and speaks the existing NDJSON protocol via plugin/client.js. All protocol/state
// logic is in plugin/state.js (a tested port of src/plugin-runtime.ts); this file is DOM/IDE glue.
//
// Load order (config.json): state.js, diff-view.js, panel.js, config-bridge.js, client.js, chatgml.js
// (each later file uses globals defined by the earlier ones).
(function () {
  'use strict';

  const path = require('path');
  const { join } = path;
  const fsp = require('fs/promises');
  const fs = require('fs');
  const crypto = require('crypto');
  const { spawn } = require('child_process');

  const MenuItem = Electron_MenuItem;
  const Preferences = $gmedit['ui.Preferences'];
  // GMEdit's renderer loads plugin scripts via <script> tags, so the relative-require resolution
  // base is the index.html directory, not the plugin's __dirname. Pass absolute paths so the
  // modules resolve correctly. The `globalThis.*` short-circuit still wins when the script is
  // preloaded by config.json (the normal case) and lets Node-based tests require this file
  // directly without a custom loader.
  const _abs = function (mod) {
    return require(path.join(__dirname, mod));
  };
  const ClientApi = globalThis.ChatGmlClient || _abs('client.js');
  const PanelApi = globalThis.ChatGmlPanel || _abs('panel.js');
  const DiffViewApi = globalThis.ChatGmlDiffView || _abs('diff-view.js');
  const ConfigBridgeApi = globalThis.ChatGmlConfigBridge || _abs('config-bridge.js');
  const State = globalThis.ChatGmlState || _abs('state.js');
  const ChildProcessApi = globalThis.ChatGmlChildProcess || _abs('child-process.js');
  const SettingsTasks = globalThis.ChatGmlSettingsTasks || _abs('settings-tasks.js');
  // Resolve markdown.js so the renderer global is populated (config.json loads it before
  // panel.js, but the require fallback is also fine in Node-based test contexts).
  const MarkdownApi = globalThis.ChatGmlMarkdown || _abs('markdown.js');
  void MarkdownApi;
  const FuzzyApi = globalThis.ChatGmlFuzzy || _abs('fuzzy.js');
  // SESSIONS module (plugin/sessions.js): multi-session history sidebar. Required the same way
  // as the other modules above — `globalThis.ChatGmlSessions` first (the normal config.json
  // load path), `require(path.join(__dirname, 'sessions.js'))` as the test/renderer fallback.
  const Sessions = globalThis.ChatGmlSessions || _abs('sessions.js');
  // Providers registry module (plugin/providers.js). Owns the bootstrap from
  // `~/.pi/agent/providers.json` and the `.env` export; panel.js consumes it via the instance
  // methods `populateProviders` / `applyProviderEntry`.
  const ProvidersApi = globalThis.ChatGmlProviders || _abs('providers.js');

  const PLUGIN_NAME = 'chatgml';
  const OPEN_PREF_KEY = 'chatgml_open_on_project_v1';
  const ASIDE_WIDTH_KEY = 'chatgml_aside_width_v3';
  const ASIDE_DEFAULT_WIDTH = 520;
  // SESSION_DIR is the per-project NDJSON store. Per spec, files live at
  // `~/.config/chatgml/sessions/<projectHash>-<taskId>.ndjson` (one NDJSON line per turn). The
  // SESSIONS module (plugin/sessions.js) owns all session I/O; this constant is retained as the
  // legacy fallback for the few sync paths that pre-date sessions.js (e.g. `listTasks`'s
  // readdirSync scan). sessions.js and chatgml.js agree on the same path so a legacy readdir
  // and the new metadata scan see the same files.
  const SESSION_DIR = (function () {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    return join(home.replace(/[\\/]+$/, ''), '.config', 'chatgml', 'sessions');
  })();
  const SESSION_MAX_TURNS = 50;

  let ready = false; // side-panel DOM prepared
  let sizer, splitter, container, editor, mainCont;
  let panelHostEl = null;
  let gmlFile = null;

  let projectDirectory = null;
  let client = null;
  let panel = null;
  let terminalOutput = '';
  let currentTaskId = 'default';
  const diagnosticsLog = [];
  let lastLaunchAuthInfo = null;
  let activeGmloopChild = null;
  // Active per-turn tier override ('planner' | 'implementer' | 'reviewer' | null). Set via the
  // panel's `/tier <name>` slash command or the inline picker chip; included on the next user
  // message as UserCommand.tier (the core's UserCommand schema accepts it; the resulting turn is
  // stamped with the tier that produced it and the panel renders a badge).
  let activeTierOverride = null;
  const configBridge = new ConfigBridgeApi.ConfigBridge(__dirname);

  function sanitizeDiagnosticText(value) {
    let text = String(value == null ? '' : value);
    text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>');
    text = text.replace(/(api[_-]?key|authorization|token)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>');
    text = text.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>');
    return text;
  }

  function recordDiagnostic(kind, value) {
    const stamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
    diagnosticsLog.push(stamp + ' ' + kind + ': ' + sanitizeDiagnosticText(value));
    while (diagnosticsLog.length > 80) diagnosticsLog.shift();
  }

  function readOpenPrefMap() {
    try {
      if (typeof localStorage === 'undefined') return {};
      const raw = localStorage.getItem(OPEN_PREF_KEY);
      return raw ? JSON.parse(raw) || {} : {};
    } catch (e) {
      return {};
    }
  }

  function writeOpenPreference(open) {
    try {
      if (typeof localStorage === 'undefined') return;
      const key = projectDirectory || '__global__';
      const map = readOpenPrefMap();
      map[key] = !!open;
      localStorage.setItem(OPEN_PREF_KEY, JSON.stringify(map));
    } catch (e) {
      /* localStorage can be unavailable in test contexts */
    }
  }

  function shouldRestoreOpen(projectDir) {
    const map = readOpenPrefMap();
    return !!map[projectDir || '__global__'];
  }

  function copyText(text) {
    const value = sanitizeDiagnosticText(text);
    try {
      if (typeof GMEdit !== 'undefined' && GMEdit && typeof GMEdit.setClipboard === 'function') {
        GMEdit.setClipboard(value);
        return true;
      }
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        navigator.clipboard.writeText(value);
        return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  function inferAuthState(cfg, provider) {
    if (provider && provider.authState) return provider.authState;
    const apiKey = cfg && cfg.chat && cfg.chat.apiKey ? String(cfg.chat.apiKey) : '';
    if (/^env:/i.test(apiKey)) return 'env ref';
    if (apiKey) return 'set';
    return 'missing';
  }

  function readChatgmlEnvForDiagnostics() {
    const out = {};
    const file = path.join(chatgmlUserDirForProviders(), '.env');
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(lines[i]);
        if (!m) continue;
        const key = m[1];
        let value = m[2] || '';
        if ((value[0] === '"' && value[value.length - 1] === '"') || (value[0] === "'" && value[value.length - 1] === "'")) {
          value = value.slice(1, -1);
        }
        out[key] = value;
      }
    } catch (e) {
      /* absent .env is fine */
    }
    return out;
  }

  function fallbackDiagnostics() {
    const envFile = readChatgmlEnvForDiagnostics();
    const envValue = function (key) {
      return process.env[key] || envFile[key] || '';
    };
    const items = [];
    if (envValue('CHATGML_FALLBACK_CHAT_BASE_URL') && envValue('CHATGML_FALLBACK_CHAT_MODEL')) {
      items.push(
        (envValue('CHATGML_FALLBACK_CHAT_PROVIDER') || 'fallback') +
          ' / ' +
          envValue('CHATGML_FALLBACK_CHAT_MODEL'),
      );
    }
    if (envValue('OPENROUTER_API_KEY')) {
      items.push('OpenRouter / ' + (envValue('CHATGML_FALLBACK_OPENROUTER_MODEL') || 'minimax/minimax-m3'));
    }
    if (envValue('MINIMAX_API_KEY')) {
      items.push('MiniMax / ' + (envValue('CHATGML_FALLBACK_MINIMAX_MODEL') || 'MiniMax-M3'));
    }
    if (envValue('NVIDIA_API_KEY') && envValue('CHATGML_FALLBACK_NVIDIA_MODEL')) {
      items.push('NVIDIA / ' + envValue('CHATGML_FALLBACK_NVIDIA_MODEL'));
    }
    if (
      envValue('MAVEROS_API_KEY') &&
      envValue('CHATGML_FALLBACK_MAVEROS_BASE_URL') &&
      envValue('CHATGML_FALLBACK_MAVEROS_MODEL')
    ) {
      items.push('Maveros / ' + envValue('CHATGML_FALLBACK_MAVEROS_MODEL'));
    }
    return items.join(', ');
  }

  function pathExistsAsFile(filePath) {
    try {
      return !!filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch (e) {
      return false;
    }
  }

  function pathExistsAsDirectory(filePath) {
    try {
      return !!filePath && fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
    } catch (e) {
      return false;
    }
  }

  function findCommandOnPath(name) {
    const pathEnv = process.env.PATH || process.env.Path || process.env.path || '';
    const suffixes = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
    const parts = pathEnv.split(path.delimiter);
    for (let i = 0; i < parts.length; i++) {
      const dir = parts[i];
      if (!dir) continue;
      for (let j = 0; j < suffixes.length; j++) {
        const candidate = path.join(dir, name + suffixes[j]);
        if (pathExistsAsFile(candidate)) return candidate;
      }
    }
    return '';
  }

  function gmloopDiagnostics() {
    const envFile = readChatgmlEnvForDiagnostics();
    const envValue = function (key) {
      return process.env[key] || envFile[key] || '';
    };
    const configuredBin = envValue('CHATGML_GMLOOP_BIN');
    const configuredDir = envValue('CHATGML_GMLOOP_DIR');
    const siblingDir = path.resolve(__dirname, '..', '..', 'GMLoop');
    const dir = configuredDir || (pathExistsAsDirectory(siblingDir) ? siblingDir : '');
    const packageFile = dir ? path.join(dir, 'package.json') : '';
    const cliDist = dir ? path.join(dir, 'src', 'cli', 'dist', 'index.js') : '';
    const pathBin = findCommandOnPath('gmloop');
    const commands = [
      'gmloop lint <file.gml>',
      'gmloop format --path <file.gml>',
      'gmloop lint <project>',
      'gmloop format --path <project>',
      'gmloop graph doctor --path <project>',
      'gmloop parse --path <file.gml>',
    ];

    if (configuredBin) {
      const configuredBinExists = pathExistsAsFile(configuredBin);
      return {
        status: configuredBinExists ? 'ready' : 'configured bin missing',
        dir: dir,
        runner: configuredBin,
        cmd: configuredBinExists ? (/\.js$/i.test(configuredBin) ? 'node' : configuredBin) : '',
        argvPrefix: configuredBinExists && /\.js$/i.test(configuredBin) ? [configuredBin] : [],
        setup: configuredBinExists ? '' : 'CHATGML_GMLOOP_BIN points to a missing file',
        commands: commands.join(', '),
      };
    }
    if (pathBin) {
      return {
        status: 'ready',
        dir: dir,
        runner: pathBin,
        cmd: pathBin,
        argvPrefix: [],
        setup: '',
        commands: commands.join(', '),
      };
    }
    if (pathExistsAsFile(cliDist)) {
      return {
        status: 'ready',
        dir: dir,
        runner: 'node ' + cliDist,
        cmd: 'node',
        argvPrefix: [cliDist],
        setup: '',
        commands: commands.join(', '),
      };
    }
    if (pathExistsAsFile(packageFile)) {
      return {
        status: 'clone found; build needed',
        dir: dir,
        runner: '',
        cmd: '',
        argvPrefix: [],
        setup: 'build GMLoop or set CHATGML_GMLOOP_BIN before enabling direct tool runs',
        commands: commands.join(', '),
      };
    }
    return {
      status: 'not found',
      dir: '',
      runner: '',
      cmd: '',
      argvPrefix: [],
      setup: 'clone SimulatorLife/GMLoop next to ChatGML or set CHATGML_GMLOOP_DIR',
      commands: commands.join(', '),
    };
  }

  function diagnosticsSnapshot() {
    const cfg = panel && panel._config ? panel._config : null;
    const provider =
      panel && typeof panel.getActiveProviderEntry === 'function'
        ? panel.getActiveProviderEntry()
        : null;
    const gmloop = gmloopDiagnostics();
    return {
      core: client ? (client.ready ? 'ready' : 'starting') : 'stopped',
      projectDir: projectDirectory || '',
      taskId: currentTaskId || 'default',
      provider:
        provider && provider.providerName
          ? provider.providerName
          : lastLaunchAuthInfo && lastLaunchAuthInfo.providerName
            ? lastLaunchAuthInfo.providerName
            : '',
      model: cfg && cfg.chat && cfg.chat.model ? cfg.chat.model : '',
      baseURL: cfg && cfg.chat && cfg.chat.baseURL ? cfg.chat.baseURL : '',
      fallbacks: fallbackDiagnostics(),
      gmloop: gmloop.status,
      gmloopDir: gmloop.dir || '',
      gmloopRunner: gmloop.runner || '',
      envFile: path.join(chatgmlUserDirForProviders(), '.env'),
      authState:
        lastLaunchAuthInfo && lastLaunchAuthInfo.authState
          ? lastLaunchAuthInfo.authState
          : inferAuthState(cfg, provider),
      authSource: lastLaunchAuthInfo && lastLaunchAuthInfo.authSource ? lastLaunchAuthInfo.authSource : '',
      lastError: panel && panel.state && panel.state.error ? panel.state.error : '',
      logs: diagnosticsLog.slice(-12),
    };
  }

  // Resolve the chatgml-owned user config directory for the providers.json file. Mirrors the
  // platform conventions of `~/.config/chatgml/` on POSIX and `%APPDATA%/chatgml/` on Windows so
  // the bootstrap-write lands alongside `~/.config/chatgml/config.json`. Centralized in a helper
  // so the providers callbacks always agree on the path.
  function chatgmlUserDirForProviders() {
    try {
      const xdg = process.env.XDG_CONFIG_HOME;
      if (xdg && typeof xdg === 'string') return path.join(xdg, 'chatgml');
      if (process.platform === 'win32') {
        const appdata = process.env.APPDATA;
        if (appdata) return path.join(appdata, 'chatgml');
      }
      return path.join(require('os').homedir(), '.config', 'chatgml');
    } catch (e) {
      return path.join(require('os').homedir(), '.config', 'chatgml');
    }
  }

  function chatgmlConfigPath() {
    const xdg = process.env.XDG_CONFIG_HOME;
    const base = xdg && typeof xdg === 'string' ? xdg : path.join(require('os').homedir(), '.config');
    return path.join(base, 'chatgml', 'config.json');
  }

  function readJsonObject(filePath) {
    try {
      if (!filePath || !fs.existsSync(filePath)) return {};
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      recordDiagnostic('config', 'could not read ' + filePath + ': ' + (e.message || e));
      return {};
    }
  }

  function configSnapshotForAuth() {
    const userCfg = readJsonObject(chatgmlConfigPath());
    const projectCfg = projectDirectory
      ? readJsonObject(path.join(projectDirectory, '.chatgml.json'))
      : {};
    const panelCfg = panel && panel._config ? panel._config : {};
    const userChat = userCfg && userCfg.chat && typeof userCfg.chat === 'object' ? userCfg.chat : {};
    const projectChat =
      projectCfg && projectCfg.chat && typeof projectCfg.chat === 'object' ? projectCfg.chat : {};
    const panelChat =
      panelCfg && panelCfg.chat && typeof panelCfg.chat === 'object' ? panelCfg.chat : {};
    const chat = Object.assign({}, userChat, projectChat, panelChat);
    const rawApiKey =
      typeof projectChat.apiKey === 'string'
        ? projectChat.apiKey
        : typeof userChat.apiKey === 'string'
          ? userChat.apiKey
          : '';
    if (rawApiKey) chat.apiKey = rawApiKey;
    else if (chat.apiKey === '***') delete chat.apiKey;
    return { chat: chat };
  }

  function launchAuthEnv() {
    try {
      const cfg = configSnapshotForAuth();
      const chat = cfg && cfg.chat ? cfg.chat : {};
      const load = ProvidersApi.loadAll({ chatgmlUserDir: chatgmlUserDirForProviders() });
      const authEnv = Object.assign({}, readChatgmlEnvForDiagnostics(), process.env);
      const auth = ProvidersApi.resolveAuthForConfig(
        load.registry,
        {
          model: chat.model || '',
          baseURL: chat.baseURL || '',
          apiKey: chat.apiKey || '',
        },
        authEnv,
      );
      lastLaunchAuthInfo = {
        providerName: auth.providerName || '',
        authState: auth.authState || 'missing',
        authSource: auth.authSource || '',
        envVar: auth.envVar || '',
      };
      const keys = auth.extraEnv && typeof auth.extraEnv === 'object' ? Object.keys(auth.extraEnv) : [];
      recordDiagnostic(
        'auth',
        (auth.providerName || 'manual') +
          ' ' +
          (auth.authSource || auth.authState || 'missing') +
          (keys.length > 0 ? ' bridged ' + keys.join(',') : ''),
      );
      return auth.extraEnv || {};
    } catch (e) {
      lastLaunchAuthInfo = {
        providerName: '',
        authState: 'missing',
        authSource: 'auth probe failed',
        envVar: '',
      };
      recordDiagnostic('auth', 'probe failed: ' + (e.message || e));
      return {};
    }
  }

  // File index for @file autocomplete: cached list of project files, lazily scanned, invalidated
  // when projectDirectory changes. Capped at FILE_INDEX_MAX to keep autocomplete snappy on huge
  // projects. We skip obvious noise directories (node_modules, .git, .cache, .vscode, build, dist)
  // and skip hidden files / large binaries by extension. Each entry is a POSIX-style path relative
  // to projectDirectory so the panel can show short labels and insert full relative paths into
  // the input.
  const FILE_INDEX_MAX = 5000;
  const FILE_INDEX_SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    '.cache',
    '.vscode',
    'build',
    'dist',
    'out',
    'target',
    '.next',
    '.nuxt',
  ]);
  const FILE_INDEX_SKIP_EXTS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.bmp',
    '.ico',
    '.pdf',
    '.zip',
    '.tar',
    '.gz',
    '.7z',
    '.rar',
    '.mp3',
    '.mp4',
    '.mov',
    '.wav',
    '.ogg',
    '.ttf',
    '.otf',
    '.woff',
    '.woff2',
    '.exe',
    '.dll',
    '.so',
    '.dylib',
    '.class',
    '.o',
    '.obj',
    '.lib',
    '.a',
    '.pdb',
  ]);
  let fileIndexCache = { cwd: null, files: null };

  function normalizeToPosixForIndex(p) {
    if (!p) return p;
    return p.split(path.sep).join('/');
  }

  async function scanProjectFiles(cwd, opts) {
    opts = opts || {};
    const max = opts.max || FILE_INDEX_MAX;
    if (!cwd) return [];
    if (fileIndexCache.cwd === cwd && fileIndexCache.files) return fileIndexCache.files;
    const out = [];
    const root = normalizeToPosixForIndex(cwd);
    async function walk(dir, relPrefix) {
      if (out.length >= max) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (e) {
        return; // permission denied, etc -- skip
      }
      for (const ent of entries) {
        if (out.length >= max) return;
        const name = ent.name;
        if (name.startsWith('.')) continue; // skip hidden
        const childAbs = join(dir, name);
        const childRel = relPrefix ? relPrefix + '/' + name : name;
        if (ent.isDirectory()) {
          if (FILE_INDEX_SKIP_DIRS.has(name)) continue;
          await walk(childAbs, childRel);
        } else if (ent.isFile()) {
          const ext = path.extname(name).toLowerCase();
          if (FILE_INDEX_SKIP_EXTS.has(ext)) continue;
          out.push(childRel);
        }
        // symlinks, sockets, etc -- skip
      }
    }
    try {
      await walk(root, '');
    } catch (e) {
      console.warn('chatgml: file index scan failed', e);
    }
    fileIndexCache = { cwd: cwd, files: out };
    return out;
  }

  function invalidateFileIndex() {
    fileIndexCache = { cwd: null, files: null };
  }

  // -------------------------------------------------------------------------
  // Editor context (opencode-style "current file" awareness). Best-effort + guarded: GMEdit
  // versions differ, so any failure is swallowed and the user message is sent bare (v1-safe).
  // -------------------------------------------------------------------------
  function normalizeToPosix(p) {
    return String(p || '').replace(/\\/g, '/');
  }

  function relativeToProject(absPath) {
    if (!absPath || !projectDirectory) return undefined;
    const a = normalizeToPosix(absPath);
    const root = normalizeToPosix(projectDirectory);
    if (a === root) return undefined;
    let rel = a.startsWith(root + '/') ? a.slice(root.length + 1) : a;
    rel = rel.replace(/^\.\//, '');
    return rel || undefined;
  }

  // Returns the GMEdit file object backing the active Ace session, or null.
  function activeFile() {
    try {
      const sess = aceEditor && aceEditor.session;
      if (sess && sess.gmlFile) return sess.gmlFile;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function activeFilePath() {
    const f = activeFile();
    if (!f) return undefined;
    // The on-disk path lives under different keys across GMEdit builds; try the common ones.
    const raw = f.path || f.filePath || (f.codeEditor && f.codeEditor.path) || undefined;
    return raw ? relativeToProject(raw) : undefined;
  }

  /** Build the {openFile,selection,cursorLine} editor-context object for a user message. */
  function currentEditorContext() {
    let ctx;
    try {
      ctx = State.buildEditorContext({
        openFile: activeFilePath(),
        selection: aceEditor ? aceEditor.getSelectedText() : undefined,
        cursorLine: aceEditor ? aceEditor.getCursorPosition().row + 1 : undefined,
      });
    } catch (e) {
      ctx = undefined;
    }
    return ctx;
  }

  // -------------------------------------------------------------------------
  // @mention resolution (async — may touch disk/network). parseMentions is pure and lives in
  // plugin/state.js; this glue resolves each mention into content the core can render.
  // -------------------------------------------------------------------------
  function resolveProjectPath(target) {
    if (!target || !projectDirectory) return undefined;
    if (target.charAt(0) === '/') return join(projectDirectory, target.slice(1));
    return join(projectDirectory, target);
  }

  async function resolveMention(mention) {
    switch (mention.type) {
      case 'file': {
        const p = resolveProjectPath(mention.target);
        let text = await fsp.readFile(p, 'utf8');
        if (text.length > 8192) text = text.slice(0, 8192) + '…';
        return Object.assign({}, mention, { content: text });
      }
      case 'folder': {
        const p = resolveProjectPath(mention.target);
        const entries = await fsp.readdir(p, { withFileTypes: true });
        const lines = entries.map(function (e) {
          return e.name + (e.isDirectory() ? '/' : '');
        });
        let text = lines.join('\n');
        if (text.length > 4096) text = text.slice(0, 4096) + '…';
        return Object.assign({}, mention, { content: text });
      }
      case 'problems': {
        const lines = [];
        try {
          const tabEls = document.querySelectorAll('.gmedit-tab');
          for (let i = 0; i < tabEls.length; i++) {
            const tabEl = tabEls[i];
            const file = tabEl.gmlFile || tabEl.file;
            if (!file || !file.codeEditor || !file.codeEditor.session) continue;
            const anns = file.codeEditor.session.getAnnotations();
            if (!anns || anns.length === 0) continue;
            const rawPath = file.path || file.filePath || (file.codeEditor && file.codeEditor.path);
            const relPath = rawPath ? relativeToProject(rawPath) : undefined;
            const pathLabel = relPath || '(untitled)';
            for (let j = 0; j < anns.length; j++) {
              const ann = anns[j];
              lines.push(
                pathLabel +
                  ':' +
                  ((ann.row || 0) + 1) +
                  ': ' +
                  (ann.type || 'error') +
                  ': ' +
                  (ann.text || ''),
              );
            }
          }
        } catch (e) {
          /* ignore */
        }
        return Object.assign({}, mention, { content: lines.join('\n') || 'No problems' });
      }
      case 'terminal': {
        return Object.assign({}, mention, { content: terminalOutput || '' });
      }
      case 'url': {
        try {
          const res = await fetch(mention.target);
          let text = await res.text();
          if (text.length > 8192) text = text.slice(0, 8192) + '…';
          return Object.assign({}, mention, { content: text });
        } catch (e) {
          return Object.assign({}, mention, {
            content: 'Could not fetch URL: ' + (e.message || e),
          });
        }
      }
      case 'image': {
        const p = resolveProjectPath(mention.target);
        const buf = await fsp.readFile(p);
        const ext = path.extname(p).slice(1).toLowerCase();
        const mime =
          ext === 'png'
            ? 'image/png'
            : ext === 'jpg' || ext === 'jpeg'
              ? 'image/jpeg'
              : 'image/' + ext;
        const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
        return Object.assign({}, mention, { content: dataUrl });
      }
      default: {
        return mention;
      }
    }
  }

  async function getMentions(text) {
    const parsed = State.parseMentions(text);
    const mentions = [];
    for (let i = 0; i < parsed.mentions.length; i++) {
      try {
        mentions.push(await resolveMention(parsed.mentions[i]));
      } catch (e) {
        const m = parsed.mentions[i];
        mentions.push(
          Object.assign({}, m, { content: 'Could not resolve mention: ' + (e.message || e) }),
        );
      }
    }
    return { mentions: mentions, cleanText: parsed.cleanText };
  }

  // -------------------------------------------------------------------------
  // Per-project session persistence (resumable conversations). One NDJSON file per project,
  // keyed by a short hash of the project dir; each line is a turn_end record. Capped to the last
  // SESSION_MAX_TURNS turns to bound size. Append is best-effort (never breaks the live panel).
  //
  // The SESSIONS module (plugin/sessions.js) is now the SSOT for session I/O — `listTasks`,
  // `switchTask`, `createTask`, `deleteTask`, `appendTurn`, `loadSessionTurns`, `clearSessionFile`
  // all delegate to `Sessions.*` so the sidebar (panel.setSessions/setActiveSession) sees the
  // same data as the slash commands and the legacy onTurnEnd path. The `setTasks` legacy
  // callback still drives the OLD `<select>`-based task picker for backwards compatibility, but
  // it now reads from `Sessions.list(projectDir)` so the two surfaces agree on the task set.
  // -------------------------------------------------------------------------
  function projectHash() {
    // The SESSIONS module owns the canonical project-hash computation (SHA-1 of the project
    // dir, hex, first 12 chars). This thin wrapper keeps the legacy `sessionFile(taskId)` helper
    // working without duplicating the hash logic in two places.
    return Sessions.projectHash(projectDirectory);
  }

  function sessionFile(taskId) {
    return Sessions.sessionFile(projectDirectory, taskId || currentTaskId);
  }

  // Legacy sync scan over the session dir — used only as a fast in-process fallback for the
  // `<select>`-based task picker if the SESSIONS module has not yet been wired (shouldn't
  // happen in normal flow because chatgml.js awaits Sessions.list before calling panel.setTasks,
  // but we keep this synchronous helper so a fire-and-forget path can still get a task id set).
  function listTasks() {
    const h = projectHash();
    const prefix = h + '-';
    const tasks = new Set(['default']);
    try {
      const files = fs.readdirSync(SESSION_DIR);
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f.startsWith(prefix) && f.endsWith('.ndjson')) {
          tasks.add(f.slice(prefix.length, f.length - '.ndjson'.length));
        }
      }
    } catch (e) {
      /* directory may not exist yet */
    }
    return Array.from(tasks).sort();
  }

  async function refreshSessionsPanel() {
    // Re-scan the session list on disk and push it to BOTH the new sessions sidebar (preferred
    // surface) AND the legacy `<select>`-based task picker (kept for backwards compatibility).
    // Best-effort: a failure to read disk never breaks the panel — we just keep the existing
    // visible state and flash a notice.
    try {
      const list = await Sessions.list(projectDirectory);
      if (panel) {
        if (typeof panel.setSessions === 'function') {
          panel.setSessions(list);
          const active = list.find(function (e) {
            return e.isActive;
          });
          if (active && typeof panel.setActiveSession === 'function') {
            panel.setActiveSession(active.id);
          }
        }
        if (typeof panel.setTasks === 'function') {
          // Legacy task picker takes just ids, in stable order (old code sorted alphabetically).
          panel.setTasks(
            list
              .map(function (e) {
                return e.id;
              })
              .sort(),
          );
        }
      }
    } catch (e) {
      console.warn('chatgml: refreshSessionsPanel failed', e);
    }
  }

  async function switchTask(taskId) {
    if (!taskId) return;
    if (taskId === currentTaskId && (await Sessions.getActive(projectDirectory)) === taskId) {
      // Already on this task and disk agrees; nothing to do.
      return;
    }
    // Mid-stream guard: switching sessions while a turn is in flight would misroute the
    // in-flight turn_end record to the NEW session (because appendTurn snapshots
    // `currentTaskId` at append time, after we just changed it). Block the switch and ask
    // the user to wait for the in-flight turn to finish — matches the same send-disable
    // semantics on the input row.
    if (
      panel &&
      panel.state &&
      panel.state.busy &&
      Array.isArray(panel.state.outbox) &&
      panel.state.outbox.length > 0
    ) {
      if (panel) {
        panel.flash(
          'cannot switch sessions while a turn is in flight — wait for the response',
          true,
        );
      }
      return;
    }
    currentTaskId = taskId;
    // Update the active pointer on disk FIRST so a /resume after a crash lands on the same task.
    try {
      await Sessions.switchTo(projectDirectory, taskId);
    } catch (e) {
      console.warn('chatgml: could not switch session', e);
    }
    if (panel) {
      panel.setTask(currentTaskId);
      panel.clear();
    }
    const turns = await loadSessionTurns();
    if (panel) panel.loadTurns(turns);
    if (client) {
      client.sendResume(State.turnEndToMessages(turns), currentTaskId);
    }
    if (panel) panel.flash('switched to task: ' + currentTaskId);
    void refreshSessionsPanel();
  }

  const TASK_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

  async function createTask(taskId) {
    if (!TASK_ID_RE.test(taskId)) {
      if (panel) panel.flash('invalid task id (alphanumeric/hyphen/underscore, max 64)', true);
      return;
    }
    // Delegate to Sessions.create so the new task is persisted on disk before we switch to it.
    // If the id is already in use, Sessions.create is idempotent — it just sets the active
    // pointer to the existing task and returns the id unchanged.
    const id = await Sessions.create(projectDirectory, taskId);
    await switchTask(id);
    void refreshSessionsPanel();
    return id;
  }

  async function deleteTask(taskId) {
    if (taskId === 'default') {
      if (panel) panel.flash('cannot delete the default task', true);
      return;
    }
    if (!window.confirm('Delete task "' + taskId + '"?')) return;
    try {
      await Sessions.delete(projectDirectory, taskId);
    } catch (e) {
      if (panel) panel.flash('could not delete task: ' + (e.message || e), true);
      return;
    }
    if (taskId === currentTaskId) {
      // switchTask falls back to 'default' (which Sessions.delete has already wired on disk).
      await switchTask('default');
    }
    void refreshSessionsPanel();
  }

  async function appendTurn(record) {
    if (!projectDirectory) return;
    // Delegate to Sessions.appendTurn so the per-session metadata (title, messageCount,
    // updatedAt) stays in lock-step with the NDJSON. We still keep the legacy `taskId` field on
    // the record for back-compat with older resume payloads, but the SSOT for "which session is
    // this turn for" is the active pointer (Sessions.getActive), not `record.taskId`.
    record.taskId = currentTaskId;
    try {
      await Sessions.appendTurn(projectDirectory, record);
    } catch (e) {
      console.warn('chatgml: could not append session turn', e);
    }
  }

  async function loadSessionTurns() {
    // Read turns for the CURRENT task (which is the active session on disk). Falls back to [] on
    // any error so a corrupt NDJSON never breaks the panel.
    try {
      return await Sessions.loadTurns(projectDirectory, currentTaskId);
    } catch (e) {
      return [];
    }
  }

  async function clearSessionFile() {
    // /clear drops the turns for the CURRENT task by truncating its NDJSON. The metadata
    // sidecar keeps its title (it's still the same session) but the next appendTurn will bump
    // messageCount from 0 again.
    try {
      await fsp.writeFile(sessionFile(currentTaskId), '', 'utf8');
    } catch (e) {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Inline-diff in the open Ace editor (opencode-style). After an approved edit is written, if the
  // touched file is the one currently open, reload its session from disk and jump to the first
  // changed hunk line. Pure glue; the protocol parity stays untouched.
  // -------------------------------------------------------------------------
  function firstChangedNewLine(diff) {
    try {
      const lines = String(diff || '').split('\n');
      for (const ln of lines) {
        const m = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/.exec(ln);
        if (m) return parseInt(m[1], 10) - 1; // 0-based Ace row
      }
    } catch (e) {
      /* ignore */
    }
    return 0;
  }

  function applyInlineDiffOnApprove(proposalPath) {
    if (!aceEditor || !proposalPath) return;
    const openRel = activeFilePath();
    if (!openRel || openRel !== proposalPath) return;
    // Give the core's atomic write a tick to land before we re-read + jump.
    setTimeout(function () {
      try {
        const f = activeFile();
        const abs = f && (f.path || f.filePath || (f.codeEditor && f.codeEditor.path));
        if (!abs || !fs.existsSync(abs)) return;
        const updated = fs.readFileSync(abs, 'utf8');
        const sess = aceEditor.session;
        if (sess && sess.getValue() !== updated) sess.setValue(updated);
        const row = firstChangedNewLine(lastDiffForPath[proposalPath] || '');
        aceEditor.gotoLine(row + 1, 0, false);
        aceEditor.focus();
        aceEditor.scrollToLine(row, true, true);
      } catch (e) {
        console.info('chatgml: inline diff reload skipped', e);
      }
    }, 50);
  }

  // Maps an approved proposal path to its diff text for the inline-diff jump. Populated from
  // edit_proposal events by the panel reducer (read off panel.state.pendingProposals).
  const lastDiffForPath = {};
  const diffStateByFile = new WeakMap(); // gmlFile -> { markers, gutters, annotationRows, widgets }

  function getSession(file) {
    if (!file) return null;
    try {
      if (file.codeEditor && file.codeEditor.session) return file.codeEditor.session;
      if (file.session) return file.session;
      const af = activeFile();
      if (af === file && aceEditor && aceEditor.session) return aceEditor.session;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function clearDiffMarkers(file) {
    const state = diffStateByFile.get(file);
    if (!state) return;
    try {
      const sess = state.session || getSession(file);
      if (sess) {
        for (let i = 0; i < state.markers.length; i++) sess.removeMarker(state.markers[i]);
        for (let i = 0; i < state.gutters.length; i++) {
          const g = state.gutters[i];
          sess.removeGutterDecoration(g.row, g.cls);
        }
        if (state.annotationRows.size) {
          const remaining = (sess.getAnnotations() || []).filter(function (a) {
            return !state.annotationRows.has(a.row);
          });
          sess.setAnnotations(remaining);
        }
        if (state.widgets.length && sess.widgetManager) {
          for (let i = 0; i < state.widgets.length; i++)
            sess.widgetManager.removeLineWidget(state.widgets[i]);
        }
      }
    } catch (e) {
      console.warn('chatgml: clearDiffMarkers failed', e);
    }
    diffStateByFile.delete(file);
  }

  function renderDiffMarkers(file, proposal) {
    clearDiffMarkers(file);
    const sess = getSession(file);
    if (!sess || !proposal || !proposal.diff) return;
    let blocks;
    try {
      blocks = DiffViewApi.parseDiffBlocks(proposal.diff);
    } catch (e) {
      return;
    }
    const aceGlobal =
      typeof globalThis.ace !== 'undefined'
        ? globalThis.ace
        : typeof ace !== 'undefined'
          ? ace
          : null;
    if (!aceGlobal || !aceGlobal.require) return;
    const Range = aceGlobal.require('ace/range').Range;
    const state = {
      session: sess,
      markers: [],
      gutters: [],
      annotationRows: new Set(),
      widgets: [],
    };
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      const rows = [];
      try {
        if (block.header && block.header.indexOf('@@') === 0) {
          const newM = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(block.header);
          const oldM = /^@@\s+-(\d+)(?:,(\d+))?\s+\+\d+(?:,\d+)?\s+@@/.exec(block.header);
          let newRow = newM ? parseInt(newM[1], 10) - 1 : 0;
          let oldRow = oldM ? parseInt(oldM[1], 10) - 1 : 0;
          for (let li = 1; li < block.lines.length; li++) {
            const text = block.lines[li].text;
            if (text.indexOf('+') === 0 && text.indexOf('+++') !== 0) {
              rows.push({ row: newRow, cls: 'chatgml-diff-add' });
              newRow++;
            } else if (text.indexOf('-') === 0 && text.indexOf('---') !== 0) {
              rows.push({ row: oldRow, cls: 'chatgml-diff-del' });
              oldRow++;
            } else {
              newRow++;
              oldRow++;
            }
          }
        } else if (block.searchText && block.searchText.length > 0) {
          const search = block.searchText;
          const replace = block.replaceText || [];
          let found = -1;
          const n = sess.getLength();
          for (let r = 0; r <= n - search.length; r++) {
            let ok = true;
            for (let i = 0; i < search.length; i++) {
              if (sess.getLine(r + i) !== search[i]) {
                ok = false;
                break;
              }
            }
            if (ok) {
              found = r;
              break;
            }
          }
          if (found >= 0) {
            const len = Math.max(search.length, replace.length);
            const blockCls = replace.length > 0 ? 'chatgml-diff-add' : 'chatgml-diff-del';
            for (let i = 0; i < len; i++) {
              const row = found + i;
              if (i < search.length && i < replace.length) rows.push({ row: row, cls: blockCls });
              else if (i < search.length) rows.push({ row: row, cls: 'chatgml-diff-del' });
              else rows.push({ row: row, cls: 'chatgml-diff-add' });
            }
          }
        }
      } catch (e) {
        /* ignore malformed block */
      }
      if (rows.length === 0) continue;
      const maxRow = sess.getLength();
      const startRow = rows[0].row;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.row < 0 || r.row >= maxRow) continue;
        try {
          const markerId = sess.addMarker(
            new Range(r.row, 0, r.row, Infinity),
            'chatgml-diff-' + r.cls + '-line',
            'fullLine',
          );
          state.markers.push(markerId);
          sess.addGutterDecoration(r.row, 'chatgml-diff-' + r.cls);
          state.gutters.push({ row: r.row, cls: 'chatgml-diff-' + r.cls });
        } catch (e) {
          /* ignore */
        }
      }
      if (startRow >= 0 && startRow < maxRow) {
        try {
          const anns = (sess.getAnnotations() || []).slice();
          anns.push({ row: startRow, column: 0, type: 'info', text: 'Proposed change' });
          sess.setAnnotations(anns);
          state.annotationRows.add(startRow);
        } catch (e) {
          /* ignore */
        }
      }
      if (startRow >= 0 && startRow < maxRow) {
        try {
          const bar = document.createElement('div');
          bar.className = 'chatgml-hunk-bar';
          const acceptBtn = document.createElement('button');
          acceptBtn.type = 'button';
          acceptBtn.className = 'run-button';
          acceptBtn.textContent = 'Accept';
          acceptBtn.addEventListener('click', function () {
            if (client) client.approve(proposal.id, bi);
          });
          const rejectBtn = document.createElement('button');
          rejectBtn.type = 'button';
          rejectBtn.className = 'run-button chatgml-reject';
          rejectBtn.textContent = 'Reject';
          rejectBtn.addEventListener('click', function () {
            if (client) client.reject(proposal.id, bi);
          });
          bar.appendChild(acceptBtn);
          bar.appendChild(rejectBtn);
          const widget = {
            row: startRow,
            rowCount: 1,
            fixedWidth: true,
            el: bar,
            coverGutter: false,
          };
          if (!sess.widgetManager) {
            const LineWidgets = aceGlobal.require('ace/line_widgets').LineWidgets;
            sess.widgetManager = new LineWidgets(sess);
            sess.widgetManager.attach(sess);
          }
          sess.widgetManager.addLineWidget(widget);
          state.widgets.push(widget);
        } catch (e) {
          /* ignore */
        }
      }
    }
    diffStateByFile.set(file, state);
  }

  function rememberProposals() {
    if (!panel) return;
    try {
      for (const [id, p] of panel.state.pendingProposals.entries()) {
        if (p && p.path) lastDiffForPath[p.path] = p.diff;
      }
    } catch (e) {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Slash-command handling (commands that affect the core/panel, not the agent).
  // -------------------------------------------------------------------------
  function handleSlash(cmd) {
    switch (cmd.kind) {
      case 'clear':
        if (client) client.sendClear();
        void clearSessionFile();
        if (panel) panel.flash('cleared conversation history');
        return;
      case 'reindex':
        if (client) client.reindex();
        return;
      case 'resume': {
        void (async function () {
          const turns = await loadSessionTurns();
          if (!client) return;
          if (turns.length === 0) {
            if (panel) panel.flash('no saved session to resume');
            return;
          }
          if (panel) panel.loadTurns(turns);
          client.sendResume(State.turnEndToMessages(turns), currentTaskId);
          if (panel) panel.flash('resumed ' + turns.length + ' saved turn(s)');
        })();
        return;
      }
      case 'new_task':
        void (async function () {
          await createTask(cmd.value);
          if (panel) panel.flash('created task: ' + cmd.value);
        })();
        return;
      case 'list_tasks':
        if (panel) panel.flash(listTasks().join(', '));
        return;
      case 'switch_task':
        void (async function () {
          await switchTask(cmd.value);
          if (panel) panel.flash('switched to task: ' + cmd.value);
        })();
        return;
      case 'delete_task':
        void (async function () {
          await deleteTask(cmd.value);
          if (panel) panel.flash('deleted task: ' + cmd.value);
        })();
        return;
      case 'help':
        return; // handled in panel
      case 'unknown':
      case 'empty':
        return; // handled in panel
      case 'scope':
        // scope is a plugin pref (passed as --scope at serve launch); set it + restart the core.
        configBridge.setScope(cmd.value);
        restartCore();
        return;
      case 'model':
        void setConfigAndRestart('chat.model', cmd.value);
        return;
      case 'mode':
        void setConfigAndRestart('mode', cmd.value);
        return;
      case 'approval':
        void setConfigAndRestart('approval', cmd.value);
        return;
      case 'mcp':
        handleMcpCommand();
        return;
      case 'gmloop':
        handleGmloopCommand(cmd);
        return;
      case 'undo':
        if (client) client.sendUndo(cmd.checkpointId);
        return;
      case 'tier':
        // /tier <planner|implementer|reviewer|off> — set/clear the per-turn tier override.
        // arg === null means "off" (or any unknown name). The panel has already updated its
        // own chip + flashed a notice; we only mirror into the glue's let-bind so the next
        // sendUser() includes UserCommand.tier.
        activeTierOverride = cmd.arg;
        return;
    }
  }

  function restartCore() {
    stop();
    setTimeout(function () {
      launch();
    }, 50);
  }

  function handleMcpCommand() {
    let config;
    try {
      config = JSON.parse(configBridge.getMcpServers() || '{}');
    } catch (e) {
      if (panel) panel.flash('MCP config is invalid JSON', true);
      return;
    }
    const serverNames = Object.keys(config);
    if (serverNames.length === 0) {
      if (panel) panel.flash('no MCP servers configured');
      return;
    }
    const catalog = (panel && panel.state && panel.state.catalog) || [];
    const lines = ['MCP servers:'];
    for (let i = 0; i < serverNames.length; i++) {
      const name = serverNames[i];
      const entry = config[name];
      const disabled = entry && entry.disabled;
      const toolCount = catalog.filter(function (t) {
        return t.kind === 'mcp' && t.server === name;
      }).length;
      lines.push(
        '  ' +
          name +
          (disabled ? ' (disabled)' : '') +
          ' — ' +
          toolCount +
          ' tool' +
          (toolCount === 1 ? '' : 's'),
      );
    }
    if (panel) panel.flash(lines.join('\n'));
  }

  const GMLOOP_OUTPUT_CAP = 12000;
  const GMLOOP_TIMEOUT_MS = 120000;
  const GMLOOP_OUTPUT_HALF_CAP = Math.floor(GMLOOP_OUTPUT_CAP / 2);

  function gmloopReadOnlyAction(value) {
    const action = String(value || 'status').toLowerCase();
    if (action === 'lint') {
      const target = gmloopCurrentGmlFileTarget();
      if (!target) return { label: 'lint', error: 'open a GML file before /gmloop lint' };
      return { label: 'lint ' + target.label, argv: ['lint', target.path] };
    }
    if (action === 'lint-project' || action === 'project-lint') {
      return { label: 'lint project', argv: ['lint', projectDirectory] };
    }
    if (action === 'format' || action === 'format-check' || action === 'check') {
      const target = gmloopCurrentGmlFileTarget();
      if (!target) return { label: 'format check', error: 'open a GML file before /gmloop format-check' };
      return { label: 'format check ' + target.label, argv: ['format', '--path', target.path] };
    }
    if (action === 'format-project' || action === 'check-project') {
      return { label: 'format check project', argv: ['format', '--path', projectDirectory] };
    }
    if (action === 'doctor' || action === 'graph' || action === 'graph-doctor') {
      return { label: 'graph doctor', argv: ['graph', 'doctor', '--path', projectDirectory] };
    }
    if (action === 'parse') {
      const target = gmloopCurrentGmlFileTarget();
      if (!target) {
        return { label: 'parse', error: 'open a GML file before /gmloop parse' };
      }
      return { label: 'parse current file', argv: ['parse', '--path', target.path] };
    }
    return null;
  }

  function gmloopCurrentGmlFileTarget() {
    const ctx = currentEditorContext();
    if (!ctx || !ctx.openFile || !/\.gml$/i.test(String(ctx.openFile))) return null;
    const abs = resolveProjectChildPath(ctx.openFile);
    return abs ? { path: abs, label: 'current file' } : null;
  }

  function resolveProjectChildPath(relPath) {
    if (!projectDirectory || !relPath) return '';
    const root = path.resolve(projectDirectory);
    const cleaned = normalizeToPosix(relPath).replace(/^\/+/, '');
    const abs = path.resolve(root, cleaned);
    const relative = path.relative(root, abs);
    if (
      relative === '' ||
      relative === '..' ||
      relative.indexOf('..' + path.sep) === 0 ||
      path.isAbsolute(relative)
    ) {
      return '';
    }
    return abs;
  }

  function runGmloopReadOnly(action) {
    if (!projectDirectory) {
      if (panel) panel.flash('open a GameMaker project before running GMLoop', true);
      return true;
    }
    if (activeGmloopChild) {
      if (panel) panel.flash('GMLoop is already running a check', true);
      return true;
    }
    const spec = gmloopReadOnlyAction(action);
    if (!spec) return false;
    if (spec.error) {
      if (panel) panel.flash(spec.error, true);
      return true;
    }
    const info = gmloopDiagnostics();
    if (!info.cmd) {
      handleGmloopCommand({ kind: 'gmloop', value: 'status' });
      return true;
    }
    const argv = (info.argvPrefix || []).concat(spec.argv);
    const wrapped =
      ChildProcessApi && typeof ChildProcessApi.wrapCmdForWindows === 'function'
        ? ChildProcessApi.wrapCmdForWindows(info.cmd, argv)
        : { cmd: info.cmd, argv: argv };
    const env =
      ChildProcessApi && typeof ChildProcessApi.buildMinimalEnv === 'function'
        ? ChildProcessApi.buildMinimalEnv()
        : process.env;
    let child;
    let output = '';
    let finished = false;
    const append = function (chunk) {
      output = capGmloopOutput(output + sanitizeDiagnosticText(String(chunk || '')));
    };
    try {
      child = spawn(wrapped.cmd, wrapped.argv, {
        cwd: projectDirectory,
        env: env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      recordDiagnostic('gmloop', spec.label + ' spawn failed: ' + (e.message || e));
      if (panel) panel.flash('GMLoop ' + spec.label + ' failed to start: ' + (e.message || e), true);
      return true;
    }
    activeGmloopChild = child;
    recordDiagnostic('gmloop', 'run ' + spec.label);
    if (panel) panel.flash('running GMLoop ' + spec.label + '...');
    const timeout = setTimeout(function () {
      if (finished) return;
      finished = true;
      try {
        child.kill();
      } catch (e) {
        /* ignore */
      }
      if (activeGmloopChild === child) activeGmloopChild = null;
      recordDiagnostic('gmloop', spec.label + ' timed out');
      if (panel) panel.flash('GMLoop ' + spec.label + ' timed out after 120s', true);
    }, GMLOOP_TIMEOUT_MS);
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', function (err) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (activeGmloopChild === child) activeGmloopChild = null;
      recordDiagnostic('gmloop', spec.label + ' error: ' + (err.message || err));
      if (panel) panel.flash('GMLoop ' + spec.label + ' error: ' + (err.message || err), true);
    });
    child.on('exit', function (code) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (activeGmloopChild === child) activeGmloopChild = null;
      const body = output.trim() || '(no output)';
      const ok = code === 0;
      recordDiagnostic('gmloop', spec.label + ' exit ' + String(code));
      if (panel) panel.flash('GMLoop ' + spec.label + ' ' + (ok ? 'passed' : 'exited ' + code) + '\n' + body, !ok);
    });
    return true;
  }

  function capGmloopOutput(text) {
    const value = String(text || '');
    if (value.length <= GMLOOP_OUTPUT_CAP) return value;
    return (
      value.slice(0, GMLOOP_OUTPUT_HALF_CAP) +
      '\n[truncated ' +
      String(value.length - GMLOOP_OUTPUT_CAP) +
      ' chars]\n' +
      value.slice(value.length - GMLOOP_OUTPUT_HALF_CAP)
    );
  }

  function handleGmloopCommand(cmd) {
    if (cmd.value && cmd.value !== 'status' && runGmloopReadOnly(cmd.value)) return;
    const info = gmloopDiagnostics();
    const lines = ['GMLoop: ' + info.status];
    if (info.dir) lines.push('dir: ' + info.dir);
    if (info.runner) lines.push('runner: ' + info.runner);
    if (info.setup) lines.push('setup: ' + info.setup);
    lines.push('safe commands: ' + info.commands);
    lines.push(
      'available now: /gmloop lint, /gmloop format-check, /gmloop graph-doctor, /gmloop parse',
    );
    lines.push('project-wide: /gmloop lint-project, /gmloop format-project');
    if (cmd.value && cmd.value !== 'status') {
      lines.push('/gmloop ' + cmd.value + ' is not wired yet');
    }
    recordDiagnostic('gmloop', info.status + (info.runner ? ' via ' + info.runner : ''));
    if (panel) panel.flash(lines.join('\n'), info.status === 'not found' || /missing/.test(info.status));
  }

  function setConfigAndRestart(field, value) {
    configBridge.setConfigField(field, value, function (err) {
      if (err) {
        if (panel) panel.flash('config set failed: ' + (err.message || err), true);
        return;
      }
      restartCore();
    });
  }

  function refreshEffectiveConfig() {
    const dir = projectDirectory || __dirname;
    configBridge.showEffectiveConfig(dir, function (err, cfg) {
      if (err) {
        if (panel) panel.flash('config load failed: ' + (err.message || err), true);
        return;
      }
      if (!panel || !cfg) return;
      panel.setConfig(cfg);
      panel.setSettingsValues(cfg);
    });
  }

  // -------------------------------------------------------------------------
  // Child process lifecycle (NdjsonClient) <-> ChatPanel wiring.
  // -------------------------------------------------------------------------
  function launch() {
    if (!projectDirectory) {
      console.warn('chatgml: open a project first');
      recordDiagnostic('launch', 'blocked: no project');
      if (panel) panel.flash('open a GameMaker project first', true);
      return;
    }
    if (client) return;
    recordDiagnostic('launch', projectDirectory);
    const extraEnv = launchAuthEnv();
    client = new ClientApi.NdjsonClient({
      projectDir: projectDirectory,
      configuredPath: configBridge.getBinaryPath(),
      scope: configBridge.getScope() || undefined,
      pluginDir: __dirname,
      extraEnv: extraEnv,
      onEvent: function (event) {
        if (panel) panel.handleEvent(event);
        if (event && event.type === 'error') {
          recordDiagnostic('model error', event.message || event.error || 'unknown error');
        }
        if (event.type === 'edit_proposal') {
          rememberProposals();
          try {
            if (activeFilePath() === event.path) renderDiffMarkers(activeFile(), event);
          } catch (e) {
            /* ignore */
          }
        }
        if (event.type === 'command_request') terminalOutput = '';
        if (event.type === 'command_output') {
          terminalOutput = (terminalOutput + String(event.text || '')).slice(-8192);
        }
      },
      onReady: function (event) {
        recordDiagnostic('ready', event && event.mode ? 'mode=' + event.mode : 'ready');
        if (panel) {
          panel.setReady();
          if (event && event.mode) panel.setMode(event.mode);
        }
        configBridge.setCoreAvailable(true);
        client.sendApprovalPolicy(configBridge.getApprovalPolicy());
        // Pull the effective config into the quick-config row (display-only; secrets are redacted).
        refreshEffectiveConfig();
        // Resume the last saved session for the current task so multi-turn context survives restarts.
        void (async function () {
          const turns = await loadSessionTurns();
          if (panel) panel.loadTurns(turns);
          if (client) client.sendResume(State.turnEndToMessages(turns), currentTaskId);
        })();
      },
      onMalformed: function (line) {
        recordDiagnostic('malformed', line);
        console.warn('chatgml: malformed protocol line (ignored):', line);
      },
      onStderr: function (text) {
        // stdout is protocol-only; stderr is diagnostics. Route to the console/log, never the panel.
        recordDiagnostic('stderr', text.trim());
        console.info('chatgml[serve]:', text.trim());
      },
      onError: function (err) {
        recordDiagnostic('error', err.message);
        console.error('chatgml: failed to launch core —', err.message);
        if (panel) panel.handleEvent({ type: 'error', message: err.message });
        client = null;
        configBridge.setCoreAvailable(false);
        if (panel) panel.setRunning(false, err);
      },
      onExit: function (code) {
        const err =
          code !== 0 && code != null ? new Error('ChatGML core exited with code ' + code) : null;
        recordDiagnostic('exit', String(code));
        console.info('chatgml: core exited', code);
        client = null;
        configBridge.setCoreAvailable(false);
        if (panel) panel.setRunning(false, err);
      },
    });
    const started = client.start();
    if (started && panel) {
      panel.setRunning(true);
    } else if (!started) {
      recordDiagnostic('launch', 'start returned false');
      client = null;
    }
  }

  function stop() {
    recordDiagnostic('stop', client ? 'stopping core' : 'no core');
    if (client) {
      client.stop();
      client = null;
    }
    if (panel) panel.setRunning(false);
  }

  // -------------------------------------------------------------------------
  // Side-panel scaffolding (reparent the main editor into a flex-row, add the chat panel beside it).
  // Port of the old plugin's GMEdit_Splitter + aceTools side-panel, minus the second Ace editor.
  // -------------------------------------------------------------------------
  function forceUpdate() {
    const e = new CustomEvent('resize');
    e.initEvent('resize');
    window.dispatchEvent(e);
  }

  function forceUpdateSoon() {
    forceUpdate();
    setTimeout(forceUpdate, 0);
    setTimeout(forceUpdate, 60);
  }

  function hide(remember) {
    if (remember !== false) writeOpenPreference(false);
    if (sizer && sizer.parentNode) sizer.parentNode.removeChild(sizer);
    if (container && container.parentNode) container.parentNode.removeChild(container);
    gmlFile = null;
    recordDiagnostic('panel', 'hidden');
    forceUpdateSoon();
    setTimeout(function () {
      aceEditor.focus();
    });
  }

  function show() {
    writeOpenPreference(true);
    if (gmlFile != null) {
      forceUpdateSoon();
      return;
    }
    if (ready && mainCont && sizer && container) {
      if (sizer.parentNode !== mainCont) mainCont.appendChild(sizer);
      if (container.parentNode !== mainCont) mainCont.appendChild(container);
    } else {
      prepare();
    }
    gmlFile = true;
    recordDiagnostic('panel', 'shown');
    forceUpdateSoon();
    if (projectDirectory && !client) launch();
  }

  function togglePanel() {
    if (gmlFile != null) hide(true);
    else show();
  }

  function prepare() {
    ready = true;

    container = document.createElement('div');
    container.classList.add('ace_container');
    container.classList.add('chatgml-aside');
    container.id = 'chatgml_editor';

    panelHostEl = document.createElement('div');
    panelHostEl.id = 'chatgml_panel_host';
    container.appendChild(panelHostEl);

    panel = new PanelApi.ChatPanel({
      container: panelHostEl,
      tasks: listTasks(),
      onNewTask: function (name) {
        void createTask(name);
      },
      onSwitchTask: function (name) {
        void switchTask(name);
      },
      onDeleteTask: function (name) {
        void deleteTask(name);
      },
      // SESSIONS sidebar callbacks: the new sessions sidebar surfaces these directly. Each
      // callback delegates to the matching legacy session function so the slash-command
      // surface and the sidebar surface share the same code path. After each mutation we
      // re-scan the list from disk so the sidebar reflects the new state without a manual
      // refresh.
      onNewSession: async function () {
        // Mint a fresh session id and switch to it. We do NOT pop a `prompt()` — the sidebar's
        // "+" button is a deliberate "start a new chat" affordance, so the user already opted in.
        const id = await Sessions.create(projectDirectory);
        await switchTask(id);
        void refreshSessionsPanel();
      },
      onSwitchSession: function (id) {
        void switchTask(id);
      },
      onDeleteSession: async function (id) {
        await deleteTask(id);
        void refreshSessionsPanel();
      },
      getMentions: getMentions,
      getProjectFiles: function () {
        return scanProjectFiles(projectDirectory);
      },
      getDiagnostics: diagnosticsSnapshot,
      onCopyDiagnostics: function (text) {
        if (!copyText(text)) {
          console.info('[chatgml] diagnostics:\n' + sanitizeDiagnosticText(text));
        }
      },
      onSendWithContext: function (text, context) {
        if (!client) return;
        // OUTBOX / busy safety-net: the panel already disables Send + marks the input
        // readOnly via _setBusy(true) when a turn is in flight (see panel.js _submit /
        // _setBusy). This belt-and-suspenders check drops an enqueue if the panel somehow
        // didn't yet gate the click (e.g. an Enter keydown that fires before the next
        // render paints). The server-side `await prior.catch(() => {})` in src/serve.ts is
        // the authoritative serializer — the worst case here is a duplicate user message
        // being sent, not a corrupt state.
        if (panel && panel.state && panel.state.outbox && panel.state.outbox.length > 0) {
          // Already have at least one in-flight message; allow up to two queued so a fast
          // double-tap still surfaces both bubbles (cap matches the spirit of "user can
          // see what they typed even if A's response lags"). Three or more enqueues likely
          // means a runaway key repeat — drop those silently.
          if (panel.state.outbox.length > 2) return;
        }
        // UserCommand wire shape (src/types.ts): { type:'user', text, context?, taskId?, tier? }.
        // taskId + tier are TOP-LEVEL fields (not under `context`); the core's UserCommand
        // schema in src/protocol.ts validates them there. The per-turn tier override is null
        // when the user has not set one (mode-based auto-dispatch).
        var sendOpts = { taskId: currentTaskId, tier: activeTierOverride };
        client.sendUser(text, context, sendOpts);
      },
      onTierOverride: function (name) {
        // Mirror the panel-side chip click + /tier slash command. The panel has already
        // re-rendered; the glue just keeps the wire-side let-bind in sync.
        activeTierOverride =
          name === 'planner' || name === 'implementer' || name === 'reviewer' ? name : null;
      },
      onSend: function (text) {
        if (!client) return;
        // Belt-and-suspenders busy check (same rationale as onSendWithContext above). The
        // panel normally gates Send via _setBusy(true), so this only fires on a keydown
        // race during a re-render.
        if (panel && panel.state && panel.state.outbox && panel.state.outbox.length > 2) return;
        client.sendUser(text);
      },
      getEditorContext: currentEditorContext,
      onSlash: handleSlash,
      onTurnEnd: function (record) {
        if (record && record.userText != null) {
          void appendTurn(record);
          // After a turn lands the session's metadata (title, messageCount, updatedAt) may
          // have changed (Sessions.appendTurn bumps the counter + re-derives the title). Push
          // the refreshed list to the sidebar so the visible badge stays in lock-step with
          // disk. Best-effort — never breaks the panel.
          void refreshSessionsPanel();
        }
      },
      onReindex: function () {
        if (client) client.reindex();
      },
      onLaunch: launch,
      onStop: stop,
      onStopGenerate: function () {
        if (client) client.cancel();
      },
      onSettingsOpen: refreshEffectiveConfig,
      onClear: function () {
        if (client) client.sendClear();
        void clearSessionFile();
        // After clearing, the session's messageCount drops to 0 in the NDJSON but the
        // metadata sidecar may still claim >0 turns until the next appendTurn runs. Push a
        // refreshed list so the sidebar's "12 msg" badge updates immediately.
        void refreshSessionsPanel();
      },
      onOpenSource: function (src) {
        try {
          if (!src || !src.path || !projectDirectory) return;
          var abs = join(projectDirectory, src.path);
          var file = $gmedit['file.File'].read(abs, null);
          if (file) GMEdit.openFile(file);
        } catch (e) {
          console.info('chatgml: could not open source', e);
        }
      },
      onRestart: function () {
        stop();
        setTimeout(function () {
          launch();
        }, 50);
      },
      onModeChange: function (mode) {
        void setConfigAndRestart('mode', mode);
      },
      onApprove: function (id, blockIndex) {
        if (client) client.approve(id, blockIndex);
        if (blockIndex === undefined) {
          if (panel) panel.settleProposal(id, 'approved');
          try {
            const proposal = panel.state.pendingProposals.get(id);
            if (proposal && proposal.path) {
              rememberProposals();
              applyInlineDiffOnApprove(proposal.path);
              if (activeFilePath() === proposal.path) clearDiffMarkers(activeFile());
            }
          } catch (e) {
            /* ignore */
          }
        }
      },
      onReject: function (id, blockIndex) {
        if (client) client.reject(id, blockIndex);
        if (blockIndex === undefined) {
          if (panel) panel.settleProposal(id, 'rejected');
          try {
            const proposal = panel.state.pendingProposals.get(id);
            if (proposal && proposal.path && activeFilePath() === proposal.path) {
              clearDiffMarkers(activeFile());
            }
          } catch (e) {
            /* ignore */
          }
        }
      },
      onApproveCommand: function (id) {
        if (client) client.sendApproveCommand(id);
      },
      onRejectCommand: function (id) {
        if (client) client.sendRejectCommand(id);
      },
      onRunOnce: function (id) {
        if (client) client.sendRunOnce(id);
      },
      onUndo: function (checkpointId) {
        if (client) client.sendUndo(checkpointId);
      },
      // ---- Provider registry callbacks (panel populates / refreshes / adds / exports) ----
      // The panel keeps the registry module reference + raw registry in instance state; the
      // glue just re-reads disk and re-pushes. All three callbacks are best-effort — a failure
      // surfaces as a panel flash and the settings panel stays usable.
      onRefreshProviders: function () {
        if (panel && typeof panel.populateProviders === 'function') {
          try {
            var load = ProvidersApi.loadAll({
              chatgmlUserDir: chatgmlUserDirForProviders(),
            });
            panel._registry = load.registry;
            panel._ProvidersApi = ProvidersApi;
            panel.populateProviders(load, {
              onRefresh: function () {
                panel.opts.onRefreshProviders();
              },
              onAddProvider: function () {
                panel.opts.onAddProvider();
              },
              onExportEnv: function () {
                panel.opts.onExportEnv();
              },
            });
            if (load.bootstrapped && panel) {
              panel.flash('Providers bootstrapped from ~/.pi/agent/providers.json');
            }
          } catch (e) {
            if (panel) panel.flash('refresh providers failed: ' + (e.message || e), true);
          }
        }
      },
      onAddProvider: function () {
        // Minimal inline add form. The panel could grow this into a full modal later; for now
        // we collect (name, baseURL, modelId) via window.prompt and write through the
        // ProvidersApi. The registry refresh callback then re-renders the section.
        var name = null;
        var baseUrl = null;
        var modelId = null;
        try {
          // GMEdit's renderer has window.prompt; we fall back to a no-op for safety in headless
          // contexts (tests + the initial background bootstrap).
          if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
            name = window.prompt('Provider name (a-z, 0-9, _, -):', '');
            if (!name) return;
            baseUrl = window.prompt('Base URL (e.g. https://api.example.com/v1):', '');
            if (!baseUrl) return;
            modelId = window.prompt('First model id (or leave blank for no models yet):', '');
          }
        } catch (e) {
          if (panel) panel.flash('add provider aborted: ' + (e.message || e), true);
          return;
        }
        if (!name || !baseUrl) return;
        try {
          var chatgmlPath = ProvidersApi.defaultChatgmlProvidersPath(chatgmlUserDirForProviders());
          var entry = {
            chatgmlPath: chatgmlPath,
            name: String(name).trim(),
            baseUrl: String(baseUrl).trim(),
            endpoint: '/chat/completions',
            auth: 'bearer',
            models: modelId
              ? [{ id: String(modelId).trim(), wire_model: String(modelId).trim() }]
              : [],
          };
          var result = ProvidersApi.registerProvider(entry);
          if (!result.ok) {
            if (panel) panel.flash('add provider failed: ' + result.error, true);
            return;
          }
          if (panel) panel.flash('Provider "' + entry.name + '" added — refresh to see');
          // Auto-refresh so the user sees the new entry in the list without an extra click.
          if (panel && panel.opts && typeof panel.opts.onRefreshProviders === 'function') {
            panel.opts.onRefreshProviders();
          }
        } catch (e) {
          if (panel) panel.flash('add provider failed: ' + (e.message || e), true);
        }
      },
      onExportEnv: function () {
        try {
          var load = ProvidersApi.loadAll({ chatgmlUserDir: chatgmlUserDirForProviders() });
          var env = ProvidersApi.toEnvFormat(load.registry);
          // Try GMEdit's clipboard API first; fall back to a textarea+execCommand for headless.
          var copied = false;
          try {
            if (
              typeof GMEdit !== 'undefined' &&
              GMEdit &&
              typeof GMEdit.setClipboard === 'function'
            ) {
              GMEdit.setClipboard(env);
              copied = true;
            } else if (
              typeof navigator !== 'undefined' &&
              navigator.clipboard &&
              typeof navigator.clipboard.writeText === 'function'
            ) {
              navigator.clipboard.writeText(env);
              copied = true;
            } else if (typeof document !== 'undefined') {
              var ta = document.createElement('textarea');
              ta.value = env;
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.select();
              try {
                document.execCommand('copy');
                copied = true;
              } catch (e) {
                /* fallthrough */
              }
              document.body.removeChild(ta);
            }
          } catch (e) {
            /* fallthrough */
          }
          if (copied) {
            if (panel)
              panel.flash('.env copied to clipboard (' + load.providers.length + ' providers)');
          } else {
            // Last resort: log to console so the user can copy manually.
            try {
              console.info('[chatgml] provider .env export:\n' + env);
            } catch (e) {
              /* no console */
            }
            if (panel)
              panel.flash(
                '.env export logged to console (' + load.providers.length + ' providers)',
              );
          }
        } catch (e) {
          if (panel) panel.flash('export .env failed: ' + (e.message || e), true);
        }
      },
      // Bootstrap-on-init: read the registry and stamp it on the panel BEFORE the user opens
      // settings so the first open already shows a populated list (and the sticky header has
      // data). Best-effort — a failure here is silently logged; the panel will still work, it
      // just shows "0 providers" until the user clicks Refresh.
      onSettingsBootstrap: function () {
        try {
          var load = ProvidersApi.loadAll({ chatgmlUserDir: chatgmlUserDirForProviders() });
          if (!panel) return;
          panel._registry = load.registry;
          panel._ProvidersApi = ProvidersApi;
          // Always stash the callbacks so the lazy-build path can pick them up on first open.
          // Without this, Refresh/Add/Export buttons would be no-ops until the user closed and
          // reopened settings (since `_pendingProvidersLoad` alone would carry data but no
          // callbacks).
          panel._pendingProvidersCallbacks = {
            onRefresh: panel.opts.onRefreshProviders,
            onAddProvider: panel.opts.onAddProvider,
            onExportEnv: panel.opts.onExportEnv,
          };
          // The panel might not have built the settings DOM yet (first open lazy-builds it).
          // If the DOM exists, populate; otherwise the panel calls populateProviders itself the
          // first time settings is opened.
          if (panel.settingsHeaderEl) {
            panel.populateProviders(load, panel._pendingProvidersCallbacks);
          } else {
            // Stash the load result so the panel can pick it up on first open.
            panel._pendingProvidersLoad = load;
          }
        } catch (e) {
          console.info('chatgml: providers bootstrap failed', e && (e.message || e));
        }
      },
      onSaveSettings: function (settings) {
        void (async function () {
          // Decide which `chatgml config set` commands to run (and whether to also set the
          // plugin-local scope pref). The helper drops empty fields so an accidental blank
          // submit never overwrites an existing value; in particular `apiKey` is a no-op when
          // empty. The core itself additionally refuses to persist a literal secret for any
          // SECRET_FIELD_PATHS field (chat.apiKey, embed.apiKey, memory.hippo.key) — only an
          // `env:NAME` reference is accepted — and that's exactly what the help text under the
          // input tells the user to paste.
          var plan = SettingsTasks.buildSettingsCommands(settings);
          var tasks = plan.commands;
          // Write each config field sequentially, then restart the core. Scope is a plugin pref
          // (it must precede the serve argv on restart, NOT a user-global config field) so it
          // goes through configBridge.setScope, not configBridge.setConfigField.
          var savedCount = tasks.length;
          var failures = [];
          if (plan.scope !== null) {
            configBridge.setScope(plan.scope);
            savedCount++;
          }
          var i = 0;
          function next() {
            if (i >= tasks.length) {
              if (failures.length > 0) {
                recordDiagnostic('settings', 'failed fields: ' + failures.join(', '));
                if (panel) {
                  panel.flash(
                    'settings saved with ' +
                      failures.length +
                      ' failure' +
                      (failures.length === 1 ? '' : 's') +
                      ': ' +
                      failures.join(', '),
                    true,
                  );
                }
                return;
              }
              if (panel) {
                var selected =
                  settings && settings.providerName ? ' via ' + settings.providerName : '';
                recordDiagnostic(
                  'settings',
                  savedCount > 0 ? 'saved ' + savedCount + ' field(s)' + selected : 'unchanged',
                );
                panel.flash(
                  savedCount > 0
                    ? 'settings saved' +
                        selected +
                        ' (' +
                        savedCount +
                        ' field' +
                        (savedCount === 1 ? '' : 's') +
                        ') — restarting core…'
                    : 'settings unchanged — restarting core…',
                );
              }
              restartCore();
              return;
            }
            var field = tasks[i][0];
            var value = tasks[i][1];
            i++;
            configBridge.setConfigField(field, value, function (err) {
              if (err) {
                failures.push(field);
                recordDiagnostic(
                  'settings',
                  'config set ' + field + ' failed: ' + (err.message || err),
                );
              }
              if (err && panel)
                panel.flash('config set ' + field + ' failed: ' + (err.message || err), true);
              next();
            });
          }
          next();
        })();
      },
    });
    // Wire the fuzzy filter for the @file autocomplete dropdown.
    panel._fileFilter = FuzzyApi.filter;

    // Kick off the providers registry bootstrap as soon as the panel is alive. The panel may not
    // have built its settings DOM yet (lazy on first open) — `_pendingProvidersLoad` is the
    // handoff for that case; `_toggleSettings` consults it and runs the populate when the user
    // first opens the settings dropdown. The panel stores its constructor opts on `this.opts`
    // (see panel.js ChatPanel()), so that's where the bootstrap callback lives — NOT a free
    // `opts` variable in this scope. (Left over from a refactor: previously this function
    // received opts as a parameter; the panel constructor now owns that surface.)
    if (panel && panel.opts && typeof panel.opts.onSettingsBootstrap === 'function') {
      try {
        panel.opts.onSettingsBootstrap();
      } catch (e) {
        console.info('chatgml: settings bootstrap threw', e && (e.message || e));
      }
    }
    sizer = document.createElement('div');
    sizer.setAttribute('splitter-element', '#chatgml_editor');
    sizer.setAttribute('splitter-lskey', ASIDE_WIDTH_KEY);
    sizer.setAttribute('splitter-default-width', String(ASIDE_DEFAULT_WIDTH));
    sizer.classList.add('splitter-td');
    sizer.classList.add('chatgml-splitter');

    // Reparent the existing editor children into a flex-row container so the panel sits beside them.
    const nextCont = document.createElement('div');
    nextCont.classList.add('ace_container');
    nextCont.classList.add('chatgml-editor-main');
    mainCont = aceEditor.container.parentElement;
    const mainChildren = [];
    for (let i = 0; i < mainCont.children.length; i++) mainChildren.push(mainCont.children[i]);
    for (let i = 0; i < mainChildren.length; i++) {
      const ch = mainChildren[i];
      mainCont.removeChild(ch);
      nextCont.appendChild(ch);
    }
    mainCont.style.setProperty('flex-direction', 'row');
    mainCont.style.setProperty('min-width', '0');
    mainCont.classList.add('chatgml-aside-host');
    mainCont.appendChild(nextCont);
    mainCont.appendChild(sizer);
    mainCont.appendChild(container);

    splitter = new GMEdit_Splitter(sizer);
    void splitter;
    void editor;
    refreshEffectiveConfig();
  }

  // -------------------------------------------------------------------------
  // GMEdit lifecycle.
  // -------------------------------------------------------------------------
  function init() {
    const mainMenu = aceEditor.contextMenu.menu;
    let insertAt = 0;
    while (insertAt < mainMenu.items.length) {
      if (mainMenu.items[insertAt++].aceCommand === 'selectall') break;
    }
    const insertPosition = Math.min(insertAt + 2, mainMenu.items.length);
    mainMenu.insert(
      insertPosition,
      new MenuItem({
        label: 'ChatGML',
        id: 'chatgml',
        click: function () {
          show();
        },
      }),
    );

    // "Ask about selection": open the panel (if needed) and send a user message primed with the
    // editor context (open file + selection + cursor line) so the agent knows what you're pointing
    // at. If nothing is selected, falls back to "explain this file" with the open file only.
    mainMenu.insert(
      insertPosition + 1,
      new MenuItem({
        label: 'Ask about selection',
        id: 'chatgml-ask-selection',
        click: function () {
          show();
          setTimeout(function () {
            if (!panel || !client) return;
            const selection = (aceEditor && aceEditor.getSelectedText()) || '';
            const prompt =
              selection.trim() !== ''
                ? 'Explain this selection and suggest improvements.'
                : 'Explain this file.';
            const ctx = currentEditorContext();
            client.sendUser(prompt, ctx);
          }, 0);
        },
      }),
    );

    GMEdit.on('projectOpen', function (e) {
      invalidateFileIndex(); // new project -> rescan file list for @file autocomplete
      projectDirectory = e.project.dir; // the on-disk directory (NOT e.project.path / the .yyp)
      console.info('chatgml: project opened', projectDirectory);
      recordDiagnostic('project', projectDirectory);
      refreshEffectiveConfig();
      // Read the disk-side active pointer so the panel resumes the last-active session for
      // this project on relaunch. Falls back to 'default' when no active file exists yet
      // (first launch on this project). We then push the list to the sidebar + legacy task
      // picker via refreshSessionsPanel, which also flips `currentTaskId` in memory.
      void (async function () {
        const activeId = await Sessions.getActive(projectDirectory);
        if (activeId) {
          currentTaskId = activeId;
        }
        if (panel) {
          panel.setTask(currentTaskId);
        }
        await refreshSessionsPanel();
        if (shouldRestoreOpen(projectDirectory)) {
          setTimeout(function () {
            show();
          }, 0);
        }
      })();
    });

    GMEdit.on('activeFileChange', function (e) {
      try {
        const old = e && e.prev;
        if (old) clearDiffMarkers(old);
      } catch (err) {
        /* ignore */
      }
    });

    GMEdit.on('preferencesBuilt', function (e) {
      const out = e.target.querySelector('.plugin-settings[for="' + PLUGIN_NAME + '"]');
      if (!out) return;
      Preferences.addInput(
        out,
        'ChatGML binary path (optional)',
        configBridge.getBinaryPath(),
        function (text) {
          configBridge.setBinaryPath(text);
        },
      );
      Preferences.addInput(out, 'Scope (optional)', configBridge.getScope(), function (text) {
        configBridge.setScope(text);
      });
      buildModePreference(out);
      buildApprovalPreferences(out);
      buildMcpPreferences(out);
    });
  }

  const FALLBACK_TOOLS = [
    'read_file',
    'grep',
    'search_code',
    'search_files',
    'glob',
    'graph',
    'temporal',
    'apply_patch',
    'search_replace',
    'execute_command',
  ];

  function getKnownTools() {
    if (panel && panel.state && panel.state.catalog && panel.state.catalog.length > 0) {
      return panel.state.catalog.map(function (t) {
        return t.name;
      });
    }
    return FALLBACK_TOOLS.slice();
  }

  function buildModePreference(out) {
    const header = document.createElement('div');
    header.className = 'chatgml-prefs-section';
    header.textContent = 'Default agent mode';
    out.appendChild(header);
    const row = document.createElement('div');
    row.className = 'chatgml-prefs-row';
    const label = document.createElement('label');
    label.className = 'chatgml-prefs-label';
    label.textContent = 'Mode';
    const select = document.createElement('select');
    select.className = 'chatgml-prefs-select';
    const modes = ['code', 'ask', 'debug', 'architect'];
    for (let i = 0; i < modes.length; i++) {
      const opt = document.createElement('option');
      opt.value = modes[i];
      opt.textContent = modes[i][0].toUpperCase() + modes[i].slice(1);
      select.appendChild(opt);
    }
    select.value = 'code';
    select.addEventListener('change', function () {
      configBridge.setConfigField('mode', select.value, function (err) {
        if (err) console.warn('chatgml: could not set default mode', err);
      });
      Preferences.save();
    });
    row.appendChild(label);
    row.appendChild(select);
    out.appendChild(row);
  }

  function buildApprovalPreferences(out) {
    const tools = getKnownTools();
    if (tools.length === 0) return;
    const header = document.createElement('div');
    header.className = 'chatgml-prefs-section';
    header.textContent = 'Tool approval policy';
    out.appendChild(header);
    const policy = configBridge.getApprovalPolicy();
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];
      const row = document.createElement('div');
      row.className = 'chatgml-prefs-row';
      const label = document.createElement('label');
      label.className = 'chatgml-prefs-label';
      label.textContent = tool;
      const select = document.createElement('select');
      select.className = 'chatgml-prefs-select';
      const gatedOpt = document.createElement('option');
      gatedOpt.value = 'gated';
      gatedOpt.textContent = 'gated';
      const autoOpt = document.createElement('option');
      autoOpt.value = 'auto';
      autoOpt.textContent = 'auto';
      select.appendChild(gatedOpt);
      select.appendChild(autoOpt);
      select.value = policy[tool] === 'auto' ? 'auto' : 'gated';
      select.addEventListener('change', function () {
        configBridge.setApprovalPolicy(tool, select.value);
        Preferences.save();
      });
      row.appendChild(label);
      row.appendChild(select);
      out.appendChild(row);
    }
  }

  function buildMcpPreferences(out) {
    const header = document.createElement('div');
    header.className = 'chatgml-prefs-section';
    header.textContent = 'MCP servers';
    out.appendChild(header);

    const hint = document.createElement('div');
    hint.className = 'chatgml-prefs-label';
    hint.textContent =
      'JSON config: { "serverName": { "command": "...", "args": [], "env": {}, "url": "...", "timeout": 30000, "disabled": false } }';
    hint.style.marginBottom = '4px';
    out.appendChild(hint);

    const textarea = document.createElement('textarea');
    textarea.className = 'chatgml-input';
    textarea.style.minHeight = '80px';
    textarea.style.fontFamily = 'monospace';
    textarea.value = configBridge.getMcpServers();
    out.appendChild(textarea);

    const status = document.createElement('div');
    status.className = 'chatgml-status';
    status.style.margin = '2px 0';
    out.appendChild(status);

    function validate() {
      try {
        JSON.parse(textarea.value);
        status.textContent = 'valid JSON';
        status.style.color = '#4caf50';
        return true;
      } catch (e) {
        status.textContent = 'invalid JSON: ' + (e.message || e);
        status.style.color = '#b23b3b';
        return false;
      }
    }

    textarea.addEventListener('input', function () {
      validate();
    });

    textarea.addEventListener('change', function () {
      if (!validate()) return;
      try {
        configBridge.setMcpServers(textarea.value);
        status.textContent = 'saved';
        status.style.color = '#4caf50';
        Preferences.save();
      } catch (e) {
        status.textContent = 'save failed: ' + (e.message || e);
        status.style.color = '#b23b3b';
      }
    });

    const reloadRow = document.createElement('div');
    reloadRow.className = 'chatgml-prefs-row';
    reloadRow.style.marginTop = '6px';
    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.className = 'run-button';
    reloadBtn.textContent = 'Reload MCP servers';
    reloadBtn.addEventListener('click', function () {
      if (client && client.ready) {
        client.send({ type: 'mcp_reload' });
        if (panel) panel.flash('reloading MCP servers…');
      } else {
        if (panel) {
          panel.flash(
            'Core is not running. Launch it to apply MCP config, or restart it if already running.',
          );
        }
      }
    });
    reloadRow.appendChild(reloadBtn);
    out.appendChild(reloadRow);
  }

  // -------------------------------------------------------------------------
  // Keyboard shortcuts + command palette (GMEdit exposes AceCommands to plugins).
  //
  // Bindings (Win / Linux):
  //   Ctrl-Shift-A   → toggle the ChatGML side panel
  //   Ctrl-Shift-I   → ask about current selection (opens panel + sends prompt)
  //   Ctrl-Shift-K   → focus the chat input (panel must already be visible)
  //
  // The "ask selection" binding mirrors the context-menu entry: if nothing is selected, it sends
  // "Explain this file." with the current file as context. We schedule the prompt on a microtask
  // so the panel's host element has a chance to mount before client.sendUser runs.
  // -------------------------------------------------------------------------
  if (typeof AceCommands !== 'undefined' && AceCommands && AceCommands.add) {
    AceCommands.add({
      name: 'chatgmlTogglePanel',
      bindKey: { win: 'Ctrl-Shift-A', mac: 'Command-Shift-A' },
      exec: function () {
        togglePanel();
      },
    });
    AceCommands.add({
      name: 'chatgmlAskSelection',
      bindKey: { win: 'Ctrl-Shift-I', mac: 'Command-Shift-I' },
      exec: function () {
        show();
        setTimeout(function () {
          if (!panel || !client) return;
          const selection =
            typeof aceEditor !== 'undefined' && aceEditor && aceEditor.getSelectedText
              ? aceEditor.getSelectedText() || ''
              : '';
          const prompt =
            selection.trim() !== ''
              ? 'Explain this selection and suggest improvements.'
              : 'Explain this file.';
          const ctx = currentEditorContext();
          client.sendUser(prompt, ctx);
        }, 0);
      },
    });
    AceCommands.add({
      name: 'chatgmlFocusInput',
      bindKey: { win: 'Ctrl-Shift-K', mac: 'Command-Shift-K' },
      exec: function () {
        show();
        setTimeout(function () {
          if (panel && typeof panel.focusInput === 'function') panel.focusInput();
        }, 0);
      },
    });
    // Add all three to the command palette (Ctrl+Shift+P) so they're discoverable.
    if (typeof AceCommands.addToPalette === 'function') {
      AceCommands.addToPalette({
        name: 'ChatGML: Toggle Panel',
        exec: 'chatgmlTogglePanel',
        title: 'Open or focus the ChatGML side panel',
      });
      AceCommands.addToPalette({
        name: 'ChatGML: Ask about selection',
        exec: 'chatgmlAskSelection',
        title: 'Ask the agent about the current selection (or file)',
      });
      AceCommands.addToPalette({
        name: 'ChatGML: Focus chat input',
        exec: 'chatgmlFocusInput',
        title: 'Focus the ChatGML panel input',
      });
    }
  }

  GMEdit.register(PLUGIN_NAME, {
    init: init,
    cleanup: function () {
      stop();
      hide(false);
      // Tear down keyboard shortcuts + palette entries. Idempotent.
      if (typeof AceCommands !== 'undefined' && AceCommands && AceCommands.remove) {
        AceCommands.remove({ name: 'chatgmlTogglePanel' });
        AceCommands.remove({ name: 'chatgmlAskSelection' });
        AceCommands.remove({ name: 'chatgmlFocusInput' });
      }
    },
  });
})();
