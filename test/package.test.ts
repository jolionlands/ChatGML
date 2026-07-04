import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('package manifest', () => {
  it('ships the GMEdit setup command and plugin folders', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
      files?: string[];
      scripts?: Record<string, string>;
    };

    expect(pkg.bin?.['chatgml-gmedit-setup']).toBe('scripts/setup-gmedit.mjs');
    expect(pkg.scripts?.['setup:gmedit']).toBe('node scripts/setup-gmedit.mjs');
    expect(pkg.files).toEqual(
      expect.arrayContaining([
        'plugin',
        'plugin-inline',
        'plugin-explain',
        'plugin-gmloop',
        'scripts/setup-gmedit.mjs',
      ]),
    );
  });
});
