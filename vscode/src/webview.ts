// vscode/src/webview.ts — generate the webview HTML. The webview is PURELY presentational: it
// receives the already-reduced PluginState + pending proposals + a flash string via
// acquireVsCodeApi().postMessage (host -> webview), and sends user input + slash commands +
// approve/reject back to the host via vscode.postMessage (webview -> host). ALL protocol/state logic
// lives in the host (which reuses plugin/state.js), so the webview is a thin DOM renderer and can
// never drift from the GMEdit plugin's reducer.
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
  void extensionUri; // resources would be served via webview.asWebviewUri; none bundled here.
  void webview;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px; margin: 0; padding: 6px; box-sizing: border-box; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .row { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; }
  button { background: var(--vscode-button-background, #4caf50); color: var(--vscode-button-foreground, #fff); border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
  button:hover:not(:disabled) { filter: brightness(1.1); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.danger { background: var(--vscode-errorForeground, #b23b3b); }
  .status { font-style: italic; opacity: 0.8; margin: 2px 0 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
  .chip { font-family: monospace; font-size: 11px; background: rgba(106,126,192,0.16); border: 1px solid rgba(106,126,192,0.4); border-radius: 3px; padding: 1px 5px; }
  .activity { font-family: monospace; font-size: 12px; }
  .activity-row.running { opacity: 0.7; }
  .activity-row.error { color: var(--vscode-errorForeground, #b23b3b); }
  .transcript { white-space: pre-wrap; overflow-y: auto; margin: 6px 0; min-height: 60px; flex: 1 1 auto; border: 1px solid var(--vscode-panel-border, #555); padding: 6px; border-radius: 3px; }
  .sources { margin: 4px 0; }
  .sources-title { font-weight: bold; }
  .source { font-family: monospace; font-size: 12px; opacity: 0.85; }
  .proposal { border: 1px solid var(--vscode-panel-border, #555); border-radius: 3px; padding: 4px; margin: 6px 0; }
  .proposal-header { font-weight: bold; }
  .diff { white-space: pre-wrap; font-family: monospace; font-size: 12px; margin: 4px 0; }
  .diff-add { background: rgba(80,200,80,0.18); display: block; }
  .diff-del { background: rgba(200,80,80,0.18); display: block; }
  .diff-hunk { color: #6a7ec0; display: block; }
  .diff-ctx { display: block; }
  .proposal-note { font-style: italic; opacity: 0.8; }
  .flash { font-family: monospace; font-size: 12px; white-space: pre-wrap; padding: 6px 8px; margin: 4px 0; border-left: 3px solid #6a7ec0; background: rgba(106,126,192,0.08); }
  .flash.error { border-left-color: #b23b3b; background: rgba(178,59,59,0.08); color: #b23b3b; }
  .error { color: var(--vscode-errorForeground, #b23b3b); }
  #input { width: 100%; min-height: 60px; box-sizing: border-box; resize: vertical; background: var(--vscode-input-background, #1e1e1e); color: var(--vscode-input-foreground, #fff); border: 1px solid var(--vscode-input-border, #444); border-radius: 2px; }
  #input::placeholder { font-style: italic; opacity: 0.7; }
  .sendbar { display: flex; gap: 6px; margin-top: 6px; }
  .sendbar #send { white-space: nowrap; }
</style>
</head>
<body>
  <div class="row">
    <button id="launch">Launch</button>
    <button id="reindex" disabled>Reindex</button>
  </div>
  <div id="chips" class="chips"></div>
  <div id="status" class="status">stopped</div>
  <div id="activity" class="activity"></div>
  <div id="transcript" class="transcript"></div>
  <div id="sources" class="sources"></div>
  <div id="proposals"></div>
  <textarea id="input" placeholder="Ask about this project… (type /help for commands, Enter to send, Shift+Enter for newline)"></textarea>
  <div class="sendbar"><button id="send" disabled>Send</button></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const elLaunch = $('launch'), elReindex = $('reindex'), elStatus = $('status'), elChips = $('chips');
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
    elReindex.disabled = !s.running;
    elStatus.textContent = s.running ? ('phase: ' + s.phase) : 'stopped';
    elChips.innerHTML = '';
    if (s.config) {
      const chips = [];
      if (s.config.scope) chips.push('scope: ' + s.config.scope);
      if (s.config.model) chips.push('model: ' + s.config.model);
      if (s.config.approval) chips.push('approval: ' + s.config.approval);
      for (const c of chips) { const d = document.createElement('span'); d.className='chip'; d.textContent=c; elChips.appendChild(d); }
    }
    elActivity.innerHTML = '';
    for (const a of s.activity || []) {
      const row = document.createElement('div'); row.className = 'activity-row ' + a.status;
      row.textContent = a.name + ' — ' + a.status; elActivity.appendChild(row);
    }
    elTranscript.textContent = s.answer != null ? s.answer : s.transcript;
    elSources.innerHTML = '';
    if (s.sources && s.sources.length) {
      const t = document.createElement('div'); t.className='sources-title'; t.textContent='Sources:'; elSources.appendChild(t);
      for (const src of s.sources) { const d = document.createElement('div'); d.className='source'; d.textContent = src.path || src.snippet || '(memory)'; elSources.appendChild(d); }
    }
    elProposals.innerHTML = '';
    for (const p of s.pendingProposals || []) {
      const wrap = document.createElement('div'); wrap.className='proposal';
      const h = document.createElement('div'); h.className='proposal-header'; h.textContent='Proposed edit: ' + p.path; wrap.appendChild(h);
      const pre = document.createElement('pre'); pre.className='diff';
      for (const line of String(p.diff||'').split('\\n')) { const sp = document.createElement('span'); sp.className=diffLineClass(line); sp.textContent=line+'\\n'; pre.appendChild(sp); }
      wrap.appendChild(pre);
      const acts = document.createElement('div'); acts.className='row';
      const ap = document.createElement('button'); ap.textContent='Approve'; ap.disabled = !!p.settled;
      ap.onclick = () => vscode.postMessage({ type:'approve', id:p.id });
      const rj = document.createElement('button'); rj.className='danger'; rj.textContent='Reject'; rj.disabled = !!p.settled;
      rj.onclick = () => vscode.postMessage({ type:'reject', id:p.id });
      acts.appendChild(ap); acts.appendChild(rj); wrap.appendChild(acts);
      if (p.settled) { const n = document.createElement('div'); n.className='proposal-note'; n.textContent = p.settled === 'approved' ? 'Approved' : 'Rejected'; wrap.appendChild(n); }
      elProposals.appendChild(wrap);
    }
    if (s.flash) {
      const f = document.createElement('div'); f.className = 'flash' + (s.flash.isError ? ' error' : ''); f.textContent = s.flash.text;
      elTranscript.appendChild(f); elTranscript.scrollTop = elTranscript.scrollHeight;
    }
    if (s.error) { const e = document.createElement('div'); e.className='error'; e.textContent='error: ' + s.error; elStatus.appendChild(e); }
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
  elInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  elLaunch.addEventListener('click', () => vscode.postMessage({ type: 'launch' }));
  elReindex.addEventListener('click', () => vscode.postMessage({ type: 'reindex' }));
</script>
</body>
</html>`;
}
