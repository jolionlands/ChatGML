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
  // Cap knobs for `turns` and `activity`. Tuned for long sessions: turns cap keeps the chat
  // transcript bounded (200 user/assistant bubble pairs is plenty of context for /resume and the
  // visible scroll); activity cap keeps the tool/MCP log bounded without losing recent work.
  // Both are applied inside the reducer (NOT in the renderer) so render logic can stay dumb.
  const TURN_CAP = 200;
  const ACTIVITY_CAP = 500;

  /**
   * Append `item` to `arr` and cap the result at `max` items (dropping from the FRONT so the
   * most-recent items are kept — chat is append-only and the newest turns belong at the end of
   * the array). Returns `[newArr, newEvictedCount]` where `newEvictedCount` is incremented by the
   * number of items actually trimmed (zero when nothing was trimmed). Pure: no I/O, no
   * Date.now() — safe to call inside the reducer.
   *
   * Parity-critical: the same function (byte-for-byte equivalent behavior) lives in
   * src/plugin-runtime.ts as `pushCapped`.
   */
  function pushCapped(arr, item, max, evictedCount) {
    const combined = arr.concat([item]);
    const dropped = combined.length - max;
    if (dropped <= 0) return [combined, evictedCount || 0];
    return [combined.slice(combined.length - max), (evictedCount || 0) + dropped];
  }

  function initialPluginState() {
    return {
      ready: false,
      phase: 'stopped',
      phaseDetail: null,
      mode: 'code',
      transcript: '',
      answer: null,
      sources: [],
      activity: [],
      pendingProposals: new Map(),
      error: null,
      catalog: null,
      checkpoints: [],
      turns: [],
      // Counts of items dropped from `turns` / `activity` because they exceeded their cap.
      // Surfaced to the UI so the panel can show "Showing last N turns (X trimmed from earlier
      // history)" without re-deriving it from the array lengths (which would lose the running
      // total across /clear-free runs).
      turnsEvicted: 0,
      activityEvicted: 0,
      pendingUserText: null,
      // THINKING PROPAGATION (mirror of src/plugin-runtime.ts): accumulated thinking text for
      // the most recent `thinking` event. Cleared on 'answer' so the streaming answer bubble
      // isn't shown a stale block. Plugin reads this during the assistant bubble render to show
      // the collapsible "model thinking..." block.
      lastThinking: null,
      // OUTBOX / QUEUE (mirror of src/plugin-runtime.ts): a queue of in-flight user messages so
      // a second send before the first response streams back does NOT visually overwrite the
      // first one. Items are pushed by the panel on send and popped by the reducer on
      // `answer` / `turn_end`. The server serializes runs (`await prior.catch(() => {})` in
      // src/serve.ts) so both messages always reach the wire; the outbox is purely UI state to
      // render queued bubbles while the first turn is in flight.
      outbox: [], // [{ id, text, status: 'queued'|'streaming'|'sent', ts }]
      busy: false, // true while a turn is streaming tokens
      // Monotonically-increasing id counter for outbox entries. Kept in state so a panel
      // instance that inherits a reducer-only context still produces unique ids across turns
      // (the panel-level _queueSeq is the primary sequence; this is a defensive mirror so
      // a server-side replay that pushes onto outbox cannot collide ids).
      _queueSeq: 0,
      // SESSIONS / HISTORY SIDEBAR (mirror of src/plugin-runtime.ts): the multi-session
      // sidebar in the panel reads its data from this slice. Entries are
      // {id, title, messageCount, createdAt, updatedAt, isActive}. The slice is fully
      // panel/IO-managed — the reducer never writes to it; it stays in lock-step with
      // disk via chatgml.js wiring. `activeSessionId` mirrors the disk-side
      // <projectHash>.active.json pointer (defaults to 'default'); `sessionLoading` is a
      // visual cue flipped true while a session switch is in flight so the panel can dim
      // the sidebar header.
      sessionList: [],
      activeSessionId: 'default',
      sessionLoading: false,
    };
  }

  function reducePluginState(event, state) {
    const next = {
      ready: state.ready,
      phase: state.phase,
      phaseDetail: state.phaseDetail,
      mode: state.mode,
      transcript: state.transcript,
      answer: state.answer,
      sources: state.sources,
      activity: state.activity,
      pendingProposals: state.pendingProposals,
      error: state.error,
      catalog: state.catalog,
      checkpoints: state.checkpoints,
      turns: state.turns,
      turnsEvicted: state.turnsEvicted,
      activityEvicted: state.activityEvicted,
      pendingUserText: state.pendingUserText,
      lastThinking: state.lastThinking,
      outbox: state.outbox,
      busy: state.busy,
      _queueSeq: state._queueSeq,
      // SESSIONS / HISTORY SIDEBAR: panel/IO-managed. The reducer is a no-op for these fields
      // (no case below mutates them); we still carry them forward in the spread so a reducer
      // pass does NOT clobber the panel's in-memory sidebar state with undefined.
      sessionList: state.sessionList,
      activeSessionId: state.activeSessionId,
      sessionLoading: state.sessionLoading,
    };
    switch (event.type) {
      case 'status':
        next.phase = event.phase;
        next.phaseDetail =
          typeof event.detail === 'string' && event.detail.trim() !== '' ? event.detail : null;
        // OUTBOX / busy wiring: `status` carries lifecycle phases from the core. Only the
        // terminal (idle/done/cancelled) and explicit stopped phases mean "not busy"; other
        // phases (thinking/indexing/launching) leave busy alone so a token event arriving
        // on the next tick can flip it true. ready is special: the panel wants Send RE-enabled
        // even if a previous turn ended in a `busy=true` state due to a lost turn_end.
        if (
          event.phase === 'idle' ||
          event.phase === 'stopped' ||
          event.phase === 'cancelled' ||
          event.phase === 'done'
        ) {
          next.busy = false;
        }
        if (event.phase === 'ready') {
          next.ready = true;
          if (event.mode) next.mode = event.mode;
          next.error = null; // clear any stale error on a successful (re)connect
        }
        return next;
      case 'token':
        next.transcript = state.transcript + event.text;
        next.answer = (state.answer || '') + event.text;
        next.busy = true; // transcript is streaming -> the UI is busy until turn_end
        // Promote the head outbox item from 'queued' to 'streaming' (first token after send).
        // Pure: build a fresh array (no in-place mutation of state.outbox) so the reducer
        // stays referentially transparent across reducers.
        if (state.outbox.length > 0 && state.outbox[0].status === 'queued') {
          const promoted = state.outbox.slice();
          promoted[0] = Object.assign({}, promoted[0], { status: 'streaming' });
          next.outbox = promoted;
        }
        return next;
      case 'tool_call': {
        const capped = pushCapped(
          state.activity,
          {
            id: event.id,
            kind: 'tool',
            name: event.name,
            status: 'running',
            content: undefined,
            error: undefined,
          },
          ACTIVITY_CAP,
          state.activityEvicted,
        );
        next.activity = capped[0];
        next.activityEvicted = capped[1];
        return next;
      }
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
      case 'command_request': {
        const capped = pushCapped(
          state.activity,
          {
            id: event.id,
            kind: 'command',
            name: 'execute_command',
            status: 'waiting',
            command: event.command,
            cwd: event.cwd,
            output: '',
          },
          ACTIVITY_CAP,
          state.activityEvicted,
        );
        next.activity = capped[0];
        next.activityEvicted = capped[1];
        return next;
      }
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
      case 'mcp_tool_call': {
        const capped = pushCapped(
          state.activity,
          {
            id: event.id,
            kind: 'mcp',
            name: event.name,
            server: event.server,
            status: 'running',
            content: undefined,
            error: undefined,
          },
          ACTIVITY_CAP,
          state.activityEvicted,
        );
        next.activity = capped[0];
        next.activityEvicted = capped[1];
        return next;
      }
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
      case 'mcp_resource': {
        const capped = pushCapped(
          state.activity,
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
          ACTIVITY_CAP,
          state.activityEvicted,
        );
        next.activity = capped[0];
        next.activityEvicted = capped[1];
        return next;
      }
      case 'turn_end': {
        if (event.userText != null || event.assistantText != null) {
          // Defensive tier normalization: src/protocol.ts already validates the tier name on the
          // wire, but the CJS port is duck-typed (the parity test feeds it untyped objects), so
          // we whitelist the three known values and fall back to null for anything else. Storing
          // a non-TierName value would make the panel badge lookups silently
          // miss-render.
          const tier =
            event.tier === 'planner' || event.tier === 'implementer' || event.tier === 'reviewer'
              ? event.tier
              : null;
          const turn = {
            userText: event.userText || '',
            assistantText: event.assistantText != null ? event.assistantText : state.answer || '',
            tier: tier,
          };
          if (event.context) turn.context = event.context;
          if (event.sources) turn.sources = event.sources;
          if (event.thinking) turn.thinking = event.thinking;
          if (event.usage) turn.usage = event.usage;
          if (event.toolsUsed && event.toolsUsed.length > 0) turn.toolsUsed = event.toolsUsed.slice();
          if (event.toolTimeline && event.toolTimeline.length > 0)
            turn.toolTimeline = event.toolTimeline.slice();
          if (event.contextSummary) turn.contextSummary = event.contextSummary;
          if (event.provider) turn.provider = event.provider;
          if (event.model) turn.model = event.model;
          const capped = pushCapped(
            state.turns || [],
            turn,
            TURN_CAP,
            state.turnsEvicted,
          );
          next.turns = capped[0];
          next.turnsEvicted = capped[1];
        }
        next.answer = null; // the streaming answer is now captured in the turn
        next.pendingUserText = null;
        next.phase = 'idle';
        next.phaseDetail = null;
        // OUTBOX pop: turn_end finalizes the head outbox item. If the head is still 'streaming'
        // (the common case) shift it off; if it's 'queued' (e.g. an immediate switch), shift
        // as well. If 'sent' (a future status), shift. If the outbox is empty we no-op. Always
        // clear busy — the panel must re-enable Send on the next paint.
        if (state.outbox.length > 0) {
          next.outbox = state.outbox.slice(1);
        }
        next.busy = false;
        return next;
      }
      case 'tool_catalog':
        next.catalog = event.tools ? event.tools.slice() : event.tools;
        return next;
      case 'thinking':
        // THINKING PROPAGATION (Cline/Cursor-style model-thinking block). The agent emits a
        // `thinking{final}` event right before `turn_end` for every turn where the model
        // produced reasoning text. The reducer accumulates it into `state.lastThinking` so the
        // plugin can render the collapsible block alongside the corresponding assistant bubble.
        // The string is allowed to be empty (defensive); empty text is treated as no-op.
        next.lastThinking = event.text;
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
        next.phase = 'done';
        next.phaseDetail = null;
        next.busy = false;
        // Clear pending thinking so the next user prompt renders a fresh (empty) block; the
        // thinking block for THIS turn was already emitted by the prior `thinking` event.
        next.lastThinking = null;
        // OUTBOX: `answer` (terminal answer) marks the head item 'streaming'; the actual pop
        // happens on `turn_end` which always follows. We intentionally do NOT shift here so
        // the queued bubbles remain visible until the turn_end event definitively finalizes
        // the turn (matches the panel's expectation — see panel.js handleEvent hook).
        if (state.outbox.length > 0 && state.outbox[0].status === 'queued') {
          const promoted = state.outbox.slice();
          promoted[0] = Object.assign({}, promoted[0], { status: 'streaming' });
          next.outbox = promoted;
        }
        return next;
      case 'error':
        next.error = event.message;
        // Terminal model/core failures can arrive without a follow-up turn_end (for example a
        // dropped streaming response). Treat them as the end of the in-flight UI turn so the
        // panel does not stay stuck in "Stop / phase: streaming".
        next.phase = 'idle';
        next.phaseDetail = null;
        next.answer = null;
        next.pendingUserText = null;
        next.outbox = [];
        next.lastThinking = null;
        next.busy = false;
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
      case 'gmloop':
        return { kind: 'gmloop', value: value || 'status' };
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
      case 'tier':
        // /tier <planner|implementer|reviewer|off> -- override the mode-based dispatch for the
        // next turn. "off" (or any unknown name) means fall back to mode-based auto-dispatch.
        if (value === 'planner' || value === 'implementer' || value === 'reviewer') {
          return { kind: 'tier', arg: value };
        }
        return { kind: 'tier', arg: null };
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
    '  /gmloop [lint|format-check|graph-doctor|parse]  run safe current-file GMLoop checks',
    '  /gmloop lint-project|format-project  run slower project-wide GMLoop checks',
    '  /undo [id]      undo the most recent checkpoint (or the specified checkpoint id)',
    '  /tier planner|implementer|reviewer|off  override the dispatch tier for the next turn',
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
      const a = t.assistantText && String(t.assistantText).trim() !== '' ? t.assistantText : null;
      if (a !== null) out.push({ role: 'assistant', content: a });
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
    pushCapped: pushCapped,
    TURN_CAP: TURN_CAP,
    ACTIVITY_CAP: ACTIVITY_CAP,
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
