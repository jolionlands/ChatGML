// plugin-inline/inline.js — ChatGML inline AI edits in the Ace editor.
//
// Workflow: select code → context-menu "Edit with AI" → type an instruction in an inline input box
// → this plugin spawns `chatgml serve` as a child process, sends a user message primed with the
// selected code + the instruction + editor context, and renders the result:
//
//   - If ChatGML returns a natural-language answer WITHOUT an edit_proposal, show a tooltip with
//     the text (the agent explained rather than edited).
//   - If ChatGML proposes an edit (edit_proposal + approval_request), render an inline diff overlay
//     right below the selection with Accept/Reject buttons. On Accept, the plugin sends `approve`,
//     waits for the tool_result → answer, reloads the Ace session from disk, and jumps to the change.
//     On Reject, it sends `reject` and dismisses the overlay.
//
// All process plumbing lives in the main ChatGML plugin's child-process.js (shared with the
// explain plugin). All protocol/argv/framing logic is shared via state.js. This file is thin DOM
// + per-call state machine glue.
(function () {
  'use strict';

  const path = require('path');
  const fs = require('fs');
  const MenuItem = Electron_MenuItem;

  // Borrow the verified pure logic from the main chatgml plugin (same resolution the GMEdit plugin
  // uses: the plugin dir is symlinked into %APPDATA%/AceGM/GMEdit/plugins/chatgml, and this plugin
  // sits beside it in plugins/chatgml-inline, so ../chatgml/{state,child-process}.js resolves).
  let State, ChildProcess;
  try {
    State = require('../chatgml/state.js');
    ChildProcess = require('../chatgml/child-process.js');
  } catch (e) {
    console.warn(
      'chatgml-inline: could not load chatgml plugin modules — is the chatgml plugin installed?',
      e,
    );
    return;
  }

  const PLUGIN_NAME = 'chatgml-inline';
  let projectDirectory = null;
  // Tracks the active session so GMEdit's cleanup callback can kill it on unload (the previous
  // empty-cleanup orphan left child processes running after GMEdit exit).
  let activeSession = null;

  // -------------------------------------------------------------------------
  // Editor context (open file + cursor line) — selection is passed explicitly.
  // -------------------------------------------------------------------------
  function relativePath(absPath) {
    if (!absPath || !projectDirectory) return undefined;
    const a = String(absPath).replace(/\\/g, '/');
    const root = String(projectDirectory).replace(/\\/g, '/');
    if (a.indexOf(root + '/') === 0) return a.slice(root.length + 1);
    return a.replace(/^\.\//, '');
  }

  function activeFilePath() {
    try {
      const sess = aceEditor.session;
      const f = sess && sess.gmlFile;
      if (f) {
        const raw = f.path || f.filePath || (f.codeEditor && f.codeEditor.path) || undefined;
        return raw ? relativePath(raw) : undefined;
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

  // -------------------------------------------------------------------------
  // Inline overlay: a small DOM panel positioned below the selection, showing
  // the proposed diff + Accept/Reject + a status line. Removed on resolve.
  // Accept/Reject handlers are wired SYNCHRONOUSLY here so we never depend on
  // a setTimeout race to attach the click handlers (the old version's bug).
  // -------------------------------------------------------------------------
  function diffLineClass(line) {
    if (line.startsWith('+++') || line.startsWith('---')) return 'chatgml-inline-diff-ctx';
    if (line.startsWith('+')) return 'chatgml-inline-diff-add';
    if (line.startsWith('-')) return 'chatgml-inline-diff-del';
    if (line.startsWith('@@')) return 'chatgml-inline-diff-hunk';
    return 'chatgml-inline-diff-ctx';
  }

  function showOverlay(proposal, opts) {
    const editorEl = aceEditor.container;
    const overlay = document.createElement('div');
    overlay.className = 'chatgml-inline-overlay';

    const header = document.createElement('div');
    header.className = 'chatgml-inline-header';
    header.textContent = 'ChatGML · proposed edit to ' + (proposal ? proposal.path : '?');
    overlay.appendChild(header);

    if (proposal && proposal.diff) {
      const pre = document.createElement('pre');
      pre.className = 'chatgml-inline-diff';
      const lines = String(proposal.diff).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const span = document.createElement('span');
        span.className = diffLineClass(lines[i]);
        span.textContent = lines[i] + '\n';
        pre.appendChild(span);
      }
      overlay.appendChild(pre);
    }

    if (opts && opts.statusText) {
      const status = document.createElement('div');
      status.className = 'chatgml-inline-status';
      status.textContent = opts.statusText;
      overlay.appendChild(status);
    }

    const actions = document.createElement('div');
    actions.className = 'chatgml-inline-actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'run-button';
    acceptBtn.textContent = 'Accept';
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'run-button chatgml-reject';
    rejectBtn.textContent = 'Reject';
    actions.appendChild(acceptBtn);
    actions.appendChild(rejectBtn);
    overlay.appendChild(actions);

    // Wire handlers synchronously so there's no race against later events.
    if (opts && opts.onAccept) {
      acceptBtn.addEventListener('click', function () {
        acceptBtn.setAttribute('disabled', 'disabled');
        rejectBtn.setAttribute('disabled', 'disabled');
        opts.onAccept();
      });
    } else {
      acceptBtn.setAttribute('disabled', 'disabled');
    }
    if (opts && opts.onReject) {
      rejectBtn.addEventListener('click', function () {
        acceptBtn.setAttribute('disabled', 'disabled');
        rejectBtn.setAttribute('disabled', 'disabled');
        opts.onReject();
        if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
      });
    } else {
      rejectBtn.setAttribute('disabled', 'disabled');
    }

    editorEl.appendChild(overlay);
    return overlay;
  }

  // -------------------------------------------------------------------------
  // The interactive action: prompt for an instruction, run the core, render
  // the proposed diff + Accept/Reject overlay, and reload on approval.
  // -------------------------------------------------------------------------
  function editWithAIInteractive() {
    if (!projectDirectory) {
      console.warn('chatgml-inline: open a project first');
      return;
    }
    const selection = (aceEditor && aceEditor.getSelectedText()) || '';
    if (selection.trim() === '') return;

    const instruction = prompt('ChatGML: What should this code do?', '');
    if (!instruction || instruction.trim() === '') return;

    const context = buildContext(selection);
    const promptText =
      'Edit the following code so that: ' +
      instruction.trim() +
      '\n\nReturn ONLY a unified diff (apply_patch) for the file ' +
      (context.openFile || 'the current file') +
      '. Do not add explanation text — just propose the edit.';

    const overlay = showOverlay(null, { statusText: 'thinking…' });

    const ownDistFallback = path.join(__dirname, '..', 'dist', 'cli.js');
    const session = ChildProcess.startCore({
      projectDir: projectDirectory,
      pluginDir: path.join(__dirname, '..', 'chatgml'),
      ownDistFallback: ownDistFallback,
      heartbeatMs: 0, // one-shot — no watchdog
      onStderr: (text) => console.info('chatgml-inline[serve]:', text.trim()),
      onReady: () => {
        session.sendJson({ type: 'user', text: promptText, context: context });
      },
      onEvent: (ev) => {
        if (ev.type === 'edit_proposal' && overlay.parentElement) {
          // Replace the "thinking…" overlay with the diff + Accept/Reject.
          overlay.parentElement.removeChild(overlay);
          const proposalOverlay = showOverlay(ev, {
            onAccept: () => {
              session.sendJson({ type: 'approve', id: ev.id });
              const note = document.createElement('div');
              note.className = 'chatgml-inline-applied';
              note.textContent = 'applying…';
              proposalOverlay.appendChild(note);
            },
            onReject: () => {
              session.sendJson({ type: 'reject', id: ev.id });
            },
          });
        }
        if (ev.type === 'answer') {
          if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
          if (context.openFile) reloadFile(context.openFile);
          session.stop();
          if (activeSession === session) activeSession = null;
        }
        if (ev.type === 'error') {
          if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
          showToast('ChatGML: ' + ev.message);
          session.stop();
          if (activeSession === session) activeSession = null;
        }
      },
      onError: (err) => {
        if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
        showToast('ChatGML: ' + err.message);
        if (activeSession === session) activeSession = null;
      },
      onExit: () => {
        if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
        if (activeSession === session) activeSession = null;
      },
    });
    if (session) activeSession = session;
  }

  // -------------------------------------------------------------------------
  // Reload the open Ace session from disk (after an approved edit was written).
  // -------------------------------------------------------------------------
  function reloadFile(relPath) {
    try {
      const f = aceEditor.session && aceEditor.session.gmlFile;
      const abs = f && (f.path || f.filePath || (f.codeEditor && f.codeEditor.path));
      if (!abs || !fs.existsSync(abs)) return;
      const updated = fs.readFileSync(abs, 'utf8');
      if (aceEditor.session.getValue() !== updated) aceEditor.session.setValue(updated);
      aceEditor.focus();
    } catch (e) {
      console.info('chatgml-inline: reload skipped', e);
    }
  }

  // -------------------------------------------------------------------------
  // Transient toast (non-blocking; auto-dismisses).
  // -------------------------------------------------------------------------
  function showToast(text) {
    const editorEl = aceEditor.container;
    const toast = document.createElement('div');
    toast.className = 'chatgml-inline-toast';
    toast.textContent = text;
    editorEl.appendChild(toast);
    setTimeout(function () {
      if (toast.parentElement) toast.parentElement.removeChild(toast);
    }, 4000);
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
    mainMenu.insert(
      Math.min(insertAt + 1, mainMenu.items.length),
      new MenuItem({
        label: 'Edit with AI',
        id: 'chatgml-inline-edit',
        click: editWithAIInteractive,
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
