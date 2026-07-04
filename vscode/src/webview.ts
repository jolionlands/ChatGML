// vscode/src/webview.ts - generate the webview HTML. The webview is PURELY presentational: it
// receives reduced PluginState from the extension host and posts user commands back.
import * as vscode from 'vscode';

export interface PendingProposalView {
  id: string;
  path: string;
  diff: string;
  settled?: 'approved' | 'rejected';
}

export interface WebviewState {
  phase: string;
  running: boolean;
  transcript: string;
  answer: string | null;
  sources: Array<{ path?: string; snippet?: string; provider?: string }>;
  activity: Array<{ id: string; name: string; status: 'running' | 'ok' | 'error' }>;
  pendingProposals: PendingProposalView[];
  config: { scope?: string; model?: string; approval?: string } | null;
  flash: { text: string; isError: boolean; ts: number } | null;
  error: string | null;
}

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = Math.random().toString(36).slice(2);
  void extensionUri;
  void webview;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px; line-height: 1.35; margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  .app { min-height: 100vh; display: flex; flex-direction: column; gap: 10px; padding: 10px; }
  .topbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .brand { min-width: 0; }
  .title { font-size: 12px; font-weight: 700; text-transform: uppercase; color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground)); }
  .subtitle { margin-top: 2px; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .toolbar, .row, .chips, .quick, .sources { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  button { background: var(--vscode-button-secondaryBackground, var(--vscode-toolbar-hoverBackground)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-button-border, transparent); padding: 4px 9px; min-height: 26px; border-radius: 3px; cursor: pointer; font: inherit; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.danger { background: var(--vscode-errorForeground, #b23b3b); color: var(--vscode-button-foreground, #fff); }
  .statusbar { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border)); background: var(--vscode-sideBarSectionHeader-background, transparent); border-radius: 4px; }
  .status { min-width: 0; color: var(--vscode-descriptionForeground); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-testing-iconQueued, #cca700); flex: 0 0 auto; }
  .dot.running { background: var(--vscode-testing-iconPassed, #73c991); }
  .dot.error { background: var(--vscode-testing-iconFailed, #f48771); }
  .chip { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); border-radius: 3px; padding: 2px 6px; }
  .quick button { font-size: 12px; padding: 3px 7px; }
  .section-title { margin: 4px 0 -4px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  .activity { display: grid; gap: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .activity-row { padding: 4px 6px; border-left: 2px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background, transparent); }
  .activity-row.running { border-left-color: var(--vscode-progressBar-background, #0e70c0); }
  .activity-row.error { color: var(--vscode-errorForeground, #b23b3b); }
  .transcript { white-space: pre-wrap; overflow-y: auto; min-height: 140px; flex: 1 1 auto; border: 1px solid var(--vscode-panel-border, #555); padding: 10px; border-radius: 4px; background: var(--vscode-editor-background); }
  .empty { color: var(--vscode-descriptionForeground); }
  .source { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 6px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; background: var(--vscode-editorWidget-background, transparent); }
  .proposal { border: 1px solid var(--vscode-panel-border, #555); border-radius: 4px; padding: 8px; margin: 6px 0; background: var(--vscode-editorWidget-background, transparent); }
  .proposal-header { font-weight: 700; overflow-wrap: anywhere; }
  .diff { white-space: pre; overflow: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; margin: 6px 0; padding: 6px; background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background)); border-radius: 3px; }
  .diff-add { background: rgba(80,200,80,0.18); display: block; }
  .diff-del { background: rgba(200,80,80,0.18); display: block; }
  .diff-hunk { color: var(--vscode-textLink-foreground, #3794ff); display: block; }
  .diff-ctx { display: block; }
  .proposal-note { font-style: italic; opacity: 0.8; }
  .flash { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre-wrap; padding: 6px 8px; margin-top: 8px; border-left: 3px solid var(--vscode-textLink-foreground, #3794ff); background: var(--vscode-editorWidget-background, transparent); }
  .flash.error { border-left-color: #b23b3b; background: rgba(178,59,59,0.08); color: #b23b3b; }
  .error { color: var(--vscode-errorForeground, #b23b3b); }
  .composer { border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; }
  #input { width: 100%; min-height: 78px; resize: vertical; background: var(--vscode-input-background, #1e1e1e); color: var(--vscode-input-foreground, #fff); border: 1px solid var(--vscode-input-border, #444); border-radius: 3px; padding: 7px; font: inherit; }
  #input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .sendbar { display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end; }
  .sendbar #send { white-space: nowrap; }
</style>
</head>
<body>
  <div class="app">
    <div class="topbar">
      <div class="brand">
        <div class="title">ChatGML</div>
        <div class="subtitle">coding agent for GameMaker projects</div>
      </div>
      <div class="toolbar">
        <button id="launch" class="primary">Launch</button>
        <button id="reindex" disabled>Reindex</button>
      </div>
    </div>
    <div class="statusbar">
      <span id="dot" class="dot"></span>
      <div id="status" class="status">stopped</div>
    </div>
    <div id="chips" class="chips"></div>
    <div class="quick" aria-label="Prompt shortcuts">
      <button data-prompt="Review the current file for bugs and risky changes.">Review</button>
      <button data-prompt="Explain the current file and the important symbols it defines.">Explain</button>
      <button data-prompt="Find the smallest safe fix for the current problem.">Fix</button>
      <button data-prompt="/help">Commands</button>
    </div>
    <div class="section-title">Activity</div>
    <div id="activity" class="activity"></div>
    <div class="section-title">Chat</div>
    <div id="transcript" class="transcript"></div>
    <div class="section-title">Sources</div>
    <div id="sources" class="sources"></div>
    <div id="proposals"></div>
    <div class="composer">
      <textarea id="input" placeholder="Ask about this project... Enter sends, Shift+Enter adds a line"></textarea>
      <div class="sendbar"><button id="send" class="primary" disabled>Send</button></div>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const elLaunch = $('launch'), elReindex = $('reindex'), elStatus = $('status'), elDot = $('dot'), elChips = $('chips');
  const elActivity = $('activity'), elTranscript = $('transcript'), elSources = $('sources');
  const elProposals = $('proposals'), elInput = $('input'), elSend = $('send');

  function diffLineClass(line) {
    if (line.startsWith('+++') || line.startsWith('---')) return 'diff-ctx';
    if (line.startsWith('+')) return 'diff-add';
    if (line.startsWith('-')) return 'diff-del';
    if (line.startsWith('@@')) return 'diff-hunk';
    return 'diff-ctx';
  }

  function render(s) {
    elLaunch.textContent = s.running ? 'Stop' : 'Launch';
    elLaunch.className = s.running ? '' : 'primary';
    elReindex.disabled = !s.running;
    elStatus.textContent = s.running ? ('phase: ' + s.phase) : 'stopped';
    elDot.className = 'dot' + (s.error ? ' error' : s.running ? ' running' : '');

    elChips.innerHTML = '';
    if (s.config) {
      const chips = [];
      if (s.config.scope) chips.push('scope: ' + s.config.scope);
      if (s.config.model) chips.push('model: ' + s.config.model);
      if (s.config.approval) chips.push('approval: ' + s.config.approval);
      for (const c of chips) {
        const d = document.createElement('span');
        d.className = 'chip';
        d.textContent = c;
        elChips.appendChild(d);
      }
    }

    elActivity.innerHTML = '';
    for (const a of s.activity || []) {
      const row = document.createElement('div');
      row.className = 'activity-row ' + a.status;
      row.textContent = a.name + ' - ' + a.status;
      elActivity.appendChild(row);
    }

    elTranscript.textContent = s.answer != null ? s.answer : s.transcript;
    if (!elTranscript.textContent.trim()) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = s.running ? 'Ask for a review, edit, explanation, or search.' : 'Launch ChatGML to start an agent session.';
      elTranscript.appendChild(empty);
    }

    elSources.innerHTML = '';
    for (const src of s.sources || []) {
      const d = document.createElement('div');
      d.className = 'source';
      d.textContent = src.path || src.snippet || '(memory)';
      elSources.appendChild(d);
    }

    elProposals.innerHTML = '';
    for (const p of s.pendingProposals || []) {
      const wrap = document.createElement('div');
      wrap.className = 'proposal';
      const h = document.createElement('div');
      h.className = 'proposal-header';
      h.textContent = 'Proposed edit: ' + p.path;
      wrap.appendChild(h);
      const pre = document.createElement('pre');
      pre.className = 'diff';
      for (const line of String(p.diff || '').split('\\n')) {
        const sp = document.createElement('span');
        sp.className = diffLineClass(line);
        sp.textContent = line + '\\n';
        pre.appendChild(sp);
      }
      wrap.appendChild(pre);
      const acts = document.createElement('div');
      acts.className = 'row';
      const ap = document.createElement('button');
      ap.className = 'primary';
      ap.textContent = 'Approve';
      ap.disabled = !!p.settled;
      ap.onclick = () => vscode.postMessage({ type: 'approve', id: p.id });
      const rj = document.createElement('button');
      rj.className = 'danger';
      rj.textContent = 'Reject';
      rj.disabled = !!p.settled;
      rj.onclick = () => vscode.postMessage({ type: 'reject', id: p.id });
      acts.appendChild(ap);
      acts.appendChild(rj);
      wrap.appendChild(acts);
      if (p.settled) {
        const n = document.createElement('div');
        n.className = 'proposal-note';
        n.textContent = p.settled === 'approved' ? 'Approved' : 'Rejected';
        wrap.appendChild(n);
      }
      elProposals.appendChild(wrap);
    }

    if (s.flash) {
      const f = document.createElement('div');
      f.className = 'flash' + (s.flash.isError ? ' error' : '');
      f.textContent = s.flash.text;
      elTranscript.appendChild(f);
      elTranscript.scrollTop = elTranscript.scrollHeight;
    }
    if (s.error) {
      const e = document.createElement('div');
      e.className = 'error';
      e.textContent = 'error: ' + s.error;
      elStatus.appendChild(e);
    }
    elSend.disabled = !s.running;
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg && msg.kind === 'state') render(msg.state);
  });

  function submit() {
    const text = elInput.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'input', text });
    elInput.value = '';
  }

  elSend.addEventListener('click', submit);
  elInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  for (const btn of document.querySelectorAll('[data-prompt]')) {
    btn.addEventListener('click', () => {
      elInput.value = btn.getAttribute('data-prompt') || '';
      submit();
    });
  }
  elLaunch.addEventListener('click', () => vscode.postMessage({ type: 'launch' }));
  elReindex.addEventListener('click', () => vscode.postMessage({ type: 'reindex' }));
</script>
</body>
</html>`;
}
