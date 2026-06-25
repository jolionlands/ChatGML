// test/plugin/client.test.ts — drives plugin/client.js (the NdjsonClient) against a FAKE chatgml
// serve script that echoes scripted events. Complements serve.spawn-integration.test.ts (which uses
// the REAL core): this proves the plugin's spawn plumbing — argv ordering, raw-chunk decode,
// handshake gating, command round-trip, clean shutdown, and binary resolution — in isolation, and
// asserts the spawn argv contains NO git/python tokens (the old plugin's removed behaviors).
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

interface ClientLike {
  start(): boolean;
  sendUser(text: string): boolean;
  approve(id: string): boolean;
  stop(): void;
  ready: boolean;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NdjsonClient } = require(path.join(HERE, '../../plugin/client.js')) as {
  NdjsonClient: new (opts: Record<string, unknown>) => ClientLike;
};

// A fake `chatgml serve`: records its argv to a side file, prints the ready handshake, then for each
// `{type:'user'}` emits a token + answer; for `{type:'approve'}` emits a confirming token. Exits 0
// on stdin EOF. (It is placed at <pluginDir>/dist/cli.js so client.js's resolver picks the
// node + dist/cli.js fallback and spawns it with `serve <dir>` args, which the fake ignores.)
const FAKE_SERVE = `
const fs = require('fs');
const path = require('path');
// Write the received argv next to this script (the client's minimal env strips ad-hoc vars, so we
// use a fixed location derived from __dirname rather than an env-var side channel).
fs.writeFileSync(path.join(__dirname, 'argv.json'), JSON.stringify(process.argv.slice(2)));
let buf = '';
process.stdout.write(JSON.stringify({ type: 'status', phase: 'ready', protocolVersion: 1 }) + '\\n');
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let cmd; try { cmd = JSON.parse(line); } catch { continue; }
    if (cmd.type === 'user') {
      process.stdout.write(JSON.stringify({ type: 'token', text: 'echo:' + cmd.text }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'answer', text: 'done', sources: [] }) + '\\n');
    }
    if (cmd.type === 'approve') {
      process.stdout.write(JSON.stringify({ type: 'token', text: 'approved:' + cmd.id }) + '\\n');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

let tmpDir: string | null = null;
let activeClient: ClientLike | null = null;

afterEach(async () => {
  if (activeClient) {
    activeClient.stop();
    activeClient = null;
  }
  if (tmpDir) {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

/** Create a plugin dir containing dist/cli.js = the fake serve. The fake writes the argv it received
 * to <pluginDir>/dist/argv.json (a fixed path, since the client's minimal env strips ad-hoc vars). */
async function makePluginDir(): Promise<{ pluginDir: string; argvFile: string }> {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plugin-client-'));
  const pluginDir = path.join(tmpDir, 'plugin');
  await fsp.mkdir(path.join(pluginDir, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(pluginDir, 'dist', 'cli.js'), FAKE_SERVE);
  const argvFile = path.join(pluginDir, 'dist', 'argv.json');
  return { pluginDir, argvFile };
}

function until(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (pred()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('NdjsonClient', () => {
  it('gates on the handshake, round-trips a user turn, and shuts down cleanly', async () => {
    const { pluginDir } = await makePluginDir();
    const events: Array<{ type: string; text?: string }> = [];
    let readyFired = false;
    let exitCode: number | null | undefined;
    const client = new NdjsonClient({
      projectDir: '/some/project',
      pluginDir,
      onEvent: (e: { type: string }) => events.push(e),
      onReady: () => {
        readyFired = true;
      },
      onExit: (code: number | null) => {
        exitCode = code;
      },
    });
    activeClient = client;
    expect(client.start()).toBe(true);
    await until(() => client.ready);
    expect(readyFired).toBe(true);

    client.sendUser('hello world');
    await until(() => events.some((e) => e.type === 'answer'));
    expect(events.some((e) => e.type === 'token' && e.text === 'echo:hello world')).toBe(true);
    expect(events.some((e) => e.type === 'answer')).toBe(true);

    client.stop();
    await until(() => exitCode === 0, 3000);
    expect(exitCode).toBe(0);
  });

  it('spawns with [serve, <dir>] argv — NO git/python/venv/clone tokens', async () => {
    const { pluginDir, argvFile } = await makePluginDir();
    const client = new NdjsonClient({ projectDir: '/my/gm/project', pluginDir, onEvent: () => {} });
    activeClient = client;
    client.start();
    await until(() => client.ready);
    await until(() => existsSync(argvFile));
    const argv = JSON.parse(await fsp.readFile(argvFile, 'utf8')) as string[];
    expect(argv).toEqual(['serve', '/my/gm/project']);
    const joined = argv.join(' ');
    for (const banned of ['git', 'pull', 'python', 'venv', 'clone', 'talk-codebase', 'END', 'RECREATE']) {
      expect(joined).not.toContain(banned);
    }
  });

  it('forwards an approve command out-of-band by id', async () => {
    const { pluginDir } = await makePluginDir();
    const events: Array<{ type: string; text?: string }> = [];
    const client = new NdjsonClient({
      projectDir: '/p',
      pluginDir,
      onEvent: (e: { type: string }) => events.push(e),
    });
    activeClient = client;
    client.start();
    await until(() => client.ready);
    client.approve('e9a1');
    await until(() => events.some((e) => e.type === 'token' && e.text === 'approved:e9a1'));
    expect(events.some((e) => e.type === 'token' && e.text === 'approved:e9a1')).toBe(true);
  });

  it('surfaces a clear error (no silent ENOENT) when the binary cannot be resolved', async () => {
    // No configured path, no CHATGML_BIN, and a pluginDir with NO dist/cli.js -> resolver throws.
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plugin-noresolve-'));
    const emptyPluginDir = path.join(tmpDir, 'plugin');
    await fsp.mkdir(emptyPluginDir, { recursive: true });
    delete process.env['CHATGML_BIN'];
    let err: Error | undefined;
    const client = new NdjsonClient({
      projectDir: '/p',
      pluginDir: emptyPluginDir,
      configuredPath: '',
      onEvent: () => {},
      onError: (e: Error) => {
        err = e;
      },
    });
    activeClient = client;
    // Force a clean env for resolution: stub APPDATA so the win32 shim probe also misses.
    const savedAppData = process.env['APPDATA'];
    process.env['APPDATA'] = path.join(tmpDir, 'nope-appdata');
    try {
      const ok = client.start();
      expect(ok).toBe(false);
    } finally {
      if (savedAppData === undefined) delete process.env['APPDATA'];
      else process.env['APPDATA'] = savedAppData;
    }
    expect(err).toBeDefined();
    expect(err?.message).toMatch(/chatgml executable not found/);
  });
});
