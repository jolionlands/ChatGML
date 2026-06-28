// plugin/config-bridge.js — stores plugin-local Preferences (binary path + scope) and inspects the
// core's effective config by shelling `chatgml config show <dir>` (parsing its redacted JSON).
//
// It NEVER parses YAML (config is unified JSON now) and NEVER writes secrets — endpoints/model/keys
// live in the core's user-global config file (~/.config/chatgml/config.json), set via `chatgml
// config set`. This replaces the old loadConfig/saveConfig/parseYamlForPaths + js-yaml entirely.
(function (root) {
  'use strict';

  const { execFile } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const State = root.ChatGmlState || require('./state.js');

  // Simple persisted prefs in the plugin dir (GMEdit Preferences UI also edits these).
  function ConfigBridge(pluginDir) {
    this.pluginDir = pluginDir;
    this.prefsPath = path.join(pluginDir, 'chatgml-prefs.json');
    this.prefs = { binaryPath: '', scope: '', approvalPolicy: {}, mcpServers: '{}' };
    this._coreAvailable = false;
    this._load();
  }

  ConfigBridge.prototype._load = function () {
    try {
      if (fs.existsSync(this.prefsPath)) {
        const raw = JSON.parse(fs.readFileSync(this.prefsPath, 'utf8'));
        if (raw && typeof raw === 'object') {
          if (typeof raw.binaryPath === 'string') this.prefs.binaryPath = raw.binaryPath;
          if (typeof raw.scope === 'string') this.prefs.scope = raw.scope;
          if (raw.approvalPolicy && typeof raw.approvalPolicy === 'object') {
            this.prefs.approvalPolicy = raw.approvalPolicy;
          }
          if (typeof raw.mcpServers === 'string') {
            this.prefs.mcpServers = raw.mcpServers;
          }
        }
      }
    } catch (e) {
      console.warn('chatgml: could not read prefs', e);
    }
  };

  ConfigBridge.prototype._save = function () {
    try {
      fs.writeFileSync(this.prefsPath, JSON.stringify(this.prefs, null, 2));
    } catch (e) {
      console.warn('chatgml: could not write prefs', e);
    }
  };

  ConfigBridge.prototype.getBinaryPath = function () {
    return this.prefs.binaryPath;
  };
  ConfigBridge.prototype.setBinaryPath = function (value) {
    this.prefs.binaryPath = value || '';
    this._save();
  };
  ConfigBridge.prototype.getScope = function () {
    return this.prefs.scope;
  };
  ConfigBridge.prototype.setScope = function (value) {
    this.prefs.scope = value || '';
    this._save();
  };

  ConfigBridge.prototype.getMcpServers = function () {
    return this.prefs.mcpServers || '{}';
  };

  ConfigBridge.prototype.setMcpServers = function (jsonString) {
    if (typeof jsonString !== 'string') {
      throw new Error('MCP server config must be a JSON string');
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonString);
    } catch (e) {
      throw new Error('invalid JSON: ' + (e.message || e));
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('MCP server config must be an object mapping server names to configs');
    }
    const normalized = JSON.stringify(parsed, null, 2);
    this.prefs.mcpServers = normalized;
    this._save();
    const self = this;
    this.setConfigField('mcpServers', normalized, function (err) {
      if (err) console.warn('chatgml: could not set mcpServers', err);
    });
  };

  ConfigBridge.prototype.getApprovalPolicy = function () {
    return this.prefs.approvalPolicy || {};
  };

  ConfigBridge.prototype.setApprovalPolicy = function (tool, mode) {
    if (!tool || (mode !== 'gated' && mode !== 'auto')) return;
    const policy = this.getApprovalPolicy();
    policy[tool] = mode;
    this.prefs.approvalPolicy = policy;
    this._save();
    if (this._coreAvailable) {
      this.setConfigField('toolApproval.' + tool, mode, function (err) {
        if (err) console.warn('chatgml: could not mirror toolApproval.' + tool, err);
      });
    }
  };

  ConfigBridge.prototype.setCoreAvailable = function (available) {
    this._coreAvailable = !!available;
  };

  /** Resolve the executable the same way the client does (for `config show` and UI display). */
  ConfigBridge.prototype._resolveBinary = function () {
    const distCli = path.join(this.pluginDir, 'dist', 'cli.js');
    const distCliUp = path.join(this.pluginDir, '..', 'dist', 'cli.js');
    return State.resolveServeBinary({
      configuredPath: this.prefs.binaryPath,
      env: process.env,
      platform: process.platform,
      distCliPath: fs.existsSync(distCli) ? distCli : distCliUp,
      nodePath: 'node',
      exists: function (p) {
        return fs.existsSync(p);
      },
    });
  };

  /**
   * Shell `chatgml config show <dir>` and return the parsed (redacted) effective config via callback
   * (err, config). Display-only; secrets are already masked by the core.
   */
  ConfigBridge.prototype.showEffectiveConfig = function (projectDir, cb) {
    let resolved;
    try {
      resolved = this._resolveBinary();
    } catch (err) {
      return cb(err, null);
    }
    const args = resolved.argvPrefix.concat(['config', 'show', projectDir]);
    execFile(resolved.cmd, args, { encoding: 'utf8' }, function (err, stdout) {
      if (err) return cb(err, null);
      // `config show` prints the JSON object then a "config files searched:" footer; parse the
      // leading JSON object only.
      try {
        const end = stdout.indexOf('\n}');
        const jsonText = end >= 0 ? stdout.slice(0, end + 2) : stdout;
        cb(null, JSON.parse(jsonText));
      } catch (parseErr) {
        cb(parseErr, null);
      }
    });
  };

  /**
   * Persist one config field via `chatgml config set <field> <value>` (writes the user-global config
   * file). The core itself refuses literal secrets (exit 2); for the non-secret UI fields we expose
   * here (scope is NOT a config field — scope is a plugin pref; chat.model/approval ARE config
   * fields). Returns the core's stdout text on success. Used by the /model and /approval slash
   * commands from the panel.
   */
  ConfigBridge.prototype.setConfigField = function (field, value, cb) {
    let resolved;
    try {
      resolved = this._resolveBinary();
    } catch (err) {
      return cb(err, null);
    }
    // `scope` is handled as a plugin pref (configBridge.setScope) because the core takes it as a
    // flag at serve argv build time, not a config field. Guard defensively anyway.
    const args = resolved.argvPrefix.concat(['config', 'set', field, value]);
    execFile(resolved.cmd, args, { encoding: 'utf8' }, function (err, stdout, stderr) {
      if (err) return cb(err, null);
      cb(null, stdout || stderr || '');
    });
  };

  const api = { ConfigBridge: ConfigBridge };
  root.ChatGmlConfigBridge = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
