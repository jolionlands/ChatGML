// test/plugin/sessions.test.ts — multi-session history module contract tests.
//
// The sessions module (plugin/sessions.js) is the SSOT for the new "history per project"
// sidebar in the GMEdit plugin. It manages:
//   - per-session NDJSON files (<projectHash>-<id>.ndjson)
//   - per-session metadata sidecars (<projectHash>-<id>.meta.json)
//   - a per-project active pointer file (<projectHash>.active.json)
//
// These tests pin the file-lifecycle contract: creation, listing, switching, deletion, appending
// turns, and title derivation. We use the test-only `_setSessionDirForTests` hook to redirect
// disk I/O to a tmpdir so the tests never touch a real session store.
//
// We also assert a parity invariant: state.js's initial state must declare the three session
// fields (`sessionList`, `activeSessionId`, `sessionLoading`), and src/plugin-runtime.ts must
// carry the same. Drift here breaks `setSessions()` / `setActiveSession()` panel rendering, so
// the parity test would not catch it but this test does.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Sessions = require(path.join(HERE, '../../plugin/sessions.js')) as {
  list: (projectDir: string) => Promise<
    Array<{
      id: string;
      title: string;
      messageCount: number;
      createdAt: number;
      updatedAt: number;
      isActive: boolean;
    }>
  >;
  create: (projectDir: string, id?: string) => Promise<string>;
  switchTo: (projectDir: string, id: string) => Promise<void>;
  delete: (projectDir: string, id: string) => Promise<void>;
  getActive: (projectDir: string) => Promise<string>;
  setActive: (projectDir: string, id: string) => Promise<void>;
  appendTurn: (
    projectDir: string,
    turn: { userText: string; assistantText: string; ts?: number },
  ) => Promise<void>;
  loadTurns: (
    projectDir: string,
    id: string,
  ) => Promise<Array<{ userText: string; assistantText: string; ts?: number }>>;
  deriveTitle: (turns: Array<{ userText: string }>) => string;
  updateTitle: (projectDir: string, id: string, title: string) => Promise<unknown>;
  projectHash: (projectDir: string) => string;
  sessionFile: (projectDir: string, id?: string) => string;
  metadataFile: (projectDir: string, id?: string) => string;
  activeFile: (projectDir: string) => string;
  sessionDir: () => string;
  _setSessionDirForTests: (dir: string | null) => void;
};

let tmpDir = '';
let projectDir = '';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgml-sessions-'));
  projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  Sessions._setSessionDirForTests(tmpDir);
  // Adding a small inter-test delay helps the wall-clock timestamps differ so the sidebar
  // sort-by-updatedAt is deterministic across rapid sequential appends.
  await wait(2);
});

afterEach(() => {
  Sessions._setSessionDirForTests(null);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    /* best-effort */
  }
});

