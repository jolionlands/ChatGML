// plugin-explain/explain.js — ChatGML "Explain this" context menu.
//
// Right-click → "Explain this" → spawns `chatgml serve` as a one-shot child process, sends a user
// message asking for an explanation of the current selection (or the whole file if nothing is
// selected), with editor context (open file, cursor line, selection), and renders the answer in an
// inline overlay. Pure glue — process plumbing is shared from the main chatgml plugin's
// child-process.js, and protocol/argv/framing from state.js.
(function () {
  'use strict';

  const path = require('path');
  const MenuItem = Electron_MenuItem;

  let State, ChildProcess;
  try {
    State = require('../chatgml/state.js');
    ChildProcess = require('../chatgml/child-process.js');
  } catch (e) {
    console.warn(
      'chatgml-explain: could not load chatgml plugin modules — is the chatgml plugin installed?',
      e,
    );
    return;
  }

  const PLUGIN_NAME = 'chatgml-explain';
  let projectDirectory = null;
  let activeSession = null;

  function activeFilePath() {
    try {
      const sess = aceEditor.session;
      const f = sess && sess.gmlFile;
      if (f) {
        const raw = f.path || f.filePath || (f.codeEditor && f.codeEditor.path) || undefined;
        if (raw && projectDirectory) {
          const a = String(raw).replace(/\\/g, '/');
          const root = String(projectDirectory).replace(/\\/g, '/');
          if (a.indexOf(root + '/') === 0) return a.slice(root.length + 1);
        }
        return raw;
      }
    } catch (e) {
      /* ignore */
    }
    return undefined;
  }

  function buildContext(selection) {
    let cursor = 1;
    try {
      cursor = aceEditor.getCursorPosition().row + 1;
    } catch (e) {
      /* ignore */
    }
    return State.buildEditorContext({
      openFile: activeFilePath(),
      selection: selection,
      cursorLine: cursor,
    });
  }

  function showOverlay(statusText) {
    const editorEl = aceEditor.container;
    const overlay = document.createElement('div');
    overlay.className = 'chatgml-explain-overlay';
    const header = document.createElement('div');
    header.className = 'chatgml-explain-header';
    header.textContent = 'ChatGML · explain';
    overlay.appendChild(header);
    const body = document.createElement('div');
    body.className = 'chatgml-explain-body';
    body.textContent = statusText || 'thinking…';
    overlay.appendChild(body);
    const close = document.createElement('button');
    close.className = 'chatgml-explain-close';
    close.textContent = 'Close';
    close.addEventListener('click', function () {
      if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
    });
    overlay.appendChild(close);
    editorEl.appendChild(overlay);
    return { overlay: overlay, body: body };
  }

  function explainThis() {
    if (!projectDirectory) {
      console.warn('chatgml-explain: open a project first');
      return;
    }
    const selection = (aceEditor && aceEditor.getSelectedText()) || '';
    const wholeFile = selection.trim() === '';
    const context = buildContext(wholeFile ? undefined : selection);
    const promptText = wholeFile
      ? 'Explain what this file does, its main functions, and any GameMaker-specific concepts it uses.'
      : 'Explain what this selected code does, step by step, and note any GameMaker-specific concepts.';

    const ui = showOverlay('thinking…');

    const ownDistFallback = path.join(__dirname, '..', 'dist', 'cli.js');
    const session = ChildProcess.startCore({
      projectDir: projectDirectory,
      pluginDir: path.join(__dirname, '..', 'chatgml'),
      ownDistFallback: ownDistFallback,
      heartbeatMs: 0, // one-shot — no watchdog
      onStderr: (text) => console.info('chatgml-explain[serve]:', text.trim()),
      onReady: () => {
        const cmd = { type: 'user', text: promptText };
        if (context) cmd.context = context;
        session.sendJson(cmd);
      },
      onEvent: (ev) => {
        if (ev.type === 'status' && ev.phase) {
          ui.body.textContent = 'phase: ' + ev.phase;
          return;
        }
        if (ev.type === 'answer') {
          ui.body.textContent = ev.text || '(no explanation returned)';
          return;
        }
        if (ev.type === 'error') {
          ui.body.textContent = 'error: ' + ev.message;
        }
      },
      onError: (err) => {
        ui.body.textContent = 'failed: ' + err.message;
      },
      onExit: () => {
        if (activeSession === session) activeSession = null;
      },
    });
    if (session) activeSession = session;
  }

  function init() {
    const mainMenu = aceEditor.contextMenu.menu;
    let insertAt = 0;
    while (insertAt < mainMenu.items.length) {
      if (mainMenu.items[insertAt++].aceCommand === 'selectall') break;
    }
    mainMenu.insert(
      Math.min(insertAt, mainMenu.items.length),
      new MenuItem({
        label: 'Explain this',
        id: 'chatgml-explain',
        click: explainThis,
      }),
    );

    GMEdit.on('projectOpen', function (e) {
      projectDirectory = e.project.dir;
    });
  }

  GMEdit.register(PLUGIN_NAME, {
    init: init,
    cleanup: function () {
      // Kill any in-flight session so GMEdit shutdown doesn't orphan a child.
      if (activeSession) {
        activeSession.stop();
        activeSession = null;
      }
    },
  });
})();
