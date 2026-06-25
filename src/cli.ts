// src/cli.ts — the commander CLI: `index`, `chat`, `serve`, `config`.
//
// Global options carry the config overrides (chat/embed endpoints, scope, approval, trust). Each
// subcommand resolves the config (flag > env > file > defaults), then wires the runtime: an
// LlmClient over the chat lane, an Embeddings over the (separate) embed lane, a MemoryProvider, and
// the agent. `main(argv, deps)` returns an exit code (0 ok, 2 usage, 3 config error, 1 other) and
// never calls process.exit so it is unit-testable. The runtime pieces are injectable via CliDeps.
import { Command, Option } from 'commander';
import * as readline from 'node:readline';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { argv as processArgv } from 'node:process';
import {
  resolveConfig,
  redact,
  ConfigError,
  configFilePaths,
  setUserGlobalConfigField,
  SECRET_FIELD_PATHS,
  SETTABLE_FIELD_NAMES,
} from './config.js';
import type { Config } from './types.js';
import { LlmClient } from './llm.js';
import { OpenAIEmbeddings, type Embeddings } from './index/embeddings.js';
import { createMemoryProvider, type MemoryProvider } from './memory/provider.js';
import { runIndexCommand } from './index/run-index.js';
import { buildToolRegistry } from './tools/index.js';
import { createAgentLike, type AgentLike, type LlmLike } from './agent.js';
import { runServe, createStdioTransport } from './serve.js';
import { runChatRepl, type LineSource } from './cli/repl.js';
import { supportsColor } from './cli/theme.js';
import { buildIgnoreFilter, DEFAULT_INDEX_EXTENSIONS } from './index/files.js';
import { findYypOnDisk } from './index/gm-resolver.js';

export const EXIT_OK = 0;
export const EXIT_OTHER = 1;
export const EXIT_USAGE = 2;
export const EXIT_CONFIG = 3;

/** The CLI version, read from the bundled package.json (single source of truth; F23). */
export function readPackageVersion(): string {
  // dist/cli.js -> ../package.json (package.json ships alongside dist via the `files` allowlist).
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch {
    // fall through to the safe default below
  }
  return '0.0.0';
}

export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  env: NodeJS.ProcessEnv;
}

export interface CliDeps {
  io?: Partial<CliIo>;
  /** Override the chat model (tests inject a FakeLlm). */
  makeLlm?: (config: Config) => LlmLike;
  /** Override the embeddings (tests inject FakeEmbeddings). */
  makeEmbeddings?: (config: Config) => Embeddings;
  /** Override memory provider construction. */
  makeMemory?: (config: Config, embeddings: Embeddings) => Promise<MemoryProvider>;
  /** Provide a line source for the chat REPL (tests inject scripted lines). */
  makeLineSource?: (io: CliIo) => LineSource;
}

function resolveIo(io?: Partial<CliIo>): CliIo {
  return {
    stdout: io?.stdout ?? process.stdout,
    stderr: io?.stderr ?? process.stderr,
    stdin: io?.stdin ?? process.stdin,
    env: io?.env ?? process.env,
  };
}

interface GlobalFlags {
  chatBaseUrl?: string;
  chatApiKey?: string;
  chatModel?: string;
  embedBaseUrl?: string;
  embedApiKey?: string;
  embedModel?: string;
  scope?: string;
  approval?: string;
  color?: boolean;
  trustProjectConfig?: boolean;
}

function buildConfig(root: string, flags: GlobalFlags, io: CliIo): Config {
  return resolveConfig({
    root,
    flags: flags as Record<string, unknown>,
    env: io.env,
    trustProjectConfig: flags.trustProjectConfig === true,
    warn: (msg) => io.stderr.write(`${msg}\n`),
  });
}

function makeLlm(deps: CliDeps, config: Config): LlmLike {
  if (deps.makeLlm) return deps.makeLlm(config);
  return new LlmClient(config.chat);
}

function makeEmbeddings(deps: CliDeps, config: Config): Embeddings {
  if (deps.makeEmbeddings) return deps.makeEmbeddings(config);
  return new OpenAIEmbeddings({
    baseURL: config.embed.baseURL,
    ...(config.embed.apiKey !== undefined ? { apiKey: config.embed.apiKey } : {}),
    model: config.embed.model,
    batchSize: config.embed.batchSize,
  });
}

