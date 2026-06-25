import { describe, it, expect, afterEach } from 'vitest';
import { Writable, Readable } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, EXIT_USAGE, EXIT_CONFIG, EXIT_OK } from '../src/cli.js';
import type { CliDeps, CliIo } from '../src/cli.js';
import { FakeEmbeddings } from './helpers/fakes.js';
import { FakeLlm } from './helpers/fake-llm.js';
import { makeTmpRepo } from './helpers/fakes.js';
import type { LineSource } from '../src/cli/repl.js';

const SENTINEL = 'sk-SENTINEL-DEADBEEF';

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function sink(): { out: Writable; text: () => string } {
  const chunks: string[] = [];
  const out = new Writable({
    write(c, _e, cb) {
      chunks.push(String(c));
      cb();
    },
  });
  return { out, text: () => chunks.join('') };
}

function baseEnv(): NodeJS.ProcessEnv {
  return {
    CHATGML_CHAT_BASE_URL: 'http://chat.local/v1',
    CHATGML_CHAT_MODEL: 'test-chat',
    CHATGML_CHAT_API_KEY: SENTINEL,
    CHATGML_EMBED_MODEL: 'test-embed',
    CHATGML_SCOPE: 'game',
  };
}

function depsWith(over: Partial<CliDeps> & { io: CliIo }): CliDeps {
  return {
    makeLlm: () => new FakeLlm([{ tokens: ['ok'] }]),
    makeEmbeddings: () => new FakeEmbeddings(),
    ...over,
  };
}

