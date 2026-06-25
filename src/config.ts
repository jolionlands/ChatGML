// src/config.ts — config loading, merging, validation, and secret resolution.
//
// Resolution order (highest precedence first): flags > env (CHATGML_*) > config file > DEFAULTS,
// with a deep per-key merge. Secrets are resolved from `env:NAME` references and are NEVER logged.
//
// Security (audit §8.2): the per-project `<root>/.chatgml.json` is UNTRUSTED. It may not supply or
// override a secret-bearing endpoint (chat.baseURL / embed.baseURL / memory.hippo.url) while the
// matching key resolves from `env:` — rejected unless `trustProjectConfig` is set. `approval:'auto'`
// may never be sourced from the project layer.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';

import type { Config, ChatLane, EmbedLane, MemoryConfig } from './types.js';
export type { Config, ChatLane, EmbedLane, MemoryConfig };

// ---------------------------------------------------------------------------
// The ONE defaults object.
// ---------------------------------------------------------------------------
export const DEFAULTS = {
  chat: { temperature: 0.2 },
  embed: { batchSize: 64 },
  memory: { provider: 'local' },
  approval: 'gated',
  index: { chunkSize: 1500, chunkOverlap: 200 },
} as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ---------------------------------------------------------------------------
// Secret resolution: `env:NAME` -> process.env[NAME]. A literal value is passed through.
// ---------------------------------------------------------------------------
export function resolveSecret(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith('env:')) {
    const name = value.slice('env:'.length);
    return env[name];
  }
  return value;
}

/** True when a raw secret reference is an `env:NAME` indirection (vs a literal). */
function isEnvRef(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('env:');
}

/** True when a secret field holds a literal (non-`env:`) value — a leak risk in a tracked file. */
function hasLiteralSecret(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('env:');
}

// ---------------------------------------------------------------------------
// Config file discovery + loading.
// ---------------------------------------------------------------------------

/** User-global config path: ~/.config/chatgml/config.json (XDG-ish; trusted layer). */
export function userGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'chatgml', 'config.json');
}

/** Project-local config path: <root>/.chatgml.json (UNTRUSTED layer). */
function projectConfigPath(root: string): string {
  return path.join(root, '.chatgml.json');
}

/**
 * Candidate config paths, highest precedence first: the per-project file (untrusted) then the
 * user-global file (trusted).
 */
export function configFilePaths(root: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [projectConfigPath(root), userGlobalConfigPath(env)];
}

interface LoadedFile {
  value: unknown;
  path: string;
  trusted: boolean; // false for the per-project file
}

function readJsonFile(p: string): unknown | undefined {
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return undefined; // missing/unreadable -> treated as absent
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConfigError(`config file is not valid JSON: ${p}`);
  }
}

/**
 * Load the first existing config file. The project file takes precedence over the user-global file.
 * Returns the loaded object plus whether it came from a trusted layer.
 */
