// plugin/settings-tasks.js — pure, DOM-free helper that decides what the settings panel's
// "Save & Restart" button should persist.
//
// Extracted out of plugin/chatgml.js's inline onSaveSettings so the wiring is unit-testable
// without a DOM / without spawning the core. The chatgml glue calls `buildSettingsCommands`
// with the settings object the panel collected, then feeds each `commands[i]` pair through the
// existing `chatgml config set` subcommand (config-bridge.js's setConfigField). `scope` is
// handled separately because it is a plugin-local preference (it must precede the serve argv),
// not a field in the user-global config file.
//
// Behavior:
//   - Empty / whitespace-only fields are DROPPED (never overwrite an existing value with "").
//   - `apiKey` is treated as opaque: we never blank it on empty submit. The core itself
//     refuses literal secrets (only `env:NAME` references are persistable for chat.apiKey); the
//     help text under the field tells the user this.
//   - Field order is stable: model / baseURL / embed.model / embed.baseURL / apiKey / mode /
//     approval, then scope as a separate plugin pref. The save handler in chatgml.js writes them
//     sequentially so a partial failure still leaves the earlier writes persisted.
(function (root) {
  'use strict';

  /**
   * Decide what config commands the panel's "Save & Restart" button should issue, plus whether
   * to also update the plugin-local scope pref.
   *
   * @param {object} settings - the raw settings object the panel collected
   * @param {string} [settings.model]         chat model id (non-empty => chat.model)
   * @param {string} [settings.baseURL]       chat endpoint URL (non-empty => chat.baseURL)
   * @param {string} [settings.embedModel]    embed model id (non-empty => embed.model)
   * @param {string} [settings.embedBaseURL]  embed endpoint URL (non-empty => embed.baseURL)
   * @param {string} [settings.apiKey]        chat API key (non-empty => chat.apiKey; EMPTY IS NO-OP)
   * @param {string} [settings.mode]          mode (non-empty => mode)
   * @param {string} [settings.approval]      approval policy (non-empty => approval)
   * @param {string} [settings.scope]         memory scope (plugin pref, not a config field)
   * @param {object} [settings.tiers]         per-tier overrides: { planner?: {model?,baseURL?}, implementer?: {...}, reviewer?: {...} }
   *                                          Each non-empty leaf becomes a `tiers.X.<field>` config command.
   * @returns {{ commands: Array<[string,string]>, scope: string|null }}
   */
  function buildSettingsCommands(settings) {
    const s = settings || {};
    const commands = [];

    function pushIfNonEmpty(field, value) {
      // Trim once. Empty / whitespace-only is a no-op — never overwrite an existing value with
      // '' (which would silently blank the user's saved config).
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed !== '') commands.push([field, trimmed]);
    }

    pushIfNonEmpty('chat.model', s.model);
    pushIfNonEmpty('chat.baseURL', s.baseURL);
    pushIfNonEmpty('embed.model', s.embedModel);
    pushIfNonEmpty('embed.baseURL', s.embedBaseURL);
    // apiKey: same no-empty rule, but called out separately because empty means "leave unchanged"
    // (NOT "blank it"). The core additionally refuses a literal secret (only env:NAME persists).
    pushIfNonEmpty('chat.apiKey', s.apiKey);
    pushIfNonEmpty('mode', s.mode);
    pushIfNonEmpty('approval', s.approval);

    // Per-tier overrides: each tier slot (planner / implementer / reviewer) is a partial
    // override of the global chat lane. Each non-empty leaf becomes a `tiers.<name>.<field>`
    // dotted-path config command (the core's SETTABLE_FIELDS in src/config.ts already accepts
    // these paths). We whitelist the tier names AND the leaf fields defensively so a future
    // caller can't smuggle in an arbitrary nested write.
    if (s.tiers && typeof s.tiers === 'object') {
      var tierNames = ['planner', 'implementer', 'reviewer'];
      var leafFields = ['model', 'baseURL'];
      for (var ti = 0; ti < tierNames.length; ti++) {
        var tname = tierNames[ti];
        var slot = s.tiers[tname];
        if (!slot || typeof slot !== 'object') continue;
        for (var fi = 0; fi < leafFields.length; fi++) {
          var lf = leafFields[fi];
          pushIfNonEmpty('tiers.' + tname + '.' + lf, slot[lf]);
        }
      }
    }

    const scope = typeof s.scope === 'string' ? s.scope.trim() : '';
    return { commands: commands, scope: scope === '' ? null : scope };
  }

  /**
   * The placeholder shown in the password-type API key input when a key is already set. The user
   * never sees the actual key back in the UI (the core's `config show` already redacts it to
   * `***`, but we keep this constant separate so the panel can render it consistently and the
   * redaction is unit-testable in isolation).
   */
  const API_KEY_PLACEHOLDER = '••••••••';

  /**
   * Given the redacted `cfg.chat.apiKey` value from `chatgml config show` (either the string
   * `***` when a key is set, or `undefined` when none), return the placeholder to display in the
   * password-type input. The actual key value is NEVER echoed back to the UI.
   *
   * @param {string|undefined} redactedApiKey
   * @returns {string} the placeholder (empty when no key is set; the redaction glyph when set)
   */
  function apiKeyDisplayPlaceholder(redactedApiKey) {
    if (typeof redactedApiKey !== 'string' || redactedApiKey.length === 0) return '';
    return API_KEY_PLACEHOLDER;
  }

  /**
   * True when the redacted `cfg.chat.apiKey` from `config show` indicates a key IS set. The core
   * redacts to `***`; we accept any non-empty string as "set" defensively (so a future redaction
   * shape, e.g. `[REDACTED]`, is still recognized).
   */
  function hasApiKey(redactedApiKey) {
    return typeof redactedApiKey === 'string' && redactedApiKey.length > 0;
  }

  /**
   * Decide whether a settings save includes a provider-registry derived entry. The panel stamps a
   * `providerSelected` flag on the settings object when the user picked a row from the providers
   * datalist; if so, the helper trusts the inline Model + Base URL fields (they were populated
   * from the registry entry) and skips the tier-override / re-resolution steps that the panel
   * would otherwise need to run itself.
   *
   * @param {object} settings - the settings object the panel collected
   * @returns {boolean}
   */
  function hasProviderSelection(settings) {
    if (!settings || typeof settings !== 'object') return false;
    if (settings.providerSelected === true) return true;
    // Defensive fallback: a non-empty model + non-empty baseURL are enough to consider the user
    // "selected" — the panel always populates both when picking from the datalist.
    var model = typeof settings.model === 'string' ? settings.model.trim() : '';
    var baseURL = typeof settings.baseURL === 'string' ? settings.baseURL.trim() : '';
    return model !== '' && baseURL !== '';
  }

  /**
   * Build the config writes implied by an Add/Use provider flow. Provider rows may carry path/auth
   * metadata, but the core only exposes the normal chat/embed fields, so unsupported leaves are
   * deliberately ignored here.
   *
   * @param {object} settings
   * @returns {Array<[string,string]>}
   */
  function providerDerivedCommands(settings) {
    return buildSettingsCommands(settings).commands;
  }

  const api = {
    buildSettingsCommands: buildSettingsCommands,
    apiKeyDisplayPlaceholder: apiKeyDisplayPlaceholder,
    hasApiKey: hasApiKey,
    hasProviderSelection: hasProviderSelection,
    providerDerivedCommands: providerDerivedCommands,
    API_KEY_PLACEHOLDER: API_KEY_PLACEHOLDER,
  };

  root.ChatGmlSettingsTasks = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
