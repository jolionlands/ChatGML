// test/plugin/prepare-bootstrap.test.ts — regression test for the chatgml.js `prepare()` crash.
// prepare() once tried to call `opts.onSettingsBootstrap()` where `opts` was not a parameter or a
// declared variable — leftover from a refactor that renamed the surface to `panel.opts`. The
// ReferenceError blew up prepare() before `container`/`sizer` were assigned, so the next show()
// call crashed on `appendChild(undefined)` (right-click + the Ctrl+Shift+A keyboard shortcut both
// triggered it). The fix invokes `panel.opts.onSettingsBootstrap()` (and guards the call in
// try/catch so a future bootstrap failure cannot blank the panel again).
//
// We can't run prepare() in unit tests without the full GMEdit DOM, so we use a static scan:
// walk chatgml.js, find the `prepare()` function body, and verify no free `opts` reference
// exists — every callback reference must go through `panel.opts`.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PLUGIN_PATH = resolve(__dirname, '../../plugin/chatgml.js');

/** Extract the body of a top-level `function name(...) { ... }` from chatgml.js. Brace-matching
 *  handles nested braces and skips braces inside string literals + template literals + comments
 *  correctly. Returns the source slice (without the wrapping braces) or null if the function
 *  isn't found. */
function extractFunctionBody(source: string, name: string): string | null {
  // Find `function NAME(` preceded by start-of-string / newline / semicolon to avoid matching a
  // method called NAME inside an object literal.
  const re = new RegExp(String.raw`(?:^|\n|;)\s*function\s+` + name + String.raw`\s*\(`, 'g');
  const m = re.exec(source);
  if (!m) return null;
  // Walk forward from the closing `)` to find the function body's opening `{`.
  let i = m.index + m[0].length;
  while (i < source.length && source[i] !== '{') {
    // Skip past parameter list (which may itself contain no braces).
    i++;
  }
  if (i >= source.length) return null;
  const openIdx = i;
  let depth = 1;
  i++;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++; // skip escaped char
        i++;
      }
    } else if (ch === '/' && source[i + 1] === '/') {
      // Line comment
      while (i < source.length && source[i] !== '\n') i++;
    } else if (ch === '/' && source[i + 1] === '*') {
      // Block comment
      i += 2;
      while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++;
    }
    i++;
  }
  if (depth !== 0) return null;
  return source.slice(openIdx + 1, i - 1);
}

describe('chatgml.js prepare() — no free `opts` references', () => {
  it('exposes the prepare() function', () => {
    const src = readFileSync(PLUGIN_PATH, 'utf8');
    expect(extractFunctionBody(src, 'prepare')).not.toBeNull();
  });

  it('does not reference a free `opts` identifier anywhere in prepare()', () => {
    const src = readFileSync(PLUGIN_PATH, 'utf8');
    const body = extractFunctionBody(src, 'prepare');
    expect(body).not.toBeNull();
    // Look for `opts.` or `opts[` or `opts(` — these would mean a free reference to an
    // `opts` variable in scope. The allowed form is `panel.opts.*` (a property access on the
    // already-constructed panel, which holds the constructor opts).
    // Strip `panel.opts.` so we only check for stray `opts` outside that pattern.
    const stripped = body!.replace(/panel\.opts/g, '');
    const freeRefs = stripped.match(/\bopts(?:\.|\[|\(|$)/g) || [];
    expect(
      freeRefs,
      `prepare() must not reference a free \`opts\` variable — found ${freeRefs.length}: ` +
        freeRefs.slice(0, 5).join(', ') +
        '. The constructor opts live on `panel.opts` (see ChatPanel() in panel.js).',
    ).toHaveLength(0);
  });

  it('wraps the settings-bootstrap call in try/catch so a future throw cannot blank the panel', () => {
    const src = readFileSync(PLUGIN_PATH, 'utf8');
    const body = extractFunctionBody(src, 'prepare');
    expect(body).not.toBeNull();
    const refIdx = body!.indexOf('panel.opts.onSettingsBootstrap');
    expect(refIdx, 'prepare() must invoke panel.opts.onSettingsBootstrap').toBeGreaterThan(-1);
    const window = body!.slice(Math.max(0, refIdx - 400), refIdx + 200);
    expect(
      /\btry\s*\{/.test(window) && /\bcatch\s*\(/.test(window),
      'panel.opts.onSettingsBootstrap() must be guarded by try/catch so a throw cannot blank ' +
        'the panel mid-prepare',
    ).toBe(true);
  });

  it('creates `sizer` and `container` UNCONDITIONALLY so a second show() cannot crash on appendChild(undefined)', () => {
    const src = readFileSync(PLUGIN_PATH, 'utf8');
    const body = extractFunctionBody(src, 'prepare');
    expect(body).not.toBeNull();
    // show() does `if (ready) { mainCont.appendChild(sizer); mainCont.appendChild(container); }`
    // — both must be assigned by the time prepare() returns. The bootstrap throw must not be
    // able to prevent that.
    expect(body).toMatch(/container\s*=\s*document\.createElement/);
    expect(body).toMatch(/sizer\s*=\s*document\.createElement/);
  });

  it('does not reference provider callbacks as free identifiers inside prepare()', () => {
    const src = readFileSync(PLUGIN_PATH, 'utf8');
    const body = extractFunctionBody(src, 'prepare');
    expect(body).not.toBeNull();
    expect(body).not.toMatch(/onRefresh:\s*onRefreshProviders/);
    expect(body).not.toMatch(/onAddProvider:\s*onAddProvider/);
    expect(body).not.toMatch(/onExportEnv:\s*onExportEnv/);
    expect(body).not.toMatch(/[^.]onRefreshProviders\s*\(/);
  });
});