describe('cli main', () => {
  it('config show prints a redacted config (sentinel never appears)', async () => {
    const { out, text } = sink();
    const err = sink();
    const io: CliIo = { stdout: out, stderr: err.out, stdin: Readable.from([]), env: baseEnv() };
    const repo = makeTmpRepo({ 'a.gml': 'x\n' });
    cleanup = repo.cleanup;
    const code = await main(['config', 'show', repo.root], { io });
    expect(code).toBe(EXIT_OK);
    expect(text()).toContain('"apiKey": "***"');
    expect(text()).not.toContain(SENTINEL);
    expect(err.text()).not.toContain(SENTINEL);
  });

  it('config set refuses a literal secret and exits usage (nothing written)', async () => {
    const xdg = mkdtempSync(path.join(tmpdir(), 'chatgml-cli-xdg-'));
    cleanup = () => rmSync(xdg, { recursive: true, force: true });
    const out = sink();
    const err = sink();
    const io: CliIo = {
      stdout: out.out,
      stderr: err.out,
      stdin: Readable.from([]),
      env: { ...baseEnv(), XDG_CONFIG_HOME: xdg },
    };
    const code = await main(['config', 'set', 'chat.apiKey', SENTINEL], { io });
    expect(code).toBe(EXIT_USAGE);
    expect(err.text()).toContain('refusing to persist a literal secret');
    expect(out.text()).not.toContain(SENTINEL);
    // The literal secret must never have been written anywhere.
    expect(existsSync(path.join(xdg, 'chatgml', 'config.json'))).toBe(false);
  });

  it('config set DURABLY persists an env: reference to the user-global file', async () => {
    const xdg = mkdtempSync(path.join(tmpdir(), 'chatgml-cli-xdg-'));
    cleanup = () => rmSync(xdg, { recursive: true, force: true });
    const out = sink();
    const io: CliIo = {
      stdout: out.out,
      stderr: sink().out,
      stdin: Readable.from([]),
      env: { ...baseEnv(), XDG_CONFIG_HOME: xdg },
    };
    const code = await main(['config', 'set', 'chat.apiKey', 'env:MY_KEY'], { io });
    expect(code).toBe(EXIT_OK);
    const file = path.join(xdg, 'chatgml', 'config.json');
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    // The env: REFERENCE is persisted (never the resolved secret), and re-reads after restart.
    expect(written.chat.apiKey).toBe('env:MY_KEY');
    expect(JSON.stringify(written)).not.toContain(SENTINEL);
  });

  it('config set persists a non-secret field and round-trips', async () => {
    const xdg = mkdtempSync(path.join(tmpdir(), 'chatgml-cli-xdg-'));
    cleanup = () => rmSync(xdg, { recursive: true, force: true });
    const io: CliIo = {
      stdout: sink().out,
      stderr: sink().out,
      stdin: Readable.from([]),
      env: { ...baseEnv(), XDG_CONFIG_HOME: xdg },
    };
    expect(await main(['config', 'set', 'chat.model', 'persisted-model'], { io })).toBe(EXIT_OK);
    expect(await main(['config', 'set', 'scope', 'persisted-scope'], { io })).toBe(EXIT_OK);
    const written = JSON.parse(
      readFileSync(path.join(xdg, 'chatgml', 'config.json'), 'utf8'),
    );
    expect(written.chat.model).toBe('persisted-model');
    expect(written.scope).toBe('persisted-scope'); // second set merges, not clobbers
  });

  it('config set on an unknown field -> config error (exit 3)', async () => {
    const xdg = mkdtempSync(path.join(tmpdir(), 'chatgml-cli-xdg-'));
    cleanup = () => rmSync(xdg, { recursive: true, force: true });
    const io: CliIo = {
      stdout: sink().out,
      stderr: sink().out,
      stdin: Readable.from([]),
      env: { ...baseEnv(), XDG_CONFIG_HOME: xdg },
    };
    const code = await main(['config', 'set', 'chat.bogus', 'x'], { io });
    expect(code).toBe(EXIT_CONFIG);
  });

  it('missing required config field -> exit code 3 (ConfigError)', async () => {
    const err = sink();
    const io: CliIo = {
      stdout: sink().out,
      stderr: err.out,
      stdin: Readable.from([]),
      env: {}, // no chat.baseURL/model/scope
    };
    const repo = makeTmpRepo({ 'a.gml': 'x\n' });
    cleanup = repo.cleanup;
    const code = await main(['config', 'show', repo.root], { io });
    expect(code).toBe(EXIT_CONFIG);
    expect(err.text()).toContain('config error');
  });

  it('index runs with injected fake embeddings and reports counts', async () => {
    const repo = makeTmpRepo({
      'objects/obj_player/Step_0.gml': 'hp -= 1;\n',
      'scripts/scr_util/scr_util.gml': 'function scr_util() {}\n',
    });
    cleanup = repo.cleanup;
    const out = sink();
    const io: CliIo = { stdout: out.out, stderr: sink().out, stdin: Readable.from([]), env: baseEnv() };
    const code = await main(['index', repo.root], depsWith({ io }));
    expect(code).toBe(EXIT_OK);
    expect(out.text()).toMatch(/indexed: \d+ added/);
  });

  it('chat runs the REPL over an injected line source and exits 0', async () => {
    const repo = makeTmpRepo({ 'objects/obj_player/Step_0.gml': 'hp -= 1;\n' });
    cleanup = repo.cleanup;
    const out = sink();
    const io: CliIo = { stdout: out.out, stderr: sink().out, stdin: Readable.from([]), env: baseEnv() };
    const lineSource: LineSource = {
      async *[Symbol.asyncIterator]() {
        yield 'what does the player do?';
        yield 'exit';
      },
    };
    const code = await main(
      ['chat', repo.root],
      depsWith({
        io,
        makeLlm: () => new FakeLlm([{ tokens: ['The player loses hp each step.'] }]),
        makeLineSource: () => lineSource,
      }),
    );
    expect(code).toBe(EXIT_OK);
    expect(out.text()).toContain('The player loses hp each step.');
  });

  it('serve speaks NDJSON: ready handshake then an answer', async () => {
    const repo = makeTmpRepo({ 'a.gml': 'x\n' });
    cleanup = repo.cleanup;
    const out = sink();
    const input = new Readable({ read() {} });
    const io: CliIo = { stdout: out.out, stderr: sink().out, stdin: input, env: baseEnv() };
    const serve = main(
      ['serve', repo.root],
      depsWith({ io, makeLlm: () => new FakeLlm([{ tokens: ['hello from serve'] }]) }),
    );
    input.push('{"type":"user","text":"hi"}\n');
    await new Promise((r) => setTimeout(r, 30));
    input.push(null); // EOF
    const code = await serve;
    expect(code).toBe(EXIT_OK);
    const lines = out.text().split('\n').filter((l) => l.trim() !== '');
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'status', phase: 'ready', protocolVersion: 1 });
    expect(out.text()).toContain('hello from serve');
  });

  it('unknown subcommand -> usage exit 2', async () => {
    const err = sink();
    const io: CliIo = { stdout: sink().out, stderr: err.out, stdin: Readable.from([]), env: baseEnv() };
    const code = await main(['frobnicate'], { io });
    expect(code).toBe(EXIT_USAGE);
  });

  it('--version exits 0', async () => {
    const io: CliIo = { stdout: sink().out, stderr: sink().out, stdin: Readable.from([]), env: baseEnv() };
    const code = await main(['--version'], { io });
    expect(code).toBe(EXIT_OK);
  });

  it('no subcommand -> usage exit 2', async () => {
    const io: CliIo = { stdout: sink().out, stderr: sink().out, stdin: Readable.from([]), env: baseEnv() };
    const code = await main([], { io });
    expect(code).toBe(EXIT_USAGE);
  });
});
