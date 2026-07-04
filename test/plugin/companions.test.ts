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
      expect(src, `${file} should track an active session`).toMatch(/let activeSession = null/);
      expect(src, `${file} should stop the active session on cleanup`).toMatch(
        /activeSession\.stop\(\)/,
      );
    }
  });

  it('both companions still register a disabled plugin if shared chatgml modules are missing', () => {
    const fs = require('node:fs');
    const cases: Array<[string, string]> = [
      ['plugin-inline/inline.js', 'chatgml-inline'],
      ['plugin-explain/explain.js', 'chatgml-explain'],
    ];
    for (const [file, name] of cases) {
      const src = fs.readFileSync(path.join(REPO, file), 'utf8');
      expect(src).toMatch(new RegExp(`GMEdit\\.register\\(['"]${name}['"]`));
      expect(src).toMatch(/cleanup:\s*function\s*\(\)\s*\{\}/);
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

  it('plugin-gmloop registers a safe read-only GMEdit companion', () => {
    const fs = require('node:fs');
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin-gmloop/config.json'), 'utf8'));
    const src = fs.readFileSync(path.join(REPO, 'plugin-gmloop/gmloop.js'), 'utf8');
    expect(cfg.name).toBe('chatgml-gmloop');
    expect(src).toMatch(/PLUGIN_NAME\s*=\s*['"]chatgml-gmloop['"]/);
    expect(src).toMatch(/GMEdit\.register\(PLUGIN_NAME/);
    expect(src).toMatch(/GMLoop: lint current file/);
    expect(src).toMatch(/GMLoop: format check current file/);
    expect(src).toMatch(/GMLoop: graph doctor project/);
    expect(src).toMatch(/GMLoop: live reload status/);
    expect(src).toMatch(/GMLoop: runner start/);
    expect(src).toMatch(/GMLoop: runner stop/);
    expect(src).toMatch(/GMLive: toggle bridge/);
    expect(src).toMatch(/window\.ChatGmlGmloop/);
    expect(src).toMatch(/window\.ChatGmlGmlive/);
    expect(src).toMatch(/shell:\s*false/);
    expect(src).not.toMatch(/--write/);
  });
});
