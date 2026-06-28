// plugin/child-process.js — shared `chatgml serve` process plumbing for ALL three GMEdit plugins.
//
// CommonJS, loaded by GMEdit as a plain <script> in the Electron renderer (Node integration on).
// The main chatgml plugin (plugin/client.js) uses this directly. The two companion plugins
// (plugin-inline/, plugin-explain/) require it from the main plugin's directory via
// `'../chatgml/child-process.js'`, the same pattern they use for state.js. This is the only place
// that knows how to spawn the core, build its minimal env, and frame stdout as NDJSON events — so
// a Windows .cmd-shim bug fix, an env var change, or a watchdog tweak lands ONCE.
//
// Protocol/framing/argv/binary-resolution logic still lives in plugin/state.js (verified port of
// src/plugin-runtime.ts; parity-tested). This file is pure process plumbing — no protocol parsing,
// no reducer state.
(function (root) {
  'use strict';

  const { spawn } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const State = root.ChatGmlState || require('./state.js');

  /**
   * Build the minimal child env: PATH + the config-locating vars + any CHATGML_* the user set.
   * We do NOT inherit the full Electron env — keeps the child's surface small and predictable,
   * and stops the renderer-only `ELECTRON_*`/`NODE_*` noise from leaking into the core's process
   * listing.
   */
  function buildMinimalEnv() {
    const env = { PATH: process.env.PATH || process.env.Path };
    for (const k of ['APPDATA', 'HOME', 'USERPROFILE', 'SystemRoot', 'XDG_CONFIG_HOME']) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    for (const k of Object.keys(process.env)) {
      if (k.indexOf('CHATGML_') === 0) env[k] = process.env[k];
    }
    return env;
  }

  /**
   * Windows .cmd/.bat shims cannot be spawned directly with `shell:false` (EINVAL). Wrap them in
   * `cmd.exe /c <shim> <args>` so the npm shim (or any future .cmd fallback) still works.
   */
  function wrapCmdForWindows(cmd, argv) {
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
      return { cmd: 'cmd.exe', argv: ['/c', cmd].concat(argv) };
    }
    return { cmd, argv };
  }

  /**
   * Resolve the dist/cli.js candidate path from a plugin dir. Returns the first existing path
   * among `<pluginDir>/dist/cli.js`, `<pluginDir>/../dist/cli.js` (sibling repo checkout), and
   * `<pluginDir>/../dist/cli.js` again for the dev-checkout case. The state.js resolver still
   * checks CHATGML_BIN + the Windows npm shim, so passing a non-existent distCliPath is fine.
   */
  function resolveDistCliPath(pluginDir, ownDistFallback) {
    const candidates = [];
    if (pluginDir) {
      candidates.push(path.join(pluginDir, 'dist', 'cli.js'));
      candidates.push(path.join(pluginDir, '..', 'dist', 'cli.js'));
    }
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    if (ownDistFallback && fs.existsSync(ownDistFallback)) return ownDistFallback;
    return candidates[0] || '';
  }

  /**
   * Resolve the binary path via the verified state.js resolver. Pulls CHATGML_BIN, the platform-
   * specific npm shim, and the supplied distCliPath together into a single argvPrefix + cmd.
   */
  function resolveBinary({ configuredPath, pluginDir, ownDistFallback }) {
    const distCliPath = resolveDistCliPath(pluginDir, ownDistFallback);
    return State.resolveServeBinary({
      configuredPath: configuredPath || '',
      env: process.env,
      platform: process.platform,
      distCliPath,
      // Electron's renderer process.execPath is the app exe (GMEdit.exe), not node.
      // The core is a Node ESM CLI, so we must spawn it with the system node binary.
      nodePath: 'node',
      exists: function (p) {
        return fs.existsSync(p);
      },
    });
  }

  /**
   * Spawn the chatgml core as a child of this renderer. Resolves the binary, builds argv, applies
   * the Windows shim wrap, builds the minimal env, spawns with `shell:false` + piped stdio, and
   * starts piping stdout chunks into a fresh NDJSONLineBuffer.
   *
   * Returns `{ child, buffer, write, stop, isReady }`. `stop()` cancels + ends stdin + 500ms-kill
   * backstop. `isReady` flips true once the handshake arrives. `write(line)` writes a JSON line to
   * stdin (no-op when the child is gone). The caller adds `child.on('exit')` and the per-event
   * `onEvent` handler.
   *
   * @param {object} opts
   * @param {string} opts.projectDir
   * @param {string=} opts.scope
   * @param {string=} opts.configuredPath
   * @param {string=} opts.pluginDir
   * @param {string=} opts.ownDistFallback  - extra distCliPath to probe (for sibling plugins)
   * @param {(event:object)=>void} opts.onEvent
   * @param {(line:string)=>void=} opts.onMalformed
   * @param {(text:string)=>void=} opts.onStderr
   * @param {(event:object)=>void=} opts.onReady
   * @param {(code:number|null)=>void=} opts.onExit
   * @param {(err:Error)=>void=} opts.onError
   * @param {number=} opts.heartbeatMs  - watchdog kill timeout after this much idle time (default: 60000)
   * @param {number=} opts.killBackstopMs - backstop timer for `stop()` (default: 500/1000)
   */
  function startCore(opts) {
    let resolved;
    try {
      resolved = resolveBinary({
        configuredPath: opts.configuredPath,
        pluginDir: opts.pluginDir,
        ownDistFallback: opts.ownDistFallback,
      });
    } catch (err) {
      if (opts.onError) opts.onError(err);
      return null;
    }
    const serveArgv = State.buildServeArgv({
      dir: opts.projectDir,
      scope: opts.scope,
    });
    const argv = resolved.argvPrefix.concat(serveArgv);
    const wrapped = wrapCmdForWindows(resolved.cmd, argv);
    const env = buildMinimalEnv();

    let child;
    try {
      child = spawn(wrapped.cmd, wrapped.argv, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env,
      });
    } catch (err) {
      if (opts.onError) opts.onError(err);
      return null;
    }

    const buffer = new State.NdjsonLineBuffer();
    let ready = false;
    let lastActivityAt = Date.now();
    let watchdog = null;
    const heartbeatMs = opts.heartbeatMs ?? 60000;
    const killBackstopMs = opts.killBackstopMs ?? (opts.longLived ? 1000 : 500);

    const clearWatchdog = () => {
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = null;
      }
    };

    child.stdout.on('data', (chunk) => {
      // RAW chunk -> line buffer (NO per-chunk .trim(); the old plugin's framing bug).
      lastActivityAt = Date.now();
      const result = buffer.push(chunk);
      for (let i = 0; i < result.events.length; i++) {
        const ev = result.events[i];
        if (!ready && State.isReadyHandshake(ev)) {
          ready = true;
          lastActivityAt = Date.now();
          if (opts.onReady) opts.onReady(ev);
          if (heartbeatMs > 0) {
            clearWatchdog();
            watchdog = setInterval(
              () => {
                if (!child) return;
                if (Date.now() - lastActivityAt > heartbeatMs) {
                  const err = new Error('ChatGML core heartbeat timeout');
                  stop();
                  if (opts.onError) opts.onError(err);
                }
              },
              Math.min(10000, Math.max(1000, Math.floor(heartbeatMs / 6))),
            );
          }
        }
        if (opts.onEvent) opts.onEvent(ev);
      }
      for (let j = 0; j < result.malformed.length; j++) {
        if (opts.onMalformed) opts.onMalformed(result.malformed[j]);
      }
    });

    child.stderr.on('data', (chunk) => {
      if (opts.onStderr) opts.onStderr(chunk.toString('utf8'));
    });

    child.on('error', (err) => {
      clearWatchdog();
      if (opts.onError) opts.onError(err);
    });

    child.on('exit', (code) => {
      clearWatchdog();
      if (opts.onExit) opts.onExit(code);
    });

    function write(line) {
      if (!child || !child.stdin.writable) return false;
      child.stdin.write(line);
      return true;
    }

    function sendJson(obj) {
      return write(JSON.stringify(obj) + '\n');
    }

    function stop() {
      clearWatchdog();
      if (!child) return;
      try {
        sendJson({ type: 'cancel' });
        if (child.stdin) child.stdin.end();
      } catch (e) {
        /* ignore */
      }
      const target = child;
      setTimeout(() => {
        if (target && !target.killed) {
          try {
            target.kill();
          } catch (e) {
            /* ignore */
          }
        }
      }, killBackstopMs);
    }

    return {
      child,
      buffer,
      isReady: () => ready,
      write,
      sendJson,
      stop,
    };
  }

  const api = {
    buildMinimalEnv,
    wrapCmdForWindows,
    resolveDistCliPath,
    resolveBinary,
    startCore,
  };
  root.ChatGmlChildProcess = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