async function makeMemory(
  deps: CliDeps,
  config: Config,
  embeddings: Embeddings,
): Promise<MemoryProvider> {
  if (deps.makeMemory) return deps.makeMemory(config, embeddings);
  return createMemoryProvider({ ...config.memory, root: config.index.root }, { embeddings });
}

// ---------------------------------------------------------------------------
// Subcommand implementations.
// ---------------------------------------------------------------------------
async function cmdIndex(root: string, flags: GlobalFlags, deps: CliDeps): Promise<number> {
  const io = resolveIo(deps.io);
  const config = buildConfig(root, flags, io);

  // Validate the index target UP FRONT, before any `.chatgml` store is created. A typo'd path used
  // to be brought into existence by the manifest's mkdir (green "success" + junk dir); a file path
  // leaked a raw ENOTDIR. Both now fail cleanly with a usage exit code.
  const target = config.index.root;
  let stat: import('node:fs').Stats;
  try {
    stat = await fsp.stat(target);
  } catch {
    io.stderr.write(`index: ${target} is not an existing directory\n`);
    return EXIT_USAGE;
  }
  if (!stat.isDirectory()) {
    io.stderr.write(`index: ${target} is a file, expected a directory\n`);
    return EXIT_USAGE;
  }

  const indexDeps = deps.makeEmbeddings ? { embeddings: deps.makeEmbeddings(config) } : {};
  const result = await runIndexCommand(config, indexDeps);
  const gmSuffix = result.gmEnriched > 0 ? `; ${result.gmEnriched} GameMaker-enriched` : '';
  io.stdout.write(
    `indexed: ${result.scanned} scanned, ${result.added} added, ${result.modified} modified, ` +
      `${result.unchanged} unchanged, ${result.deleted} deleted` +
      `${result.fullRebuild ? ' (full rebuild)' : ''}${gmSuffix}\n`,
  );

  // GameMaker confirmation: always note a detected `.yyp`, even when nothing enriched (F22).
  const yyp = await findYypOnDisk(target).catch(() => undefined);
  if (yyp !== undefined) {
    const name = path.basename(yyp);
    io.stdout.write(`GameMaker project detected (${name})\n`);
  }

  // Zero-result signal: a fresh/empty/wrong-extension project indexes nothing, which otherwise looks
  // identical to re-indexing an unchanged repo. Warn, name the indexed extensions, and add a
  // GameMaker hint when a `.yyp` is present but no `.gml` was scanned (F3).
  if (result.scanned === 0) {
    io.stderr.write(
      `warning: indexed 0 files under ${target}. ` +
        `Indexed extensions: ${DEFAULT_INDEX_EXTENSIONS.join(', ')}.\n`,
    );
    if (yyp !== undefined) {
      io.stderr.write(
        `hint: a GameMaker project was detected but it has no .gml files yet — ` +
          `add object/script code, then re-index.\n`,
      );
    }
  }
  return EXIT_OK;
}

async function buildAgent(
  root: string,
  flags: GlobalFlags,
  deps: CliDeps,
): Promise<{ agent: AgentLike; config: Config; memory: MemoryProvider }> {
  const io = resolveIo(deps.io);
  const config = buildConfig(root, flags, io);
  const llm = makeLlm(deps, config);
  const embeddings = makeEmbeddings(deps, config);
  const memory = await makeMemory(deps, config, embeddings);
  const ignore = await buildIgnoreFilter(config.index.root);
  const agent = createAgentLike({
    llm,
    tools: buildToolRegistry(),
    config,
    memory,
    ignore,
    runReindex: async function* () {
      yield { type: 'status', phase: 'indexing' };
      const result = await runIndexCommand(config, { embeddings });
      yield {
        type: 'status',
        phase: 'done',
        detail: `${result.added} added, ${result.modified} modified`,
      };
    },
  });
  return { agent, config, memory };
}

async function cmdChat(root: string, flags: GlobalFlags, deps: CliDeps): Promise<number> {
  const io = resolveIo(deps.io);
  const { agent, memory } = await buildAgent(root, flags, deps);
  const color =
    flags.color === false
      ? false
      : supportsColor({
          isTTY: (io.stdout as NodeJS.WriteStream).isTTY,
          env: { NO_COLOR: io.env['NO_COLOR'], FORCE_COLOR: io.env['FORCE_COLOR'] },
        });

  const lines = deps.makeLineSource ? deps.makeLineSource(io) : readlineLineSource(io);
  try {
    return await runChatRepl({
      agent,
      lines,
      out: io.stdout,
      color,
      promptApproval: deps.makeLineSource
        ? async () => false // tests drive approvals explicitly; default reject
        : makeReadlinePrompt(io),
    });
  } finally {
    if (memory.close) await memory.close();
  }
}

