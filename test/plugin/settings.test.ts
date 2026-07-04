// test/plugin/settings.test.ts — audit gap #12 (API key) + #13 (embed model + embed base URL)
//
// The settings dropdown's "Save & Restart" button writes through `chatgml config set <field>
// <value>` (via plugin/config-bridge.js's setConfigField). The save wiring is in
// plugin/chatgml.js (the inline onSaveSettings), which is hard to exercise without a DOM, so the
// save-decision logic is factored out into plugin/settings-tasks.js as a pure helper. This file
// drives that helper directly AND verifies that the new settings panel fields the helper consumes
// are wired correctly (password-type api key, embed.model, embed.baseURL).
//
// Coverage:
//   1. Settings save sends the correct `chatgml config set` commands in the right order, and
//      includes chat.apiKey + embed.model + embed.baseURL.
//   2. Empty / whitespace-only fields are dropped (an accidental blank submit does NOT overwrite
//      a previously saved value). In particular, an empty apiKey submission is a NO-OP.
//   3. The api key placeholder is redacted in the UI: when `cfg.chat.apiKey` is the redacted
//      `***` (as returned by `chatgml config show`), the password input shows the redaction
//      glyph `••••••••` and never echoes the actual value. When no key is set, the placeholder
//      is empty (the input remains usable for the user to paste a new key).
//   4. The scope field is handled separately as a plugin pref (it goes through setScope, not
//      setConfigField).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PLUGIN = path.join(HERE, '../../plugin');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const SettingsTasks = require(path.join(PLUGIN, 'settings-tasks.js')) as {
  buildSettingsCommands: (s: Record<string, unknown>) => {
    commands: Array<[string, string]>;
    scope: string | null;
  };
  apiKeyDisplayPlaceholder: (redacted: string | undefined) => string;
  hasApiKey: (redacted: string | undefined) => boolean;
  providerDerivedCommands: (settings: Record<string, unknown>) => Array<[string, string]>;
  API_KEY_PLACEHOLDER: string;
};

