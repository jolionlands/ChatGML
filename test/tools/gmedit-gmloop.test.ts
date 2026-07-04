import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dispatchTool, buildToolRegistry } from '../../src/tools/index.js';
import { makeToolContext } from '../helpers/tool-context.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chatgml-tools-'));
}

describe('GMEdit/GMLoop tools', () => {
  it('gmedit_plugins lists plugin config metadata without executing plugins', async () => {
    const root = tmpDir();
    try {
      const dir = path.join(root, 'plugins');
      fs.mkdirSync(path.join(dir, 'demo'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'demo', 'config.json'),
        JSON.stringify({ name: 'demo-plugin', description: 'Demo', scripts: ['demo.js'] }),
      );
      const { ctx } = makeToolContext({ root });
      const res = await dispatchTool(
        buildToolRegistry(),
        'gmedit_plugins',
        JSON.stringify({ pluginsDir: dir }),
        ctx,
      );
      expect(res.ok).toBe(true);
      expect(res.content).toContain('demo-plugin');
      expect(res.content).toContain('scripts:1');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('gmloop_check status is safe when gmloop is not installed', async () => {
    const root = tmpDir();
    try {
      const { ctx } = makeToolContext({ root });
      const res = await dispatchTool(buildToolRegistry(), 'gmloop_check', '{}', ctx);
      expect(res.ok).toBe(true);
      expect(res.content).toMatch(/GMLoop (ready|not found)/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('gmloop_check status honors CHATGML_GMLOOP_DIR', async () => {
    const root = tmpDir();
    const gmloop = tmpDir();
    const old = process.env.CHATGML_GMLOOP_DIR;
    try {
      const cli = path.join(gmloop, 'src', 'cli', 'dist');
      fs.mkdirSync(cli, { recursive: true });
      fs.writeFileSync(path.join(cli, 'index.js'), 'console.log("fake gmloop")\n');
      process.env.CHATGML_GMLOOP_DIR = gmloop;
      const { ctx } = makeToolContext({ root });
      const res = await dispatchTool(buildToolRegistry(), 'gmloop_check', '{}', ctx);
      expect(res.ok).toBe(true);
      expect(res.content).toContain('GMLoop ready');
      expect(res.content).toContain(gmloop);
    } finally {
      if (old === undefined) delete process.env.CHATGML_GMLOOP_DIR;
      else process.env.CHATGML_GMLOOP_DIR = old;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(gmloop, { recursive: true, force: true });
    }
  });
});
