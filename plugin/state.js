// plugin/state.js — pure, DOM-free plugin logic. A CommonJS PORT of src/plugin-runtime.ts.
//
// GMEdit loads this as a plain <script> in an Electron renderer with Node integration, so it both
// (a) attaches to a global namespace for the other plugin scripts AND (b) exports via module.exports
// for the Node-based parity/unit tests (test/plugin/parity.test.ts asserts this file behaves
// identically to src/plugin-runtime.ts so the two copies can never drift).
//
// Nothing here touches the DOM, fs, or process — every dependency is passed in (env, platform,
// existence probe). Keep this in lock-step with src/plugin-runtime.ts.
(function (root) {
  'use strict';

  // --- 1. NDJSON line buffer (raw-chunk, tolerant of a malformed line) -----------------------
  function NdjsonLineBuffer() {
    this.buffer = '';
    // Persistent decoder so a multibyte UTF-8 codepoint split across stdout chunks is carried over.
    this.decoder = new TextDecoder();
  }
  NdjsonLineBuffer.prototype.push = function (chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const events = [];
    const malformed = [];
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim() === '') continue;
      try {
        events.push(JSON.parse(line));
      } catch (e) {
        malformed.push(line);
      }
    }
    return { events: events, malformed: malformed };
  };
  NdjsonLineBuffer.prototype.flush = function () {
    this.buffer += this.decoder.decode(); // drain any bytes held back by a split multibyte sequence
    const rest = this.buffer;
    this.buffer = '';
    const line = rest.endsWith('\r') ? rest.slice(0, -1) : rest;
    if (line.trim() === '') return { events: [], malformed: [] };
    try {
      return { events: [JSON.parse(line)], malformed: [] };
    } catch (e) {
      return { events: [], malformed: [line] };
    }
  };

  // --- 2. Handshake gate ---------------------------------------------------------------------
  function isReadyHandshake(e) {
    if (typeof e !== 'object' || e === null) return false;
    return e.type === 'status' && e.phase === 'ready' && typeof e.protocolVersion === 'number';
  }

  // --- 3. buildServeArgv (commander positional-options ordering) -----------------------------
  function buildServeArgv(opts) {
    const flags = [];
    if (opts.chat && opts.chat.baseURL) flags.push('--chat-base-url', opts.chat.baseURL);
    if (opts.chat && opts.chat.model) flags.push('--chat-model', opts.chat.model);
    if (opts.embed && opts.embed.baseURL) flags.push('--embed-base-url', opts.embed.baseURL);
    if (opts.embed && opts.embed.model) flags.push('--embed-model', opts.embed.model);
    if (opts.scope) flags.push('--scope', opts.scope);
    if (opts.approval) flags.push('--approval', opts.approval);
    if (opts.trustProjectConfig) flags.push('--trust-project-config');
    return flags.concat(['serve', opts.dir]);
  }

  // --- 4. resolveServeBinary (executable resolution ladder) ----------------------------------
  function resolveServeBinary(opts) {
    if (opts.configuredPath && opts.configuredPath.trim() !== '') {
      return { cmd: opts.configuredPath, argvPrefix: [] };
    }
    const fromEnv = opts.env['CHATGML_BIN'];
    if (fromEnv && fromEnv.trim() !== '') {
      return { cmd: fromEnv, argvPrefix: [] };
    }
    if (opts.exists(opts.distCliPath)) {
      return { cmd: opts.nodePath, argvPrefix: [opts.distCliPath] };
    }
    if (opts.platform === 'win32') {
      const appData = opts.env['APPDATA'];
      if (appData && appData.trim() !== '') {
        const shim = appData.replace(/[\\/]+$/, '') + '\\npm\\chatgml.cmd';
        if (opts.exists(shim)) {
          return { cmd: shim, argvPrefix: [] };
        }
      }
    }
    throw new Error(
      'chatgml executable not found. Set the "ChatGML binary path" plugin preference to an ' +
        'absolute path, set CHATGML_BIN, or build the core (dist/cli.js) in the checkout.',
    );
  }

  // --- 5. PluginState + reducePluginState ----------------------------------------------------
  function initialPluginState() {
    return {
      ready: false,
      phase: 'stopped',
      mode: 'code',
      transcript: '',
      answer: null,
      sources: [],
      activity: [],
      pendingProposals: new Map(),
      error: null,
      catalog: null,
      checkpoints: [],
    };
  }

  function reducePluginState(event, state) {
    const next = {
      ready: state.ready,
      phase: state.phase,
      mode: state.mode,
      transcript: state.transcript,
      answer: state.answer,
      sources: state.sources,
      activity: state.activity,
      pendingProposals: state.pendingProposals,
      error: state.error,
      catalog: state.catalog,
      checkpoints: state.checkpoints,
    };
    switch (event.type) {
      case 'status':
        next.phase = event.phase;
        if (event.phase === 'ready') {
          next.ready = true;
          if (event.mode) next.mode = event.mode;
        }
        return next;
      case 'token':
        next.transcript = state.transcript + event.text;
        return next;
      case 'tool_call':
        next.activity = state.activity.concat([
          {
            id: event.id,
            kind: 'tool',
            name: event.name,
            status: 'running',
            content: undefined,
            error: undefined,
          },
        ]);
        return next;
      case 'tool_result':
        next.activity = state.activity.map(function (a) {
          if (a.id !== event.id) return a;
          const copy = { id: a.id, kind: a.kind, name: a.name, status: event.ok ? 'ok' : 'error' };
          if (event.content != null) {
            const text = String(event.content);
            copy.content = text.length > 4096 ? text.slice(0, 4096) + '…' : text;
          }
          if (event.error != null) copy.error = String(event.error);
          return copy;
        });
        return next;
      case 'command_request':
        next.activity = state.activity.concat([
          {
            id: event.id,
            kind: 'command',
            name: 'execute_command',
            status: 'waiting',
            command: event.command,
            cwd: event.cwd,
            output: '',
          },
        ]);
        return next;
      case 'command_output': {
        const MAX_OUTPUT = 8192;
        next.activity = state.activity.map(function (a) {
          if (a.id !== event.id || a.kind !== 'command') return a;
          const text = String(a.output || '') + String(event.text || '');
          const output = text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + '…' : text;
          return {
            id: a.id,
            kind: a.kind,
            name: a.name,
            status: 'running',
            command: a.command,
            cwd: a.cwd,
            output: output,
          };
        });
        return next;
      }
      case 'command_exit':
        next.activity = state.activity.map(function (a) {
          if (a.id !== event.id || a.kind !== 'command') return a;
          const output = String(a.output || '') + '\n[exit code ' + event.code + ']';
          return {
            id: a.id,
            kind: a.kind,
            name: a.name,
            status: event.code === 0 ? 'ok' : 'error',
            command: a.command,
            cwd: a.cwd,
            output: output,
          };
        });
        return next;
      case 'mcp_tool_call':
        next.activity = state.activity.concat([
          {
            id: event.id,
            kind: 'mcp',
            name: event.name,
            server: event.server,
            status: 'running',
            content: undefined,
            error: undefined,
          },
        ]);
        return next;
      case 'mcp_tool_result':
        next.activity = state.activity.map(function (a) {
          if (a.id !== event.id || a.kind !== 'mcp') return a;
          const copy = {
            id: a.id,
            kind: a.kind,
            name: a.name,
            server: a.server,
            status: event.ok ? 'ok' : 'error',
          };
          if (event.content != null) {
            const text = String(event.content);
            copy.content = text.length > 4096 ? text.slice(0, 4096) + '…' : text;
          }
          if (event.error != null) copy.error = String(event.error);
          return copy;
        });
        return next;
      case 'mcp_resource':
        next.activity = state.activity.concat([
          {
            id: event.id,
            kind: 'mcp',
            name: event.name,
            server: event.server,
            status: 'ok',
            content:
              event.content != null
                ? (function () {
                    const text = String(event.content);
                    return text.length > 4096 ? text.slice(0, 4096) + '…' : text;
                  })()
                : undefined,
          },
        ]);
        return next;
      case 'turn_end':
        return next;
      case 'tool_catalog':
        next.catalog = event.tools ? event.tools.slice() : event.tools;
        return next;
      case 'checkpoint':
        next.checkpoints = state.checkpoints.concat([
          { id: event.id, path: event.path, label: event.label },
        ]);
        return next;
      case 'edit_proposal': {
        const map = new Map(state.pendingProposals);
        map.set(event.id, { id: event.id, path: event.path, diff: event.diff });
        next.pendingProposals = map;
        return next;
      }
      case 'approval_request':
        if (!state.pendingProposals.has(event.id)) {
          const map2 = new Map(state.pendingProposals);
          map2.set(event.id, { id: event.id, path: event.path, diff: '' });
          next.pendingProposals = map2;
        }
        return next;
      case 'answer':
        next.answer = event.text;
        next.sources = event.sources;
        return next;
      case 'error':
        next.error = event.message;
        return next;
      default:
        return next;
    }
  }

  function settleProposal(id, state) {
    if (!state.pendingProposals.has(id)) return state;
    const map = new Map(state.pendingProposals);
    map.delete(id);
    const next = Object.assign({}, state);
    next.pendingProposals = map;
    return next;
  }

  // --- 6. matchApproval ----------------------------------------------------------------------
  function matchApproval(req, pendingProposals) {
    return pendingProposals.get(req.id);
  }

  // --- 7. Slash commands (opencode-style chat input) -----------------------------------------
  function parseSlashCommand(line) {
    const trimmed = String(line == null ? '' : line).trim();
    if (trimmed === '' || trimmed[0] !== '/') return null;
    const sp = trimmed.indexOf(' ');
    const name = (sp === -1 ? trimmed.slice(1) : trimmed.slice(1, sp)).toLowerCase();
    if (name === '') return { kind: 'empty', name: '' };
    const value = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
    switch (name) {
      case 'clear':
        return { kind: 'clear' };
      case 'reindex':
        return { kind: 'reindex' };
      case 'resume':
        return { kind: 'resume' };
      case 'help':
      case '?':
        return { kind: 'help' };
      case 'scope':
        return value === '' ? { kind: 'empty', name: name } : { kind: 'scope', value: value };
      case 'model':
        return value === '' ? { kind: 'empty', name: name } : { kind: 'model', value: value };
      case 'mode':
        if (value === '') return { kind: 'empty', name: name };
        if (value !== 'architect' && value !== 'code' && value !== 'ask' && value !== 'debug')
          return { kind: 'unknown', name: name + ' ' + value };
        return { kind: 'mode', value: value };
      case 'approval':
        if (value !== 'gated' && value !== 'auto')
          return { kind: 'unknown', name: name + ' ' + value };
        return { kind: 'approval', value: value };
      case 'mcp':
        return { kind: 'mcp' };
      case 'undo':
        return { kind: 'undo', checkpointId: value || undefined };
      case 'new':
        return value === '' ? { kind: 'empty', name: name } : { kind: 'new_task', value: value };
      case 'tasks':
        return { kind: 'list_tasks' };
      case 'switch':
        return value === '' ? { kind: 'empty', name: name } : { kind: 'switch_task', value: value };
      case 'delete-task':
        return value === '' ? { kind: 'empty', name: name } : { kind: 'delete_task', value: value };
      default:
        return { kind: 'unknown', name: name };
    }
  }

  const SLASH_HELP = [
    'ChatGML slash commands:',
    '  /clear          drop conversation history (this session)',
    '  /reindex        rebuild the code index now',
    '  /resume         reload the last saved session for this project',
    '  /new <name>     create a new task workspace',
    '  /tasks          list existing task workspaces',
    '  /switch <name>  switch to a task workspace',
    '  /delete-task <name>  delete a task workspace',
    '  /mode architect|code|ask|debug   set the agent mode and restart the core',
    '  /scope <name>   set the memory scope and restart the core',
    '  /model <id>     set the chat model (chat.model) and restart the core',
    '  /approval gated|auto   set edit approval mode and restart the core',
    '  /mcp            list configured MCP servers and tool counts',
    '  /undo [id]      undo the most recent checkpoint (or the specified checkpoint id)',
    '  /help           show this help',
  ];

  // --- 8. Editor context construction (opencode-style current-file awareness) ----------------
  function buildEditorContext(opts) {
    const context = {};
    const file = opts && opts.openFile != null ? String(opts.openFile) : '';
    if (file.trim() !== '') context.openFile = file;
    const sel = opts && opts.selection != null ? String(opts.selection) : '';
    if (sel.trim() !== '') context.selection = sel;
    const line = Number(opts && opts.cursorLine);
    // Number.isInteger may be absent in old engines; emulate with Math.floor + isFinite.
    const isInt = isFinite(line) && Math.floor(line) === line;
    if (isInt && line > 0) context.cursorLine = line;
    if (
      context.openFile === undefined &&
      context.selection === undefined &&
      context.cursorLine === undefined
    ) {
      return undefined;
    }
    return context;
  }

  // --- 9. Session persistence (resumable conversation history) -----------------------------
  function turnEndToMessages(turns) {
    const out = [];
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (!t || !t.userText || String(t.userText).trim() === '') continue;
      out.push({ role: 'user', content: t.userText });
      const a = t.assistantText && String(t.assistantText).length > 0 ? t.assistantText : null;
      out.push({ role: 'assistant', content: a });
    }
    return out;
  }

  function buildResumeCommand(turns) {
    return { type: 'resume', messages: turnEndToMessages(turns) };
  }

  // --- 10. @mention parsing (opencode-style explicit context) -------------------------------
  function parseMentionLine(line) {
    if (!line || line.charAt(0) !== '@') return null;
    const rest = line.slice(1).trim();
    if (rest === '') return null;

    // Bare URL form: @https://example.com
    const urlMatch = /^(https?:\/\/\S+)$/.exec(rest);
    if (urlMatch) {
      return { type: 'url', target: urlMatch[1] };
    }

    // @/path shorthand: infer file vs folder from trailing slash
    if (rest.charAt(0) === '/') {
      const target = rest.split(/\s+/)[0];
      const type = target.endsWith('/') ? 'folder' : 'file';
      return { type: type, target: target };
    }

    // Keyword form: @type [target]
    const kwMatch = /^(file|folder|problems|diagnostics|terminal|url|image)(?:\s+(\S+))?$/.exec(
      rest,
    );
    if (!kwMatch) return null;

    const keyword = kwMatch[1];
    const arg = kwMatch[2];

    if (keyword === 'problems' || keyword === 'diagnostics') {
      return { type: 'problems', target: arg || 'problems' };
    }
    if (keyword === 'terminal') {
      return { type: 'terminal', target: arg || 'terminal' };
    }
    if (!arg) return null; // file/folder/url/image require a target
    return { type: keyword, target: arg };
  }

  function parseMentions(text) {
    const mentions = [];
    const lines = String(text == null ? '' : text).split('\n');
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const m = parseMentionLine(raw.trim());
      if (m) {
        mentions.push(m);
      } else {
        kept.push(raw);
      }
    }
    return { mentions: mentions, cleanText: kept.join('\n').trim() };
  }

  const api = {
    NdjsonLineBuffer: NdjsonLineBuffer,
    isReadyHandshake: isReadyHandshake,
    buildServeArgv: buildServeArgv,
    resolveServeBinary: resolveServeBinary,
    initialPluginState: initialPluginState,
    reducePluginState: reducePluginState,
    settleProposal: settleProposal,
    matchApproval: matchApproval,
    parseSlashCommand: parseSlashCommand,
    SLASH_HELP: SLASH_HELP,
    buildEditorContext: buildEditorContext,
    turnEndToMessages: turnEndToMessages,
    buildResumeCommand: buildResumeCommand,
    parseMentions: parseMentions,
  };

  // Expose as a renderer global (for panel.js / client.js / chatgml.js) ...
  root.ChatGmlState = api;
  // ... and as a CommonJS module (for the Node parity test).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
