import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const AgentPacks = require('../../plugin/agent-packs.js') as {
  BUILTIN_PACKS: Array<{ id: string; name: string; prompt: string }>;
  listPacks: (dir?: string) => Array<{ id: string; installed: boolean; prompt: string }>;
  installPack: (id: string, dir?: string) => { id: string; installed: boolean };
  listMarketplace: (opts?: {
    providersPath?: string;
    agentPacksDir?: string;
    manifestDir?: string;
  }) => Array<{ id: string; kind: string; installed: boolean; prompt: string }>;
  installMarketplace: (
    id: string,
    opts?: { providersPath?: string; agentPacksDir?: string; manifestDir?: string },
  ) => { id: string; installed: boolean };
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

  it('lists skills, plugins, and providers in the local marketplace', () => {
    const entries = AgentPacks.listMarketplace();
    expect(entries.map((p) => p.kind)).toEqual(
      expect.arrayContaining(['agent-pack', 'skill', 'plugin', 'provider']),
    );
    expect(entries.map((p) => p.id)).toEqual(
      expect.arrayContaining(['ponytail', 'review-current-file', 'chatgml-gmloop', 'provider-kimi-coding']),
    );
  });

  it('installs a pack as a local manifest and marks it installed', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'chatgml-agent-packs-'));
    expect(AgentPacks.listPacks(tmp).find((p) => p.id === 'ponytail')?.installed).toBe(false);

    const installed = AgentPacks.installPack('ponytail', tmp);

    expect(installed).toMatchObject({ id: 'ponytail', installed: true });
    expect(AgentPacks.listPacks(tmp).find((p) => p.id === 'ponytail')?.installed).toBe(true);
  });

  it('installs marketplace providers into providers.json', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'chatgml-marketplace-'));
    const providersPath = path.join(tmp, 'providers.json');

    const installed = AgentPacks.installMarketplace('provider-kimi-coding', { providersPath });

    expect(installed).toMatchObject({ id: 'provider-kimi-coding', installed: true });
    const saved = JSON.parse(readFileSync(providersPath, 'utf8'));
    expect(saved.providers['kimi-coding'].base_url).toBe('https://api.kimi.com/coding/v1');
    expect(saved.providers['kimi-coding'].models[0].id).toBe('kimi-for-coding');
    expect(
      AgentPacks.listMarketplace({ providersPath }).find((p) => p.id === 'provider-kimi-coding')
        ?.installed,
    ).toBe(true);
  });
});
