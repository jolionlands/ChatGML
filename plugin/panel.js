// plugin/panel.js — ChatPanel: the side-panel DOM. Renders transcript / activity / status / answer
// from the reducePluginState projection (plugin/state.js) and surfaces Launch/Stop, Send, Reindex
// controls + the EditProposalView. Pure DOM glue (visual layout manual-only); ALL protocol/state
// logic lives in plugin/state.js and is unit-tested headless.
(function (root) {
  'use strict';

  const State = root.ChatGmlState || require('./state.js');
  const DiffView = root.ChatGmlDiffView || require('./diff-view.js');

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container
   * @param {(text:string)=>void} opts.onSend
   * @param {()=>void} opts.onReindex
   * @param {()=>void} opts.onLaunch
   * @param {()=>void} opts.onStop
   * @param {(id:string)=>void} opts.onApprove
   * @param {(id:string)=>void} opts.onReject
   */
  function ChatPanel(opts) {
    this.opts = opts;
    this.state = State.initialPluginState();
    this.running = false;
    this._build();
  }

  ChatPanel.prototype._build = function () {
    const self = this;
    const c = this.opts.container;
    c.classList.add('chatgml-panel');

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

    controls.appendChild(this.launchBtn);
    controls.appendChild(this.reindexBtn);
    c.appendChild(controls);

    // Status line.
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'chatgml-status';
    this.statusEl.textContent = 'stopped';
    c.appendChild(this.statusEl);

    // Activity (tool calls).
    this.activityEl = document.createElement('div');
    this.activityEl.className = 'chatgml-activity';
    c.appendChild(this.activityEl);

    // Transcript (streamed tokens) + final answer.
    this.transcriptEl = document.createElement('pre');
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
      onApprove: function (id) {
        self.opts.onApprove(id);
      },
      onReject: function (id) {
        self.opts.onReject(id);
      },
    });

    // Input row.
    const inputRow = document.createElement('div');
    inputRow.className = 'chatgml-input-row';
    this.inputEl = document.createElement('textarea');
    this.inputEl.className = 'chatgml-input';
    this.inputEl.setAttribute('placeholder', 'Ask about this project…');
    this.sendBtn = document.createElement('button');
    this.sendBtn.className = 'run-button';
    this.sendBtn.textContent = 'Send';
    this.sendBtn.addEventListener('click', function () {
      const text = self.inputEl.value.trim();
      if (text) {
        self.opts.onSend(text);
        self.inputEl.value = '';
      }
    });
    this.sendBtn.setAttribute('disabled', 'disabled');
    inputRow.appendChild(this.inputEl);
    inputRow.appendChild(this.sendBtn);
    c.appendChild(inputRow);
  };

  /** Apply one AgentEvent: reduce state, then re-render. */
  ChatPanel.prototype.handleEvent = function (event) {
    this.state = State.reducePluginState(event, this.state);
    if (event.type === 'edit_proposal') {
      const proposal = this.state.pendingProposals.get(event.id);
      if (proposal) this.diffView.show(proposal);
    }
    this.render();
  };

  ChatPanel.prototype.setRunning = function (running) {
    this.running = running;
    this.launchBtn.textContent = running ? 'Stop' : 'Launch';
    if (!running) {
      this.state = State.initialPluginState();
      this.sendBtn.setAttribute('disabled', 'disabled');
      this.reindexBtn.setAttribute('disabled', 'disabled');
      this.diffView.clear();
    }
    this.render();
  };

  /** Called once the ready handshake arrives: enable Send + Reindex. */
  ChatPanel.prototype.setReady = function () {
    this.sendBtn.removeAttribute('disabled');
    this.reindexBtn.removeAttribute('disabled');
  };

  /** Mark a proposal resolved in the diff view after approve/reject is sent. */
  ChatPanel.prototype.settleProposal = function (id, outcome) {
    this.diffView.resolve(id, outcome);
    this.state = State.settleProposal(id, this.state);
  };

  ChatPanel.prototype.render = function () {
    const s = this.state;
    this.statusEl.textContent = this.running ? 'phase: ' + s.phase : 'stopped';

    // Activity.
    this.activityEl.innerHTML = '';
    for (let i = 0; i < s.activity.length; i++) {
      const a = s.activity[i];
      const row = document.createElement('div');
      row.className = 'chatgml-activity-row chatgml-activity-' + a.status;
      row.textContent = a.name + ' — ' + a.status;
      this.activityEl.appendChild(row);
    }

    // Transcript / answer.
    this.transcriptEl.textContent = s.answer != null ? s.answer : s.transcript;

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
  };

  const api = { ChatPanel: ChatPanel };
  root.ChatGmlPanel = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
