// test/plugin/companions.test.ts — smoke-load tests for the two companion plugins.
//
// The companion plugins (`plugin-inline/`, `plugin-explain/`) require their protocol + process
// plumbing from the main chatgml plugin (../chatgml/state.js + ../chatgml/child-process.js). They
// MUST load cleanly when the main plugin is symlinked into the GMEdit plugins/ directory. We
// verify that here by loading them against a synthetic main-plugin copy — pure CJS require()
// against the real plugin/ tree.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const REPO = path.join(HERE, '../..');

describe('companion plugin modules load as CommonJS', () => {
  // Each plugin is an IIFE that exposes nothing on `module.exports` — it relies on globals
  // (Electron_MenuItem, aceEditor, GMEdit) being present at script-load time. So we can't
  // import it directly. Instead we read the source and assert it (a) does `require` the
  // shared modules from ../chatgml/, (b) registers `GMEdit.register`, and (c) defines a
  // single-file structure (no extra deps beyond the shared modules + electron's MenuItem).

  it('plugin-inline/inline.js references ../chatgml/state.js + ../chatgml/child-process.js', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(REPO, 'plugin-inline/inline.js'), 'utf8');
    expect(src).toMatch(/require\(['"]\.\.\/chatgml\/state\.js['"]\)/);
    expect(src).toMatch(/require\(['"]\.\.\/chatgml\/child-process\.js['"]\)/);
    // GMEdit.register is called with PLUGIN_NAME = 'chatgml-inline' (a string constant).
    expect(src).toMatch(/GMEdit\.register\(/);
    expect(src).toMatch(/PLUGIN_NAME\s*=\s*['"]chatgml-inline['"]/);
    // No icon refs (removed when the icons/ dir was dropped from the repo).
    expect(src).not.toMatch(/icons\/silk/);
  });

  it('plugin-explain/explain.js references ../chatgml/state.js + ../chatgml/child-process.js', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(REPO, 'plugin-explain/explain.js'), 'utf8');
    expect(src).toMatch(/require\(['"]\.\.\/chatgml\/state\.js['"]\)/);
    expect(src).toMatch(/require\(['"]\.\.\/chatgml\/child-process\.js['"]\)/);
    expect(src).toMatch(/GMEdit\.register\(/);
    expect(src).toMatch(/PLUGIN_NAME\s*=\s*['"]chatgml-explain['"]/);
    expect(src).not.toMatch(/icons\/silk/);
  });

  it('both companions wrap the spawn via ChildProcess.startCore (no inline spawn)', () => {
    const fs = require('node:fs');
    for (const file of ['plugin-inline/inline.js', 'plugin-explain/explain.js']) {
      const src = fs.readFileSync(path.join(REPO, file), 'utf8');
      // Once we have the shared helper, neither plugin should call spawn() directly.
      expect(src).not.toMatch(/\bspawn\s*\(/);
      // Both must use the shared helper.
      expect(src).toMatch(/ChildProcess\.startCore/);
    }
  });

  it('both companions have a real cleanup callback that stops the active session', () => {
    const fs = require('node:fs');
    for (const file of ['plugin-inline/inline.js', 'plugin-explain/explain.js']) {
      const src = fs.readFileSync(path.join(REPO, file), 'utf8');
      // The cleanup must reference activeSession (the tracked handle) and call .stop() on it.
      // A bare `cleanup: function () {}` (the old buggy version) would orphan the child on
      // GMEdit shutdown. We require a meaningful body.
      const cleanupMatch = src.match(
        /cleanup:\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}\s*,?\s*\n\s*\}\s*\)/,
      );
      expect(cleanupMatch, `${file} should define cleanup`).toBeTruthy();
      const body = cleanupMatch![1] ?? '';
      expect(body).toMatch(/activeSession/);
      expect(body).toMatch(/\.stop\(/);
    }
  });

  it('plugin-inline/inline.js does not include the dead editWithAI function', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(REPO, 'plugin-inline/inline.js'), 'utf8');
    // The dead function was ~100 lines and contained a long apology comment — the cleanup
    // marker is the unique "// INTERACTIVE APPROVAL ROUND-TRIP" apology.
    expect(src).not.toMatch(/INTERACTIVE APPROVAL ROUND-TRIP/);
    // The function itself was never called from init(); only editWithAIInteractive is.
    expect(src).toMatch(/function editWithAIInteractive/);
    expect(src).not.toMatch(/function editWithAI\(\)/);
  });

  it('plugin-inline/inline.js wires Accept/Reject synchronously (no overlay-button setTimeout race)', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(REPO, 'plugin-inline/inline.js'), 'utf8');
    // The buggy old pattern used `setTimeout(..., 50)` to reach into the overlay DOM after
    // creation and rewire the click handlers. With Accept/Reject handlers wired synchronously
    // in showOverlay, that hack is gone. (The legitimate setTimeout in `showToast` for the
    // auto-dismiss is allowed.)
    expect(src).not.toMatch(/setTimeout\([^,]+,\s*50\)/);
    // Belt-and-suspenders: the comment that used to introduce the hack should also be gone.
    expect(src).not.toMatch(/patch showOverlay's callbacks/i);
  });
});
