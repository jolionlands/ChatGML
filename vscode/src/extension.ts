// vscode/src/extension.ts — ChatGML VS Code extension entry point.
//
// Spawns the chatgml core (`chatgml serve <workspaceFolder>`) as a child process and talks the v2
// NDJSON protocol (the same surface the GMEdit plugin uses). All pure protocol logic is shared by
// require()-ing the core's CommonJS plugin/state.js (a verified port of src/plugin-runtime.ts), so
// this extension cannot drift from the GMEdit plugin's reducer/argv/binary/context logic.
//
// Features (opencode-style):
//   - Chat webview view mounted in the ChatGML activity-bar container.
//   - Editor-context awareness: every user message carries {openFile, selection, cursorLine}.
//   - Slash commands: /clear /reindex /resume /scope /model /approval /help.
//   - Approve/Reject from the webview; on approval, the open file is reloaded from disk + the
//     cursor jumps to the first changed hunk line (inline diff).
//   - Quick-config chips (scope / model / approval) from `chatgml config show`.
//   - Per-project resumable session: turn_end records -> a `resume` command on the next start.
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  NdjsonClient,
  type AgentEvent,
  type ResumableMessage,
  type EditorContext,
} from './ndjson-client.js';
import { getWebviewHtml } from './webview.js';
import type * as State from 'chatgml-plugin-state';

// The pure logic module is CommonJS and the extension host is CommonJS — require it directly so the
// extension cannot drift from the GMEdit plugin's verified (parity-tested) copy.
const StateModule = require('../../plugin/state.js') as typeof State;

const SESSION_MAX_TURNS = 50;
const VIEW_ID = 'chatgml.chatView';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatGmlViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('chatgml.openChat', () => provider.show()),
    vscode.commands.registerCommand('chatgml.askSelection', () => provider.askSelection()),
    vscode.commands.registerCommand('chatgml.reindex', () => provider.reindex()),
  );
}

export function deactivate(): void {
  /* the provider's webview lifetime + child cleanup are owned by VS Code */
}

interface TurnRecord {
  userText: string;
  assistantText: string;
}

class ChatGmlViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private client: NdjsonClient | null = null;
  private running = false;
  private ready = false;
  private pluginState = StateModule.initialPluginState();
  private lastDiffForPath: Record<string, string> = {};
  private workspaceFolder = '';
  private sessionFile = '';
  private flash: { text: string; isError: boolean; ts: number } | null = null;
  private effectiveConfig: { scope?: string; model?: string; approval?: string } | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.workspaceFolder = this.resolveWorkspace();
    this.sessionFile = this.sessionPath();
  }

  // -------------------------------------------------------------------------
  // WebviewViewProvider.
  // -------------------------------------------------------------------------
  resolveWebviewView(view: vscode.WebviewView): void | Thenable<void> {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getWebviewHtml(view.webview, this.context.extensionUri);
    view.webview.onDidReceiveMessage(
      (msg) => {
        void this.onWebviewMessage(msg);
      },
      null,
      this.context.subscriptions,
    );
    // Re-renders an initial state so the webview isn't blank until a core starts.
    this.pushState();
    // Auto-start when a workspace is open (the user can stop it from the panel).
    if (this.workspaceFolder) {
      setTimeout(() => this.startCore(), 100);
    }
  }

  show(): void {
    if (this.view) {
      this.view.show?.(true);
    } else {
      vscode.commands.executeCommand(`${VIEW_ID}.focus`).then(
        () => {},
        () => {},
      );
    }
    this.pushState();
  }

  reindex(): void {
    if (this.client) {
      this.client.reindex();
      this.flashNotice('reindex requested');
    }
  }

  // -------------------------------------------------------------------------
  // Workspace + session.
  // -------------------------------------------------------------------------
  private resolveWorkspace(): string {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0]!.uri.fsPath : '';
  }

  private sessionPath(): string {
    const dir = path.join(this.context.globalStorageUri?.fsPath ?? __dirname, 'sessions');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    const h = crypto
      .createHash('sha1')
      .update(this.workspaceFolder || 'default')
      .digest('hex')
      .slice(0, 12);
    return path.join(dir, h + '.ndjson');
  }

  private async loadSession(): Promise<TurnRecord[]> {
    try {
      const text = await fsp.readFile(this.sessionFile, 'utf8');
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      return lines
        .slice(-SESSION_MAX_TURNS * 2)
        .map((l) => JSON.parse(l) as TurnRecord)
        .filter((t) => t && typeof t.userText === 'string' && typeof t.assistantText === 'string');
    } catch {
      return [];
    }
  }

  private async appendTurn(rec: TurnRecord): Promise<void> {
    if (!this.workspaceFolder) return;
    try {
      await fsp.appendFile(this.sessionFile, JSON.stringify(rec) + '\n', 'utf8');
    } catch {
      /* best-effort */
    }
  }

  private async clearSession(): Promise<void> {
    try {
      await fsp.writeFile(this.sessionFile, '', 'utf8');
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Editor-context awareness.
  // -------------------------------------------------------------------------
  private relativeToWorkspace(absPath: string): string | undefined {
    if (!absPath || !this.workspaceFolder) return undefined;
    let rel = absPath;
    if (rel.startsWith(this.workspaceFolder)) {
      rel = rel.slice(this.workspaceFolder.length).replace(/^[\\/]+/, '');
    }
    return rel.replace(/\\/g, '/').replace(/^\.\//, '') || undefined;
  }

  private currentEditorContext(): EditorContext | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const doc = editor.document;
    const rel = this.relativeToWorkspace(doc.uri.fsPath);
    let selection: string | undefined;
    const sel = editor.selection;
    if (!sel.isEmpty) selection = doc.getText(sel);
    return StateModule.buildEditorContext({
      openFile: rel,
      selection,
      cursorLine: sel.active.line + 1,
    }) as EditorContext | undefined;
  }

  private activeFilePath(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    return this.relativeToWorkspace(editor.document.uri.fsPath);
  }

  // -------------------------------------------------------------------------
  // Core lifecycle.
  // -------------------------------------------------------------------------
  private startCore(): void {
    if (!this.workspaceFolder) {
      this.flashNotice('open a workspace folder first', true);
      return;
    }
    if (this.client) return;
    const cfg = vscode.workspace.getConfiguration('chatgml');
    this.client = new NdjsonClient({
      onEvent: (e) => this.onEvent(e),
      onReady: () => void this.onReady(),
      onMalformed: (l) => console.warn('chatgml: malformed line ignored:', l),
      onStderr: (t) => console.info('chatgml[serve]:', t.trim()),
      onError: (err) => {
        console.error('chatgml:', err.message);
        this.flashNotice('failed to launch core: ' + err.message, true);
        this.client = null;
        this.setRunning(false);
      },
      onExit: (code) => {
        console.info('chatgml: core exited', code);
        this.client = null;
        this.setRunning(false);
      },
    });
    const ok = this.client.start({
      projectDir: this.workspaceFolder,
      configuredPath: (cfg.get('binaryPath') as string) || undefined,
      scope: (cfg.get('scope') as string) || undefined,
      approval: cfg.get('autoApprove') === true ? 'auto' : undefined,
      pluginDir: this.context.extensionPath,
    });
    if (ok) this.setRunning(true);
    else this.client = null;
  }

  private stopCore(): void {
    if (this.client) {
      this.client.stop();
      this.client = null;
    }
    this.setRunning(false);
  }

  private restartCore(): void {
    this.stopCore();
    setTimeout(() => this.startCore(), 50);
  }

  private setRunning(running: boolean): void {
    this.running = running;
    if (!running) {
      this.ready = false;
      this.pluginState = StateModule.initialPluginState();
    }
    this.pushState();
  }

  // -------------------------------------------------------------------------
  // Event handling.
  // -------------------------------------------------------------------------
  private onEvent(e: AgentEvent): void {
    this.pluginState = StateModule.reducePluginState(e, this.pluginState);
    if (e.type === 'edit_proposal') {
      const p = this.pluginState.pendingProposals.get(e.id as string);
      if (p) this.lastDiffForPath[p.path] = p.diff;
    }
    if (e.type === 'turn_end') {
      void this.appendTurn({
        userText: (e.userText as string) ?? '',
        assistantText: (e.assistantText as string) ?? '',
      });
    }
    this.pushState();
  }

  private async onReady(): Promise<void> {
    this.ready = true;
    void this.refreshConfig();
    const turns = await this.loadSession();
    if (this.client && turns.length > 0) {
      this.client.sendResume(StateModule.turnEndToMessages(turns) as ResumableMessage[]);
      this.flashNotice(`resumed ${turns.length} saved turn(s)`);
    }
    this.pushState();
  }

  // Effective config (scope/model/approval) for the chips, from `chatgml config show`.
  private refreshConfig(): void {
    if (!this.workspaceFolder) return;
    try {
      const candidates = [
        path.join(this.context.extensionPath, 'dist', 'cli.js'),
        path.join(this.context.extensionPath, '..', 'dist', 'cli.js'),
      ];
      let distCli = candidates[candidates.length - 1]!;
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          distCli = c;
          break;
        }
      }
      const resolved = StateModule.resolveServeBinary({
        configuredPath:
          (vscode.workspace.getConfiguration('chatgml').get('binaryPath') as string) || undefined,
        env: process.env,
        platform: process.platform,
        distCliPath: distCli,
        nodePath: 'node',
        exists: (p) => fs.existsSync(p),
      });
      execFile(
        resolved.cmd,
        resolved.argvPrefix.concat(['config', 'show', this.workspaceFolder]),
        { encoding: 'utf8' },
        (err, stdout) => {
          if (err || !stdout) return;
          const end = stdout.indexOf('\n}');
          const json = end >= 0 ? stdout.slice(0, end + 2) : stdout;
          try {
            const cfg = JSON.parse(json) as {
              scope?: string;
              chat?: { model?: string };
              approval?: string;
            };
            this.effectiveConfig = {
              scope: cfg.scope,
              model: cfg.chat?.model,
              approval: cfg.approval,
            };
            this.pushState();
          } catch {
            /* ignore */
          }
        },
      );
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Webview message handling.
  // -------------------------------------------------------------------------
  private async onWebviewMessage(msg: unknown): Promise<void> {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { type: string; text?: string; id?: string };
    switch (m.type) {
      case 'launch':
        if (this.running) this.stopCore();
        else this.startCore();
        return;
      case 'reindex':
        if (this.client) this.client.reindex();
        return;
      case 'approve':
        if (this.client && m.id) {
          this.client.approve(m.id);
          this.inlineDiffOnApprove(m.id);
          this.pluginState = StateModule.settleProposal(m.id, this.pluginState);
          this.pushState();
        }
        return;
      case 'reject':
        if (this.client && m.id) {
          this.client.reject(m.id);
          this.pluginState = StateModule.settleProposal(m.id, this.pluginState);
          this.pushState();
        }
        return;
      case 'input': {
        const text = (m.text ?? '').trim();
        if (text === '') return;
        const slash = StateModule.parseSlashCommand(text);
        if (slash !== null) {
          void this.handleSlash(slash);
          return;
        }
        if (this.client) this.client.sendUser(text, this.currentEditorContext() ?? undefined);
        return;
      }
    }
  }

  private async handleSlash(cmd: ReturnType<typeof StateModule.parseSlashCommand>): Promise<void> {
    if (cmd === null) return;
    switch (cmd.kind) {
      case 'clear':
        if (this.client) this.client.sendClear();
        await this.clearSession();
        this.flashNotice('cleared conversation history');
        return;
      case 'reindex':
        if (this.client) this.client.reindex();
        return;
      case 'resume': {
        const turns = await this.loadSession();
        if (!this.client) return;
        if (turns.length === 0) {
          this.flashNotice('no saved session to resume');
          return;
        }
        this.client.sendResume(StateModule.turnEndToMessages(turns) as ResumableMessage[]);
        this.flashNotice(`resumed ${turns.length} saved turn(s)`);
        return;
      }
      case 'help':
        this.flashNotice(StateModule.SLASH_HELP.join('\n'));
        return;
      case 'unknown':
      case 'empty':
        this.flashNotice(`/${cmd.name || ''} — unknown command (try /help)`, true);
        return;
      case 'scope':
        await vscode.workspace
          .getConfiguration('chatgml')
          .update('scope', cmd.value, vscode.ConfigurationTarget.Workspace);
        this.restartCore();
        return;
      case 'model':
        void this.setConfigAndRestart('chat.model', cmd.value);
        return;
      case 'approval':
        await vscode.workspace
          .getConfiguration('chatgml')
          .update('autoApprove', cmd.value === 'auto', vscode.ConfigurationTarget.Workspace);
        void this.setConfigAndRestart('approval', cmd.value);
        return;
      case 'undo':
        if (this.client) this.client.send({ type: 'undo', checkpointId: cmd.checkpointId });
        return;
    }
  }

  private setConfigAndRestart(field: string, value: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        const cfgBin = StateModule.resolveServeBinary({
          configuredPath:
            (vscode.workspace.getConfiguration('chatgml').get('binaryPath') as string) || undefined,
          env: process.env,
          platform: process.platform,
          distCliPath: path.join(this.context.extensionPath, '..', 'dist', 'cli.js'),
          nodePath: 'node',
          exists: (p) => fs.existsSync(p),
        });
        execFile(
          cfgBin.cmd,
          cfgBin.argvPrefix.concat(['config', 'set', field, value]),
          { encoding: 'utf8' },
          (err) => {
            if (err) {
              this.flashNotice('config set failed: ' + (err.message || String(err)), true);
              resolve();
              return;
            }
            this.restartCore();
            resolve();
          },
        );
      } catch (err) {
        this.flashNotice('config set failed: ' + (err as Error).message, true);
        resolve();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Inline diff: on approve, reload the open file from disk + jump to the changed hunk.
  // -------------------------------------------------------------------------
  private inlineDiffOnApprove(id: string): void {
    const proposal = this.pluginState.pendingProposals.get(id);
    if (!proposal) return;
    const openRel = this.activeFilePath();
    if (!openRel || openRel !== proposal.path) return;
    setTimeout(async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !this.workspaceFolder) return;
      const doc = editor.document;
      const onDisk = path.join(this.workspaceFolder, proposal.path);
      try {
        const text = await fsp.readFile(onDisk, 'utf8');
        const row = this.firstChangedNewLine(proposal.diff);
        const full = new vscode.Range(0, 0, doc.lineCount, 0);
        const we = new vscode.WorkspaceEdit();
        we.replace(doc.uri, full, text);
        await vscode.workspace.applyEdit(we);
        const pos = new vscode.Position(Math.max(0, row - 1), 0);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(pos, pos);
      } catch (err) {
        console.info('chatgml: inline diff reload skipped', err);
      }
    }, 50);
  }

  private firstChangedNewLine(diff: string): number {
    try {
      for (const ln of String(diff || '').split('\n')) {
        const m = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/.exec(ln);
        if (m) return parseInt(m[1]!, 10);
      }
    } catch {
      /* ignore */
    }
    return 1;
  }

  // -------------------------------------------------------------------------
  // "Ask about selection" command.
  // -------------------------------------------------------------------------
  askSelection(): void {
    this.show();
    setTimeout(() => {
      if (!this.client) return;
      const editor = vscode.window.activeTextEditor;
      const sel =
        editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
      const prompt =
        sel.trim() !== ''
          ? 'Explain this selection and suggest improvements.'
          : 'Explain this file.';
      this.client.sendUser(prompt, this.currentEditorContext() ?? undefined);
    }, 0);
  }

  // -------------------------------------------------------------------------
  // Rendering: push the already-reduced state to the webview.
  // -------------------------------------------------------------------------
  private flashNotice(text: string, isError = false): void {
    this.flash = { text, isError, ts: Date.now() };
    this.pushState();
    setTimeout(() => {
      if (this.flash && Date.now() - this.flash.ts >= 2800) {
        this.flash = null;
        this.pushState();
      }
    }, 3000);
  }

  private pushState(): void {
    if (!this.view) return;
    const proposals = [...this.pluginState.pendingProposals.values()].map((pwere) => ({
      id: pwere.id,
      path: pwere.path,
      diff: pwere.diff,
    }));
    this.view.webview.postMessage({
      kind: 'state',
      state: {
        phase: this.pluginState.phase,
        running: this.running,
        transcript: this.pluginState.transcript,
        answer: this.pluginState.answer,
        sources: this.pluginState.sources.map((s) => ({
          path: s.path,
          snippet: s.snippet,
          provider: s.provider,
        })),
        activity: this.pluginState.activity,
        pendingProposals: proposals,
        config: this.effectiveConfig,
        flash: this.flash,
        error: this.pluginState.error,
      },
    });
  }
}
