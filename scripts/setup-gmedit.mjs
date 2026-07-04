#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const valueArg = (name) => {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
};

function defaultPluginsDir() {
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'AceGM',
      'GMEdit',
      'plugins',
    );
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'AceGM', 'GMEdit', 'plugins');
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'AceGM',
    'GMEdit',
    'plugins',
  );
}

function sameRealPath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

function linkDir(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`missing source folder: ${src}`);
  if (fs.existsSync(dest)) {
    if (sameRealPath(src, dest)) return 'already linked';
    throw new Error(`target exists, remove or rename it first: ${dest}`);
  }
  fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
  return 'linked';
}

if (args.has('--help') || args.has('-h')) {
  console.log(
    [
      'Usage:',
      '  chatgml-gmedit-setup [--plugins-dir=/path/to/plugins] [--gmloop]',
      '  npm run setup:gmedit -- [--plugins-dir=/path/to/plugins] [--gmloop]',
    ].join('\n'),
  );
  process.exit(0);
}

if (!fs.existsSync(path.join(root, 'dist', 'cli.js'))) {
  console.error('dist/cli.js is missing. Run: npm run build');
  process.exit(1);
}

const pluginsDir = path.resolve(valueArg('--plugins-dir') || defaultPluginsDir());
const plugins = [
  ['plugin', 'chatgml'],
  ['plugin-inline', 'chatgml-inline'],
  ['plugin-explain', 'chatgml-explain'],
];
if (args.has('--gmloop')) plugins.push(['plugin-gmloop', 'chatgml-gmloop']);

fs.mkdirSync(pluginsDir, { recursive: true });

for (const [folder, name] of plugins) {
  const src = path.join(root, folder);
  const dest = path.join(pluginsDir, name);
  const status = linkDir(src, dest);
  console.log(`${status}: ${dest} -> ${src}`);
}

console.log('\nRestart GMEdit, then open the ChatGML panel.');
