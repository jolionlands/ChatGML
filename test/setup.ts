// test/setup.ts — global test setup.
//
// Installs a default global `fetch` that THROWS so any unmocked network call fails loudly, and
// snapshots/restores process.env around each test so CHATGML_* vars never leak between tests.
import { beforeEach, afterEach, vi } from 'vitest';

let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  envSnapshot = { ...process.env };
  vi.stubGlobal('fetch', (() => {
    throw new Error('unmocked fetch() called in a test — install a fetch mock first');
  }) as typeof fetch);
});

afterEach(() => {
  // Restore env to the pre-test snapshot.
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value !== undefined) process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