async function cmdServe(root: string, flags: GlobalFlags, deps: CliDeps): Promise<number> {
  const io = resolveIo(deps.io);
  const { agent, memory } = await buildAgent(root, flags, deps);
  const transport = deps.io
    ? { input: io.stdin, output: io.stdout, diagnostics: io.stderr }
    : createStdioTransport();
  try {
    await runServe(agent, { transport });
  } finally {
    if (memory.close) await memory.close();
  }
  return EXIT_OK;
}

function cmdConfigShow(root: string, flags: GlobalFlags, deps: CliDeps): number {
  const io = resolveIo(deps.io);
  const config = buildConfig(root, flags, io);
  io.stdout.write(`${JSON.stringify(redact(config), null, 2)}\n`);
  io.stdout.write(`config files searched:\n`);
  for (const p of configFilePaths(root, io.env)) io.stdout.write(`  - ${p}\n`);
  return EXIT_OK;
}

function cmdConfigSet(field: string, value: string, deps: CliDeps): number {
  const io = resolveIo(deps.io);
  // Refuse a literal secret up front (so the user sees an actionable usage error, exit 2) before we
  // ever touch the filesystem. Persistence itself ALSO refuses literal secrets defensively.
  if (SECRET_FIELD_PATHS.has(field) && !value.startsWith('env:')) {
    io.stderr.write(
      `refusing to persist a literal secret for '${field}'. ` +
        `Use an env reference, e.g.  chatgml config set ${field} env:MY_KEY_VAR\n`,
    );
    return EXIT_USAGE;
  }
  // Durable persistence to the user-global config file (~/.config/chatgml/config.json). This file
  // is the trusted layer and lives OUTSIDE any repo, so no raw key is ever written into a
  // repo-tracked file. ConfigError (unknown field / bad value) maps to exit 3 via main().
  const { filePath } = setUserGlobalConfigField(field, value, io.env);
  io.stdout.write(`set ${field} in ${filePath}\n`);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// readline-backed line source + approval prompt (real interactive REPL).
// ---------------------------------------------------------------------------
function readlineLineSource(io: CliIo): LineSource {
  const rl = readline.createInterface({ input: io.stdin, terminal: false });
  return {
    async *[Symbol.asyncIterator]() {
      io.stdout.write('chatgml> ');
      for await (const line of rl) {
        yield line;
        io.stdout.write('chatgml> ');
      }
    },
  };
}

function makeReadlinePrompt(io: CliIo): (path: string) => Promise<boolean> {
  return (path: string) =>
    new Promise<boolean>((resolve) => {
      const rl = readline.createInterface({ input: io.stdin, output: io.stdout, terminal: false });
      rl.question(`Apply edit to ${path}? [y/N] `, (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 'y');
      });
    });
}

