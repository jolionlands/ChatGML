// plugin/diff-view.js — EditProposalView: render a gated edit's unified diff with Approve/Reject
// buttons wired to the proposal id. Pure DOM glue (visual layout is manual-only); the correlation
// logic (matchApproval) lives in plugin/state.js and is unit-tested headless.
(function (root) {
  'use strict';

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container
   * @param {(id:string)=>void} opts.onApprove
   * @param {(id:string)=>void} opts.onReject
   */
  function EditProposalView(opts) {
    this.container = opts.container;
    this.onApprove = opts.onApprove;
    this.onReject = opts.onReject;
    this.elements = new Map(); // id -> root element
  }

  /** Classify a unified-diff line for styling. */
  function diffLineClass(line) {
    if (line.startsWith('+') && !line.startsWith('+++')) return 'chatgml-diff-add';
    if (line.startsWith('-') && !line.startsWith('---')) return 'chatgml-diff-del';
    if (line.startsWith('@@')) return 'chatgml-diff-hunk';
    return 'chatgml-diff-ctx';
  }

  /** Show (or update) a proposal. proposal = { id, path, diff }. */
  EditProposalView.prototype.show = function (proposal) {
    const self = this;
    let el = this.elements.get(proposal.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'chatgml-proposal';
      this.elements.set(proposal.id, el);
      this.container.appendChild(el);
    }
    el.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'chatgml-proposal-header';
    header.textContent = 'Proposed edit: ' + proposal.path;
    el.appendChild(header);

    const pre = document.createElement('pre');
    pre.className = 'chatgml-diff';
    const lines = String(proposal.diff || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const span = document.createElement('span');
      span.className = diffLineClass(lines[i]);
      span.textContent = lines[i] + '\n';
      pre.appendChild(span);
    }
    el.appendChild(pre);

    const actions = document.createElement('div');
    actions.className = 'chatgml-proposal-actions';

    const approveBtn = document.createElement('button');
    approveBtn.className = 'run-button';
    approveBtn.textContent = 'Approve';
    approveBtn.addEventListener('click', function () {
      self.onApprove(proposal.id);
      self.resolve(proposal.id, 'approved');
    });

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'run-button chatgml-reject';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', function () {
      self.onReject(proposal.id);
      self.resolve(proposal.id, 'rejected');
    });

    actions.appendChild(approveBtn);
    actions.appendChild(rejectBtn);
    el.appendChild(actions);
  };

  /** Mark a proposal resolved (disable buttons, annotate) after approve/reject is sent. */
  EditProposalView.prototype.resolve = function (id, outcome) {
    const el = this.elements.get(id);
    if (!el) return;
    const buttons = el.querySelectorAll('button');
    for (let i = 0; i < buttons.length; i++) buttons[i].setAttribute('disabled', 'disabled');
    const note = document.createElement('div');
    note.className = 'chatgml-proposal-note';
    note.textContent = outcome === 'approved' ? 'Approved' : 'Rejected';
    el.appendChild(note);
  };

  EditProposalView.prototype.clear = function () {
    for (const el of this.elements.values()) {
      if (el.parentElement) el.parentElement.removeChild(el);
    }
    this.elements.clear();
  };

  const api = { EditProposalView: EditProposalView, diffLineClass: diffLineClass };
  root.ChatGmlDiffView = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
