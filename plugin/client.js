// plugin/client.js — NdjsonClient: the long-lived `chatgml serve <dir>` bridge for the GMEdit side
// panel. Thin glue: the actual spawn/env/NDJSON-framing/handshake/watchdog lives in
// plugin/child-process.js (shared with the companion inline/explain plugins). This file adds the
// per-tool API surface (`sendUser` / `reindex` / `approve` / …) and the editor-friendly lifecycle.
//
// CommonJS, loaded by GMEdit as a plain <script> in the Electron renderer (Node integration on).
// This is the ONLY integration bridge between the CJS plugin and the ESM core: the core runs as a
// SEPARATE child process and we speak the existing NDJSON protocol that src/serve.ts was built for.
// No require()/import of the core (that would throw ERR_REQUIRE_ESM).
(function (root) {
  'use strict';

  const ChildProcess = root.ChatGmlChildProcess || require('./child-process.js');

  /**
   * @param {object} opts
   * @param {string} opts.projectDir            - e.project.dir (the GameMaker project root)
   * @param {string=} opts.configuredPath       - absolute chatgml path from a Preference
   * @param {string=} opts.scope                - optional --scope
   * @param {string=} opts.pluginDir            - __dirname of the plugin (to locate a bundled core)
   * @param {(event:object)=>void} opts.onEvent - called once per decoded AgentEvent
   * @param {(line:string)=>void=} opts.onMalformed
   * @param {(text:string)=>void=} opts.onStderr
   * @param {(event:object)=>void=} opts.onReady            - fired with the ready handshake event
   * @param {(code:number|null)=>void=} opts.onExit
   * @param {(err:Error)=>void=} opts.onError
   */
  function NdjsonClient(opts) {
    this.opts = opts;
    this.session = null;
    this.ready = false;
    this.lastActivityAt = Date.now();
  }

  /** Spawn the child. Returns true if it started, false (with onError) otherwise. */
  NdjsonClient.prototype.start = function () {
    if (this.session) return true;
    const self = this;
    this.session = ChildProcess.startCore({
      projectDir: this.opts.projectDir,
      scope: this.opts.scope,
      configuredPath: this.opts.configuredPath,
      pluginDir: this.opts.pluginDir,
      longLived: true,
      heartbeatMs: 60000,
      killBackstopMs: 1000,
      onEvent: (ev) => {
        if (self.opts.onEvent) self.opts.onEvent(ev);
      },
      onReady: (ev) => {
        self.ready = true;
        self.lastActivityAt = Date.now();
        if (self.opts.onReady) self.opts.onReady(ev);
      },
      onMalformed: (line) => {
        if (self.opts.onMalformed) self.opts.onMalformed(line);
      },
      onStderr: (text) => {
        if (self.opts.onStderr) self.opts.onStderr(text);
      },
      onExit: (code) => {
        self.session = null;
        self.ready = false;
        if (self.opts.onExit) self.opts.onExit(code);
      },
      onError: (err) => {
        self.session = null;
        self.ready = false;
        if (self.opts.onError) self.opts.onError(err);
      },
    });
    return this.session !== null;
  };

  /** Write a client command ({type:'user',text} etc.) as one NDJSON line. */
  NdjsonClient.prototype.send = function (command) {
    return this.session ? this.session.sendJson(command) : false;
  };
  NdjsonClient.prototype.sendUser = function (text, context) {
    const cmd = { type: 'user', text: text };
    if (context !== undefined && context !== null) cmd.context = Object.assign({}, context);
    return this.send(cmd);
  };
  NdjsonClient.prototype.reindex = function () {
    return this.send({ type: 'reindex' });
  };
  NdjsonClient.prototype.sendResume = function (messages, taskId) {
    const cmd = { type: 'resume', messages: messages };
    if (taskId !== undefined && taskId !== null) cmd.taskId = taskId;
    return this.send(cmd);
  };
  NdjsonClient.prototype.sendClear = function () {
    return this.send({ type: 'clear' });
  };
  NdjsonClient.prototype.sendUndo = function (checkpointId) {
    return this.send({ type: 'undo', checkpointId: checkpointId });
  };
  NdjsonClient.prototype.approve = function (id, blockIndex) {
    const cmd = { type: 'approve', id: id };
    if (blockIndex !== undefined && blockIndex !== null) cmd.block = blockIndex;
    return this.send(cmd);
  };
  NdjsonClient.prototype.reject = function (id, blockIndex) {
    const cmd = { type: 'reject', id: id };
    if (blockIndex !== undefined && blockIndex !== null) cmd.block = blockIndex;
    return this.send(cmd);
  };
  NdjsonClient.prototype.sendApproveCommand = function (id) {
    return this.send({ type: 'approve_command', id: id });
  };
  NdjsonClient.prototype.sendRejectCommand = function (id) {
    return this.send({ type: 'reject_command', id: id });
  };
  NdjsonClient.prototype.sendRunOnce = function (id) {
    // For now identical to approve; future: persist an auto-approval preference.
    return this.send({ type: 'approve_command', id: id });
  };
  NdjsonClient.prototype.sendApprovalPolicy = function (policy) {
    return this.send({ type: 'approval_policy', policy: policy });
  };
  NdjsonClient.prototype.cancel = function () {
    return this.send({ type: 'cancel' });
  };

  /**
   * Graceful shutdown: send cancel (settles pending approvals as rejected) then end stdin so the
   * core exits 0 cleanly (verified behavior). child.kill() is a backstop against an orphan.
   */
  NdjsonClient.prototype.stop = function () {
    if (this.session) {
      const s = this.session;
      this.session = null;
      this.ready = false;
      s.stop();
    }
  };

  const api = { NdjsonClient: NdjsonClient };
  root.ChatGmlClient = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
