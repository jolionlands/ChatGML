import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { defineTool } from '../tool-error.js';
import type { ToolDef, ToolResult } from '../types.js';

const GmeditPluginsArgs = z.object({
  pluginsDir: z.string().optional().describe('Optional GMEdit plugins directory to inspect.'),
});
type GmeditPluginsArgs = z.infer<typeof GmeditPluginsArgs>;

function defaultPluginsDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'AceGM', 'GMEdit', 'plugins');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'AceGM', 'GMEdit', 'plugins');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'AceGM', 'GMEdit', 'plugins');
}

export const gmeditPluginsTool: ToolDef<GmeditPluginsArgs> = defineTool<GmeditPluginsArgs>({
  name: 'gmedit_plugins',
  description:
    'List installed GMEdit plugin config metadata. Read-only; does not execute plugin JavaScript.',
  kind: 'read',
  schema: GmeditPluginsArgs,
  async execute(args: GmeditPluginsArgs): Promise<ToolResult> {
    const dir = args.pluginsDir || defaultPluginsDir();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return { content: `GMEdit plugins directory not found: ${dir}` };
    }

    const lines: string[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const pluginDir = path.join(dir, ent.name);
      try {
        const raw = await fs.readFile(path.join(pluginDir, 'config.json'), 'utf8');
        const cfg = JSON.parse(raw) as {
          name?: string;
          description?: string;
          scripts?: unknown[];
          stylesheets?: unknown[];
          dependencies?: unknown[];
        };
        lines.push(
          [
            cfg.name || ent.name,
            cfg.description || '',
            `scripts:${Array.isArray(cfg.scripts) ? cfg.scripts.length : 0}`,
            `styles:${Array.isArray(cfg.stylesheets) ? cfg.stylesheets.length : 0}`,
            `deps:${Array.isArray(cfg.dependencies) ? cfg.dependencies.join(',') : ''}`,
          ]
            .filter(Boolean)
            .join(' | '),
        );
      } catch {
        lines.push(`${ent.name} | missing or invalid config.json`);
      }
    }

    return {
      content: lines.length === 0 ? `No GMEdit plugins found in ${dir}` : `GMEdit plugins in ${dir}\n${lines.join('\n')}`,
    };
  },
});
