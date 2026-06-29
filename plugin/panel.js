// plugin/panel.js — ChatPanel: the side-panel DOM. Renders transcript / activity / status / answer
// from the reducePluginState projection (plugin/state.js) and surfaces Launch/Stop, Send, Reindex
// controls + the EditProposalView. Pure DOM glue (visual layout manual-only); ALL protocol/state
// logic lives in plugin/state.js and is unit-tested headless.
(function (root) {
  'use strict';

  const State = root.ChatGmlState || require('./state.js');
  const SettingsTasks = root.ChatGmlSettingsTasks || require('./settings-tasks.js');
  const DiffView = root.ChatGmlDiffView || require('./diff-view.js');

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container
   * @param {(text:string)=>void} opts.onSend                     - a NON-slash user message
   * @param {(text:string,context?:object)=>void} opts.onSendWithContext - user msg w/ editor context
   * @param {(text:string)=>Promise<{mentions:object[],cleanText:string}>} opts.getMentions - parse + resolve @mentions
   * @param {()=>void} opts.onReindex
   * @param {()=>void} opts.onLaunch
   * @param {()=>void} opts.onStop
   * @param {(mode:string)=>void=} opts.onModeChange
   * @param {(id:string, blockIndex?:number)=>void} opts.onApprove
   * @param {(id:string, blockIndex?:number)=>void} opts.onReject
   * @param {(id:string)=>void} opts.onApproveCommand
   * @param {(id:string)=>void} opts.onRejectCommand
   * @param {(id:string)=>void} opts.onRunOnce
   * @param {(cmd:object)=>void=} opts.onSlash        - a parsed slash command (default: handled here)
   * @param {(record:object)=>void=} opts.onTurnEnd    - one record per turn_end (for session save)
   * @param {(record:object)=>void=} opts.onAppliedEdit - after an edit is approved&written (inline diff)
   * @param {(ev:PopStateEvent|Event)=>void=} opts.onEditorContext - supply openFile/selection/cursor
   * @param {()=>void=} opts.onUndo                    - undo the most recent checkpoint
   * @param {(name:('planner'|'implementer'|'reviewer'|null))=>void=} opts.onTierOverride - set/clear the per-turn tier override (Cline-style Plan/Act)
   */
  function ChatPanel(opts) {
    this.opts = opts;
    this.state = State.initialPluginState();
    this.running = false;
    this.catalogOpen = false;
    this.selectedCheckpointId = null;
    // The last turn_end record for the in-flight turn (so onAppliedEdit and the inline-diff jump can
    // map a proposal id back to the path that was actually written). Keyed by proposal id -> path.
    this.lastWrittenPaths = new Map();
    // Active per-turn tier override ('planner' | 'implementer' | 'reviewer' | null). When set,
    // the next user message is sent with UserCommand.tier=<name> so the core dispatches to the
    // configured tier lane (Cline-style Plan/Act). null means mode-based auto-dispatch.
    this.tierOverride = null;
    // OUTBOX / busy mirror (see plugin/state.js for the SSOT): the panel owns the primary
    // sequence counter and the "is a turn in flight?" flag. state.outbox is the canonical
    // source of truth pushed by the reducer; this._busy is the panel-local cache that
    // _setBusy reads/writes so the send button / input read-only state stays in lock-step
    // with the reducer on every render (avoiding a stale enabled Send during a streaming
    // turn). _queueSeq keeps id collisions impossible across the lifetime of the panel.
    this._busy = false;
    this._queueSeq = 0;
    // _outboxBubbleEl / _outboxRenderedIds are the panel's lazy-init DOM cache for the
    // outbox wrapper. They are created on first render that actually has outbox entries and
    // torn down on `/clear`; we initialize to null/[] here so the lazy-init branch in
    // render() doesn't have to special-case undefined.
    this._outboxBubbleEl = null;
    this._outboxRenderedIds = [];
    // OUTBOX cap: defensive bound on a runaway key-repeat or pathological sync test. The
    // panel drops the OLDEST entries past this cap; the server in src/serve.ts serializes
    // runs so dropping is purely cosmetic at this cap (the dropped messages would otherwise
    // hang around as queued bubbles that the user has no way to clear). Matches the spirit
    // of the existing TURN_CAP / ACTIVITY_CAP in state.js.
    this._outboxCap = 20;
    this._build();
    this._detectTheme();
    this.setTask('default');
    // Initialize the sessions sidebar to its empty state so the "No sessions yet"
    // placeholder is visible until the first project-open event fires `setSessions(...)`
    // with a real list. Without this, a fresh GMEdit launch shows a permanently-empty
    // sidebar with no affordance for the user.
    this.setSessions([]);
  }

  ChatPanel.prototype._build = function () {
    const self = this;
    const c = this.opts.container;
    c.classList.add('chatgml-panel');

    // SESSIONS SIDEBAR: built FIRST so it sits at the very top of the panel container (above the
    // controls row), per spec — the sidebar must be visible at all times while the user is
    // reviewing the chat transcript below it. Collapsible via the header toggle. See
    // `_buildSessionsSidebar` for the DOM structure and `setSessions` for the data path.
    this._buildSessionsSidebar();
    c.appendChild(this.sessionsEl);

    // Controls row.
    const controls = document.createElement('div');
    controls.className = 'chatgml-controls';

    this.launchBtn = document.createElement('button');
    this.launchBtn.className = 'run-button';
    this.launchBtn.textContent = 'Launch';
    this.launchBtn.addEventListener('click', function () {
      if (self.running) self.opts.onStop();
      else self.opts.onLaunch();
    });

    this.reindexBtn = document.createElement('button');
    this.reindexBtn.className = 'run-button';
    this.reindexBtn.textContent = 'Reindex';
    this.reindexBtn.addEventListener('click', function () {
      self.opts.onReindex();
    });
    this.reindexBtn.setAttribute('disabled', 'disabled');

    this.restartBtn = document.createElement('button');
    this.restartBtn.className = 'run-button';
    this.restartBtn.textContent = 'Restart';
    this.restartBtn.addEventListener('click', function () {
      if (typeof self.opts.onRestart === 'function') self.opts.onRestart();
    });
    this.restartBtn.style.display = 'none';

    controls.appendChild(this.launchBtn);
    controls.appendChild(this.reindexBtn);
    controls.appendChild(this.restartBtn);

    // Mode segmented control.
    this.modeSegEl = document.createElement('div');
    this.modeSegEl.className = 'chatgml-mode-segmented';
    this.modeBtns = {};
    const modes = ['code', 'ask', 'debug', 'architect'];
    for (let i = 0; i < modes.length; i++) {
      const m = modes[i];
      const btn = document.createElement('button');
      btn.className = 'chatgml-mode-btn';
      btn.textContent = m[0].toUpperCase() + m.slice(1);
      btn.addEventListener(
        'click',
        (function (mode) {
          return function () {
            if (typeof self.opts.onModeChange === 'function') self.opts.onModeChange(mode);
            self.setMode(mode);
            self.flash('switching to ' + mode + ' mode…');
          };
        })(m),
      );
      this.modeSegEl.appendChild(btn);
      this.modeBtns[m] = btn;
    }
    controls.appendChild(this.modeSegEl);

    // Task workspace picker.
    this.taskWrapEl = document.createElement('div');
    this.taskWrapEl.className = 'chatgml-task-wrap';
    this.taskSelectEl = document.createElement('select');
    this.taskSelectEl.className = 'chatgml-task-select';
    this.taskSelectEl.addEventListener('change', function () {
      const value = self.taskSelectEl.value;
      if (value === '') {
        const name = window.prompt('New task name:');
        if (name && typeof self.opts.onNewTask === 'function') {
          self.opts.onNewTask(name.trim());
        } else {
          self.taskSelectEl.value = self.taskId || 'default';
        }
      } else if (typeof self.opts.onSwitchTask === 'function') {
        self.opts.onSwitchTask(value);
      }
    });
    this.taskDeleteBtn = document.createElement('button');
    this.taskDeleteBtn.className = 'chatgml-task-delete';
    this.taskDeleteBtn.textContent = '×';
    this.taskDeleteBtn.title = 'Delete the selected task';
    this.taskDeleteBtn.addEventListener('click', function () {
      if (
        self.taskId &&
        self.taskId !== 'default' &&
        typeof self.opts.onDeleteTask === 'function'
      ) {
        self.opts.onDeleteTask(self.taskId);
      }
    });
    this.taskWrapEl.appendChild(this.taskSelectEl);
    this.taskWrapEl.appendChild(this.taskDeleteBtn);
    controls.appendChild(this.taskWrapEl);

    // Clear conversation button (mirrors the /clear slash command).
    this.clearBtn = document.createElement('button');
    this.clearBtn.className = 'run-button chatgml-clear-btn';
    this.clearBtn.textContent = 'Clear';
    this.clearBtn.title = 'Clear conversation';
    this.clearBtn.addEventListener('click', function () {
      if (typeof self.opts.onClear === 'function') self.opts.onClear();
      self.clear();
    });
    this.clearBtn.style.fontSize = '11px';
    this.clearBtn.style.padding = '4px 10px';
    controls.appendChild(this.clearBtn);

    c.appendChild(controls);

    // Status line.
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'chatgml-status';
    this.statusEl.textContent = 'stopped';

    // Quick-config row (scope/model/approval snapshot from the core's effective config). Populated
    // by setConfig(); empty until then so the panel never lies about config it has not read.
    this.configRowEl = document.createElement('div');
    this.configRowEl.className = 'chatgml-config-row';
    c.appendChild(this.configRowEl);

    // Checkpoint chips row (after config chips).
    this.checkpointRowEl = document.createElement('div');
    this.checkpointRowEl.className = 'chatgml-checkpoint-row';
    this.undoBtn = document.createElement('button');
    this.undoBtn.className = 'chatgml-undo-btn';
    this.undoBtn.textContent = 'Undo last';
    this.undoBtn.title = 'Undo the most recent checkpoint';
    this.undoBtn.addEventListener('click', function () {
      if (typeof self.opts.onUndo === 'function') self.opts.onUndo();
    });
    this.checkpointRowEl.appendChild(this.undoBtn);
    c.appendChild(this.checkpointRowEl);

    c.appendChild(this.statusEl);

    // Activity (tool calls).
    this.activityEl = document.createElement('div');
    this.activityEl.className = 'chatgml-activity';
    c.appendChild(this.activityEl);

    // Tool catalog (collapsible).
    this.catalogEl = document.createElement('div');
    this.catalogEl.className = 'chatgml-tool-catalog';
    c.appendChild(this.catalogEl);

    // Transcript (streamed tokens) + final answer.
    // Trim notice: a small dim line shown ABOVE the transcript whenever the reducer had to evict
    // turns or activity rows because they exceeded their cap. Hidden by default; the renderer
    // toggles its display + text from `s.turnsEvicted` / `s.activityEvicted`. The reducer is the
    // single source of truth (the renderer never computes this from array lengths).
    this.trimNoticeEl = document.createElement('div');
    this.trimNoticeEl.className = 'chatgml-trim-notice';
    this.trimNoticeEl.style.display = 'none';
    c.appendChild(this.trimNoticeEl);

    this.transcriptEl = document.createElement('div');
    this.transcriptEl.className = 'chatgml-transcript';
    c.appendChild(this.transcriptEl);

    // Sources list.
    this.sourcesEl = document.createElement('div');
    this.sourcesEl.className = 'chatgml-sources';
    c.appendChild(this.sourcesEl);

    // Edit proposals.
    const proposalsContainer = document.createElement('div');
    proposalsContainer.className = 'chatgml-proposals';
    c.appendChild(proposalsContainer);
    this.diffView = new DiffView.EditProposalView({
      container: proposalsContainer,
      onApprove: function (id, blockIndex) {
        self.opts.onApprove(id, blockIndex);
      },
      onReject: function (id, blockIndex) {
        self.opts.onReject(id, blockIndex);
      },
    });

    // Mention chips row (above input).
    this.mentionRowEl = document.createElement('div');
    this.mentionRowEl.className = 'chatgml-mention-row';
    this.mentionRowEl.style.display = 'none';
    c.appendChild(this.mentionRowEl);

    // Input row.
    const inputRow = document.createElement('div');
    inputRow.className = 'chatgml-input-row';
    inputRow.style.position = 'relative';
    this.inputEl = document.createElement('textarea');
    this.inputEl.className = 'chatgml-input';
    this.inputEl.setAttribute('placeholder', 'Ask about this project… (type /help for commands)');
    this.sendBtn = document.createElement('button');
    this.sendBtn.className = 'run-button';
    this.sendBtn.textContent = 'Send';
    const submit = function () {
      self._submit();
    };
    this.sendBtn.addEventListener('click', submit);
    // Ctrl/Cmd+Enter (or plain Enter without a shift) submits; Shift+Enter inserts a newline.
    this.inputEl.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.defaultPrevented) {
        ev.preventDefault();
        submit();
        return;
      }
      // Mention autocomplete keyboard navigation
      var dropdownVisible =
        self.mentionDropdownEl && self.mentionDropdownEl.style.display !== 'none';
      if (ev.key === '@') {
        self._mentionTriggerPos = self.inputEl.selectionStart;
        self._showMentionDropdown();
      } else if (ev.key === 'ArrowDown' && dropdownVisible) {
        ev.preventDefault();
        self._moveMentionSelection(1);
      } else if (ev.key === 'ArrowUp' && dropdownVisible) {
        ev.preventDefault();
        self._moveMentionSelection(-1);
      } else if ((ev.key === 'Enter' || ev.key === 'Tab') && dropdownVisible) {
        ev.preventDefault();
        self._selectMentionItem();
      } else if (ev.key === 'Escape' && dropdownVisible) {
        ev.preventDefault();
        self._hideMentionDropdown();
      } else if (ev.key === 'Escape') {
        self._hideMentionDropdown();
      }
    });
    this.inputEl.addEventListener('input', function () {
      self._renderMentionChips();
      // Check if '@' was just typed or pasted (triggers on paste, not just keydown)
      var val = self.inputEl.value;
      var pos = self.inputEl.selectionStart;
      if (pos > 0 && val.charAt(pos - 1) === '@' && (pos === 1 || /\s/.test(val.charAt(pos - 2)))) {
        self._mentionTriggerPos = pos - 1;
        self._showMentionDropdown();
        return;
      }
      // If we are inside a "@file " mention (typed or pasted), show the file autocomplete.
      var fctx = self._fileMentionContext();
      if (fctx) {
        self._showFileMentionDropdown(fctx.query);
      } else {
        self._hideFileMentionDropdown();
      }
    });
    this.mentionDropdownEl = document.createElement('div');
    this.mentionDropdownEl.className = 'chatgml-mention-autocomplete';
    this.mentionDropdownEl.style.display = 'none';
    inputRow.appendChild(this.mentionDropdownEl);
    // Settings gear button (right-aligned in controls row).
    this.settingsBtn = document.createElement('button');
    this.settingsBtn.className = 'chatgml-settings-btn';
    this.settingsBtn.title = 'Settings';
    this.settingsBtn.innerHTML = '⚙';
    this.settingsBtn.addEventListener('click', function () {
      self._toggleSettings();
    });
    controls.appendChild(this.settingsBtn);

    this.sendBtn.setAttribute('disabled', 'disabled');
    inputRow.appendChild(this.inputEl);
    inputRow.appendChild(this.sendBtn);
    // Stop-generating button: visible only while the agent is streaming or running a tool. Inserted
    // BEFORE the send button so it lands to its left in the input row.
    this.stopGenBtn = document.createElement('button');
    this.stopGenBtn.className = 'run-button chatgml-stop-btn';
    this.stopGenBtn.textContent = '⏹';
    this.stopGenBtn.title = 'Stop generating';
    this.stopGenBtn.style.display = 'none';
    this.stopGenBtn.addEventListener('click', function () {
      if (typeof self.opts.onStopGenerate === 'function') self.opts.onStopGenerate();
    });
    inputRow.insertBefore(this.stopGenBtn, this.sendBtn);
    c.appendChild(inputRow);
  };

  /** Toggle the settings dropdown panel (lazy-builds on first open). Visibility is determined
   * from the COMPUTED display value, not just the inline style: CSS sets the default to
   * `display: none`, so a freshly-built panel has empty inline style but is still visually hidden
   * — checking inline alone would make the toggle wrong on the very first click. */
  ChatPanel.prototype._toggleSettings = function () {
    var wasUnbuilt = !this.settingsPanelEl;
    if (wasUnbuilt) this._buildSettingsPanel();
    var el = this.settingsPanelEl;
    var computed =
      typeof getComputedStyle === 'function' ? getComputedStyle(el).display : el.style.display;
    el.style.display = computed === 'none' ? 'flex' : 'none';
    // First open after the panel was just built: pick up the providers load result that
    // chatgml.js stashed on `this._pendingProvidersLoad` during the bootstrap call. We use the
    // same callbacks the bootstrap uses so Refresh/Add/Export behave identically.
    if (wasUnbuilt && this._pendingProvidersLoad && typeof this.populateProviders === 'function') {
      var pending = this._pendingProvidersLoad;
      this._pendingProvidersLoad = null;
      this.populateProviders(pending, {
        onRefresh: this._pendingProvidersCallbacks && this._pendingProvidersCallbacks.onRefresh,
        onAddProvider:
          this._pendingProvidersCallbacks && this._pendingProvidersCallbacks.onAddProvider,
        onExportEnv: this._pendingProvidersCallbacks && this._pendingProvidersCallbacks.onExportEnv,
      });
    }
  };

  // -------------------------------------------------------------------------
  // SESSIONS SIDEBAR (multi-session history). The sidebar lives at the very top of the panel
  // container, above the controls row, so it's visible while the user reviews the chat
  // transcript below. It is collapsible via the header toggle. Each row shows title, message
  // count, last-updated relative time, and a trash icon. Active session is highlighted.
  //
  // The data path is: chatgml.js calls Sessions.list(projectDir), then panel.setSessions(list)
  // and panel.setActiveSession(activeId). This file only renders; it never reads disk.
  // -------------------------------------------------------------------------
  ChatPanel.prototype._buildSessionsSidebar = function () {
    const self = this;
    const root = document.createElement('div');
    root.className = 'chatgml-session-root';

    // Header row (always visible). Holds the toggle chevron + title + count + "+ New session".
    const header = document.createElement('div');
    header.className = 'chatgml-session-header';
    const toggle = document.createElement('button');
    toggle.className = 'chatgml-session-toggle';
    toggle.type = 'button';
    toggle.title = 'Toggle sessions list';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.textContent = '\u25BE'; // ▾ — small downward chevron
    toggle.addEventListener('click', function () {
      self._toggleSessionsSidebar();
    });
    const title = document.createElement('span');
    title.className = 'chatgml-session-header-title';
    title.textContent = 'Sessions';
    const count = document.createElement('span');
    count.className = 'chatgml-session-header-count';
    count.textContent = '0';
    const newBtn = document.createElement('button');
    newBtn.className = 'chatgml-session-new';
    newBtn.type = 'button';
    newBtn.textContent = '+';
    newBtn.title = 'New session';
    newBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (typeof self.opts.onNewSession === 'function') {
        void self.opts.onNewSession();
      }
    });
    header.appendChild(toggle);
    header.appendChild(title);
    header.appendChild(count);
    header.appendChild(newBtn);
    // Click anywhere on the header (except the new-button) toggles the sidebar so the user can
    // collapse without hunting for the chevron.
    header.addEventListener('click', function (ev) {
      if (ev.target === newBtn) return;
      self._toggleSessionsSidebar();
    });
    root.appendChild(header);

    // Collapsible body (the actual list). start collapsed = false; expanded by default so a fresh
    // panel shows the sidebar immediately.
    const body = document.createElement('div');
    body.className = 'chatgml-session-body';
    const list = document.createElement('div');
    list.className = 'chatgml-session-list';
    body.appendChild(list);
    root.appendChild(body);

    // Empty-state placeholder so an unconfigured sidebar doesn't look broken.
    const empty = document.createElement('div');
    empty.className = 'chatgml-session-empty';
    empty.textContent = 'No sessions yet';
    empty.style.display = 'none';
    body.appendChild(empty);

    // Persist on the panel for setSessions/setActiveSession. The full state lives here; chatgml.js
    // is the source of truth for the data, this file is the renderer.
    this.sessionsEl = root;
    this.sessionsHeaderEl = header;
    this.sessionsToggleEl = toggle;
    this.sessionsCountEl = count;
    this.sessionsBodyEl = body;
    this.sessionsListEl = list;
    this.sessionsEmptyEl = empty;
    this.sessionsCollapsed = false;
    this._sessionsData = [];
    this._sessionsActiveId = 'default';
  };

  ChatPanel.prototype._toggleSessionsSidebar = function () {
    const self = this;
    if (!this.sessionsEl) return;
    this.sessionsCollapsed = !this.sessionsCollapsed;
    if (this.sessionsCollapsed) {
      this.sessionsEl.classList.add('chatgml-session-root--collapsed');
      if (this.sessionsToggleEl) {
        this.sessionsToggleEl.textContent = '\u25B8'; // ▸
        this.sessionsToggleEl.setAttribute('aria-expanded', 'false');
      }
    } else {
      this.sessionsEl.classList.remove('chatgml-session-root--collapsed');
      if (this.sessionsToggleEl) {
        this.sessionsToggleEl.textContent = '\u25BE'; // ▾
        this.sessionsToggleEl.setAttribute('aria-expanded', 'true');
      }
    }
    void self;
  };

  /** Replace the sessions list with a fresh snapshot from disk. Pure renderer — does not
   * mutate state. The data shape mirrors `Sessions.list(projectDir)` output:
   *   [{id, title, messageCount, createdAt, updatedAt, isActive}] */
  ChatPanel.prototype.setSessions = function (list) {
    const self = this;
    this._sessionsData = Array.isArray(list) ? list.slice() : [];
    if (!this.sessionsListEl) return;
    // Drop all existing rows.
    while (this.sessionsListEl.firstChild) {
      this.sessionsListEl.removeChild(this.sessionsListEl.firstChild);
    }
    const total = this._sessionsData.length;
    if (this.sessionsCountEl) this.sessionsCountEl.textContent = String(total);
    if (this.sessionsEmptyEl) {
      this.sessionsEmptyEl.style.display = total === 0 ? '' : 'none';
    }
    for (let i = 0; i < this._sessionsData.length; i++) {
      const entry = this._sessionsData[i];
      const row = this._buildSessionRow(entry);
      this.sessionsListEl.appendChild(row);
    }
    void self;
  };

  /** Build one row in the sessions list. Pure DOM construction; click handlers call back into
   * the panel opts (`onSwitchSession` / `onDeleteSession`) so chatgml.js stays the source of
   * truth for what happens when the user picks a session. */
  ChatPanel.prototype._buildSessionRow = function (entry) {
    const self = this;
    const row = document.createElement('div');
    row.className = 'chatgml-session-list-item';
    if (entry.isActive) row.classList.add('chatgml-session-list-item--active');
    row.dataset.sessionId = entry.id;

    // Indicator dot (filled for active, outline otherwise).
    const dot = document.createElement('span');
    dot.className = entry.isActive
      ? 'chatgml-session-dot chatgml-session-dot--active'
      : 'chatgml-session-dot';
    row.appendChild(dot);

    // Body wrapper for title + meta line.
    const body = document.createElement('div');
    body.className = 'chatgml-session-row-body';

    const titleEl = document.createElement('div');
    titleEl.className = 'chatgml-session-title';
    const rawTitle = entry.title || 'untitled';
    titleEl.textContent = rawTitle.length > 32 ? rawTitle.slice(0, 31).trimEnd() + '…' : rawTitle;
    titleEl.title = rawTitle; // tooltip shows full title
    body.appendChild(titleEl);

    const meta = document.createElement('div');
    meta.className = 'chatgml-session-meta';
    const msgs = entry.messageCount || 0;
    const msgsSpan = document.createElement('span');
    msgsSpan.className = 'chatgml-session-msgs';
    msgsSpan.textContent = msgs + (msgs === 1 ? ' msg' : ' msgs');
    meta.appendChild(msgsSpan);
    const sep = document.createElement('span');
    sep.className = 'chatgml-session-sep';
    sep.textContent = ' · ';
    meta.appendChild(sep);
    const time = document.createElement('span');
    time.className = 'chatgml-session-time';
    time.textContent = formatRelativeTime(entry.updatedAt);
    if (entry.updatedAt) time.title = new Date(entry.updatedAt).toLocaleString();
    meta.appendChild(time);
    body.appendChild(meta);

    row.appendChild(body);

    // Trash button — separate from the row click so clicking it doesn't also switch.
    const trash = document.createElement('button');
    trash.className = 'chatgml-session-trash';
    trash.type = 'button';
    trash.textContent = '\u2715'; // ✕
    trash.title = 'Delete this session';
    trash.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (typeof self.opts.onDeleteSession === 'function') {
        void self.opts.onDeleteSession(entry.id);
      }
    });
    row.appendChild(trash);

    // Whole-row click switches session (except on the trash button, which stops propagation).
    row.addEventListener('click', function () {
      if (typeof self.opts.onSwitchSession === 'function') {
        self.opts.onSwitchSession(entry.id);
      }
    });

    return row;
  };

  /** Update the active-session highlight. Called by chatgml.js after a switch/create so the
   * sidebar reflects the new active id without re-pulling the entire list from disk. */
  ChatPanel.prototype.setActiveSession = function (id) {
    this._sessionsActiveId = id || 'default';
    if (!this.sessionsListEl) return;
    const rows = this.sessionsListEl.querySelectorAll('.chatgml-session-list-item');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const sid = r.dataset.sessionId;
      const isActive = sid === this._sessionsActiveId;
      r.classList.toggle('chatgml-session-list-item--active', isActive);
      const dot = r.querySelector('.chatgml-session-dot');
      if (dot) {
        dot.className = isActive
          ? 'chatgml-session-dot chatgml-session-dot--active'
          : 'chatgml-session-dot';
      }
    }
  };

  /** Set the "switch in progress" visual cue. Used by chatgml.js to dim the sidebar header
   * during a session switch so the user sees feedback. */
  ChatPanel.prototype.setSessionsLoading = function (loading) {
    if (!this.sessionsHeaderEl) return;
    this.sessionsHeaderEl.classList.toggle('chatgml-session-header--loading', !!loading);
  };

  /** Format a millisecond timestamp as a compact relative-time string ("just now", "5m ago",
   * "2h ago", "yesterday", "Mar 12"). Pure — no DOM, safe to call on every render. */
  function formatRelativeTime(ts) {
    if (!ts || typeof ts !== 'number') return '—';
    const diff = Date.now() - ts;
    if (diff < 0) return 'just now';
    if (diff < 30 * 1000) return 'just now';
    if (diff < 60 * 1000) return Math.floor(diff / 1000) + 's ago';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / (60 * 1000)) + 'm ago';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / (60 * 60 * 1000)) + 'h ago';
    // "yesterday" iff the timestamp falls on the previous calendar day.
    const now = new Date();
    const then = new Date(ts);
    const dayDiff = Math.floor(
      (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
        Date.UTC(then.getFullYear(), then.getMonth(), then.getDate())) /
        (24 * 60 * 60 * 1000),
    );
    if (dayDiff === 1) return 'yesterday';
    if (dayDiff < 7) return dayDiff + 'd ago';
    // Older: short month + day.
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return months[then.getMonth()] + ' ' + then.getDate();
  }

  /** Build the inline settings dropdown (model, base URL, api key, embed model, embed base URL,
   * mode, approval, scope + Save&Restart). */
  ChatPanel.prototype._buildSettingsPanel = function () {
    var self = this;
    this.settingsPanelEl = document.createElement('div');
    this.settingsPanelEl.className = 'chatgml-settings-panel';
    // Explicitly hidden at build time so the computed-style read in `_toggleSettings` returns
    // 'none' on the first click. (CSS `display: none` alone isn't visible to inline-style checks.)
    this.settingsPanelEl.style.display = 'none';

    // Scroll wrapper — the panel can grow tall (8+ rows + tier groups) so we cap it at ~70vh
    // and let it scroll. The wrapper is the actual scroll container; the panel itself is just a
    // positioning anchor. Sticky header inside the wrapper keeps the title visible while users
    // scroll long provider lists.
    this.settingsScrollEl = document.createElement('div');
    this.settingsScrollEl.className = 'chatgml-settings-scroll';

    // Sticky header — providers count + actions (Refresh, Add Provider, Export .env). Stays at
    // the top of the scroll viewport so users can always see the current registry size.
    this.settingsHeaderEl = document.createElement('div');
    this.settingsHeaderEl.className = 'chatgml-settings-header';
    var headerLeft = document.createElement('div');
    headerLeft.className = 'chatgml-settings-header-left';
    this.settingsHeaderEl.appendChild(headerLeft);
    var headerRight = document.createElement('div');
    headerRight.className = 'chatgml-settings-header-right';
    this.settingsHeaderEl.appendChild(headerRight);
    this.settingsScrollEl.appendChild(this.settingsHeaderEl);

    // Provider registry section — collapsible details panel inside the settings. Lists every
    // provider+model pair from the merged registry, with a click-to-apply handler that fills the
    // Model + Base URL fields and stamps `providerSelected` on the save.
    this.settingsProvidersEl = document.createElement('div');
    this.settingsProvidersEl.className = 'chatgml-settings-providers';

    function makeRow(labelText, el) {
      var row = document.createElement('div');
      row.className = 'chatgml-settings-row';
      var label = document.createElement('label');
      label.textContent = labelText;
      label.className = 'chatgml-settings-label';
      row.appendChild(label);
      row.appendChild(el);
      return row;
    }

    function makeHelpRow(text) {
      var help = document.createElement('div');
      help.className = 'chatgml-settings-help';
      help.textContent = text;
      return help;
    }

    // Model — text input bound to a `<datalist>` populated from the provider registry. Users can
    // still type any value (free text) but pick from the registry as autocomplete. The datalist
    // element is created here and re-populated whenever the providers list refreshes.
    this.settingsModelDatalist = document.createElement('datalist');
    this.settingsModelDatalist.id = 'chatgml-settings-model-list';
    this.settingsModelInput = document.createElement('input');
    this.settingsModelInput.type = 'text';
    this.settingsModelInput.className = 'chatgml-settings-input';
    this.settingsModelInput.placeholder = 'chat model id';
    this.settingsModelInput.setAttribute('list', this.settingsModelDatalist.id);
    this.settingsScrollEl.appendChild(makeRow('Model', this.settingsModelInput));
    this.settingsScrollEl.appendChild(this.settingsModelDatalist);

    // Base URL — same datalist pattern, separate options array.
    this.settingsUrlDatalist = document.createElement('datalist');
    this.settingsUrlDatalist.id = 'chatgml-settings-url-list';
    this.settingsUrlInput = document.createElement('input');
    this.settingsUrlInput.type = 'text';
    this.settingsUrlInput.className = 'chatgml-settings-input';
    this.settingsUrlInput.placeholder = 'chat endpoint URL';
    this.settingsUrlInput.setAttribute('list', this.settingsUrlDatalist.id);
    this.settingsScrollEl.appendChild(makeRow('Base URL', this.settingsUrlInput));
    this.settingsScrollEl.appendChild(this.settingsUrlDatalist);

    // Provider-matched hint shown under the URL row when the typed value matches a registered
    // provider. Lets the user confirm at a glance "yes, this URL is registered as X". Cleared on
    // next edit.
    this.settingsUrlHintEl = document.createElement('div');
    this.settingsUrlHintEl.className = 'chatgml-settings-url-hint';
    this.settingsUrlHintEl.style.display = 'none';
    this.settingsScrollEl.appendChild(this.settingsUrlHintEl);

    // API key — password-type input so the value is never echoed on screen. When a key is already
    // set (the redacted `cfg.chat.apiKey` from `chatgml config show` is truthy), the placeholder
    // shows the redaction glyph; the actual value is NEVER round-tripped into the UI. Empty submit
    // is intentionally a no-op so the user does not accidentally blank their saved key.
    this.settingsApiKeyInput = document.createElement('input');
    this.settingsApiKeyInput.type = 'password';
    this.settingsApiKeyInput.className = 'chatgml-settings-input chatgml-settings-input-secret';
    this.settingsApiKeyInput.placeholder = SettingsTasks.API_KEY_PLACEHOLDER;
    this.settingsApiKeyInput.autocomplete = 'off';
    this.settingsApiKeyInput.spellcheck = false;
    this.settingsScrollEl.appendChild(makeRow('API Key', this.settingsApiKeyInput));
    this.settingsScrollEl.appendChild(
      makeHelpRow(
        'Stored in ~/.config/chatgml/config.json. For production, set CHATGML_CHAT_KEY in your ' +
          'environment and paste  env:CHATGML_CHAT_KEY  here — only env references are persisted.',
      ),
    );

    // Embed Model (separate lane; the chat model does NOT fall back to the embed model). Bound to
    // a datalist populated from the registry when available.
    this.settingsEmbedModelDatalist = document.createElement('datalist');
    this.settingsEmbedModelDatalist.id = 'chatgml-settings-embed-model-list';
    this.settingsEmbedModelInput = document.createElement('input');
    this.settingsEmbedModelInput.type = 'text';
    this.settingsEmbedModelInput.className = 'chatgml-settings-input';
    this.settingsEmbedModelInput.placeholder = 'embed model id';
    this.settingsEmbedModelInput.setAttribute('list', this.settingsEmbedModelDatalist.id);
    this.settingsScrollEl.appendChild(makeRow('Embed Model', this.settingsEmbedModelInput));
    this.settingsScrollEl.appendChild(this.settingsEmbedModelDatalist);

    // Embed Base URL.
    this.settingsEmbedUrlDatalist = document.createElement('datalist');
    this.settingsEmbedUrlDatalist.id = 'chatgml-settings-embed-url-list';
    this.settingsEmbedUrlInput = document.createElement('input');
    this.settingsEmbedUrlInput.type = 'text';
    this.settingsEmbedUrlInput.className = 'chatgml-settings-input';
    this.settingsEmbedUrlInput.placeholder = 'embed endpoint URL';
    this.settingsEmbedUrlInput.setAttribute('list', this.settingsEmbedUrlDatalist.id);
    this.settingsScrollEl.appendChild(makeRow('Embed Base URL', this.settingsEmbedUrlInput));
    this.settingsScrollEl.appendChild(this.settingsEmbedUrlDatalist);

    // Mode select
    this.settingsModeSelect = document.createElement('select');
    this.settingsModeSelect.className = 'chatgml-settings-input';
    var modes = ['code', 'ask', 'debug', 'architect'];
    for (var i = 0; i < modes.length; i++) {
      var opt = document.createElement('option');
      opt.value = modes[i];
      opt.textContent = modes[i][0].toUpperCase() + modes[i].slice(1);
      this.settingsModeSelect.appendChild(opt);
    }
    this.settingsScrollEl.appendChild(makeRow('Mode', this.settingsModeSelect));

    // Approval select
    this.settingsApprovalSelect = document.createElement('select');
    this.settingsApprovalSelect.className = 'chatgml-settings-input';
    var gatedOpt = document.createElement('option');
    gatedOpt.value = 'gated';
    gatedOpt.textContent = 'gated';
    var autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = 'auto';
    this.settingsApprovalSelect.appendChild(gatedOpt);
    this.settingsApprovalSelect.appendChild(autoOpt);
    this.settingsScrollEl.appendChild(makeRow('Approval', this.settingsApprovalSelect));

    // Scope
    this.settingsScopeInput = document.createElement('input');
    this.settingsScopeInput.type = 'text';
    this.settingsScopeInput.className = 'chatgml-settings-input';
    this.settingsScopeInput.placeholder = 'memory scope';
    this.settingsScrollEl.appendChild(makeRow('Scope', this.settingsScopeInput));

    // Tier overrides subsection (Cline-style Plan/Act). Three collapsible groups — one per tier
    // (planner/implementer/reviewer) — each with `Model` + `Base URL` fields. Empty fields are
    // dropped on save (SettingsTasks drops them when building the config commands), so a user can
    // partially populate a tier and only those two leaves are persisted. The model + base URL
    // inputs are bound to datalists so users can pick from the registry just like the global
    // chat lane.
    var tierHeader = document.createElement('div');
    tierHeader.className = 'chatgml-settings-section-header';
    tierHeader.textContent = 'Tiers (per-role lane overrides)';
    this.settingsScrollEl.appendChild(tierHeader);

    this.settingsTierInputs = { planner: {}, implementer: {}, reviewer: {} };
    this.settingsTierDatalists = { planner: {}, implementer: {}, reviewer: {} };
    var tierNames = ['planner', 'implementer', 'reviewer'];
    var tierLabels = {
      planner: '🧠 Planner',
      implementer: '⚙ Implementer',
      reviewer: '🔍 Reviewer',
    };
    for (var tni = 0; tni < tierNames.length; tni++) {
      (function (name) {
        var group = document.createElement('details');
        group.className = 'chatgml-settings-tier-group';
        var sum = document.createElement('summary');
        sum.textContent = tierLabels[name];
        group.appendChild(sum);

        var modelDatalist = document.createElement('datalist');
        modelDatalist.id = 'chatgml-settings-tier-' + name + '-model-list';
        var modelInput = document.createElement('input');
        modelInput.type = 'text';
        modelInput.className = 'chatgml-settings-input';
        modelInput.placeholder = name + ' model id';
        modelInput.setAttribute('list', modelDatalist.id);
        group.appendChild(makeRow('Model', modelInput));
        group.appendChild(modelDatalist);

        var urlDatalist = document.createElement('datalist');
        urlDatalist.id = 'chatgml-settings-tier-' + name + '-url-list';
        var urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.className = 'chatgml-settings-input';
        urlInput.placeholder = name + ' endpoint URL';
        urlInput.setAttribute('list', urlDatalist.id);
        group.appendChild(makeRow('Base URL', urlInput));
        group.appendChild(urlDatalist);

        self.settingsTierInputs[name] = { model: modelInput, baseURL: urlInput };
        self.settingsTierDatalists[name] = { model: modelDatalist, baseURL: urlDatalist };
        self.settingsScrollEl.appendChild(group);
      })(tierNames[tni]);
    }
    this.settingsScrollEl.appendChild(
      makeHelpRow(
        'Empty fields are dropped (existing values are preserved). Each tier is a partial ' +
          'override of the global chat lane; unset leaves fall back to the global model/URL.',
      ),
    );

    // Save & Restart button
    var saveBtn = document.createElement('button');
    saveBtn.className = 'run-button chatgml-settings-save';
    saveBtn.textContent = 'Save & Restart';
    saveBtn.addEventListener('click', function () {
      var settings = {
        model: self.settingsModelInput.value.trim(),
        baseURL: self.settingsUrlInput.value.trim(),
        // Note: we do NOT pre-trim the api key value here; SettingsTasks.buildSettingsCommands will
        // trim it AND treat empty/whitespace as a no-op so an accidental blank submit leaves the
        // saved key intact.
        apiKey: self.settingsApiKeyInput.value,
        embedModel: self.settingsEmbedModelInput.value.trim(),
        embedBaseURL: self.settingsEmbedUrlInput.value.trim(),
        mode: self.settingsModeSelect.value,
        approval: self.settingsApprovalSelect.value,
        scope: self.settingsScopeInput.value.trim(),
        tiers: {
          planner: {
            model: self.settingsTierInputs.planner.model.value.trim(),
            baseURL: self.settingsTierInputs.planner.baseURL.value.trim(),
          },
          implementer: {
            model: self.settingsTierInputs.implementer.model.value.trim(),
            baseURL: self.settingsTierInputs.implementer.baseURL.value.trim(),
          },
          reviewer: {
            model: self.settingsTierInputs.reviewer.model.value.trim(),
            baseURL: self.settingsTierInputs.reviewer.baseURL.value.trim(),
          },
        },
      };
      // Stamp provider-selected metadata so SettingsTasks can choose to emit the registry-derived
      // fields (path, auth) without having to re-resolve the (provider, model) pair itself. The
      // panel set `this._activeProviderEntry` when the user clicked a registry row.
      if (self._activeProviderEntry) {
        settings.providerSelected = true;
        settings.path = self._activeProviderEntry.endpoint || '';
        settings.auth = self._activeProviderEntry.auth || '';
      }
      if (typeof self.opts.onSaveSettings === 'function') {
        self.opts.onSaveSettings(settings);
      }
      // Reset the password field after save so the raw value doesn't linger in the DOM. Empty
      // submit is already a no-op on the wire (see SettingsTasks.buildSettingsCommands).
      self.settingsApiKeyInput.value = '';
      // Clear the active-provider marker so the next open of the panel starts fresh — the user
      // may pick a different entry next time.
      self._activeProviderEntry = null;
      self.settingsPanelEl.style.display = 'none';
    });
    this.settingsScrollEl.appendChild(saveBtn);

    // Mount the scroll wrapper inside the panel, then the panel inside the container.
    this.settingsPanelEl.appendChild(this.settingsScrollEl);

    // Insert after controls, before status line.
    this.opts.container.insertBefore(this.settingsPanelEl, this.statusEl);
  };

  /** Populate settings inputs from a config object (from `chatgml config show`). The api key is
   * never echoed: when the redacted `cfg.chat.apiKey` is truthy (the core masks it to `***`), the
   * password input keeps its redaction-glyph placeholder so the user knows a key is set without
   * revealing it. */
  ChatPanel.prototype.setSettingsValues = function (cfg) {
    if (!cfg) return;
    if (cfg.chat && cfg.chat.model && this.settingsModelInput)
      this.settingsModelInput.value = cfg.chat.model;
    if (cfg.chat && cfg.chat.baseURL && this.settingsUrlInput)
      this.settingsUrlInput.value = cfg.chat.baseURL;
    if (cfg.embed && cfg.embed.model && this.settingsEmbedModelInput)
      this.settingsEmbedModelInput.value = cfg.embed.model;
    if (cfg.embed && cfg.embed.baseURL && this.settingsEmbedUrlInput)
      this.settingsEmbedUrlInput.value = cfg.embed.baseURL;
    if (cfg.chat && this.settingsApiKeyInput) {
      // Reflect whether a key is already set without revealing the value. The redacted `***`
      // placeholder is the visual cue; we never assign the redacted value into `value`.
      var placeholder = SettingsTasks.apiKeyDisplayPlaceholder(cfg.chat.apiKey);
      this.settingsApiKeyInput.placeholder = placeholder || SettingsTasks.API_KEY_PLACEHOLDER;
    }
    if (cfg.mode && this.settingsModeSelect) this.settingsModeSelect.value = cfg.mode;
    if (cfg.approval && this.settingsApprovalSelect)
      this.settingsApprovalSelect.value = cfg.approval;
    if (cfg.scope && this.settingsScopeInput) this.settingsScopeInput.value = cfg.scope;
    if (cfg.tiers && this.settingsTierInputs) {
      // Mirror the parsed `cfg.tiers` partial overrides into the form. We never echo the api key
      // back (the spec only exposes model + baseURL in the UI). Undefined tier slots are left at
      // their default empty value so the user can re-set them.
      var names = ['planner', 'implementer', 'reviewer'];
      for (var ti2 = 0; ti2 < names.length; ti2++) {
        var tn = names[ti2];
        var tierSlot = cfg.tiers[tn];
        if (!tierSlot || !this.settingsTierInputs[tn]) continue;
        if (tierSlot.model) this.settingsTierInputs[tn].model.value = tierSlot.model;
        if (tierSlot.baseURL) this.settingsTierInputs[tn].baseURL.value = tierSlot.baseURL;
      }
    }
    // Re-check the URL hint so the user gets immediate feedback if their saved URL matches a
    // registered provider. Without this the hint would only update on the next manual edit.
    if (this.settingsUrlInput && this._refreshUrlHint) this._refreshUrlHint();
  };

  /** Populate the providers registry section. Replaces the contents of `settingsHeaderEl.left`
   * (provider count + bootstrap indicator) and `settingsHeaderEl.right` (Refresh / Add Provider
   * / Export .env action buttons), then renders the collapsible provider list in the scroll
   * container. Safe to call multiple times — the panel re-reads the registry each time so the
   * user can edit `~/.config/chatgml/providers.json` externally and refresh.
   *
   * @param {object} loadResult the return value of `ProvidersApi.loadAll(...)`
   * @param {{onRefresh?:Function, onAddProvider?:Function, onExportEnv?:Function}} callbacks
   */
  ChatPanel.prototype.populateProviders = function (loadResult, callbacks) {
    if (!loadResult) return;
    if (!this.settingsHeaderEl) return;
    var cbs = callbacks || {};
    var self = this;

    // Header (left): count + bootstrap indicator + any warnings.
    var headerLeft = this.settingsHeaderEl.firstChild;
    while (headerLeft.firstChild) headerLeft.removeChild(headerLeft.firstChild);
    var count = (loadResult.providers || []).length;
    var countLabel = document.createElement('span');
    countLabel.className = 'chatgml-settings-providers-count';
    countLabel.textContent = count + ' provider' + (count === 1 ? '' : 's');
    headerLeft.appendChild(countLabel);
    if (loadResult.bootstrapped) {
      var bootBadge = document.createElement('span');
      bootBadge.className = 'chatgml-settings-providers-badge';
      bootBadge.title = 'Copied from ~/.pi/agent/providers.json — you can edit freely';
      bootBadge.textContent = '⚙ bootstrapped';
      headerLeft.appendChild(bootBadge);
    }
    if (Array.isArray(loadResult.warnings) && loadResult.warnings.length > 0) {
      var warnBadge = document.createElement('span');
      warnBadge.className = 'chatgml-settings-providers-warn';
      warnBadge.title = loadResult.warnings.join('\n');
      warnBadge.textContent = '⚠ ' + loadResult.warnings.length;
      headerLeft.appendChild(warnBadge);
    }

    // Header (right): actions.
    var headerRight = this.settingsHeaderEl.lastChild;
    while (headerRight.firstChild) headerRight.removeChild(headerRight.firstChild);
    function makeBtn(text, title, onClick) {
      var b = document.createElement('button');
      b.className = 'chatgml-settings-action-btn';
      b.type = 'button';
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', onClick);
      return b;
    }
    headerRight.appendChild(
      makeBtn('↻', 'Refresh provider registry', function () {
        if (typeof cbs.onRefresh === 'function') cbs.onRefresh();
      }),
    );
    headerRight.appendChild(
      makeBtn('+', 'Add a custom provider entry', function () {
        if (typeof cbs.onAddProvider === 'function') cbs.onAddProvider();
      }),
    );
    headerRight.appendChild(
      makeBtn('.env', 'Export registry as .env snippet', function () {
        if (typeof cbs.onExportEnv === 'function') cbs.onExportEnv();
      }),
    );

    // Datalists — replace the option set on every refresh.
    function fillDatalist(dl, opts) {
      while (dl.firstChild) dl.removeChild(dl.firstChild);
      for (var i = 0; i < opts.length; i++) {
        var o = document.createElement('option');
        o.value = opts[i].value;
        o.label = opts[i].label;
        dl.appendChild(o);
      }
    }
    var dlists = loadResult.datalistOptions || { modelOptions: [], baseUrlOptions: [] };
    if (this.settingsModelDatalist) fillDatalist(this.settingsModelDatalist, dlists.modelOptions);
    if (this.settingsUrlDatalist) fillDatalist(this.settingsUrlDatalist, dlists.baseUrlOptions);
    // Embed lanes reuse the same options (there is no separate registry for embeddings today);
    // a future split could fork this out without changing the panel structure.
    if (this.settingsEmbedModelDatalist)
      fillDatalist(this.settingsEmbedModelDatalist, dlists.modelOptions);
    if (this.settingsEmbedUrlDatalist)
      fillDatalist(this.settingsEmbedUrlDatalist, dlists.baseUrlOptions);
    var tierNames = ['planner', 'implementer', 'reviewer'];
    for (var tni3 = 0; tni3 < tierNames.length; tni3++) {
      var tn2 = tierNames[tni3];
      var slot = this.settingsTierDatalists && this.settingsTierDatalists[tn2];
      if (!slot) continue;
      fillDatalist(slot.model, dlists.modelOptions);
      fillDatalist(slot.baseURL, dlists.baseUrlOptions);
    }

    // Provider list — collapsible `<details>` per provider, with click-to-apply rows for each
    // model. The apply handler fills the Model + Base URL inputs and stores the entry on the
    // panel so the save handler can stamp `providerSelected`.
    while (this.settingsProvidersEl.firstChild)
      this.settingsProvidersEl.removeChild(this.settingsProvidersEl.firstChild);
    var providers = loadResult.providers || [];
    if (providers.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'chatgml-settings-providers-empty';
      empty.textContent =
        'No providers registered. Edit ~/.config/chatgml/providers.json or click + to add one.';
      this.settingsProvidersEl.appendChild(empty);
    } else {
      for (var pi = 0; pi < providers.length; pi++) {
        (function (prov) {
          var det = document.createElement('details');
          det.className = 'chatgml-settings-provider-group';
          var sm = document.createElement('summary');
          var nameSpan = document.createElement('span');
          nameSpan.textContent = prov.name;
          sm.appendChild(nameSpan);
          var metaSpan = document.createElement('span');
          metaSpan.className = 'chatgml-settings-provider-meta';
          metaSpan.textContent =
            prov.kind +
            (prov.models.length > 0
              ? ' · ' + prov.models.length + ' model' + (prov.models.length === 1 ? '' : 's')
              : '');
          sm.appendChild(metaSpan);
          det.appendChild(sm);

          var urlRow = document.createElement('div');
          urlRow.className = 'chatgml-settings-provider-url';
          urlRow.textContent = prov.baseUrl || '(no base_url)';
          det.appendChild(urlRow);

          var list = document.createElement('div');
          list.className = 'chatgml-settings-provider-models';
          if (prov.models.length === 0) {
            var nm = document.createElement('div');
            nm.className = 'chatgml-settings-provider-no-models';
            nm.textContent = 'No models registered — click + to add one.';
            list.appendChild(nm);
          } else {
            for (var mi = 0; mi < prov.models.length; mi++) {
              (function (model, parent) {
                var row = document.createElement('button');
                row.type = 'button';
                row.className = 'chatgml-settings-provider-model';
                row.title = 'Click to apply this provider+model to the chat lane';
                var lbl = document.createElement('span');
                lbl.textContent = model.id;
                row.appendChild(lbl);
                var wire = document.createElement('span');
                wire.className = 'chatgml-settings-provider-wire';
                wire.textContent =
                  model.wireModel && model.wireModel !== model.id ? 'wire: ' + model.wireModel : '';
                row.appendChild(wire);
                if (model.contextWindow > 0) {
                  var ctx = document.createElement('span');
                  ctx.className = 'chatgml-settings-provider-ctx';
                  ctx.textContent = 'ctx ' + model.contextWindow.toLocaleString();
                  row.appendChild(ctx);
                }
                row.addEventListener('click', function () {
                  self._applyProviderEntry({
                    providerName: prov.name,
                    modelId: model.id,
                    baseUrl: prov.baseUrl,
                    endpoint: prov.endpoint,
                    auth: prov.auth,
                  });
                });
                parent.appendChild(row);
              })(prov.models[mi], list);
            }
          }
          det.appendChild(list);
          self.settingsProvidersEl.appendChild(det);
        })(providers[pi]);
      }
    }
    // Mount the provider list just after the sticky header, so it appears above the form rows.
    if (this.settingsProvidersEl.parentNode !== this.settingsScrollEl) {
      this.settingsScrollEl.insertBefore(
        this.settingsProvidersEl,
        this.settingsHeaderEl.nextSibling,
      );
    }
    // URL hint + click handler wiring (re-bound on each refresh so the closure captures the
    // fresh registry).
    if (this.settingsUrlInput) {
      var input = this.settingsUrlInput;
      this._refreshUrlHint = function () {
        if (!self.settingsUrlHintEl || !self._registry) return;
        var v = (input.value || '').trim();
        if (!v) {
          self.settingsUrlHintEl.style.display = 'none';
          return;
        }
        var ProvidersApi = self._ProvidersApi;
        var hit = ProvidersApi && ProvidersApi.findProviderByUrl(self._registry, v);
        if (hit) {
          self.settingsUrlHintEl.textContent = '✓ registered as ' + hit.name;
          self.settingsUrlHintEl.className =
            'chatgml-settings-url-hint chatgml-settings-url-hint--match';
          self.settingsUrlHintEl.style.display = 'block';
        } else {
          self.settingsUrlHintEl.textContent = 'Not in registry — free-text mode';
          self.settingsUrlHintEl.className =
            'chatgml-settings-url-hint chatgml-settings-url-hint--free';
          self.settingsUrlHintEl.style.display = 'block';
        }
      };
      this.settingsUrlInput.removeEventListener('input', this._onUrlInput);
      this._onUrlInput = function () {
        self._refreshUrlHint();
      };
      this.settingsUrlInput.addEventListener('input', this._onUrlInput);
      this._refreshUrlHint();
    }
    // Store the registry + providers module on the instance so applyProviderEntry can look up.
    this._registry = loadResult.registry;
  };

  /** Apply a registry (provider, model) entry to the chat-lane inputs. Called when the user
   * clicks a row in the providers list. Stamps the entry on the panel so the save handler emits
   * the registry-derived fields (path, auth) alongside the model + URL. */
  ChatPanel.prototype._applyProviderEntry = function (entry) {
    if (!entry) return;
    this._activeProviderEntry = entry;
    if (this.settingsModelInput) this.settingsModelInput.value = entry.modelId || '';
    if (this.settingsUrlInput) this.settingsUrlInput.value = entry.baseUrl || '';
    if (this._refreshUrlHint) this._refreshUrlHint();
    // Scroll the chat-lane form rows into view so the user can confirm the auto-fill before
    // hitting Save & Restart.
    if (this.settingsModelInput && typeof this.settingsModelInput.scrollIntoView === 'function') {
      this.settingsModelInput.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    if (this.settingsModelInput && typeof this.settingsModelInput.focus === 'function') {
      this.settingsModelInput.focus();
    }
  };

  /** Public accessor for the currently-selected provider entry, used by the save handler. */
  ChatPanel.prototype.getActiveProviderEntry = function () {
    return this._activeProviderEntry || null;
  };

  /** Submit the current input: route slash commands; otherwise send a user message + editor ctx + mentions. */
  ChatPanel.prototype._submit = async function () {
    const raw = this.inputEl.value;
    const text = raw.trim();
    if (text === '') return;
    const slash = State.parseSlashCommand(text);
    if (slash !== null) {
      this._handleSlash(slash);
      this.inputEl.value = '';
      this._renderMentionChips();
      return;
    }
    // Non-slash: resolve @mentions, gather editor context, and send the clean message.
    let context;
    if (typeof this.opts.getEditorContext === 'function') {
      try {
        context = this.opts.getEditorContext();
      } catch (e) {
        context = undefined;
      }
    }
    let mentionsResult = { mentions: [], cleanText: raw };
    if (typeof this.opts.getMentions === 'function') {
      try {
        mentionsResult = await this.opts.getMentions(raw);
      } catch (e) {
        mentionsResult = { mentions: [], cleanText: raw };
      }
    }
    const cleanText = mentionsResult.cleanText.trim();
    if (cleanText === '' && mentionsResult.mentions.length === 0) return;
    const send = this.opts.onSendWithContext || this.opts.onSend;
    send(cleanText, Object.assign({}, context, { mentions: mentionsResult.mentions }));
    // Show the user message immediately (before the core responds) for instant feedback.
    // OUTBOX: push a 'queued' entry onto the outbox so a SECOND send before this turn finishes
    // does NOT visually overwrite the first one (the OLD code wrote `pendingUserText = cleanText`
    // on every send). The reducer promotes this 'queued' entry to 'streaming' when tokens
    // arrive, and 'turn_end' pops it. The same fresh `cleanText` is also kept on
    // `state.pendingUserText` so the legacy "show my bubble immediately" code path below still
    // works when only one message is in flight (the legacy UX contract is preserved when
    // outbox.length === 1).
    //
    // Cap: drop the OLDEST entries past `this._outboxCap` (default 20) so a runaway key-repeat
    // can't grow this array unbounded. The cap matches the spirit of TURN_CAP / ACTIVITY_CAP
    // in state.js. The chatgml.js safety net (`if (panel.state.outbox.length > 2) return;`)
    // already prevents runaway, so this is purely a defensive bound.
    if (this.state.outbox.length >= this._outboxCap) {
      const dropped = this.state.outbox.length - this._outboxCap + 1;
      this.state.outbox = this.state.outbox.slice(dropped);
      this._outboxRenderedIds = this._outboxRenderedIds.slice(dropped);
      this.flash(
        'queue capped at ' + this._outboxCap + ' — dropped ' + dropped + ' oldest message(s)',
        true,
      );
    }
    this.state.outbox.push({
      id: 'q' + ++this._queueSeq,
      text: cleanText,
      status: 'queued',
      ts: Date.now(),
    });
    // Mirror the seq bump into state (the reducer never writes _queueSeq; this is the only
    // writer). The mirror lets a future server-side replay stay id-unique.
    this.state._queueSeq = this._queueSeq;
    // Backwards-compat: pendingUserText stays in lock-step with the head of the outbox. Single-
    // send (the common case) makes pendingUserText == cleanText, which preserves the legacy
    // `_render -> pending bubble` rendering path. Multi-send leaves pendingUserText pinned to
    // the head so the legacy single-bubble render (when triggered with an empty outbox) would
    // still show the most-recently-typed message — the bug we are fixing is "the second send
    // visually replaced the first bubble", and pinning pendingUserText to the head is exactly
    // the right semantics.
    this.state.pendingUserText = this.state.outbox[0].text;
    this._setBusy(true);
    this.inputEl.value = '';
    this._renderMentionChips();
    this.render();
  };

  /**
   * Toggle the panel's "is a turn streaming?" UI state. Disables Send and marks the input
   * read-only while `busy === true` so a fast second tap on Send can't enqueue a duplicate
   * or race the in-flight wire command. The reducer's `state.busy` is the SSOT — we mirror
   * it here at every render via render(), so this helper is the ONLY place that flips the
   * disabled/readOnly attributes (callers: _submit [true] and handleEvent [re-sync]).
   *
   * Safety net: if the panel hasn't built the input row yet (e.g. during a render race), the
   * element refs are null and we no-op silently. setRunning()/clear() also drive this via
   * direct DOM manipulation; see those call sites.
   */
  ChatPanel.prototype._setBusy = function (busy) {
    this._busy = !!busy;
    if (this.sendBtn) {
      if (busy) this.sendBtn.setAttribute('disabled', 'disabled');
      else this.sendBtn.removeAttribute('disabled');
    }
    if (this.inputEl) {
      // readOnly prevents typing into an in-flight turn (matches the visual "wait" affordance);
      // it's also a hard guarantee — the textarea ignores keystrokes when readOnly = true.
      try {
        this.inputEl.readOnly = !!busy;
      } catch (e) {
        /* readOnly is a reflected property on textarea; ignore engine quirks */
      }
    }
  };

  /**
   * Act on a parsed slash command. Commands that need the core (clear/reindex/resume) are forwarded
   * via opts.onSlash; pure display commands (help/unknown/empty) are rendered here. The glue
   * (chatgml.js) implements onSlash for clear/reindex/resume/scope/model/approval so the panel
   * stays DOM-only.
   */
  ChatPanel.prototype._handleSlash = function (cmd) {
    switch (cmd.kind) {
      case 'help':
        this.flashHelp();
        return;
      case 'unknown':
      case 'empty':
        this.flash('/' + (cmd.name || '') + ' — unknown command (try /help)', true);
        return;
      case 'tier':
        // arg === null => cleared (auto). Any of the three canonical names sets the override.
        this.setTierOverride(cmd.arg);
        if (cmd.arg) {
          this.flash('tier set to ' + cmd.arg + ' — next turn uses this lane');
        } else {
          this.flash('tier override cleared — back to mode-based dispatch');
        }
        if (typeof this.opts.onTierOverride === 'function') {
          try {
            this.opts.onTierOverride(cmd.arg);
          } catch (e) {
            /* glue should never throw, but the panel must survive */
          }
        }
        return;
      default:
        if (typeof this.opts.onSlash === 'function') {
          this.opts.onSlash(cmd);
        }
    }
  };

  /** Append a short notice line into the transcript region (error=true styles it red). */
  ChatPanel.prototype.flash = function (text, isError = false) {
    const note = document.createElement('div');
    note.className = 'chatgml-flash' + (isError ? ' chatgml-flash-error' : '');
    note.textContent = text;
    this.transcriptEl.appendChild(note);
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  };

  /** Show the @mention autocomplete dropdown. */
  ChatPanel.prototype._showMentionDropdown = function () {
    const self = this;
    this.mentionDropdownEl.innerHTML = '';
    const items = [
      { type: 'file', label: 'file', insert: 'file ' },
      { type: 'folder', label: 'folder', insert: 'folder ' },
      { type: 'problems', label: 'problems', insert: 'problems' },
      { type: 'terminal', label: 'terminal', insert: 'terminal' },
      { type: 'url', label: 'url', insert: 'url ' },
      { type: 'image', label: 'image', insert: 'image ' },
    ];
    this._mentionItems = items;
    this._mentionActiveIndex = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const div = document.createElement('div');
      div.className = 'chatgml-mention-autocomplete-item';
      if (i === 0) div.classList.add('chatgml-mention-active');
      div.textContent = item.label;
      div.addEventListener(
        'click',
        (function (insert) {
          return function () {
            self._insertMention(insert);
            self._hideMentionDropdown();
          };
        })(item.insert),
      );
      this.mentionDropdownEl.appendChild(div);
    }
    this.mentionDropdownEl.style.display = 'block';
  };

  /**
   * Detect whether the cursor is currently inside a "@file " mention. Returns the query
   * (the substring typed after "@file ") and the absolute start position of the @ so the panel
   * knows where to splice the selected path back in. Returns null if the cursor is not in a
   * @file mention.
   */
  ChatPanel.prototype._fileMentionContext = function () {
    var val = this.inputEl.value;
    var pos = this.inputEl.selectionStart;
    if (pos == null) return null;
    // Walk backwards from the cursor to find an '@file ' that starts at a word boundary.
    var i = pos;
    while (i > 0) {
      var ch = val.charAt(i - 1);
      if (ch === '\n') break; // newline ends a line
      if (ch === '@') {
        // Check the prefix is '@file ' or '@file<not-space>' (so '@filename' does NOT match).
        var after = val.slice(i, i + 4);
        if (
          after.toLowerCase() === 'file' &&
          (i + 4 >= val.length || /\s/.test(val.charAt(i + 4)))
        ) {
          // Cursor must be within or at the end of the file mention. We allow the cursor to be
          // anywhere in "after @file" up to the next whitespace.
          var j = i + 4;
          while (j < val.length && !/\s/.test(val.charAt(j))) j++;
          if (pos >= i && pos <= j + (val.charAt(j) === ' ' ? 1 : 0)) {
            return { start: i, end: j, query: val.slice(i + 5, pos) };
          }
          return null;
        }
        return null;
      }
      i--;
    }
    return null;
  };

  /** Show the @file autocomplete dropdown with fuzzy-filtered project files. */
  ChatPanel.prototype._showFileMentionDropdown = function (query) {
    var self = this;
    if (typeof this.opts.getProjectFiles !== 'function') return; // no project dir
    var promise = this.opts.getProjectFiles();
    if (!promise || typeof promise.then !== 'function') return; // not a promise
    var token = ++this._fileDropdownToken;
    promise
      .then(function (files) {
        if (token !== self._fileDropdownToken) return; // stale (user kept typing)
        if (!files || files.length === 0) {
          self._hideFileMentionDropdown();
          return;
        }
        var matches = (
          self._fileFilter ||
          function (all, q) {
            return all.slice(0, 8);
          }
        )(files, query);
        if (!matches || matches.length === 0) {
          self._hideFileMentionDropdown();
          return;
        }
        self._renderFileDropdown(matches, query);
      })
      .catch(function (e) {
        console.warn('chatgml: file index failed', e);
        self._hideFileMentionDropdown();
      });
  };

  /** Render the file dropdown contents (called by _showFileMentionDropdown once files are ready). */
  ChatPanel.prototype._renderFileDropdown = function (matches, query) {
    this.mentionDropdownEl.innerHTML = '';
    this._mentionItems = matches.map(function (m) {
      return { type: 'file-result', label: m, insert: m + ' ' };
    });
    this._mentionActiveIndex = 0;
    for (var i = 0; i < matches.length; i++) {
      var item = matches[i];
      var div = document.createElement('div');
      div.className = 'chatgml-mention-autocomplete-item';
      if (i === 0) div.classList.add('chatgml-mention-active');
      div.textContent = item.label;
      div.addEventListener(
        'click',
        (function (insert) {
          return function () {
            self._insertFileResult(insert);
            self._hideMentionDropdown();
          };
        })(item.label),
      );
      this.mentionDropdownEl.appendChild(div);
    }
    this.mentionDropdownEl.style.display = 'block';
  };

  /** Insert a file result at the cursor (replaces the @file + query with the chosen path). */
  ChatPanel.prototype._insertFileResult = function (path) {
    var ctx = this._fileMentionContext();
    var val = this.inputEl.value;
    if (ctx) {
      // Replace from '@' through the typed query with the chosen path.
      var insertPos = ctx.start; // position of '@'
      var before = val.slice(0, insertPos);
      // Re-add a leading @ so the file mention is preserved verbatim in the sent text.
      var after = val.slice(insertPos + 5 + ctx.query.length);
      this.inputEl.value = before + '@file ' + path + after;
      var newPos = before.length + 6 + path.length;
      this.inputEl.selectionStart = newPos;
      this.inputEl.selectionEnd = newPos;
    } else {
      // Fallback: append at cursor.
      var start2 = this.inputEl.selectionStart;
      var end2 = this.inputEl.selectionEnd;
      this.inputEl.value = val.slice(0, start2) + path + val.slice(end2);
      this.inputEl.selectionStart = start2 + path.length;
      this.inputEl.selectionEnd = start2 + path.length;
    }
    this._renderMentionChips();
  };

  /** Hide the file dropdown if it's showing file completions. */
  ChatPanel.prototype._hideFileMentionDropdown = function () {
    this._fileDropdownToken = (this._fileDropdownToken || 0) + 1; // invalidate in-flight
  };

  /** Move the mention autocomplete selection up or down. */
  ChatPanel.prototype._moveMentionSelection = function (delta) {
    if (!this._mentionItems || this._mentionItems.length === 0) return;
    this._mentionActiveIndex =
      (this._mentionActiveIndex + delta + this._mentionItems.length) % this._mentionItems.length;
    var items = this.mentionDropdownEl.querySelectorAll('.chatgml-mention-autocomplete-item');
    for (var i = 0; i < items.length; i++) {
      if (i === this._mentionActiveIndex) items[i].classList.add('chatgml-mention-active');
      else items[i].classList.remove('chatgml-mention-active');
    }
  };

  /** Confirm the currently selected mention item. */
  ChatPanel.prototype._selectMentionItem = function () {
    if (!this._mentionItems || this._mentionItems.length === 0) return;
    this._insertMention(this._mentionItems[this._mentionActiveIndex].insert);
    this._hideMentionDropdown();
  };

  /** Build the inline tier picker on first open; toggling the chip re-uses the same node. */
  ChatPanel.prototype._toggleTierPicker = function () {
    if (this.tierPickerEl && this.tierPickerEl.parentNode) {
      this._hideTierPicker();
      return;
    }
    this._showTierPicker();
  };

  ChatPanel.prototype._showTierPicker = function () {
    if (!this.tierPickerEl) {
      this.tierPickerEl = document.createElement('div');
      this.tierPickerEl.className = 'chatgml-tier-picker';
      this.opts.container.appendChild(this.tierPickerEl);
    }
    this.tierPickerEl.innerHTML = '';
    var opts = [
      { name: 'auto', label: 'Auto', cls: 'chatgml-tier-picker-auto' },
      { name: 'planner', label: '🧠 Planner', cls: 'chatgml-tier-picker-planner' },
      { name: 'implementer', label: '⚙ Implementer', cls: 'chatgml-tier-picker-implementer' },
      { name: 'reviewer', label: '🔍 Reviewer', cls: 'chatgml-tier-picker-reviewer' },
    ];
    var selfRef = this;
    for (var i = 0; i < opts.length; i++) {
      (function (entry) {
        var btn = document.createElement('button');
        btn.className = 'chatgml-tier-picker-btn ' + entry.cls;
        btn.textContent = entry.label;
        if (
          entry.name === selfRef.tierOverride ||
          (entry.name === 'auto' && selfRef.tierOverride === null)
        ) {
          btn.classList.add('active');
        }
        btn.addEventListener('click', function () {
          var chosen = entry.name === 'auto' ? null : entry.name;
          selfRef.setTierOverride(chosen);
          if (chosen) selfRef.flash('tier set to ' + chosen + ' — next turn uses this lane');
          else selfRef.flash('tier override cleared — back to mode-based dispatch');
          if (typeof selfRef.opts.onTierOverride === 'function') {
            try {
              selfRef.opts.onTierOverride(chosen);
            } catch (e) {
              /* ignore — chip click must never break the panel */
            }
          }
          selfRef._hideTierPicker();
        });
        selfRef.tierPickerEl.appendChild(btn);
      })(opts[i]);
    }
    this.tierPickerEl.style.display = 'flex';
  };

  ChatPanel.prototype._hideTierPicker = function () {
    if (this.tierPickerEl) this.tierPickerEl.style.display = 'none';
  };

  /** Hide the @mention autocomplete dropdown. */
  ChatPanel.prototype._hideMentionDropdown = function () {
    if (this.mentionDropdownEl) this.mentionDropdownEl.style.display = 'none';
    this._mentionTriggerPos = null;
    this._fileDropdownToken = 0;
    // Fuzzy filter for the @file autocomplete. Defaults to null; chatgml.js sets
    // this._fileFilter to the real fuzzy scorer at panel construction time.
    this._fileFilter = null;
    if (this._fileDropdownToken != null) this._fileDropdownToken++; // invalidate in-flight file dropdown
  };

  /** Insert a mention keyword at the trigger position (replacing the typed '@'). */
  ChatPanel.prototype._insertMention = function (keyword) {
    const pos = this._mentionTriggerPos;
    const val = this.inputEl.value;
    if (pos != null && pos >= 0 && pos < val.length && val.charAt(pos) === '@') {
      const before = val.slice(0, pos);
      const after = val.slice(pos + 1);
      this.inputEl.value = before + '@' + keyword + after;
      const newPos = pos + 1 + keyword.length;
      this.inputEl.selectionStart = newPos;
      this.inputEl.selectionEnd = newPos;
    } else {
      const start = this.inputEl.selectionStart;
      const end = this.inputEl.selectionEnd;
      const before = this.inputEl.value.slice(0, start);
      const after = this.inputEl.value.slice(end);
      this.inputEl.value = before + '@' + keyword + after;
      const newPos = start + 1 + keyword.length;
      this.inputEl.selectionStart = newPos;
      this.inputEl.selectionEnd = newPos;
    }
    this._mentionTriggerPos = null;
    this._renderMentionChips();
  };

  /** Render removable chips for each parsed mention above the textarea. */
  ChatPanel.prototype._renderMentionChips = function () {
    const self = this;
    this.mentionRowEl.innerHTML = '';
    const parsed = State.parseMentions(this.inputEl.value);
    if (parsed.mentions.length === 0) {
      this.mentionRowEl.style.display = 'none';
      return;
    }
    this.mentionRowEl.style.display = '';
    for (let i = 0; i < parsed.mentions.length; i++) {
      const m = parsed.mentions[i];
      const chip = document.createElement('span');
      chip.className = 'chatgml-mention-chip';
      const label = m.type + (m.target && m.target !== m.type ? ': ' + m.target : '');
      chip.appendChild(document.createTextNode(label));
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = 'Remove mention';
      x.addEventListener(
        'click',
        (function (mention) {
          return function () {
            self._removeMention(mention);
          };
        })(m),
      );
      chip.appendChild(x);
      this.mentionRowEl.appendChild(chip);
    }
  };

  /** Remove the first mention line matching the given mention from the textarea. */
  ChatPanel.prototype._removeMention = function (mention) {
    const lines = this.inputEl.value.split('\n');
    const kept = [];
    let removed = false;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const m = State.parseMentions(raw).mentions[0];
      if (!removed && m && m.type === mention.type && m.target === mention.target) {
        removed = true;
        continue;
      }
      kept.push(raw);
    }
    this.inputEl.value = kept.join('\n');
    this._renderMentionChips();
  };

  ChatPanel.prototype.flashHelp = function () {
    const help = State.SLASH_HELP || [];
    const block = document.createElement('div');
    block.className = 'chatgml-flash chatgml-help';
    for (let i = 0; i < help.length; i++) {
      const ln = document.createElement('div');
      ln.textContent = help[i];
      block.appendChild(ln);
    }
    this.transcriptEl.appendChild(block);
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  };

  /** Apply one AgentEvent: reduce state, then re-render. Token events are debounced to ~60fps
   * via requestAnimationFrame so a fast model streaming 500+ tokens/s doesn't trigger 500 full
   * re-renders (which would freeze the panel on longer conversations). */
  ChatPanel.prototype.handleEvent = function (event) {
    this.state = State.reducePluginState(event, this.state);
    // OUTBOX / busy re-sync: the reducer already managed `state.outbox` and `state.busy`, but
    // `_busy` (the panel-side flag) and the Send-button disabled state have to be flipped here
    // so the next render reflects the busy transition immediately. We re-derive busy from
    // `state.outbox.length` rather than `state.busy` so the panel stays in sync with whichever
    // event fired (an `error` event without a follow-up turn_end will still drop busy).
    this._setBusy(this.state.outbox.length > 0);
    if (event.type === 'edit_proposal') {
      const proposal = this.state.pendingProposals.get(event.id);
      if (proposal) this.diffView.show(proposal);
    }
    // turn_end: a persistence side-channel. The reducer treats it as a no-op on the visible state
    // (the answer event already finalized it); we forward the record to the glue so it can append
    // it to the per-project session file for /resume later.
    if (event.type === 'turn_end' && typeof this.opts.onTurnEnd === 'function') {
      try {
        this.opts.onTurnEnd(event);
      } catch (e) {
        // persistence must never break the live panel
      }
    }
    if (event.type === 'token') {
      this._scheduleTokenRender();
    } else {
      this.render();
    }
  };

  /** Debounce token rendering to ~60fps (16ms) using requestAnimationFrame. Multiple token
   * events arriving within one frame are coalesced into a single render. */
  ChatPanel.prototype._scheduleTokenRender = function () {
    var self = this;
    if (this._tokenRafScheduled) return;
    this._tokenRafScheduled = true;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        self._tokenRafScheduled = false;
        self.render();
      });
    } else {
      setTimeout(function () {
        self._tokenRafScheduled = false;
        self.render();
      }, 16);
    }
  };

  /** Detect GMEdit's theme (light/dark) and set data-theme on the panel container so CSS
   * variables adapt. Checks document.documentElement class/attribute first, then falls back to
   * computing the luminance of the main editor's background color. */
  ChatPanel.prototype._detectTheme = function () {
    var isLight = false;
    try {
      var root = document.documentElement;
      if (root.classList.contains('light') || root.getAttribute('data-theme') === 'light') {
        isLight = true;
      }
      var mainEl = document.getElementById('main') || document.querySelector('.ace_editor');
      if (mainEl) {
        var bg = window.getComputedStyle(mainEl).backgroundColor;
        var m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(bg);
        if (m) {
          var lum = parseInt(m[1]) * 0.299 + parseInt(m[2]) * 0.587 + parseInt(m[3]) * 0.114;
          if (lum > 128) isLight = true;
        }
      }
    } catch (e) {
      /* ignore */
    }
    this.opts.container.setAttribute('data-theme', isLight ? 'light' : 'dark');
  };

  /** Check if the transcript is scrolled to (or near) the bottom — used to decide whether
   * auto-scrolling on new content would yank the user away from what they're reading. */
  ChatPanel.prototype._isNearBottom = function () {
    var el = this.transcriptEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  ChatPanel.prototype.setRunning = function (running, error) {
    this.running = running;
    this.launchBtn.textContent = running ? 'Stop' : 'Launch';
    if (!running) {
      this.state = State.initialPluginState();
      // Reset the panel-side seq counter alongside state.outbox so a fresh session restarts at
      // q1 — leaving the old counter would collide on id with a future session's outbox entries
      // if the panel instance is reused.
      this._queueSeq = 0;
      this.catalogOpen = false;
      this.selectedCheckpointId = null;
      // Stop+Launch cancels any in-flight turn: drop the Send-disabled / input-readOnly flags
      // via _setBusy(false) — keeps the legacy direct DOM writes working AND resets _busy.
      this._setBusy(false);
      this.sendBtn.setAttribute('disabled', 'disabled');
      this.reindexBtn.setAttribute('disabled', 'disabled');
      this.state.pendingUserText = null;
      // Reset the eviction counters and the trim-notice element so a Stop+Launch doesn't leave a
      // stale "Showing last N turns (X trimmed)" line behind for a fresh session.
      this.state.turnsEvicted = 0;
      this.state.activityEvicted = 0;
      if (this.trimNoticeEl) this.trimNoticeEl.style.display = 'none';
      this._renderedTurnsCount = 0;
      this._streamingBubbleEl = null;
      this._pendingBubbleEl = null;
      this._outboxBubbleEl = null;
      this._outboxRenderedIds = [];
      // Stop+Launch returns the panel to a clean state: drop any in-flight tier override so the
      // next turn dispatches via the freshly-loaded mode (avoids a stale override carrying over
      // from a previous session).
      this.tierOverride = null;
      this._hideTierPicker();
      this.diffView.clear();
      if (this.stopGenBtn) this.stopGenBtn.style.display = 'none';
      if (error) this.showRestart();
      else this.hideRestart();
    } else {
      this.hideRestart();
      // Until the ready handshake arrives the status line should read "phase: connecting" (not the
      // stale "stopped" from initialPluginState()), so the user sees something useful while the
      // child is booting.
      this.state.phase = 'connecting';
    }
    this.render();
  };

  ChatPanel.prototype.showRestart = function () {
    if (this.restartBtn) this.restartBtn.style.display = '';
  };

  ChatPanel.prototype.hideRestart = function () {
    if (this.restartBtn) this.restartBtn.style.display = 'none';
  };

  /** Called once the ready handshake arrives: enable Send + Reindex. */
  ChatPanel.prototype.setReady = function () {
    this.sendBtn.removeAttribute('disabled');
    this.reindexBtn.removeAttribute('disabled');
  };

  /** Set the per-turn tier override ('planner' | 'implementer' | 'reviewer' | null). null clears
   * the override and falls back to mode-based auto-dispatch. The picker chip and /tier slash
   * command both route through here. */
  ChatPanel.prototype.setTierOverride = function (name) {
    var normalized =
      name === 'planner' || name === 'implementer' || name === 'reviewer' ? name : null;
    this.tierOverride = normalized;
    this.render();
  };

  /** Update the active mode (from the ready handshake or user interaction). */
  ChatPanel.prototype.setMode = function (mode) {
    this.state.mode = mode;
    if (this.modeBtns) {
      const modes = Object.keys(this.modeBtns);
      for (let i = 0; i < modes.length; i++) {
        const btn = this.modeBtns[modes[i]];
        if (modes[i] === mode) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    }
    this.render();
  };

  /** Focus the chat input (no-op if input element isn't mounted yet). */
  ChatPanel.prototype.focusInput = function () {
    if (this.inputEl && typeof this.inputEl.focus === 'function') {
      this.inputEl.focus();
      if (typeof this.inputEl.setSelectionRange === 'function') {
        const len = (this.inputEl.value || '').length;
        try {
          this.inputEl.setSelectionRange(len, len);
        } catch (_) {
          /* ignore */
        }
      }
    }
  };

  /** Clear the visible transcript/activity/proposals without resetting ready/mode. */
  ChatPanel.prototype.clear = function () {
    if (this.stopGenBtn) this.stopGenBtn.style.display = 'none';
    this._renderedTurnsCount = 0;
    this._streamingBubbleEl = null;
    this._pendingBubbleEl = null;
    // /clear also drops any outbox wrapper/ids so a /clear-mid-stream doesn't leave
    // dangling queued user bubbles on a fresh transcript.
    this._outboxBubbleEl = null;
    this._outboxRenderedIds = [];
    this.state.transcript = '';
    this.state.answer = null;
    this.state.sources = [];
    this.state.activity = [];
    this.state.pendingProposals = new Map();
    this.state.error = null;
    this.state.checkpoints = [];
    this.state.turns = [];
    // /clear is a user-initiated reset of the in-memory history — drop the eviction counters too
    // so the trim notice disappears immediately (a still-positive count would otherwise render
    // "Showing last N turns (0 trimmed)" against an empty transcript, which is meaningless).
    this.state.turnsEvicted = 0;
    this.state.activityEvicted = 0;
    this.state.pendingUserText = null;
    // OUTBOX: /clear also empties the outbox (queued/stale bubbles from prior sends have nowhere
    // to go on a cleared session) and clears busy so Send re-enables immediately. The seq
    // counter is preserved across /clear so future outbox ids remain unique within the panel.
    this.state.outbox = [];
    this.state.busy = false;
    this._setBusy(false);
    // /clear also clears the tier override: the user explicitly asked for a clean slate.
    this.tierOverride = null;
    this._hideTierPicker();
    this.lastWrittenPaths.clear();
    this.selectedCheckpointId = null;
    this.diffView.clear();
    if (this.trimNoticeEl) this.trimNoticeEl.style.display = 'none';
    this.render();
  };

  /** Replace the task picker dropdown options. */
  ChatPanel.prototype.setTasks = function (tasks) {
    this.tasks = tasks ? tasks.slice() : [];
    this.taskSelectEl.innerHTML = '';
    const newOpt = document.createElement('option');
    newOpt.value = '';
    newOpt.textContent = 'New task...';
    this.taskSelectEl.appendChild(newOpt);
    for (let i = 0; i < this.tasks.length; i++) {
      const id = this.tasks[i];
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      this.taskSelectEl.appendChild(opt);
    }
    this.taskSelectEl.value =
      this.taskId && this.tasks.indexOf(this.taskId) !== -1 ? this.taskId : 'default';
  };

  /** Update the active task id in the picker, badge, and delete button. */
  ChatPanel.prototype.setTask = function (taskId) {
    this.taskId = taskId || 'default';
    if (this.taskSelectEl) {
      this.taskSelectEl.value =
        this.tasks && this.tasks.indexOf(this.taskId) !== -1 ? this.taskId : 'default';
    }
    if (this.taskDeleteBtn) {
      this.taskDeleteBtn.style.display = this.taskId === 'default' ? 'none' : '';
    }
    this.render();
  };

  /** Mark a proposal resolved in the diff view after approve/reject is sent. */
  ChatPanel.prototype.settleProposal = function (id, outcome) {
    this.diffView.resolve(id, outcome);
    this.state = State.settleProposal(id, this.state);
  };

  /**
   * Render the quick-config row from the (redacted) effective config returned by `chatgml config
   * show`. Accepts the parsed config object OR null (clears the row). Pure display; never edits.
   */
  ChatPanel.prototype.setConfig = function (config) {
    this._config = config || null;
    this.render();
  };

  ChatPanel.prototype.toggleCatalog = function () {
    this.catalogOpen = !this.catalogOpen;
    this.render();
  };

  ChatPanel.prototype.render = function () {
    const self = this;
    const s = this.state;
    // Periodically re-detect GMEdit's theme (every 50 renders) to catch theme switches.
    this._renderCount = (this._renderCount || 0) + 1;
    if (this._renderCount % 50 === 1) this._detectTheme();
    // Track scroll position before re-rendering so we can avoid yanking the user back to bottom.
    var wasNearBottom = this._isNearBottom();
    this.statusEl.textContent = this.running ? 'phase: ' + s.phase : 'stopped';

    // Working/connecting indicator: pulse the status line while the agent is streaming, running
    // a tool, or the core is still booting.
    var isWorking =
      (s.answer != null && String(s.answer).length > 0) ||
      (s.activity &&
        s.activity.some(function (a) {
          return a.status === 'running' || a.status === 'waiting';
        }));
    this.statusEl.classList.remove('chatgml-status--working');
    this.statusEl.classList.remove('chatgml-status--connecting');
    if (isWorking && this.running) {
      this.statusEl.classList.add('chatgml-status--working');
    } else if (s.phase === 'connecting') {
      this.statusEl.classList.add('chatgml-status--connecting');
    }

    // Sync mode segmented control active state.
    if (this.modeBtns) {
      const modes = Object.keys(this.modeBtns);
      for (let i = 0; i < modes.length; i++) {
        const btn = this.modeBtns[modes[i]];
        if (modes[i] === s.mode) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    }

    // Config row: scope / model / approval (read-only snapshot). строй rendered from this._config.
    this.configRowEl.innerHTML = '';
    const modeBadge = document.createElement('span');
    modeBadge.className = 'chatgml-mode-badge';
    modeBadge.textContent = s.mode || 'code';
    this.configRowEl.appendChild(modeBadge);
    const taskBadge = document.createElement('span');
    taskBadge.className = 'chatgml-task-badge';
    taskBadge.textContent = this.taskId || 'default';
    this.configRowEl.appendChild(taskBadge);
    // Tier override chip: shows the active per-turn override ("Tier: planner" etc.) and opens an
    // inline picker on click. When no override is set, the label reads "Tier: auto" so the user
    // can see at a glance whether the next turn is dispatch-bound or mode-bound.
    const tierChip = document.createElement('span');
    const activeTier = this.tierOverride;
    if (activeTier) {
      tierChip.className = 'chatgml-tier-chip chatgml-tier-chip-' + activeTier;
      tierChip.textContent = 'Tier: ' + activeTier;
    } else {
      tierChip.className = 'chatgml-tier-chip chatgml-tier-chip-auto';
      tierChip.textContent = 'Tier: auto';
    }
    tierChip.title = 'Click to set the per-turn tier override';
    const selfRef = this;
    tierChip.addEventListener('click', function (ev) {
      ev.stopPropagation();
      selfRef._toggleTierPicker();
    });
    this.configRowEl.appendChild(tierChip);
    const cfg = this._config;
    if (cfg) {
      const chips = [];
      if (cfg.scope) chips.push('scope: ' + cfg.scope);
      if (cfg.chat && cfg.chat.model) chips.push('model: ' + cfg.chat.model);
      if (cfg.approval) chips.push('approval: ' + cfg.approval);
      for (let i = 0; i < chips.length; i++) {
        const chip = document.createElement('span');
        chip.className = 'chatgml-config-chip';
        chip.textContent = chips[i];
        this.configRowEl.appendChild(chip);
      }
    }

    // Checkpoint chips.
    this.checkpointRowEl.innerHTML = '';
    const hasCheckpoints = s.checkpoints && s.checkpoints.length > 0;
    if (hasCheckpoints) {
      this.checkpointRowEl.appendChild(this.undoBtn);
      for (let i = 0; i < s.checkpoints.length; i++) {
        const cp = s.checkpoints[i];
        const chip = document.createElement('span');
        chip.className = 'chatgml-checkpoint-chip';
        if (cp.id === this.selectedCheckpointId) chip.classList.add('selected');
        const text = cp.label || cp.path;
        chip.textContent = text.length > 18 ? text.slice(0, 18) + '…' : text;
        chip.title = cp.path + (cp.label ? ' (' + cp.label + ')' : '') + ' — click to copy id';
        chip.addEventListener('click', function () {
          self.selectedCheckpointId = cp.id;
          try {
            if (
              typeof navigator !== 'undefined' &&
              navigator.clipboard &&
              navigator.clipboard.writeText
            ) {
              navigator.clipboard.writeText(cp.id);
            }
          } catch (e) {
            /* ignore */
          }
          self.render();
        });
        this.checkpointRowEl.appendChild(chip);
      }
    } else {
      this.selectedCheckpointId = null;
    }

    // Activity.
    this.activityEl.innerHTML = '';
    for (let i = 0; i < s.activity.length; i++) {
      const a = s.activity[i];
      const row = document.createElement('div');
      row.className = 'chatgml-activity-row chatgml-activity-' + a.status;
      const header = document.createElement('span');
      header.className = 'chatgml-activity-header';
      if (a.kind === 'command') {
        const cmd = String(a.command || '');
        const cmdText = cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd;
        header.textContent = 'execute_command: ' + cmdText + ' — ' + a.status;
      } else if (a.kind === 'mcp') {
        header.textContent = (a.server ? a.server + '/' : '') + a.name + ' — ' + a.status;
      } else {
        header.textContent = a.name + ' — ' + a.status;
      }
      row.appendChild(header);
      if (a.kind === 'command') {
        const pre = document.createElement('pre');
        pre.className = 'chatgml-activity-content';
        pre.textContent = a.output || '';
        row.appendChild(pre);
        header.addEventListener('click', function () {
          pre.classList.toggle('open');
        });
        if (a.status === 'waiting') {
          const bar = document.createElement('div');
          bar.className = 'chatgml-cmd-bar';
          const approve = document.createElement('button');
          approve.className = 'chatgml-cmd-btn';
          approve.textContent = 'Approve';
          approve.addEventListener('click', function (ev) {
            ev.stopPropagation();
            self.opts.onApproveCommand(a.id);
          });
          const runOnce = document.createElement('button');
          runOnce.className = 'chatgml-cmd-btn';
          runOnce.textContent = 'Run once';
          runOnce.addEventListener('click', function (ev) {
            ev.stopPropagation();
            self.opts.onRunOnce(a.id);
          });
          const reject = document.createElement('button');
          reject.className = 'chatgml-cmd-btn';
          reject.textContent = 'Reject';
          reject.addEventListener('click', function (ev) {
            ev.stopPropagation();
            self.opts.onRejectCommand(a.id);
          });
          bar.appendChild(approve);
          bar.appendChild(runOnce);
          bar.appendChild(reject);
          row.appendChild(bar);
        }
      } else if (a.content != null || a.error != null) {
        const pre = document.createElement('pre');
        pre.className = 'chatgml-activity-content';
        if (a.error != null) {
          pre.classList.add('chatgml-activity-error-content');
          pre.textContent = a.error;
        } else {
          pre.textContent = a.content;
        }
        row.appendChild(pre);
        header.addEventListener('click', function () {
          pre.classList.toggle('open');
        });
      }
      this.activityEl.appendChild(row);
    }

    // Tool catalog.
    this.catalogEl.innerHTML = '';
    if (s.catalog && s.catalog.length > 0) {
      const header = document.createElement('div');
      header.className = 'chatgml-tool-catalog-header';
      header.textContent = (this.catalogOpen ? '▼ ' : '▶ ') + 'Tools (' + s.catalog.length + ')';
      header.addEventListener('click', function () {
        self.toggleCatalog();
      });
      this.catalogEl.appendChild(header);
      if (this.catalogOpen) {
        for (let i = 0; i < s.catalog.length; i++) {
          const t = s.catalog[i];
          const row = document.createElement('div');
          row.className = 'chatgml-tool-row';
          const kind = document.createElement('span');
          kind.className = 'chatgml-tool-kind chatgml-tool-kind-' + t.kind;
          kind.textContent = t.kind;
          const name = document.createElement('span');
          name.textContent = t.name;
          if (t.kind === 'mcp') {
            const badge = document.createElement('span');
            badge.className = 'chatgml-mcp-badge';
            badge.textContent = 'MCP';
            name.appendChild(badge);
            if (t.server) {
              const serverRow = document.createElement('span');
              serverRow.className = 'chatgml-mcp-server-row';
              serverRow.textContent = ' (' + t.server + ')';
              name.appendChild(serverRow);
            }
          }
          if (t.autoApprove) {
            const badge = document.createElement('span');
            badge.className = 'chatgml-tool-auto';
            badge.textContent = 'auto';
            name.appendChild(badge);
          }
          const desc = document.createElement('span');
          desc.className = 'chatgml-tool-desc';
          const d = String(t.description || '');
          desc.textContent = d.length > 120 ? d.slice(0, 120) + '…' : d;
          row.appendChild(kind);
          row.appendChild(name);
          if (desc.textContent !== '') {
            const sep = document.createElement('span');
            sep.textContent = ' — ';
            row.appendChild(sep);
            row.appendChild(desc);
          }
          this.catalogEl.appendChild(row);
        }
      }
    }

    // Trim notice: shown only when the reducer's eviction counters are > 0. We render a single
    // composed sentence ("⚠ Showing last N turns (X trimmed from earlier history)" + an
    // optional activity phrase) so a user can see at a glance how much of the session is missing
    // without leaving the panel. Text content is set via textContent (never innerHTML) — these
    // counters are integers so XSS is impossible, but the project rule is textContent only.
    if (this.trimNoticeEl) {
      var turnCap = State.TURN_CAP || 200;
      var actCap = State.ACTIVITY_CAP || 500;
      var turnEvicted = s.turnsEvicted | 0;
      var actEvicted = s.activityEvicted | 0;
      if (turnEvicted > 0 || actEvicted > 0) {
        var parts = [];
        if (turnEvicted > 0) {
          parts.push(
            '⚠ Showing last ' +
              turnCap +
              ' turns (' +
              turnEvicted +
              ' trimmed from earlier history)',
          );
        }
        if (actEvicted > 0) {
          parts.push(
            'activity log capped at ' + actCap + ' (' + actEvicted + ' older entries dropped)',
          );
        }
        this.trimNoticeEl.textContent = parts.join(' • ');
        this.trimNoticeEl.style.display = '';
      } else {
        this.trimNoticeEl.textContent = '';
        this.trimNoticeEl.style.display = 'none';
      }
    }

    // Transcript: render finalized turns as message bubbles; the in-flight `s.answer` (streaming)
    // is rendered as a streaming bubble while it accumulates. Falls back to the legacy flat
    // transcript text only when no turns and no answer are present (so a stale display survives
    // /clear's transient state).
    //
    // Incremental render: finalized turns (s.turns) are immutable once added, so we only append
    // NEW turns (those at index >= _renderedTurnsCount) instead of rebuilding the entire DOM on
    // every token event. The streaming bubble is updated in-place (its body element is reused).
    // This prevents O(n²) DOM creation on long conversations with many tokens.
    var MarkdownApi =
      typeof root !== 'undefined' && root.ChatGmlMarkdown
        ? root.ChatGmlMarkdown
        : typeof ChatGmlMarkdown !== 'undefined'
          ? ChatGmlMarkdown
          : null;
    var turns = s.turns || [];
    var hasStreamingAnswer = s.answer != null && String(s.answer).length > 0;

    // If turns were cleared (e.g. /clear), reset everything.
    if (turns.length < (this._renderedTurnsCount || 0)) {
      this.transcriptEl.innerHTML = '';
      this._renderedTurnsCount = 0;
      this._streamingBubbleEl = null;
      this._pendingBubbleEl = null;
      this._outboxBubbleEl = null;
      this._outboxRenderedIds = [];
    }

    // Pending user message (sent but not yet finalized into a turn) — shows immediately.
    //
    // OUTBOX-aware rendering: when the user has fired multiple sends before the first response
    // streams back, the reducer-managed `s.outbox` carries each one. We render them as a stack
    // of user bubbles, each marked with `chatgml-outbox-` classes so a future CSS worker can
    // dim/italicize queued entries without colliding with the `chatgml-session-` namespace.
    //
    // Backwards-compat: when outbox is empty we fall back to the legacy `pendingUserText`
    // single-bubble path so reducers / clients that haven't been updated still render. The
    // common case (single in-flight message) uses the legacy bubble so existing code keeps
    // working unchanged.
    var outbox = s.outbox || [];
    var hasPending = s.pendingUserText && String(s.pendingUserText).trim() !== '';
    if (outbox.length > 0) {
      // Drop any stale `_pendingBubbleEl` so the legacy single-bubble DOM doesn't sit on
      // top of the new outbox bubbles.
      if (this._pendingBubbleEl) {
        if (this._pendingBubbleEl.parentNode)
          this._pendingBubbleEl.parentNode.removeChild(this._pendingBubbleEl);
        this._pendingBubbleEl = null;
      }
      // Lazy-init the outbox DOM container if needed (sibling of, NOT replacing, the legacy
      // pending bubble DOM). We use a dedicated wrapper so an empty outbox can be cleanly
      // removed without disturbing the rest of the transcript.
      if (!this._outboxBubbleEl || this._outboxBubbleEl.parentNode !== this.transcriptEl) {
        var outboxWrap = document.createElement('div');
        outboxWrap.className = 'chatgml-outbox-bubbles';
        // Insert before the legacy pending bubble slot (if any) so the bubbles appear in
        // chronological order (sends above the streaming answer).
        this.transcriptEl.appendChild(outboxWrap);
        this._outboxBubbleEl = outboxWrap;
        this._outboxRenderedIds = [];
      }
      // Render each outbox entry once. If the id is already in _outboxRenderedIds we leave
      // the bubble alone (status changes are reflected via className swap only — see below).
      var seen = Object.create(null);
      for (var oi = 0; oi < outbox.length; oi++) {
        var entry = outbox[oi];
        var existingNode = null;
        var idx = this._outboxRenderedIds.indexOf(entry.id);
        if (idx !== -1) {
          existingNode = this._outboxBubbleEl.childNodes[idx] || null;
        } else {
          var bubble = document.createElement('div');
          var labelText = entry.status === 'queued' ? '⏳ Queued' : '✍ In flight';
          bubble.className =
            'chatgml-turn chatgml-turn-user chatgml-turn-outbox chatgml-outbox-status-' +
            entry.status;
          var label = document.createElement('div');
          label.className = 'chatgml-turn-label';
          label.textContent = 'You • ' + labelText;
          bubble.appendChild(label);
          var body = document.createElement('div');
          body.className = 'chatgml-turn-body chatgml-outbox-body';
          body.textContent = entry.text; // user text is plain text — never run markdown
          bubble.appendChild(body);
          this._outboxBubbleEl.appendChild(bubble);
          this._outboxRenderedIds.push(entry.id);
          existingNode = bubble;
        }
        // Idempotent status swap: queue/streaming/sent changes the wrapper class so a future
        // CSS worker can dim queued and highlight in-flight without rebuilding the bubble.
        if (existingNode) {
          existingNode.className =
            'chatgml-turn chatgml-turn-user chatgml-turn-outbox chatgml-outbox-status-' +
            entry.status;
        }
        seen[entry.id] = true;
      }
      // Drop outbox bubbles whose ids are no longer in state (turn_end shifted them off).
      var newIds = outbox.map(function (e) {
        return e.id;
      });
      // Prune _outboxRenderedIds to match current ids (preserve order).
      var filtered = [];
      for (var pi = 0; pi < this._outboxRenderedIds.length; pi++) {
        if (seen[this._outboxRenderedIds[pi]]) filtered.push(this._outboxRenderedIds[pi]);
      }
      // Remove any DOM children that no longer have a matching id (the array-index survives
      // pruning, so we can rekey).
      while (this._outboxBubbleEl.childNodes.length > outbox.length) {
        this._outboxBubbleEl.removeChild(this._outboxBubbleEl.lastChild);
      }
      this._outboxRenderedIds = newIds;
    } else if (hasPending) {
      // Drop the outbox wrapper so a /clear or empty outbox doesn't leave dangling DOM.
      if (this._outboxBubbleEl) {
        if (this._outboxBubbleEl.parentNode)
          this._outboxBubbleEl.parentNode.removeChild(this._outboxBubbleEl);
        this._outboxBubbleEl = null;
        this._outboxRenderedIds = [];
      }
      if (!this._pendingBubbleEl || this._pendingBubbleEl.parentNode !== this.transcriptEl) {
        var pendBubble = document.createElement('div');
        pendBubble.className = 'chatgml-turn chatgml-turn-user';
        var pendLabel = document.createElement('div');
        pendLabel.className = 'chatgml-turn-label';
        pendLabel.textContent = 'You';
        pendBubble.appendChild(pendLabel);
        var pendBody = document.createElement('div');
        pendBody.className = 'chatgml-turn-body';
        pendBubble.appendChild(pendBody);
        this.transcriptEl.appendChild(pendBubble);
        this._pendingBubbleEl = pendBubble;
      }
      this._pendingBubbleEl.querySelector('.chatgml-turn-body').textContent = s.pendingUserText;
    } else {
      // No outbox and no pending text — drop both legacy and outbox DOM.
      if (this._pendingBubbleEl) {
        if (this._pendingBubbleEl.parentNode)
          this._pendingBubbleEl.parentNode.removeChild(this._pendingBubbleEl);
        this._pendingBubbleEl = null;
      }
      if (this._outboxBubbleEl) {
        if (this._outboxBubbleEl.parentNode)
          this._outboxBubbleEl.parentNode.removeChild(this._outboxBubbleEl);
        this._outboxBubbleEl = null;
        this._outboxRenderedIds = [];
      }
    }

    // Append only NEW finalized turns (those not yet rendered as DOM nodes).
    if (turns.length > (this._renderedTurnsCount || 0)) {
      for (var ti = this._renderedTurnsCount || 0; ti < turns.length; ti++) {
        var turn = turns[ti];
        if (turn.userText && String(turn.userText).trim() !== '') {
          var userBubble = document.createElement('div');
          userBubble.className = 'chatgml-turn chatgml-turn-user';
          var userLabel = document.createElement('div');
          userLabel.className = 'chatgml-turn-label';
          userLabel.textContent = 'You';
          userBubble.appendChild(userLabel);
          var userBody = document.createElement('div');
          userBody.className = 'chatgml-turn-body';
          // User text is treated as plain text — never run markdown on what the user typed.
          userBody.textContent = turn.userText;
          userBubble.appendChild(userBody);
          this.transcriptEl.appendChild(userBubble);
        }
        if (turn.assistantText && String(turn.assistantText).trim() !== '') {
          var asstBubble = document.createElement('div');
          asstBubble.className = 'chatgml-turn chatgml-turn-assistant';
          var asstLabel = document.createElement('div');
          asstLabel.className = 'chatgml-turn-label';
          var tierBadge = null;
          if (turn.tier === 'planner' || turn.tier === 'implementer' || turn.tier === 'reviewer') {
            // Three short labels mirror the Cline Plan/Act affordance: "planner" reads as a
            // think-first role, "implementer" as code-action, "reviewer" as a self-check pass.
            // The emoji prefix + the per-tier class is the visual hook; see style.css.
            var tierGlyph =
              turn.tier === 'planner' ? '🧠' : turn.tier === 'implementer' ? '⚙' : '🔍';
            tierBadge = document.createElement('span');
            tierBadge.className = 'chatgml-turn-tier chatgml-turn-tier-' + turn.tier;
            tierBadge.textContent = tierGlyph + ' ' + turn.tier;
            tierBadge.title = 'This turn used the ' + turn.tier + ' tier lane';
          }
          asstLabel.textContent = 'Assistant';
          asstBubble.appendChild(asstLabel);
          if (tierBadge) asstBubble.appendChild(tierBadge);
          var asstBody = document.createElement('div');
          asstBody.className = 'chatgml-turn-body chatgml-md-body';
          if (MarkdownApi && typeof MarkdownApi.renderMarkdown === 'function') {
            try {
              MarkdownApi.renderMarkdown(turn.assistantText, asstBody);
            } catch (e) {
              asstBody.textContent = turn.assistantText;
            }
          } else {
            asstBody.textContent = turn.assistantText;
          }
          asstBubble.appendChild(asstBody);
          this.transcriptEl.appendChild(asstBubble);
        }
      }
      this._renderedTurnsCount = turns.length;
    }

    // Streaming bubble: update in-place if it exists, create if needed, remove if no answer.
    if (hasStreamingAnswer) {
      if (!this._streamingBubbleEl || this._streamingBubbleEl.parentNode !== this.transcriptEl) {
        var streamBubble = document.createElement('div');
        streamBubble.className = 'chatgml-turn chatgml-turn-assistant chatgml-turn-streaming';
        var streamLabel = document.createElement('div');
        streamLabel.className = 'chatgml-turn-label';
        streamLabel.textContent = 'Assistant';
        streamBubble.appendChild(streamLabel);
        // Mirror the active tier on the streaming bubble so the user can see which lane is
        // producing the tokens. When the override is null we render NO badge (auto-dispatch).
        if (
          this.tierOverride === 'planner' ||
          this.tierOverride === 'implementer' ||
          this.tierOverride === 'reviewer'
        ) {
          var sGlyph =
            this.tierOverride === 'planner'
              ? '🧠'
              : this.tierOverride === 'implementer'
                ? '⚙'
                : '🔍';
          var sBadge = document.createElement('span');
          sBadge.className = 'chatgml-turn-tier chatgml-turn-tier-' + this.tierOverride;
          sBadge.textContent = sGlyph + ' ' + this.tierOverride;
          sBadge.title = 'This turn is using the ' + this.tierOverride + ' tier lane';
          streamBubble.appendChild(sBadge);
        }
        var streamBody = document.createElement('div');
        streamBody.className = 'chatgml-turn-body chatgml-md-body';
        streamBubble.appendChild(streamBody);
        this.transcriptEl.appendChild(streamBubble);
        this._streamingBubbleEl = streamBubble;
      }
      var sb = this._streamingBubbleEl.querySelector('.chatgml-turn-body');
      if (MarkdownApi && typeof MarkdownApi.renderMarkdown === 'function') {
        try {
          MarkdownApi.renderMarkdown(s.answer, sb);
        } catch (e) {
          sb.textContent = s.answer;
        }
      } else {
        sb.textContent = s.answer;
      }
    } else if (this._streamingBubbleEl) {
      // Streaming done — remove the streaming bubble (the turn is now in s.turns).
      if (this._streamingBubbleEl.parentNode)
        this._streamingBubbleEl.parentNode.removeChild(this._streamingBubbleEl);
      this._streamingBubbleEl = null;
    }

    // Legacy fallback: if no turns and no streaming answer, show the raw transcript.
    if (turns.length === 0 && !hasStreamingAnswer && s.transcript) {
      var existingFallback = this.transcriptEl.querySelector('.chatgml-transcript-legacy');
      if (!existingFallback) {
        var fallbackPre = document.createElement('pre');
        fallbackPre.className = 'chatgml-transcript-legacy';
        fallbackPre.textContent = s.transcript;
        this.transcriptEl.appendChild(fallbackPre);
      }
    }

    // Auto-scroll only if the user was near the bottom (prevents yanking them back while reading).
    if (wasNearBottom) this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;

    // Sources.
    this.sourcesEl.innerHTML = '';
    if (s.sources && s.sources.length > 0) {
      const title = document.createElement('div');
      title.className = 'chatgml-sources-title';
      title.textContent = 'Sources:';
      this.sourcesEl.appendChild(title);
      for (let j = 0; j < s.sources.length; j++) {
        const src = s.sources[j];
        const row = document.createElement('div');
        row.className = 'chatgml-source';
        row.textContent = src.path || src.snippet || '(memory)';
        if (src.path) {
          row.style.cursor = 'pointer';
          row.title = 'Click to open: ' + src.path;
          row.addEventListener('click', function () {
            if (typeof self.opts.onOpenSource === 'function') self.opts.onOpenSource(src);
          });
        }
        this.sourcesEl.appendChild(row);
      }
    }

    // Error.
    if (s.error) {
      const err = document.createElement('div');
      err.className = 'chatgml-error';
      err.textContent = 'error: ' + s.error;
      this.statusEl.appendChild(err);
    }

    // Stop-button visibility: show while the agent is actively working (streaming answer or a
    // tool/command is running or awaiting approval). Re-evaluated on every render so a state
    // change during a turn flips the button without an extra round-trip.
    var isWorking =
      (s.answer != null && String(s.answer).length > 0) ||
      s.activity.some(function (a) {
        return a.status === 'running' || a.status === 'waiting';
      });
    if (this.stopGenBtn) this.stopGenBtn.style.display = isWorking ? '' : 'none';

    // Hook copy buttons onto any newly rendered code blocks (idempotent).
    this._addCopyButtons();
  };

  /**
   * Add a "Copy" button to every markdown code block in the transcript. Idempotent: blocks that
   * already have a copy button (marked with .chatgml-copy-btn-added) are skipped. Each button
   * copies the textContent of the inner <code> (or the pre itself when no <code> child exists) to
   * the clipboard, then briefly flips its label to a checkmark before resetting.
   */
  ChatPanel.prototype._addCopyButtons = function () {
    var blocks = this.transcriptEl.querySelectorAll(
      'pre.chatgml-md-code-block:not(.chatgml-copy-btn-added)',
    );
    for (var i = 0; i < blocks.length; i++) {
      (function (block) {
        block.classList.add('chatgml-copy-btn-added');
        var btn = document.createElement('button');
        btn.className = 'chatgml-copy-btn';
        btn.textContent = 'Copy';
        btn.style.cssText =
          'position:absolute; top:4px; right:4px; font-size:10px; padding:2px 8px; cursor:pointer; ' +
          'background:var(--chatgml-surface-2); color:var(--chatgml-fg); border:1px solid ' +
          'var(--chatgml-border); border-radius:3px; opacity:0; transition:opacity 0.15s;';
        block.style.position = 'relative';
        block.addEventListener('mouseenter', function () {
          btn.style.opacity = '1';
        });
        block.addEventListener('mouseleave', function () {
          btn.style.opacity = '0';
        });
        btn.addEventListener('click', function () {
          var code = block.querySelector('code');
          var text = code ? code.textContent : block.textContent;
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text);
              btn.textContent = '✓';
              setTimeout(function () {
                btn.textContent = 'Copy';
              }, 1500);
            }
          } catch (e) {
            /* ignore */
          }
        });
        block.appendChild(btn);
      })(blocks[i]);
    }
  };

  const api = { ChatPanel: ChatPanel };
  root.ChatGmlPanel = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