export function loadConfigFile(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): LoadedFile | null {
  const projectPath = projectConfigPath(root);
  const projectValue = readJsonFile(projectPath);
  if (projectValue !== undefined) {
    return { value: projectValue, path: projectPath, trusted: false };
  }
  const globalPath = userGlobalConfigPath(env);
  const globalValue = readJsonFile(globalPath);
  if (globalValue !== undefined) {
    return { value: globalValue, path: globalPath, trusted: true };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Zod schemas for the file/flag-shaped (partial, pre-merge) config.
// ---------------------------------------------------------------------------
const PartialChatSchema = z
  .object({
    baseURL: z.string(),
    apiKey: z.string(),
    model: z.string(),
    temperature: z.number(),
    maxTokens: z.number(),
  })
  .partial()
  .strict();

const PartialEmbedSchema = z
  .object({
    baseURL: z.string(),
    apiKey: z.string(),
    model: z.string(),
    batchSize: z.number(),
  })
  .partial()
  .strict();

const PartialMemorySchema = z
  .object({
    provider: z.enum(['local', 'hippo']),
    url: z.string(),
    key: z.string(),
  })
  .partial()
  .strict();

const PartialIndexSchema = z
  .object({
    chunkSize: z.number(),
    chunkOverlap: z.number(),
    root: z.string(),
  })
  .partial()
  .strict();

const PartialConfigSchema = z
  .object({
    chat: PartialChatSchema,
    embed: PartialEmbedSchema,
    memory: PartialMemorySchema,
    scope: z.string(),
    approval: z.enum(['gated', 'auto']),
    index: PartialIndexSchema,
  })
  .partial()
  .strict();

type PartialConfig = z.infer<typeof PartialConfigSchema>;

function parsePartial(value: unknown, source: string): PartialConfig {
  const result = PartialConfigSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigError(`invalid config (${source}): ${describeZodIssue(result.error)}`);
  }
  return result.data;
}

/**
 * A human-readable description of the FIRST zod issue. Unlike `path.join('.')` (which is empty for an
 * `unrecognized_keys` issue at the root), this names the offending key and, for enum failures, lists
 * the allowed values — so the message is actionable (F18).
 */
function describeZodIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid';
  const at = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  if (issue.code === 'unrecognized_keys') {
    const keys = (issue as z.ZodIssue & { keys?: string[] }).keys ?? [];
    const where = at === '(root)' ? '' : ` under '${at}'`;
    return `unknown field(s) [${keys.join(', ')}]${where}`;
  }
  if (issue.code === 'invalid_enum_value') {
    const opts = (issue as z.ZodIssue & { options?: readonly unknown[] }).options ?? [];
    return `bad field '${at}': allowed values are ${opts.map((o) => JSON.stringify(o)).join(', ')}`;
  }
  return `bad field '${at}'`;
}

// ---------------------------------------------------------------------------
// Layer extraction from flags + env.
// ---------------------------------------------------------------------------
function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Build a partial-config layer from CLI flags (camelCase keys). */
function layerFromFlags(flags: Record<string, unknown>): PartialConfig {
  const out: PartialConfig = {};
  const chat: NonNullable<PartialConfig['chat']> = {};
  if (str(flags['chatBaseUrl'])) chat.baseURL = str(flags['chatBaseUrl']);
  if (str(flags['chatApiKey'])) chat.apiKey = str(flags['chatApiKey']);
  if (str(flags['chatModel'])) chat.model = str(flags['chatModel']);
  if (num(flags['temperature']) !== undefined) chat.temperature = num(flags['temperature']);
  if (Object.keys(chat).length > 0) out.chat = chat;

  const embed: NonNullable<PartialConfig['embed']> = {};
  if (str(flags['embedBaseUrl'])) embed.baseURL = str(flags['embedBaseUrl']);
  if (str(flags['embedApiKey'])) embed.apiKey = str(flags['embedApiKey']);
  if (str(flags['embedModel'])) embed.model = str(flags['embedModel']);
  if (Object.keys(embed).length > 0) out.embed = embed;

  if (str(flags['scope'])) out.scope = str(flags['scope']);
  if (flags['approval'] === 'gated' || flags['approval'] === 'auto') {
    out.approval = flags['approval'];
  }
  return out;
}

/** Build a partial-config layer from CHATGML_* env vars. */
function layerFromEnv(env: NodeJS.ProcessEnv): PartialConfig {
  const out: PartialConfig = {};
  const chat: NonNullable<PartialConfig['chat']> = {};
  if (str(env['CHATGML_CHAT_BASE_URL'])) chat.baseURL = str(env['CHATGML_CHAT_BASE_URL']);
  if (str(env['CHATGML_CHAT_API_KEY'])) chat.apiKey = str(env['CHATGML_CHAT_API_KEY']);
  if (str(env['CHATGML_CHAT_MODEL'])) chat.model = str(env['CHATGML_CHAT_MODEL']);
  if (Object.keys(chat).length > 0) out.chat = chat;

  const embed: NonNullable<PartialConfig['embed']> = {};
  if (str(env['CHATGML_EMBED_BASE_URL'])) embed.baseURL = str(env['CHATGML_EMBED_BASE_URL']);
  if (str(env['CHATGML_EMBED_API_KEY'])) embed.apiKey = str(env['CHATGML_EMBED_API_KEY']);
  if (str(env['CHATGML_EMBED_MODEL'])) embed.model = str(env['CHATGML_EMBED_MODEL']);
  if (Object.keys(embed).length > 0) out.embed = embed;

  if (str(env['CHATGML_SCOPE'])) out.scope = str(env['CHATGML_SCOPE']);
  const approval = env['CHATGML_APPROVAL'];
  if (approval === 'gated' || approval === 'auto') out.approval = approval;
  return out;
}

