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

  const { join } = require('path');
  const fsp = require('fs/promises');
  const fs = require('fs');
  const crypto = require('crypto');

  const MenuItem = Electron_MenuItem;
  const Preferences = $gmedit['ui.Preferences'];
  const ClientApi = globalThis.ChatGmlClient || require('./client.js');
  const PanelApi = globalThis.ChatGmlPanel || require('./panel.js');
  const DiffViewApi = globalThis.ChatGmlDiffView || require('./diff-view.js');
  const ConfigBridgeApi = globalThis.ChatGmlConfigBridge || require('./config-bridge.js');
  const State = globalThis.ChatGmlState || require('./state.js');

  const PLUGIN_NAME = 'chatgml';
  const SESSION_DIR = join(__dirname, 'chatgml-sessions');
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
  const configBridge = new ConfigBridgeApi.ConfigBridge(__dirname);

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
  // -------------------------------------------------------------------------
  function projectHash() {
    return crypto
      .createHash('sha1')
      .update(projectDirectory || 'default')
      .digest('hex')
      .slice(0, 12);
  }

  function sessionFile(taskId) {
    return join(SESSION_DIR, projectHash() + '-' + (taskId || currentTaskId) + '.ndjson');
  }

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

  async function switchTask(taskId) {
    if (!taskId || taskId === currentTaskId) return;
    currentTaskId = taskId;
    if (panel) {
      panel.setTask(currentTaskId);
      panel.clear();
    }
    const turns = await loadSessionTurns();
    if (client) {
      client.sendResume(State.turnEndToMessages(turns), currentTaskId);
    }
    if (panel) panel.flash('switched to task: ' + currentTaskId);
  }

  const TASK_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

  async function createTask(taskId) {
    if (!TASK_ID_RE.test(taskId)) {
      if (panel) panel.flash('invalid task id (alphanumeric/hyphen/underscore, max 64)', true);
      return;
    }
    await switchTask(taskId);
    if (panel) panel.setTasks(listTasks());
  }

  async function deleteTask(taskId) {
    if (taskId === 'default') {
      if (panel) panel.flash('cannot delete the default task', true);
      return;
    }
    if (!window.confirm('Delete task "' + taskId + '"?')) return;
    try {
      await fsp.unlink(sessionFile(taskId));
    } catch (e) {
      if (panel) panel.flash('could not delete task: ' + (e.message || e), true);
      return;
    }
    if (panel) panel.setTasks(listTasks());
    if (taskId === currentTaskId) {
      await switchTask('default');
    }
  }

  async function appendTurn(record) {
    if (!projectDirectory) return;
    record.taskId = currentTaskId;
    try {
      await fsp.mkdir(SESSION_DIR, { recursive: true });
      await fsp.appendFile(sessionFile(), JSON.stringify(record) + '\n', 'utf8');
    } catch (e) {
      console.warn('chatgml: could not append session turn', e);
    }
  }

  async function loadSessionTurns() {
    try {
      const text = await fsp.readFile(sessionFile(), 'utf8');
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      // Cap to the most recent N turns (file is append-only, newest at the bottom).
      return lines
        .slice(-SESSION_MAX_TURNS * 2) // each turn is ~1 line; keep a wide margin
        .map((l) => JSON.parse(l))
        .filter((t) => t && typeof t.userText === 'string' && typeof t.assistantText === 'string');
    } catch (e) {
      return [];
    }
  }

  async function clearSessionFile() {
    try {
      await fsp.writeFile(sessionFile(), '', 'utf8');
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
          acceptBtn.className = 'run-button';
          acceptBtn.textContent = 'Accept';
          acceptBtn.addEventListener('click', function () {
            if (client) client.approve(proposal.id, bi);
          });
          const rejectBtn = document.createElement('button');
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
      case 'undo':
        if (client) client.sendUndo(cmd.checkpointId);
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

  function setConfigAndRestart(field, value) {
    configBridge.setConfigField(field, value, function (err) {
      if (err) {
        if (panel) panel.flash('config set failed: ' + (err.message || err), true);
        return;
      }
      restartCore();
    });
  }

  // -------------------------------------------------------------------------
  // Child process lifecycle (NdjsonClient) <-> ChatPanel wiring.
  // -------------------------------------------------------------------------
  function launch() {
    if (!projectDirectory) {
      console.warn('chatgml: open a project first');
      return;
    }
    if (client) return;
    client = new ClientApi.NdjsonClient({
      projectDir: projectDirectory,
      configuredPath: configBridge.getBinaryPath(),
      scope: configBridge.getScope() || undefined,
      pluginDir: __dirname,
      onEvent: function (event) {
        if (panel) panel.handleEvent(event);
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
        if (panel) {
          panel.setReady();
          if (event && event.mode) panel.setMode(event.mode);
        }
        configBridge.setCoreAvailable(true);
        client.sendApprovalPolicy(configBridge.getApprovalPolicy());
        // Pull the effective config into the quick-config row (display-only; secrets are redacted).
        configBridge.showEffectiveConfig(projectDirectory, function (err, cfg) {
          if (!err && panel && cfg) panel.setConfig(cfg);
        });
        // Resume the last saved session for the current task so multi-turn context survives restarts.
        void (async function () {
          const turns = await loadSessionTurns();
          if (client) client.sendResume(State.turnEndToMessages(turns), currentTaskId);
        })();
      },
      onMalformed: function (line) {
        console.warn('chatgml: malformed protocol line (ignored):', line);
      },
      onStderr: function (text) {
        // stdout is protocol-only; stderr is diagnostics. Route to the console/log, never the panel.
        console.info('chatgml[serve]:', text.trim());
      },
      onError: function (err) {
        console.error('chatgml: failed to launch core —', err.message);
        if (panel) panel.handleEvent({ type: 'error', message: err.message });
        client = null;
        configBridge.setCoreAvailable(false);
        if (panel) panel.setRunning(false, err);
      },
      onExit: function (code) {
        const err =
          code !== 0 && code != null ? new Error('ChatGML core exited with code ' + code) : null;
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
      client = null;
    }
  }

  function stop() {
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

  function hide() {
    if (mainCont && sizer) mainCont.removeChild(sizer);
    if (mainCont && container) mainCont.removeChild(container);
    gmlFile = null;
    forceUpdate();
    setTimeout(function () {
      aceEditor.focus();
    });
  }

  function show() {
    if (gmlFile != null) return;
    if (ready) {
      mainCont.appendChild(sizer);
      mainCont.appendChild(container);
    } else {
      prepare();
    }
    gmlFile = true;
    forceUpdate();
  }

  function prepare() {
    ready = true;

    container = document.createElement('div');
    container.classList.add('ace_container');
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
      getMentions: getMentions,
      onSendWithContext: function (text, context) {
        if (client) client.sendUser(text, Object.assign({}, context, { taskId: currentTaskId }));
      },
      onSend: function (text) {
        if (client) client.sendUser(text);
      },
      getEditorContext: currentEditorContext,
      onSlash: handleSlash,
      onTurnEnd: function (record) {
        if (record && record.userText != null) void appendTurn(record);
      },
      onReindex: function () {
        if (client) client.reindex();
      },
      onLaunch: launch,
      onStop: stop,
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
      onUndo: function () {
        if (client) client.send({ type: 'undo' });
      },
    });

    sizer = document.createElement('div');
    sizer.setAttribute('splitter-element', '#chatgml_editor');
    sizer.setAttribute('splitter-lskey', 'chatgml_aside_width');
    sizer.setAttribute('splitter-default-width', '420');
    sizer.classList.add('splitter-td');

    // Reparent the existing editor children into a flex-row container so the panel sits beside them.
    const nextCont = document.createElement('div');
    nextCont.classList.add('ace_container');
    mainCont = aceEditor.container.parentElement;
    const mainChildren = [];
    for (let i = 0; i < mainCont.children.length; i++) mainChildren.push(mainCont.children[i]);
    for (let i = 0; i < mainChildren.length; i++) {
      const ch = mainChildren[i];
      mainCont.removeChild(ch);
      nextCont.appendChild(ch);
    }
    mainCont.style.setProperty('flex-direction', 'row');
    mainCont.appendChild(nextCont);
    mainCont.appendChild(sizer);
    mainCont.appendChild(container);

    splitter = new GMEdit_Splitter(sizer);
    void splitter;
    void editor;
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
      projectDirectory = e.project.dir; // the on-disk directory (NOT e.project.path / the .yyp)
      console.info('chatgml: project opened', projectDirectory);
      if (panel) {
        panel.setTasks(listTasks());
        panel.setTask(currentTaskId);
      }
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

  GMEdit.register(PLUGIN_NAME, {
    init: init,
    cleanup: function () {
      stop();
      hide();
    },
  });
})();
