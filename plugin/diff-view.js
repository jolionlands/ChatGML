// plugin/diff-view.js — EditProposalView: render a gated edit's diff split into blocks/hunks with
// Approve/Reject buttons wired to the proposal id. Pure DOM glue (visual layout is manual-only);
// the correlation logic (matchApproval) lives in plugin/state.js and is unit-tested headless.
(function (root) {
  'use strict';

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container
   * @param {(id:string, blockIndex?:number)=>void} opts.onApprove
   * @param {(id:string, blockIndex?:number)=>void} opts.onReject
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

  /**
   * Split a diff into blocks/hunks.
   *
   * Each block has:
   *   header: string (e.g. "@@ -10,3 +10,4 @@" or "<<<<<<< SEARCH")
   *   lines:  array of { cls: 'chatgml-diff-add'|'chatgml-diff-del'|'chatgml-diff-hunk'|'chatgml-diff-ctx', text }
   *   searchText / replaceText: string[] for SEARCH/REPLACE blocks; for unified hunks they are
   *                             derived from context/add/delete lines.
   */
  function parseDiffBlocks(diffText) {
    var blocks = [];
    var lines = String(diffText || '').split('\n');
    var current = null;

    function flushCurrent() {
      if (!current) return;
      if (current.header.indexOf('@@') === 0 && !current.searchText) {
        current.searchText = [];
        current.replaceText = [];
        for (var j = 0; j < current.lines.length; j++) {
          var ln = current.lines[j];
          if (ln.cls === 'chatgml-diff-del' || ln.cls === 'chatgml-diff-ctx')
            current.searchText.push(ln.text);
          if (ln.cls === 'chatgml-diff-add' || ln.cls === 'chatgml-diff-ctx')
            current.replaceText.push(ln.text);
        }
      }
      blocks.push(current);
      current = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var isSearchStart = line.indexOf('<<<<<<< SEARCH') === 0;
      var isSeparator = line.indexOf('=======') === 0;
      var isReplaceEnd = line.indexOf('>>>>>>> REPLACE') === 0;
      var isHunk = line.indexOf('@@') === 0;
      var isFileHeader = line.indexOf('---') === 0 || line.indexOf('+++') === 0;

      if (isSearchStart || isHunk || isFileHeader) {
        flushCurrent();
        current = {
          header: line,
          lines: [],
          searchText: isSearchStart ? [] : null,
          replaceText: isSearchStart ? [] : null,
          srMode: isSearchStart ? 'search' : null,
        };
        current.lines.push({
          cls: isHunk ? 'chatgml-diff-hunk' : 'chatgml-diff-ctx',
          text: line,
        });
        continue;
      }

      if (!current) {
        current = {
          header: '',
          lines: [],
          searchText: null,
          replaceText: null,
          srMode: null,
        };
      }

      if (current.searchText) {
        if (isSeparator) {
          current.srMode = 'replace';
          current.lines.push({ cls: 'chatgml-diff-hunk', text: line });
          continue;
        }
        if (isReplaceEnd) {
          current.srMode = null;
          current.lines.push({ cls: 'chatgml-diff-hunk', text: line });
          continue;
        }
        if (current.srMode === 'search') current.searchText.push(line);
        else if (current.srMode === 'replace') current.replaceText.push(line);
      }

      current.lines.push({ cls: diffLineClass(line), text: line });
    }

    flushCurrent();
    return blocks;
  }

  /** Show (or update) a proposal. proposal = { id, path, diff }. */
  EditProposalView.prototype.show = function (proposal) {
    var self = this;
    var el = this.elements.get(proposal.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'chatgml-proposal';
      this.elements.set(proposal.id, el);
      this.container.appendChild(el);
    }
    el.innerHTML = '';

    var header = document.createElement('div');
    header.className = 'chatgml-proposal-header';
    header.textContent = 'Proposed edit: ' + proposal.path;
    el.appendChild(header);

    function makeButton(label, isReject, blockIndex) {
      var btn = document.createElement('button');
      btn.className = 'run-button' + (isReject ? ' chatgml-reject' : '');
      btn.textContent = label;
      btn.addEventListener('click', function () {
        if (isReject) {
          self.onReject(proposal.id, blockIndex);
        } else {
          self.onApprove(proposal.id, blockIndex);
        }
        if (blockIndex === undefined) self.resolve(proposal.id, isReject ? 'rejected' : 'approved');
      });
      return btn;
    }

    var blocks = parseDiffBlocks(proposal.diff);
    for (var bi = 0; bi < blocks.length; bi++) {
      var block = blocks[bi];
      var blockEl = document.createElement('div');
      blockEl.className = 'chatgml-diff-block';

      if (block.header) {
        var blockHeader = document.createElement('div');
        blockHeader.className = 'chatgml-diff-block-header';
        blockHeader.textContent = block.header;
        blockEl.appendChild(blockHeader);
      }

      var pre = document.createElement('pre');
      pre.className = 'chatgml-diff';
      for (var li = 0; li < block.lines.length; li++) {
        var line = block.lines[li];
        var span = document.createElement('span');
        span.className = line.cls;
        span.textContent = line.text + '\n';
        pre.appendChild(span);
      }
      blockEl.appendChild(pre);

      var blockActions = document.createElement('div');
      blockActions.className = 'chatgml-diff-block-actions';
      blockActions.appendChild(makeButton('Approve block', false, bi));
      blockActions.appendChild(makeButton('Reject block', true, bi));
      blockEl.appendChild(blockActions);

      el.appendChild(blockEl);
    }

    var wholeActions = document.createElement('div');
    wholeActions.className = 'chatgml-proposal-actions';
    wholeActions.appendChild(makeButton('Approve all', false));
    wholeActions.appendChild(makeButton('Reject all', true));
    el.appendChild(wholeActions);
  };

  /** Mark a proposal resolved (disable buttons, annotate) after approve/reject is sent. */
  EditProposalView.prototype.resolve = function (id, outcome) {
    var el = this.elements.get(id);
    if (!el) return;
    var buttons = el.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute('disabled', 'disabled');
    var note = document.createElement('div');
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

  var api = {
    EditProposalView: EditProposalView,
    diffLineClass: diffLineClass,
    parseDiffBlocks: parseDiffBlocks,
  };
  root.ChatGmlDiffView = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