// ---------------------------------------------------------------------------
// Resolution: merge layers (flags > env > file > defaults), validate, enforce security guards.
// ---------------------------------------------------------------------------
export interface ResolveConfigArgs {
  root: string;
  flags: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  cwdConfigPath?: string;
  trustProjectConfig?: boolean;
  /** Optional sink for non-fatal diagnostics (e.g. a plaintext secret in the project file). */
  warn?: (message: string) => void;
}

export function resolveConfig(args: ResolveConfigArgs): Config {
  const { root, flags, env, trustProjectConfig = false } = args;

  const flagLayer = layerFromFlags(flags);
  const envLayer = layerFromEnv(env);

  const loaded = loadConfigFile(root, env);
  const fileLayer: PartialConfig = loaded
    ? parsePartial(loaded.value, loaded.path)
    : {};
  const fileTrusted = loaded ? loaded.trusted : true;

  // --- Untrusted project-config guards (only when the file layer is the untrusted project file).
  if (loaded && !loaded.trusted && !trustProjectConfig) {
    // approval:'auto' may not be sourced from the project layer.
    if (fileLayer.approval === 'auto') {
      throw new ConfigError(
        "untrusted project config may not set approval='auto' (pass --trust-project-config to allow)",
      );
    }
    // A project file may not override a secret-bearing endpoint while the matching key is env-sourced.
    assertNoUntrustedSecretEndpoint(fileLayer, flagLayer, envLayer, env);
  }

  // --- Deep merge: defaults < file < env < flags.
  const chat = mergeChat(fileLayer.chat, envLayer.chat, flagLayer.chat);
  const embed = mergeEmbed(fileLayer.embed, envLayer.embed, flagLayer.embed, chat);
  const memory = mergeMemory(fileLayer.memory, envLayer.memory, flagLayer.memory);
  const scope = flagLayer.scope ?? envLayer.scope ?? fileLayer.scope;
  const approval =
    flagLayer.approval ?? envLayer.approval ?? fileLayer.approval ?? DEFAULTS.approval;
  const index = mergeIndex(fileLayer.index, root);

  // --- Required-field validation (paths only in error messages, never values).
  if (chat.baseURL === undefined) {
    throw new ConfigError("missing required config field 'chat.baseURL'");
  }
  if (chat.model === undefined) {
    throw new ConfigError("missing required config field 'chat.model'");
  }
  // Resolved open question #1: embed requires its own model (no fallback for the model).
  if (embed.model === undefined) {
    throw new ConfigError("missing required config field 'embed.model'");
  }
  if (scope === undefined) {
    throw new ConfigError("missing required config field 'scope'");
  }
  if (memory.value.provider === 'hippo' && memory.value.url === undefined) {
    throw new ConfigError("missing required config field 'memory.hippo.url'");
  }

  // Resolve `env:NAME` secret references into their actual values (the returned Config carries
  // usable keys). The untrusted-config guard above already ran on the RAW references, so resolution
  // here cannot defeat it.
  const chatKey = resolveSecret(chat.apiKey, env);
  const chatLane: ChatLane = {
    baseURL: chat.baseURL,
    model: chat.model,
    temperature: chat.temperature ?? DEFAULTS.chat.temperature,
  };
  if (chatKey !== undefined) chatLane.apiKey = chatKey;
  if (chat.maxTokens !== undefined) chatLane.maxTokens = chat.maxTokens;

  // embed lane falls back to chat's baseURL/apiKey (but NOT model).
  const embedKey = resolveSecret(embed.apiKey, env) ?? chatKey;
  const embedLane: EmbedLane = {
    baseURL: embed.baseURL ?? chat.baseURL,
    model: embed.model,
    batchSize: embed.batchSize ?? DEFAULTS.embed.batchSize,
  };
  if (embedKey !== undefined) embedLane.apiKey = embedKey;

  // Resolve the hippo key reference if present.
  let memoryValue = memory.value;
  if (memoryValue.provider === 'hippo' && memoryValue.key !== undefined) {
    const hippoKey = resolveSecret(memoryValue.key, env);
    memoryValue =
      hippoKey !== undefined
        ? { provider: 'hippo', url: memoryValue.url, key: hippoKey }
        : { provider: 'hippo', url: memoryValue.url };
  }

  // When the loaded layer is the UNTRUSTED project file and it carries a literal (non-env:) secret,
  // warn loudly (redacted): a raw key in a repo-tracked file is a leak risk. The value is consumed
  // (and redacted on display) but the on-disk file still holds the secret. (F14)
  if (loaded !== null && !fileTrusted && args.warn) {
    const fileLayerRaw = fileLayer;
    const literals: string[] = [];
    if (hasLiteralSecret(fileLayerRaw.chat?.apiKey)) literals.push('chat.apiKey');
    if (hasLiteralSecret(fileLayerRaw.embed?.apiKey)) literals.push('embed.apiKey');
    if (hasLiteralSecret(fileLayerRaw.memory?.key)) literals.push('memory.hippo.key');
    if (literals.length > 0) {
      args.warn(
        `WARNING: ${loaded.path} contains a literal secret for [${literals.join(', ')}]. ` +
          `Use an env reference (e.g. "env:OPENAI_API_KEY") and gitignore .chatgml.json so a raw ` +
          `key is never committed.`,
      );
    }
  }

  const config: Config = {
    chat: chatLane,
    embed: embedLane,
    memory: memoryValue,
    scope,
    approval,
    index,
  };
  return config;
}

