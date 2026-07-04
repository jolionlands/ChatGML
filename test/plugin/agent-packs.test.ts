import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const AgentPacks = require('../../plugin/agent-packs.js') as {
  BUILTIN_PACKS: Array<{ id: string; name: string; prompt: string }>;
  listPacks: (dir?: string) => Array<{ id: string; installed: boolean; prompt: string }>;
  installPack: (id: string, dir?: string) => { id: string; installed: boolean };
};

let tmp: string | null = null;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('plugin/agent-packs.js', () => {
  it('ships Ponytail and Superpowers as local installable packs', () => {
    const ids = AgentPacks.BUILTIN_PACKS.map((p) => p.id);
    expect(ids).toContain('ponytail');
    expect(ids).toContain('superpowers');
  });

  it('installs a pack as a local manifest and marks it installed', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'chatgml-agent-packs-'));
    expect(AgentPacks.listPacks(tmp).find((p) => p.id === 'ponytail')?.installed).toBe(false);

    const installed = AgentPacks.installPack('ponytail', tmp);

    expect(installed).toMatchObject({ id: 'ponytail', installed: true });
    expect(AgentPacks.listPacks(tmp).find((p) => p.id === 'ponytail')?.installed).toBe(true);
  });
});