describe('plugin/settings-tasks.js — settings save plan (audit gaps #12 + #13)', () => {
  it('buildSettingsCommands: sends correct config commands in stable order', () => {
    const settings = {
      model: 'qwen2.5-coder',
      baseURL: 'https://api.example.com/v1',
      embedModel: 'text-embedding-3-small',
      embedBaseURL: 'https://api.example.com/v1',
      apiKey: 'env:CHATGML_CHAT_KEY',
      mode: 'code',
      approval: 'gated',
      scope: 'mygame',
    };
    const plan = SettingsTasks.buildSettingsCommands(settings);

    // Order: chat.model, chat.baseURL, embed.model, embed.baseURL, chat.apiKey, mode, approval.
    // Scope is a plugin pref (separate channel) and does NOT appear in `commands`.
    expect(plan.commands).toEqual([
      ['chat.model', 'qwen2.5-coder'],
      ['chat.baseURL', 'https://api.example.com/v1'],
      ['embed.model', 'text-embedding-3-small'],
      ['embed.baseURL', 'https://api.example.com/v1'],
      ['chat.apiKey', 'env:CHATGML_CHAT_KEY'],
      ['mode', 'code'],
      ['approval', 'gated'],
    ]);
    expect(plan.scope).toBe('mygame');
  });

  it('buildSettingsCommands: drops empty / whitespace-only fields (no accidental blanks)', () => {
    // The panel pre-trims the non-secret fields but we still defensively drop empties here so
    // a future caller cannot bypass it.
    const settings = {
      model: '   ',
      baseURL: '',
      embedModel: '',
      embedBaseURL: '\t\n',
      apiKey: '',
      mode: 'ask',
      approval: '',
      scope: '',
    };
    const plan = SettingsTasks.buildSettingsCommands(settings);
    // Only `mode` is non-empty so only `mode` survives.
    expect(plan.commands).toEqual([['mode', 'ask']]);
    expect(plan.scope).toBeNull();
  });

  it('providerDerivedCommands: maps add-provider input to supported config fields', () => {
    expect(
      SettingsTasks.providerDerivedCommands({
        model: 'gpt-4o-mini',
        baseURL: 'https://api.openai.com/v1',
        embedModel: 'text-embedding-3-small',
        apiKey: 'env:OPENAI_API_KEY',
        path: '/chat/completions',
        auth: 'bearer',
      }),
    ).toEqual([
      ['chat.model', 'gpt-4o-mini'],
      ['chat.baseURL', 'https://api.openai.com/v1'],
      ['embed.model', 'text-embedding-3-small'],
      ['chat.apiKey', 'env:OPENAI_API_KEY'],
    ]);
  });

  it('buildSettingsCommands: empty apiKey is a NO-OP (chat.apiKey is NOT in the plan)', () => {
    // Audit gap #12 explicitly: an empty apiKey submission must leave the saved key unchanged.
    const plan = SettingsTasks.buildSettingsCommands({
      model: 'gpt-4o',
      apiKey: '',
    });
    const fields = plan.commands.map((c) => c[0]);
    expect(fields).not.toContain('chat.apiKey');
    expect(plan.commands).toEqual([['chat.model', 'gpt-4o']]);
  });

  it('buildSettingsCommands: whitespace-only apiKey is also a no-op', () => {
    const plan = SettingsTasks.buildSettingsCommands({
      model: 'gpt-4o',
      apiKey: '   \t\n  ',
    });
    const fields = plan.commands.map((c) => c[0]);
    expect(fields).not.toContain('chat.apiKey');
  });

  it('buildSettingsCommands: a non-empty apiKey is queued verbatim (helper does NOT redact)', () => {
    // The helper just decides what to write; redaction of literal secrets is the core's job
    // (SECRET_FIELD_PATHS refuses anything that does not start with `env:`). The helper must
    // pass the value through so an `env:NAME` reference can reach the core for persistence.
    const plan = SettingsTasks.buildSettingsCommands({ apiKey: 'env:CHATGML_CHAT_KEY' });
    expect(plan.commands).toEqual([['chat.apiKey', 'env:CHATGML_CHAT_KEY']]);
  });

  it('buildSettingsCommands: handles missing/undefined settings object safely', () => {
    // Defensive: callers may pass undefined when the panel has not collected anything yet.
    const plan = SettingsTasks.buildSettingsCommands(
      undefined as unknown as Record<string, string>,
    );
    expect(plan.commands).toEqual([]);
    expect(plan.scope).toBeNull();
  });

  it('buildSettingsCommands: scope is a plugin pref (separate from `commands`)', () => {
    // Scope must NOT appear in `commands` because it is not a user-global config field — it is
    // a plugin-local pref that precedes the serve argv on restart.
    const plan = SettingsTasks.buildSettingsCommands({
      scope: 'mygame::sub',
      model: 'm',
    });
    expect(plan.commands.find((c) => c[0] === 'scope')).toBeUndefined();
    expect(plan.scope).toBe('mygame::sub');
  });

  it('buildSettingsCommands: trims surrounding whitespace from non-secret fields', () => {
    const plan = SettingsTasks.buildSettingsCommands({
      model: '  qwen2.5-coder  ',
      baseURL: '  https://x/v1  ',
      embedModel: '  embed-v3  ',
      embedBaseURL: '  https://y/v1  ',
    });
    expect(plan.commands).toEqual([
      ['chat.model', 'qwen2.5-coder'],
      ['chat.baseURL', 'https://x/v1'],
      ['embed.model', 'embed-v3'],
      ['embed.baseURL', 'https://y/v1'],
    ]);
  });

  // ---- Per-tier overrides (Cline-style Plan/Act, audit gap #22) ----
  // The settings panel's "Tiers" subsection collects three slots (planner/implementer/reviewer)
  // each with a Model + Base URL input. The Save & Restart button must convert each non-empty
  // leaf into a `tiers.<name>.<field>` config command (the core's SETTABLE_FIELDS in src/config.ts
  // already accepts these paths). Empty / whitespace-only fields stay dropped, matching the
  // existing drop-empty behavior for the global lane.
  it('buildSettingsCommands: queues tiers.X.model field paths when set', () => {
    const plan = SettingsTasks.buildSettingsCommands({
      tiers: {
        planner: { model: 'o3-mini' },
        implementer: { model: 'qwen2.5-coder' },
        reviewer: { model: 'gpt-4o-mini' },
      },
    });
    expect(plan.commands).toEqual([
      ['tiers.planner.model', 'o3-mini'],
      ['tiers.implementer.model', 'qwen2.5-coder'],
      ['tiers.reviewer.model', 'gpt-4o-mini'],
    ]);
  });

  it('buildSettingsCommands: queues tiers.X.baseURL field paths when set', () => {
    const plan = SettingsTasks.buildSettingsCommands({
      tiers: {
        planner: { baseURL: 'https://planner.example.com/v1' },
        implementer: { baseURL: 'https://code.example.com/v1' },
      },
    });
    expect(plan.commands).toEqual([
      ['tiers.planner.baseURL', 'https://planner.example.com/v1'],
      ['tiers.implementer.baseURL', 'https://code.example.com/v1'],
    ]);
  });

  it('buildSettingsCommands: drops empty / whitespace-only tier leaves (no accidental blanks)', () => {
    // Per-leaf drop behavior, mirroring the global-lane rule. A user editing the panel and
    // clearing one field must NOT have the existing saved value overwritten with ''.
    const plan = SettingsTasks.buildSettingsCommands({
      tiers: {
        planner: { model: 'o3-mini', baseURL: '   ' },
        implementer: { model: '', baseURL: 'https://x/v1' },
        reviewer: { model: '\t\n', baseURL: '' },
      },
    });
    expect(plan.commands).toEqual([
      ['tiers.planner.model', 'o3-mini'],
      ['tiers.implementer.baseURL', 'https://x/v1'],
    ]);
  });

  it('buildSettingsCommands: a tier with no slots produces no tier commands', () => {
    // The `tiers` object present but empty (e.g. the panel was rendered but the user never
    // expanded any of the three <details>) must not produce any tier commands — the helper
    // skips empty/missing slots silently.
    const plan = SettingsTasks.buildSettingsCommands({
      model: 'gpt-4o',
      tiers: {},
    });
    expect(plan.commands).toEqual([['chat.model', 'gpt-4o']]);
  });

  it('buildSettingsCommands: tier commands interleave with global commands in stable order', () => {
    // Order: the existing global fields first (chat.model -> ... -> approval), then the tier
    // leaves in (planner -> implementer -> reviewer) x (model -> baseURL) order. The save
    // handler in chatgml.js writes them sequentially so a partial failure still leaves the
    // earlier writes persisted.
    const plan = SettingsTasks.buildSettingsCommands({
      model: 'gpt-4o',
      apiKey: 'env:CHATGML_CHAT_KEY',
      mode: 'code',
      tiers: {
        planner: { model: 'o3-mini' },
        implementer: { model: 'qwen2.5-coder', baseURL: 'https://code/v1' },
        reviewer: {},
      },
    });
    expect(plan.commands).toEqual([
      ['chat.model', 'gpt-4o'],
      ['chat.apiKey', 'env:CHATGML_CHAT_KEY'],
      ['mode', 'code'],
      ['tiers.planner.model', 'o3-mini'],
      ['tiers.implementer.model', 'qwen2.5-coder'],
      ['tiers.implementer.baseURL', 'https://code/v1'],
    ]);
  });
});