// ---------------------------------------------------------------------------
// Merge helpers (each later layer overrides per-key; undefined never clobbers).
// ---------------------------------------------------------------------------
interface ChatMerged {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

function pick<T>(...vals: (T | undefined)[]): T | undefined {
  for (const v of vals) if (v !== undefined) return v;
  return undefined;
}

function mergeChat(
  file: PartialConfig['chat'],
  env: PartialConfig['chat'],
  flags: PartialConfig['chat'],
): ChatMerged {
  return {
    baseURL: pick(flags?.baseURL, env?.baseURL, file?.baseURL),
    apiKey: pick(flags?.apiKey, env?.apiKey, file?.apiKey),
    model: pick(flags?.model, env?.model, file?.model),
    temperature: pick(flags?.temperature, env?.temperature, file?.temperature),
    maxTokens: pick(flags?.maxTokens, env?.maxTokens, file?.maxTokens),
  };
}

interface EmbedMerged {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  batchSize?: number;
}

function mergeEmbed(
  file: PartialConfig['embed'],
  env: PartialConfig['embed'],
  flags: PartialConfig['embed'],
  _chat: ChatMerged,
): EmbedMerged {
  return {
    baseURL: pick(flags?.baseURL, env?.baseURL, file?.baseURL),
    apiKey: pick(flags?.apiKey, env?.apiKey, file?.apiKey),
    model: pick(flags?.model, env?.model, file?.model),
    batchSize: pick(flags?.batchSize, env?.batchSize, file?.batchSize),
  };
}

function mergeMemory(
  file: PartialConfig['memory'],
  env: PartialConfig['memory'],
  flags: PartialConfig['memory'],
): { value: MemoryConfig } {
  const provider = pick(flags?.provider, env?.provider, file?.provider) ?? DEFAULTS.memory.provider;
  if (provider === 'hippo') {
    const url = pick(flags?.url, env?.url, file?.url);
    const key = pick(flags?.key, env?.key, file?.key);
    const value: MemoryConfig =
      url !== undefined
        ? key !== undefined
          ? { provider: 'hippo', url, key }
          : { provider: 'hippo', url }
        : // url is required for hippo; leave undefined so resolveConfig raises a path-only error.
          ({ provider: 'hippo', url: undefined as unknown as string } as MemoryConfig);
    return { value };
  }
  return { value: { provider: 'local' } };
}

function mergeIndex(
  file: PartialConfig['index'],
  root: string,
): { chunkSize: number; chunkOverlap: number; root: string } {
  return {
    chunkSize: file?.chunkSize ?? DEFAULTS.index.chunkSize,
    chunkOverlap: file?.chunkOverlap ?? DEFAULTS.index.chunkOverlap,
    root: file?.root ?? root,
  };
}

// ---------------------------------------------------------------------------
// Untrusted-config endpoint guard.
// ---------------------------------------------------------------------------
function assertNoUntrustedSecretEndpoint(
  file: PartialConfig,
  flags: PartialConfig,
  env: PartialConfig,
  processEnv: NodeJS.ProcessEnv,
): void {
  // chat lane
  checkPair(
    'chat.baseURL',
    file.chat?.baseURL,
    pick(flags.chat?.apiKey, env.chat?.apiKey),
    processEnv,
  );
  // embed lane
  checkPair(
    'embed.baseURL',
    file.embed?.baseURL,
    pick(flags.embed?.apiKey, env.embed?.apiKey, flags.chat?.apiKey, env.chat?.apiKey),
    processEnv,
  );
  // memory.hippo.url
  checkPair(
    'memory.hippo.url',
    file.memory?.url,
    pick(flags.memory?.key, env.memory?.key),
    processEnv,
  );
}

function checkPair(
  fieldPath: string,
  fileEndpoint: string | undefined,
  trustedKeyRef: string | undefined,
  _env: NodeJS.ProcessEnv,
): void {
  // The project file is trying to set a secret-bearing endpoint while the matching key resolves
  // from an env: reference supplied by a trusted layer. Refuse.
  if (fileEndpoint !== undefined && isEnvRef(trustedKeyRef)) {
    throw new ConfigError(
      `untrusted project config may not override '${fieldPath}' while its key resolves from env: ` +
        `(pass --trust-project-config to allow)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Redaction: mask secrets before logging/printing. Never mutates the input.
// ---------------------------------------------------------------------------
const REDACTED = '***';

export function redact(config: Config): unknown {
  const out: Record<string, unknown> = {
    chat: {
      baseURL: config.chat.baseURL,
      model: config.chat.model,
      temperature: config.chat.temperature,
      ...(config.chat.maxTokens !== undefined ? { maxTokens: config.chat.maxTokens } : {}),
      ...(config.chat.apiKey !== undefined ? { apiKey: REDACTED } : {}),
    },
    embed: {
      baseURL: config.embed.baseURL,
      model: config.embed.model,
      batchSize: config.embed.batchSize,
      ...(config.embed.apiKey !== undefined ? { apiKey: REDACTED } : {}),
    },
    memory:
      config.memory.provider === 'hippo'
        ? {
            provider: 'hippo',
            url: config.memory.url,
            ...(config.memory.key !== undefined ? { key: REDACTED } : {}),
          }
        : { provider: 'local' },
    scope: config.scope,
    approval: config.approval,
    index: config.index,
  };
  return out;
}

// ---------------------------------------------------------------------------
// Durable `config set`: write a single field to the user-global config file.
//
// The user-global file (~/.config/chatgml/config.json) is the TRUSTED layer and lives OUTSIDE any
// repo, so it is the only durable target for `config set`. Secret fields (chat.apiKey /
// embed.apiKey / memory.hippo.key) may only be set to an `env:NAME` reference — a literal key is
// refused so a raw secret is never written to disk (and never into a repo-tracked file).
// ---------------------------------------------------------------------------

/** The dotted field paths that carry a secret; only an `env:NAME` reference is persistable. */
export const SECRET_FIELD_PATHS = new Set(['chat.apiKey', 'embed.apiKey', 'memory.hippo.key']);

/**
 * The dotted field paths `config set` understands, mapped to where they live in the partial-config
 * object. `memory.hippo.url`/`memory.hippo.key` write to `memory.url`/`memory.key` (the provider is
 * implied). Anything else is rejected as an unknown field.
 */
const SETTABLE_FIELDS: Record<string, { path: string[]; type: 'string' | 'number' }> = {
  'chat.baseURL': { path: ['chat', 'baseURL'], type: 'string' },
  'chat.apiKey': { path: ['chat', 'apiKey'], type: 'string' },
  'chat.model': { path: ['chat', 'model'], type: 'string' },
  'chat.temperature': { path: ['chat', 'temperature'], type: 'number' },
  'chat.maxTokens': { path: ['chat', 'maxTokens'], type: 'number' },
  'embed.baseURL': { path: ['embed', 'baseURL'], type: 'string' },
  'embed.apiKey': { path: ['embed', 'apiKey'], type: 'string' },
  'embed.model': { path: ['embed', 'model'], type: 'string' },
  'embed.batchSize': { path: ['embed', 'batchSize'], type: 'number' },
  'memory.provider': { path: ['memory', 'provider'], type: 'string' },
  'memory.hippo.url': { path: ['memory', 'url'], type: 'string' },
  'memory.hippo.key': { path: ['memory', 'key'], type: 'string' },
  scope: { path: ['scope'], type: 'string' },
  approval: { path: ['approval'], type: 'string' },
  'index.chunkSize': { path: ['index', 'chunkSize'], type: 'number' },
  'index.chunkOverlap': { path: ['index', 'chunkOverlap'], type: 'number' },
  'index.root': { path: ['index', 'root'], type: 'string' },
};

/** The dotted field names `config set` accepts (sorted), for help text and validation hints. */
export const SETTABLE_FIELD_NAMES: readonly string[] = Object.keys(SETTABLE_FIELDS).sort();

export interface SetConfigResult {
  /** The absolute path of the user-global config file that was written. */
  filePath: string;
}

/**
 * Set a single config field in the user-global config file, creating it (and its directory) if
 * needed. Refuses a literal secret for a secret field (only `env:NAME` is allowed). Coerces numeric
 * fields. Validates the merged result against the partial-config schema so a bad write is rejected.
 * Never touches any repo-tracked file (always the user-global path).
 *
 * @throws {ConfigError} on an unknown field, a literal secret, a bad numeric value, or a result that
 *   fails schema validation.
 */
export function setUserGlobalConfigField(
  field: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): SetConfigResult {
  const spec = SETTABLE_FIELDS[field];
  if (!spec) {
    throw new ConfigError(`unknown config field '${field}'`);
  }
  if (SECRET_FIELD_PATHS.has(field) && !isEnvRef(value)) {
    throw new ConfigError(
      `refusing to persist a literal secret for '${field}'; use an env reference (env:NAME)`,
    );
  }

  // Coerce the value to the field's type.
  let coerced: string | number;
  if (spec.type === 'number') {
    const n = num(value);
    if (n === undefined) {
      throw new ConfigError(`config field '${field}' expects a number, got '${value}'`);
    }
    coerced = n;
  } else {
    coerced = value;
  }

  const filePath = userGlobalConfigPath(env);

  // Load the existing user-global file (if any) as a mutable object. A corrupt file is a hard error
  // rather than a silent overwrite (so a typo never nukes the user's config).
  let current: Record<string, unknown> = {};
  const existing = readJsonFile(filePath); // throws ConfigError on invalid JSON
  if (existing !== undefined) {
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      throw new ConfigError(`existing config file is not a JSON object: ${filePath}`);
    }
    current = { ...(existing as Record<string, unknown>) };
  }

  setNested(current, spec.path, coerced);

  // Validate the merged object so we never write a structurally-invalid config.
  const parsed = PartialConfigSchema.safeParse(current);
  if (!parsed.success) {
    throw new ConfigError(
      `config field '${field}' would make the config invalid: ${describeZodIssue(parsed.error)}`,
    );
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  return { filePath };
}

/** Set a nested value, creating intermediate plain objects as needed. */
function setNested(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    const child = node[k];
    if (typeof child !== 'object' || child === null || Array.isArray(child)) {
      node[k] = {};
    }
    node = node[k] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]!] = value;
}
