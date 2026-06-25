// plugin/client.js — NdjsonClient: spawn `chatgml serve <dir>` and talk NDJSON over its stdio.
//
// CommonJS, loaded by GMEdit as a plain <script> in the Electron renderer (Node integration on).
// This is the ONLY integration bridge between the CJS plugin and the ESM core: there is no
// require()/import of the core (that would throw ERR_REQUIRE_ESM) — the core runs as a SEPARATE
// child process and we speak the existing NDJSON protocol that src/serve.ts was built for.
//
// All protocol/framing/argv/binary logic lives in plugin/state.js (a verified port of
// src/plugin-runtime.ts). This file is thin process plumbing: resolve the binary, spawn with
// shell:false + a minimal env, feed RAW stdout chunks (no per-chunk trim) into the line buffer,
// route stderr to the log, and gate readiness on the handshake.
(function (root) {
  'use strict';

  const { spawn } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const State = root.ChatGmlState || require('./state.js');

  /**
   * @param {object} opts
   * @param {string} opts.projectDir            - e.project.dir (the GameMaker project root)
   * @param {string=} opts.configuredPath       - absolute chatgml path from a Preference
   * @param {string=} opts.scope                - optional --scope
   * @param {string=} opts.pluginDir            - __dirname of the plugin (to locate a bundled core)
   * @param {(event:object)=>void} opts.onEvent - called once per decoded AgentEvent
   * @param {(line:string)=>void=} opts.onMalformed
   * @param {(text:string)=>void=} opts.onStderr
   * @param {()=>void=} opts.onReady            - fired when the ready handshake arrives
   * @param {(code:number|null)=>void=} opts.onExit
   * @param {(err:Error)=>void=} opts.onError
   */
  function NdjsonClient(opts) {
    this.opts = opts;
    this.child = null;
    this.ready = false;
    this.buffer = new State.NdjsonLineBuffer();
  }

  NdjsonClient.prototype._resolveBinary = function () {
    // The bundled core lives next to the plugin in a dev/symlinked checkout: <pluginDir>/dist/cli.js
    // or, if the plugin sits inside the repo, ../dist/cli.js. We probe a couple of likely spots.
    const candidates = [];
    if (this.opts.pluginDir) {
      candidates.push(path.join(this.opts.pluginDir, 'dist', 'cli.js'));
      candidates.push(path.join(this.opts.pluginDir, '..', 'dist', 'cli.js'));
    }
    let distCliPath = candidates.length > 0 ? candidates[0] : '';
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        distCliPath = c;
        break;
      }
    }
    return State.resolveServeBinary({
      configuredPath: this.opts.configuredPath,
      env: process.env,
      platform: process.platform,
      distCliPath: distCliPath,
      nodePath: process.execPath,
      exists: function (p) {
        return fs.existsSync(p);
      },
    });
  };

  /** Spawn the child. Returns true if it started, false (with onError) otherwise. */
  NdjsonClient.prototype.start = function () {
    if (this.child) return true;
    let resolved;
    try {
      resolved = this._resolveBinary();
    } catch (err) {
      if (this.opts.onError) this.opts.onError(err);
      return false;
    }
    const serveArgv = State.buildServeArgv({
      dir: this.opts.projectDir,
      scope: this.opts.scope,
      // endpoints/model come from the user-global config file (~/.config/chatgml/config.json),
      // so no secret ever touches the command line or a process listing.
    });
    const argv = resolved.argvPrefix.concat(serveArgv);

    // Minimal, explicit env (NOT the full inherited Electron env): PATH + the config-locating vars
    // + any CHATGML_* the user set. Keeps the child's surface small and predictable.
    const env = { PATH: process.env.PATH || process.env.Path };
    for (const k of ['APPDATA', 'HOME', 'USERPROFILE', 'SystemRoot', 'XDG_CONFIG_HOME']) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    for (const k of Object.keys(process.env)) {
      if (k.indexOf('CHATGML_') === 0) env[k] = process.env[k];
    }

    const self = this;
    try {
      this.child = spawn(resolved.cmd, argv, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env,
      });
    } catch (err) {
      if (this.opts.onError) this.opts.onError(err);
      return false;
    }

    this.child.stdout.on('data', function (chunk) {
      // RAW chunk -> line buffer (NO per-chunk .trim(); the old plugin's framing bug).
      const result = self.buffer.push(chunk);
      for (let i = 0; i < result.events.length; i++) {
        self._handleEvent(result.events[i]);
      }
      for (let j = 0; j < result.malformed.length; j++) {
        if (self.opts.onMalformed) self.opts.onMalformed(result.malformed[j]);
      }
    });

    // stdout is PROTOCOL-ONLY: stderr is diagnostics, never parsed as protocol.
    this.child.stderr.on('data', function (chunk) {
      if (self.opts.onStderr) self.opts.onStderr(chunk.toString('utf8'));
    });

    this.child.on('error', function (err) {
      if (self.opts.onError) self.opts.onError(err);
    });
    this.child.on('exit', function (code) {
      self.child = null;
      self.ready = false;
      if (self.opts.onExit) self.opts.onExit(code);
    });
    return true;
  };

  NdjsonClient.prototype._handleEvent = function (event) {
    if (!this.ready && State.isReadyHandshake(event)) {
      this.ready = true;
      if (this.opts.onReady) this.opts.onReady();
    }
    if (this.opts.onEvent) this.opts.onEvent(event);
  };

  /** Write a client command ({type:'user',text} etc.) as one NDJSON line. */
  NdjsonClient.prototype.send = function (command) {
    if (!this.child || !this.child.stdin.writable) return false;
    this.child.stdin.write(JSON.stringify(command) + '\n');
    return true;
  };

  NdjsonClient.prototype.sendUser = function (text) {
    return this.send({ type: 'user', text: text });
  };
  NdjsonClient.prototype.reindex = function () {
    return this.send({ type: 'reindex' });
  };
  NdjsonClient.prototype.approve = function (id) {
    return this.send({ type: 'approve', id: id });
  };
  NdjsonClient.prototype.reject = function (id) {
    return this.send({ type: 'reject', id: id });
  };
  NdjsonClient.prototype.cancel = function () {
    return this.send({ type: 'cancel' });
  };

  /**
   * Graceful shutdown: send cancel (settles pending approvals as rejected) then end stdin so the
   * core exits 0 cleanly (verified behavior). child.kill() is a backstop against an orphan.
   */
  NdjsonClient.prototype.stop = function () {
    if (!this.child) return;
    try {
      this.send({ type: 'cancel' });
      this.child.stdin.end();
    } catch (e) {
      /* ignore */
    }
    const child = this.child;
    setTimeout(function () {
      if (child && !child.killed) {
        try {
          child.kill();
        } catch (e) {
          /* ignore */
        }
      }
    }, 1000);
  };

  const api = { NdjsonClient: NdjsonClient };
  root.ChatGmlClient = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
