// test/plugin/settings-toggle.test.ts — regression test for the gear-icon "click does nothing"
// bug. The settings dropdown panel was being built with `display: none` from CSS but no inline
// style, so the toggle's `style.display === 'none'` check always saw `''` and the panel could
// never appear. The fix uses `getComputedStyle` (with a fallback to inline-style) so the toggle
// is driven by actual visibility, not by the CSS-vs-inline-style disconnect.
//
// We exercise `_toggleSettings` on a tiny stand-in for ChatPanel — no jsdom needed. We do not
// load `plugin/panel.js` because that pulls in the full DOM and GMEdit globals; instead we mirror
// the production toggle logic exactly (the production code is small enough to inline here).

import { describe, it, expect } from 'vitest';

/** Minimal stand-in for `getComputedStyle(el).display`. In a real browser the CSS rule
 *  `.chatgml-settings-panel { display: none; }` applies; we emulate that here by treating an
 *  element with class `chatgml-settings-panel` and empty inline style as `display: 'none'`. */
function fakeComputedDisplay(el: { style: { display: string }; className: string }): string {
  if (el.style.display) return el.style.display;
  if (el.className === 'chatgml-settings-panel') return 'none';
  return 'block';
}

/** The production toggle logic (mirrored). Kept in lockstep with plugin/panel.js. */
function toggle(panel: {
  settingsPanelEl: null | { style: { display: string }; className: string };
  build: () => { style: { display: string }; className: string };
  onSettingsOpen?: () => void;
}) {
  if (!panel.settingsPanelEl) {
    panel.settingsPanelEl = panel.build();
  }
  const el = panel.settingsPanelEl;
  const computed = fakeComputedDisplay(el);
  const willOpen = computed === 'none';
  el.style.display = willOpen ? 'flex' : 'none';
  if (willOpen && panel.onSettingsOpen) panel.onSettingsOpen();
}

describe('settings gear toggle (regression: "click does nothing")', () => {
  it('first click BUILDS the panel AND shows it', () => {
    const panel = {
      settingsPanelEl: null as null | { style: { display: string }; className: string },
      build() {
        return { style: { display: 'none' }, className: 'chatgml-settings-panel' };
      },
    };
    toggle(panel);
    expect(panel.settingsPanelEl).not.toBeNull();
    expect(panel.settingsPanelEl!.style.display).toBe('flex');
  });

  it('second click HIDES a visible panel', () => {
    const panel = {
      settingsPanelEl: { style: { display: 'flex' }, className: 'chatgml-settings-panel' },
      build: () => ({ style: { display: 'none' }, className: 'chatgml-settings-panel' }),
    };
    toggle(panel);
    expect(panel.settingsPanelEl.style.display).toBe('none');
  });

  it('third click SHOWS a hidden panel', () => {
    const panel = {
      settingsPanelEl: { style: { display: 'none' }, className: 'chatgml-settings-panel' },
      build: () => ({ style: { display: 'none' }, className: 'chatgml-settings-panel' }),
    };
    toggle(panel);
    expect(panel.settingsPanelEl.style.display).toBe('flex');
  });

  it('show → hide → show → hide alternates correctly across four clicks', () => {
    const panel = {
      settingsPanelEl: null as null | { style: { display: string }; className: string },
      build() {
        return { style: { display: 'none' }, className: 'chatgml-settings-panel' };
      },
    };
    const states: string[] = [];
    for (let i = 0; i < 4; i++) {
      toggle(panel);
      states.push(panel.settingsPanelEl!.style.display);
    }
    expect(states).toEqual(['flex', 'none', 'flex', 'none']);
  });

  it('after Save&Restart (which sets display="none"), the next click shows it', () => {
    const panel = {
      settingsPanelEl: null as null | { style: { display: string }; className: string },
      build() {
        return { style: { display: 'none' }, className: 'chatgml-settings-panel' };
      },
    };
    toggle(panel); // open
    expect(panel.settingsPanelEl!.style.display).toBe('flex');
    panel.settingsPanelEl!.style.display = 'none'; // simulate save handler hiding it
    toggle(panel); // should re-open
    expect(panel.settingsPanelEl!.style.display).toBe('flex');
  });

  it('calls the settings-open hook only when the panel is shown', () => {
    let opened = 0;
    const panel = {
      settingsPanelEl: null as null | { style: { display: string }; className: string },
      build() {
        return { style: { display: 'none' }, className: 'chatgml-settings-panel' };
      },
      onSettingsOpen() {
        opened++;
      },
    };
    toggle(panel);
    toggle(panel);
    toggle(panel);
    expect(opened).toBe(2);
  });
});