describe('plugin/sessions.js', () => {
  it('list(empty project) returns the default session, marked active', async () => {
    const list = await Sessions.list(projectDir);
    expect(list.length).toBeGreaterThanOrEqual(1);
    const def = list.find((e) => e.id === 'default');
    expect(def).toBeTruthy();
    expect(def!.isActive).toBe(true);
    expect(def!.title).toBe('untitled');
    expect(def!.messageCount).toBe(0);
  });

  it('create() mints a fresh id, persists metadata, and is active', async () => {
    const id = await Sessions.create(projectDir);
    expect(id).toMatch(/^s-/);
    const metaPath = Sessions.metadataFile(projectDir, id);
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(meta.title).toBe('untitled');
    expect(typeof meta.createdAt).toBe('number');
    expect(typeof meta.updatedAt).toBe('number');
    expect(meta.messageCount).toBe(0);

    const list = await Sessions.list(projectDir);
    const entry = list.find((e) => e.id === id);
    expect(entry).toBeTruthy();
    expect(entry!.isActive).toBe(true);
  });

  it('create(providedId) is idempotent when the id is already in use', async () => {
    const first = await Sessions.create(projectDir, 'feature-x');
    const second = await Sessions.create(projectDir, 'feature-x');
    expect(first).toBe(second);
    const list = await Sessions.list(projectDir);
    const matches = list.filter((e) => e.id === 'feature-x');
    expect(matches.length).toBe(1);
  });

  it('create() with an invalid id falls through to minting a fresh one', async () => {
    // Provided id is empty string — treated as "no id" by the implementation.
    const id = await Sessions.create(projectDir, '');
    expect(id).toMatch(/^s-/);
  });

  it('appendTurn() increments messageCount and updates updatedAt', async () => {
    const id = await Sessions.create(projectDir);
    const before = await Sessions.list(projectDir);
    const beforeCount = before.find((e) => e.id === id)!.messageCount;
    const beforeUpdatedAt = before.find((e) => e.id === id)!.updatedAt;

    await wait(5);
    await Sessions.appendTurn(projectDir, {
      userText: 'hello world',
      assistantText: 'hi!',
    });

    const after = await Sessions.list(projectDir);
    const entry = after.find((e) => e.id === id)!;
    expect(entry.messageCount).toBe(beforeCount + 1);
    expect(entry.updatedAt).toBeGreaterThan(beforeUpdatedAt);
  });

  it('appendTurn() auto-derives the title from the first user message', async () => {
    const id = await Sessions.create(projectDir);
    await Sessions.appendTurn(projectDir, {
      userText: 'add a double-jump to obj_player with coyote time',
      assistantText: 'done',
    });
    const list = await Sessions.list(projectDir);
    expect(list.find((e) => e.id === id)!.title).toBe(
      'add a double-jump to obj_player with coyote time',
    );
  });

  it('appendTurn() preserves a manually-set title across later turns', async () => {
    const id = await Sessions.create(projectDir);
    await Sessions.updateTitle(projectDir, id, 'Custom Feature Name');
    await Sessions.appendTurn(projectDir, { userText: 'second message', assistantText: 'ok' });
    const list = await Sessions.list(projectDir);
    expect(list.find((e) => e.id === id)!.title).toBe('Custom Feature Name');
  });

  it('deriveTitle truncates long titles and falls back to "untitled"', () => {
    expect(
      Sessions.deriveTitle([{ userText: 'short' }, { userText: 'ignored because second' }]),
    ).toBe('short');

    const long = 'x'.repeat(80);
    const title = Sessions.deriveTitle([{ userText: long }]);
    expect(title.length).toBeLessThanOrEqual(50);
    expect(title.endsWith('…')).toBe(true);

    expect(Sessions.deriveTitle([])).toBe('untitled');
    expect(Sessions.deriveTitle([{ userText: '   \n  ' }])).toBe('untitled');
    expect(Sessions.deriveTitle([{ userText: '' }])).toBe('untitled');
  });

  it('switchTo() flips the active pointer and updates isActive flags', async () => {
    const a = await Sessions.create(projectDir, 'session-a');
    await wait(2);
    const b = await Sessions.create(projectDir, 'session-b');
    await wait(2);
    await Sessions.switchTo(projectDir, a);

    const list = await Sessions.list(projectDir);
    expect(list.find((e) => e.id === a)!.isActive).toBe(true);
    expect(list.find((e) => e.id === b)!.isActive).toBe(false);
    expect(await Sessions.getActive(projectDir)).toBe(a);
  });

  it('delete() removes both NDJSON and metadata, never the default session', async () => {
    const id = await Sessions.create(projectDir, 'doomed');
    // create() only writes a metadata sidecar; the NDJSON appears on the first appendTurn.
    // Write a turn so both files exist before we exercise delete().
    expect(fs.existsSync(Sessions.metadataFile(projectDir, id))).toBe(true);
    await Sessions.appendTurn(projectDir, { userText: 'q', assistantText: 'a' });
    expect(fs.existsSync(Sessions.sessionFile(projectDir, id))).toBe(true);

    await Sessions.delete(projectDir, id);

    expect(fs.existsSync(Sessions.sessionFile(projectDir, id))).toBe(false);
    expect(fs.existsSync(Sessions.metadataFile(projectDir, id))).toBe(false);
    const list = await Sessions.list(projectDir);
    expect(list.find((e) => e.id === id)).toBeUndefined();

    // Cannot delete 'default' — it is the fallback.
    await expect(Sessions.delete(projectDir, 'default')).rejects.toBeTruthy();
  });

  it('delete() of the currently-active session falls back to default', async () => {
    const id = await Sessions.create(projectDir, 'temp');
    await Sessions.switchTo(projectDir, id);
    await Sessions.delete(projectDir, id);
    expect(await Sessions.getActive(projectDir)).toBe('default');
  });

  it('list() survives a corrupted metadata sidecar', async () => {
    const id = await Sessions.create(projectDir, 'corrupt');
    // Corrupt the metadata on disk (write garbage) — list() must skip and still produce an
    // entry (derived from the NDJSON, which is also empty).
    fs.writeFileSync(Sessions.metadataFile(projectDir, id), 'not-json{', 'utf8');
    const list = await Sessions.list(projectDir);
    const entry = list.find((e) => e.id === id);
    expect(entry).toBeTruthy();
    expect(entry!.title).toBe('untitled');
  });

  it('list() returns sessions sorted by updatedAt descending', async () => {
    const older = await Sessions.create(projectDir, 'older');
    await wait(20);
    const newer = await Sessions.create(projectDir, 'newer');
    const list = await Sessions.list(projectDir);
    const order = list.map((e) => e.id);
    expect(order.indexOf(newer)).toBeLessThan(order.indexOf(older));
  });

  it('loadTurns() reads back what appendTurn wrote', async () => {
    await Sessions.create(projectDir, 'turncheck');
    await Sessions.appendTurn(projectDir, { userText: 'Q', assistantText: 'A' });
    const turns = await Sessions.loadTurns(projectDir, 'turncheck');
    expect(turns.length).toBe(1);
    expect(turns[0].userText).toBe('Q');
    expect(turns[0].assistantText).toBe('A');
  });

  it('parity: state.js initial state carries the three session fields', () => {
    const js = require(path.join(HERE, '../../plugin/state.js')) as {
      initialPluginState: () => Record<string, unknown>;
    };
    const s = js.initialPluginState();
    expect(s).toHaveProperty('sessionList');
    expect(s).toHaveProperty('activeSessionId');
    expect(s).toHaveProperty('sessionLoading');
    expect(s.sessionList).toEqual([]);
    expect(s.activeSessionId).toBe('default');
    expect(s.sessionLoading).toBe(false);
  });

  it('parity: src/plugin-runtime.ts initial state carries the same three fields', async () => {
    const mod = await import('../../src/plugin-runtime.js');
    const s = mod.initialPluginState();
    expect(s).toHaveProperty('sessionList');
    expect(s).toHaveProperty('activeSessionId');
    expect(s).toHaveProperty('sessionLoading');
    expect(s.sessionList).toEqual([]);
    expect(s.activeSessionId).toBe('default');
    expect(s.sessionLoading).toBe(false);
  });

  it('projectHash is stable for the same projectDir', () => {
    expect(Sessions.projectHash(projectDir)).toBe(Sessions.projectHash(projectDir));
    // Different inputs produce different hashes (negative control).
    expect(Sessions.projectHash(projectDir)).not.toBe(
      Sessions.projectHash(path.join(tmpDir, 'other-project')),
    );
  });
});
