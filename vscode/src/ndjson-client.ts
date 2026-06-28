// vscode/src/ndjson-client.ts — spawn `chatgml serve <dir>` and speak NDJSON over its stdio.
//
// The VS Code extension host is Node (CommonJS) and can `require()` the core's CJS plugin/state.js
// (a verified port of src/plugin-runtime.ts). It CANNOT import the ESM core (dist/cli.js is ESM),
// so — like the GMEdit plugin — the core runs as a SEPARATE child process and we talk the v2
// NDJSON protocol that src/serve.ts exposes. All pure protocol logic (NdjsonLineBuffer,
// isReadyHandshake, buildServeArgv, resolveServeBinary, reducePluginState, parseSlashCommand,
// buildEditorContext, turnEndToMessages) is shared by require()-ing plugin/state.js, so the VS
// Code extension stays in lock-step with the GMEdit plugin by construction (no second copy).
//
// Load order: the extension only depends on plugin/state.js at runtime via a relative require, so
// the bundled/packaged extension must keep a copy of plugin/state.js next to it. In dev (this
// repo) it sits at ../../plugin/state.js relative to dist/ndjson-client.js.
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type * as State from 'chatgml-plugin-state';

// Resolve the CJS plugin/state.js relative to this compiled file (dist/). In dev the layout is
// <root>/vscode/dist/ndjson-client.js -> ../../plugin/state.js. We use a plain `require` so it is
// resolved once at first import (the extension host is CommonJS).
const StateModule = require('../../plugin/state.js') as typeof State;

export interface EditorContext {
  openFile?: string;
  selection?: string;
  cursorLine?: number;
}

export interface ResumableMessage {
  role: 'user' | 'assistant';
  content: string | null;
}

export interface AgentEvent {
  [k: string]: unknown;
  type: string;
}

export interface ClientCallbacks {
  onEvent: (event: AgentEvent) => void;
  onReady?: () => void;
  onStderr?: (text: string) => void;
  onMalformed?: (line: string) => void;
  onError?: (err: Error) => void;
  onExit?: (code: number | null) => void;
}

export interface StartOptions {
  projectDir: string;
  configuredPath?: string;
  scope?: string;
  approval?: 'gated' | 'auto';
  pluginDir: string;
}

export class NdjsonClient {
  private child: ChildProcess | null = null;
  ready = false;
  private readonly buffer = new StateModule.NdjsonLineBuffer();

  constructor(private readonly cb: ClientCallbacks) {}

  /** Resolve the chatgml executable the same way the GMEdit plugin does. */
  private resolve(
    pluginDir: string,
    configuredPath: string,
  ): { cmd: string; argvPrefix: string[] } {
    const fs = require('node:fs');
    // The bundled core lives next to the plugin in a dev/symlinked checkout: <pluginDir>/dist/cli.js
    // or ../dist/cli.js. Probe the same spots as the GMEdit plugin.
    const candidates = [
      path.join(pluginDir, 'dist', 'cli.js'),
      path.join(pluginDir, '..', 'dist', 'cli.js'),
    ];
    let distCliPath = candidates[0] ?? '';
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        distCliPath = c;
        break;
      }
    }
    return StateModule.resolveServeBinary({
      configuredPath,
      env: process.env,
      platform: process.platform,
      distCliPath,
      nodePath: 'node',
      exists: (p: string) => fs.existsSync(p),
    });
  }

  start(opts: StartOptions): boolean {
    if (this.child) return true;
    let resolved: { cmd: string; argvPrefix: string[] };
    try {
      resolved = this.resolve(opts.pluginDir, opts.configuredPath ?? '');
    } catch (err) {
      if (this.cb.onError) this.cb.onError(err as Error);
      return false;
    }
    const serveArgv = StateModule.buildServeArgv({
      dir: opts.projectDir,
      scope: opts.scope || undefined,
      approval: opts.approval,
    });
    const argv = resolved.argvPrefix.concat(serveArgv);

    // Minimal, explicit env (NOT the full inherited VS Code env): PATH + config-locating vars +
    // CHATGML_* the user set. Keeps the child predictable and secrets off the command line.
    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH ?? process.env.Path,
    };
    for (const k of ['APPDATA', 'HOME', 'USERPROFILE', 'SystemRoot', 'XDG_CONFIG_HOME']) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    for (const k of Object.keys(process.env)) {
      if (k.indexOf('CHATGML_') === 0) env[k] = process.env[k];
    }

    let cmd = resolved.cmd;
    let spawnArgv = argv;
    // Windows .cmd/.bat shims can't be spawned directly with shell:false (EINVAL) — run via cmd /c.
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
      spawnArgv = ['/c', cmd, ...argv];
      cmd = 'cmd.exe';
    }

    try {
      this.child = spawn(cmd, spawnArgv, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env,
      });
    } catch (err) {
      if (this.cb.onError) this.cb.onError(err as Error);
      return false;
    }

    this.child.stdout!.on('data', (chunk: Buffer) => {
      const result = this.buffer.push(chunk);
      for (const e of result.events) this.handleEvent(e as AgentEvent);
      for (const m of result.malformed) {
        if (this.cb.onMalformed) this.cb.onMalformed(m);
      }
    });
    this.child.stderr!.on('data', (chunk: Buffer) => {
      if (this.cb.onStderr) this.cb.onStderr(chunk.toString('utf8'));
    });
    this.child.on('error', (err: Error) => {
      if (this.cb.onError) this.cb.onError(err);
    });
    this.child.on('exit', (code) => {
      this.child = null;
      this.ready = false;
      if (this.cb.onExit) this.cb.onExit(code);
    });
    return true;
  }

  private handleEvent(event: AgentEvent): void {
    if (!this.ready && StateModule.isReadyHandshake(event)) {
      this.ready = true;
      if (this.cb.onReady) this.cb.onReady();
    }
    if (this.cb.onEvent) this.cb.onEvent(event);
  }

  send(cmd: unknown): boolean {
    if (!this.child || !this.child.stdin!.writable) return false;
    this.child.stdin!.write(JSON.stringify(cmd) + '\n');
    return true;
  }

  sendUser(text: string, context?: EditorContext): boolean {
    const cmd: Record<string, unknown> = { type: 'user', text };
    if (context !== undefined && context !== null) cmd.context = context;
    return this.send(cmd);
  }

  approve(id: string): boolean {
    return this.send({ type: 'approve', id });
  }
  reject(id: string): boolean {
    return this.send({ type: 'reject', id });
  }
  reindex(): boolean {
    return this.send({ type: 'reindex' });
  }
  sendResume(messages: ResumableMessage[]): boolean {
    return this.send({ type: 'resume', messages });
  }
  sendClear(): boolean {
    return this.send({ type: 'clear' });
  }

  stop(): void {
    if (!this.child) return;
    try {
      this.send({ type: 'cancel' });
      this.child.stdin!.end();
    } catch {
      /* ignore */
    }
    const child = this.child;
    setTimeout(() => {
      if (child && !child.killed) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
    }, 1000);
  }
}