describe('plugin/settings-tasks.js — api key redaction (audit gap #12)', () => {
  it('apiKeyDisplayPlaceholder: returns the redaction glyph when a key is set', () => {
    // The core masks `cfg.chat.apiKey` to `***` in `config show` output. The panel uses this
    // helper to render a placeholder that lets the user know a key is configured WITHOUT
    // echoing the value back.
    expect(SettingsTasks.apiKeyDisplayPlaceholder('***')).toBe('••••••••');
  });

  it('apiKeyDisplayPlaceholder: returns empty string when no key is set', () => {
    // The placeholder is intentionally empty (not the redaction glyph) so the field is inviting
    // and the user knows they can paste a new value.
    expect(SettingsTasks.apiKeyDisplayPlaceholder(undefined)).toBe('');
  });

  it('apiKeyDisplayPlaceholder: defends against a future redaction shape (any non-empty string)', () => {
    // If the core ever changes the redaction token (e.g. `[REDACTED]`), the UI still recognizes
    // it as a set key and shows the redaction glyph.
    expect(SettingsTasks.apiKeyDisplayPlaceholder('[REDACTED]')).toBe('••••••••');
  });

  it('hasApiKey: true iff the redacted value is a non-empty string', () => {
    expect(SettingsTasks.hasApiKey('***')).toBe(true);
    expect(SettingsTasks.hasApiKey(undefined)).toBe(false);
    expect(SettingsTasks.hasApiKey('')).toBe(false);
  });

  it('API_KEY_PLACEHOLDER: stable constant used by the password input', () => {
    // The panel uses this as the input.placeholder default so a user who opens the settings
    // before `setSettingsValues` runs still sees the expected glyph (i.e. never the real key).
    expect(SettingsTasks.API_KEY_PLACEHOLDER).toBe('••••••••');
  });
});

describe('plugin/settings-tasks.js — loadability + global wiring', () => {
  it('exports the helper via module.exports (CommonJS) AND attaches to the renderer global', () => {
    // The plugin loads via a <script> tag in GMEdit's Electron renderer, so the same file must
    // (a) require()-clean in Node test contexts AND (b) populate `globalThis.ChatGmlSettingsTasks`
    // for the panel/chatgml glue to pick up at runtime.
    const fresh = require(path.join(PLUGIN, 'settings-tasks.js')) as Record<string, unknown>;
    expect(typeof fresh.buildSettingsCommands).toBe('function');
    expect(typeof fresh.apiKeyDisplayPlaceholder).toBe('function');
    expect(typeof fresh.hasApiKey).toBe('function');
    // The renderer global is set as a side effect of loading. It is the SAME API namespace
    // object (not a function) so panel.js / chatgml.js can do `root.ChatGmlSettingsTasks = api`.
    const g = (globalThis as Record<string, unknown>)['ChatGmlSettingsTasks'] as
      | Record<string, unknown>
      | undefined;
    expect(g).toBeDefined();
    expect(typeof g?.buildSettingsCommands).toBe('function');
    expect(typeof g?.apiKeyDisplayPlaceholder).toBe('function');
    expect(typeof g?.hasApiKey).toBe('function');
  });
});
