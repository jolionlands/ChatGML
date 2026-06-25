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
    if (opts.platform === 'win32') {
      const appData = opts.env['APPDATA'];
      if (appData && appData.trim() !== '') {
        const shim = appData.replace(/[\\/]+$/, '') + '\\npm\\chatgml.cmd';
        if (opts.exists(shim)) {
          return { cmd: shim, argvPrefix: [] };
        }
      }
    }
    if (opts.exists(opts.distCliPath)) {
      return { cmd: opts.nodePath, argvPrefix: [opts.distCliPath] };
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
      transcript: '',
      answer: null,
      sources: [],
      activity: [],
      pendingProposals: new Map(),
      error: null,
    };
  }

  function reducePluginState(event, state) {
    const next = {
      ready: state.ready,
      phase: state.phase,
      transcript: state.transcript,
      answer: state.answer,
      sources: state.sources,
      activity: state.activity,
      pendingProposals: state.pendingProposals,
      error: state.error,
    };
    switch (event.type) {
      case 'status':
        next.phase = event.phase;
        if (event.phase === 'ready') next.ready = true;
        return next;
      case 'token':
        next.transcript = state.transcript + event.text;
        return next;
      case 'tool_call':
        next.activity = state.activity.concat([
          { id: event.id, name: event.name, status: 'running' },
        ]);
        return next;
      case 'tool_result':
        next.activity = state.activity.map(function (a) {
          if (a.id !== event.id) return a;
          const copy = { id: a.id, name: a.name, status: event.ok ? 'ok' : 'error' };
          return copy;
        });
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

  const api = {
    NdjsonLineBuffer: NdjsonLineBuffer,
    isReadyHandshake: isReadyHandshake,
    buildServeArgv: buildServeArgv,
    resolveServeBinary: resolveServeBinary,
    initialPluginState: initialPluginState,
    reducePluginState: reducePluginState,
    settleProposal: settleProposal,
    matchApproval: matchApproval,
  };

  // Expose as a renderer global (for panel.js / client.js / chatgml.js) ...
  root.ChatGmlState = api;
  // ... and as a CommonJS module (for the Node parity test).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