// ---------------------------------------------------------------------------
// Program assembly + main.
// ---------------------------------------------------------------------------
export function buildProgram(deps: CliDeps): {
  program: Command;
  run: () => Promise<number>;
} {
  const io = resolveIo(deps.io);
  const program = new Command();
  let action: (() => Promise<number>) | null = null;

  program
    .name('chatgml')
    .description(
      'GameMaker-aware agentic coding assistant.\n' +
        'Global options must come BEFORE the subcommand, e.g.  chatgml --scope game index .',
    )
    .version(readPackageVersion())
    .option('--chat-base-url <url>', 'chat endpoint base URL (OpenAI-compatible)')
    .option('--chat-api-key <key>', 'chat API key (prefer env:NAME)')
    .option('--chat-model <model>', 'chat model id')
    .option('--embed-base-url <url>', 'embedding endpoint base URL')
    .option('--embed-api-key <key>', 'embedding API key (prefer env:NAME)')
    .option('--embed-model <model>', 'embedding model id')
    .option('--scope <scope>', 'memory scope (repo or repo::sub)')
    .addOption(
      new Option('--approval <mode>', 'edit approval policy').choices(['gated', 'auto']),
    )
    .option('--no-color', 'disable ANSI colors')
    .option('--trust-project-config', 'trust a project-local .chatgml.json (allows auto + secrets)')
    .enablePositionalOptions()
    // Route commander's own output through the injected io streams (so `--help`/`--version` are
    // testable and respect a redirected stdout). Suppress commander's stderr write for usage errors:
    // main() prints the message exactly once (commander used to write it AND main() wrote e.message
    // again -> duplicate lines). `--help`/`--version` use writeOut (stdout), unaffected. (F16)
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: () => {},
    })
    .exitOverride(); // throw instead of process.exit so main() controls the code

  const flagsOf = (cmd: Command): GlobalFlags => ({
    ...(program.opts() as GlobalFlags),
    ...(cmd.opts() as GlobalFlags),
  });

  program
    .command('index')
    .argument('[dir]', 'project directory', '.')
    .description('build or update the local index')
    .action(async (dir: string, _opts, cmd: Command) => {
      action = () => cmdIndex(dir, flagsOf(cmd), deps);
    });

  program
    .command('chat')
    .argument('[dir]', 'project directory', '.')
    .description('start an interactive chat session')
    .action(async (dir: string, _opts, cmd: Command) => {
      action = () => cmdChat(dir, flagsOf(cmd), deps);
    });

  program
    .command('serve')
    .argument('[dir]', 'project directory', '.')
    .description('expose the agent over NDJSON on stdio')
    .action(async (dir: string, _opts, cmd: Command) => {
      action = () => cmdServe(dir, flagsOf(cmd), deps);
    });

  const config = program.command('config').description('inspect or set configuration');
  config
    .command('show')
    .argument('[dir]', 'project directory', '.')
    .description('print the resolved config (secrets redacted)')
    .action(async (dir: string, _opts, cmd: Command) => {
      action = () => Promise.resolve(cmdConfigShow(dir, flagsOf(cmd), deps));
    });
  config
    .command('set')
    .argument('<field>', 'a settable field (see below)')
    .argument('<value>', 'the value (secret fields accept only env:NAME)')
    .description('set a config field in the user-global config (refuses literal secrets)')
    .addHelpText(
      'after',
      '\nWrites the user-global config (~/.config/chatgml/config.json) — never a repo file.\n' +
        `Settable fields:\n  ${SETTABLE_FIELD_NAMES.join('\n  ')}\n\n` +
        `Secret fields (${[...SECRET_FIELD_PATHS].join(', ')}) accept ONLY an env reference,\n` +
        'e.g.  chatgml config set chat.apiKey env:OPENAI_API_KEY',
    )
    .action(async (field: string, value: string) => {
      action = () => Promise.resolve(cmdConfigSet(field, value, deps));
    });

  return {
    program,
    run: async (): Promise<number> => {
      if (!action) return EXIT_USAGE;
      return action();
    },
  };
}

/**
 * Parse argv and execute. Returns an exit code; never calls process.exit. Maps ConfigError -> 3,
 * commander usage errors -> 2, anything else -> 1.
 */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const io = resolveIo(deps.io);
  // No arguments at all -> print usage to stderr and exit 2 (deterministic, testable).
  if (argv.length === 0) {
    io.stderr.write('usage: chatgml <index|chat|serve|config> [dir] [options]\n');
    return EXIT_USAGE;
  }
  const { program, run } = buildProgram(deps);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    // commander.exitOverride throws CommanderError; --version/--help exit 0.
    const e = err as { code?: string; exitCode?: number; message?: string };
    if (e.code === 'commander.version' || e.code === 'commander.helpDisplayed' || e.code === 'commander.help') {
      return EXIT_OK;
    }
    let msg = e.message ?? 'usage error';
    // An unknown option is usually a global flag placed AFTER the subcommand. Make that fixable. (F19)
    if (e.code === 'commander.unknownOption') {
      msg += '\n(global options like --scope/--approval must come BEFORE the subcommand)';
    }
    io.stderr.write(`${msg}\n`);
    return EXIT_USAGE;
  }
  try {
    return await run();
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr.write(`config error: ${err.message}\n`);
      return EXIT_CONFIG;
    }
    io.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_OTHER;
  }
}

/** True when this module is the process entry point (run directly as `node dist/cli.js`). */
function isMainModule(): boolean {
  const entry = processArgv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

// Auto-run when executed directly (this is the `bin` target, dist/cli.js). Imported as a library
// (the barrel, tests), this block is inert.
if (isMainModule()) {
  void main(processArgv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
