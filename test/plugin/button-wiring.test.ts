import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PANEL = readFileSync(resolve(__dirname, '../../plugin/panel.js'), 'utf8');
const CHAT = readFileSync(resolve(__dirname, '../../plugin/chatgml.js'), 'utf8');
const STYLE = readFileSync(resolve(__dirname, '../../plugin/style.css'), 'utf8');

describe('GMEdit panel button wiring', () => {
  it('Undo button sends the selected checkpoint id when one is selected', () => {
    expect(PANEL).toMatch(/onUndo\(self\.selectedCheckpointId \|\| undefined\)/);
    expect(CHAT).toMatch(/onUndo:\s*function\s*\(checkpointId\)/);
    expect(CHAT).toMatch(/client\.sendUndo\(checkpointId\)/);
  });

  it('provider action buttons use panel opts, not free callback names', () => {
    expect(CHAT).not.toMatch(/onRefresh:\s*onRefreshProviders/);
    expect(CHAT).not.toMatch(/onAddProvider:\s*onAddProvider/);
    expect(CHAT).not.toMatch(/onExportEnv:\s*onExportEnv/);
    expect(CHAT).toMatch(/panel\.opts\.onRefreshProviders/);
  });

  it('main toolbar exposes Roo/Cline-style Plan/Act tier buttons', () => {
    expect(PANEL).toMatch(/chatgml-workbench-header/);
    expect(PANEL).toMatch(/chatgml-primary-controls/);
    expect(PANEL).toMatch(/chatgml-secondary-controls/);
    expect(PANEL).toMatch(/primaryControls\.appendChild\(this\.statusEl\)/);
    expect(PANEL).toMatch(/chatgml-tier-quick/);
    expect(PANEL).toMatch(/label:\s*'Plan'/);
    expect(PANEL).toMatch(/value:\s*'planner'/);
    expect(PANEL).toMatch(/label:\s*'Act'/);
    expect(PANEL).toMatch(/value:\s*'implementer'/);
    expect(PANEL).toMatch(/onTierOverride\(chosen\)/);
  });

  it('workbench polish surfaces context, changes, and expandable errors', () => {
    expect(PANEL).toMatch(/chatgml-context-btn/);
    expect(PANEL).toMatch(/_renderContextChip/);
    expect(PANEL).toMatch(/thinking: waiting for model response/);
    expect(PANEL).toMatch(/current file/);
    expect(PANEL).toMatch(/current selection is attached/);
    expect(PANEL).toMatch(/chatgml-changes-section/);
    expect(PANEL).toMatch(/chatgml-error-details/);
    expect(PANEL).toMatch(/chatgml-diagnostics/);
    expect(PANEL).toMatch(/chatgml-knowledge/);
    expect(PANEL).toMatch(/sanitizeDiagnosticText/);
    expect(CHAT).toMatch(/getDiagnostics:\s*diagnosticsSnapshot/);
    expect(CHAT).toMatch(/onCopyDiagnostics:\s*function/);
    expect(CHAT).toMatch(/lastLaunchAuthInfo/);
    expect(CHAT).toMatch(/launchAuthEnv/);
    expect(CHAT).toMatch(/Object\.assign\(\{\}, readChatgmlEnvForDiagnostics\(\), process\.env\)/);
    expect(CHAT).toMatch(/fallbackDiagnostics/);
    expect(PANEL).toMatch(/auth source/);
    expect(PANEL).toMatch(/fallbacks/);
    expect(PANEL).toMatch(/gmloop runner/);
    expect(CHAT).toMatch(/gmloopDiagnostics/);
    expect(CHAT).toMatch(/handleGmloopCommand/);
    expect(CHAT).toMatch(/runGmloopReadOnly/);
    expect(CHAT).toMatch(/gmloopCurrentGmlFileTarget/);
    expect(CHAT).toMatch(/resolveProjectChildPath/);
    expect(CHAT).toMatch(/activeGmloopChild/);
    expect(CHAT).toMatch(/capGmloopOutput/);
    expect(CHAT).toMatch(/\['format', '--path', target\.path\]/);
    expect(CHAT).toMatch(/\['graph', 'doctor', '--path', projectDirectory\]/);
    expect(PANEL).toMatch(/No conversation yet/);
    expect(CHAT).toMatch(/getEditorContext:\s*currentEditorContext/);
    expect(STYLE).toMatch(/\.chatgml-context-chip/);
    expect(STYLE).toMatch(/\.chatgml-error-details/);
    expect(STYLE).toMatch(/\.chatgml-diagnostics/);
    expect(STYLE).toMatch(/\.chatgml-knowledge/);
    expect(PANEL).toMatch(/ChatPanel\.prototype\._renderKnowledge/);
    expect(PANEL).toMatch(/this\._renderKnowledge\(\)/);
    expect(PANEL).toMatch(/ChatPanel\.prototype\.loadTurns/);
    expect(PANEL).toMatch(/turnMetaText/);
    expect(PANEL).toMatch(/Available tools/);
    expect(PANEL).toMatch(/Working/);
    expect(STYLE).toMatch(/\.chatgml-turn-meta/);
  });

  it('tool activity and catalog render inside the transcript instead of compressing it', () => {
    expect(PANEL).toMatch(/chatgml-activity chatgml-activity-inline/);
    expect(PANEL).toMatch(/chatgml-tool-catalog chatgml-tool-catalog-inline/);
    expect(PANEL).not.toMatch(/c\.appendChild\(this\.activityEl\)/);
    expect(PANEL).not.toMatch(/c\.appendChild\(this\.catalogEl\)/);
    expect(PANEL).toMatch(/this\.transcriptEl\.insertBefore\(this\.activityEl/);
    expect(PANEL).toMatch(/this\.transcriptEl\.insertBefore\(this\.catalogEl/);
    expect(STYLE).toMatch(/\.chatgml-transcript > \.chatgml-activity/);
    expect(STYLE).toMatch(/\.chatgml-transcript > \.chatgml-tool-catalog/);
  });

  it('opening the panel auto-launches the core when a project is open', () => {
    expect(CHAT).toMatch(/if \(projectDirectory && !client\) launch\(\)/);
  });

  it('remembers manual open state without cleanup erasing it', () => {
    expect(CHAT).toMatch(/OPEN_PREF_KEY = 'chatgml_open_on_project_v1'/);
    expect(CHAT).toMatch(/function writeOpenPreference\(open\)/);
    expect(CHAT).toMatch(/if \(shouldRestoreOpen\(projectDirectory\)\)/);
    expect(CHAT).toMatch(/function togglePanel\(\)/);
    expect(CHAT).toMatch(/hide\(false\)/);
  });

  it('provider picker hides unused providers until search', () => {
    expect(PANEL).toMatch(/Search to show other providers/);
    expect(PANEL).toMatch(/if \(query\) \{\s*self\.settingsProvidersEl\.appendChild\(all\)/);
    expect(PANEL).toMatch(/'kimi-coding': true/);
    expect(PANEL).toMatch(/model\.id === 'kimi-for-coding'/);
  });

  it('ChatGML aside uses bounded chrome and safe hide/show reattachment', () => {
    expect(CHAT).toMatch(/ASIDE_WIDTH_KEY = 'chatgml_aside_width_v2'/);
    expect(CHAT).toMatch(/ASIDE_DEFAULT_WIDTH = 420/);
    expect(CHAT).toMatch(/ASIDE_MAX_WIDTH = 760/);
    expect(CHAT).toMatch(/function applyAsideWidth\(width\)/);
    expect(CHAT).toMatch(/function installAsideResizer\(handle\)/);
    expect(CHAT).toMatch(/rect\.right - ev\.clientX/);
    expect(CHAT).toMatch(/splitter-default-width', String\(ASIDE_DEFAULT_WIDTH\)/);
    expect(CHAT).toMatch(/splitter-lskey', ASIDE_WIDTH_KEY/);
    expect(CHAT).toMatch(/container\.classList\.add\('chatgml-aside'\)/);
    expect(CHAT).toMatch(/nextCont\.classList\.add\('chatgml-editor-main'\)/);
    expect(CHAT).toMatch(/mainCont\.style\.setProperty\('min-width', '0'\)/);
    expect(CHAT).toMatch(
      /if \(sizer && sizer\.parentNode\) sizer\.parentNode\.removeChild\(sizer\)/,
    );
    expect(CHAT).toMatch(/if \(sizer\.parentNode !== mainCont\) mainCont\.appendChild\(sizer\)/);
    expect(CHAT).toMatch(/applyAsideWidth\(readAsideWidth\(\)\)/);
    expect(STYLE).toMatch(/#chatgml_editor \{[\s\S]*width: 420px/);
    expect(STYLE).toMatch(/\.chatgml-aside-host \{[\s\S]*display: flex !important/);
    expect(STYLE).toMatch(/\.chatgml-editor-main \{[\s\S]*min-width: 360px/);
    expect(STYLE).toMatch(/#chatgml_editor\.chatgml-aside \{[\s\S]*max-width: 760px !important/);
    expect(STYLE).not.toMatch(/#chatgml_editor\.chatgml-aside \{[\s\S]*width: clamp\(300px, 34vw, 520px\) !important/);
    expect(STYLE).toMatch(/\.chatgml-splitter \{[\s\S]*flex: 0 0 5px/);
    expect(STYLE).toMatch(/\.chatgml-resizing/);
    expect(STYLE).toMatch(/\.chatgml-panel\[data-theme='light'\]/);
  });

  it('core-dependent buttons are explicit buttons and sync to ready/busy state', () => {
    expect(PANEL).toMatch(/this\.ready = false/);
    expect(PANEL).toMatch(/ChatPanel\.prototype\._syncControls/);
    expect(PANEL).toMatch(/!this\.ready \|\| this\._busy/);
    expect(PANEL).toMatch(/this\.launchBtn\.type = 'button'/);
    expect(PANEL).toMatch(/this\.sendBtn\.type = 'button'/);
    expect(PANEL).toMatch(/this\.reindexBtn\.type = 'button'/);
    expect(PANEL).toMatch(/this\.diagnosticsBtn\.type = 'button'/);
    expect(CHAT).toMatch(/acceptBtn\.type = 'button'/);
    expect(CHAT).toMatch(/reloadBtn\.type = 'button'/);
  });

  it('settings panel inserts against a direct container child after status moved into header', () => {
    expect(PANEL).not.toMatch(/insertBefore\(this\.settingsPanelEl,\s*this\.statusEl\)/);
    expect(PANEL).toMatch(/this\.configRowEl && this\.configRowEl\.parentNode === this\.opts\.container/);
    expect(PANEL).toMatch(/insertBefore\(this\.settingsPanelEl, anchor \|\| null\)/);
  });

  it('settings panel scrolls to the bottom and keeps Save reachable', () => {
    expect(PANEL).toMatch(/ChatPanel\.prototype\._fitSettingsPanel/);
    expect(PANEL).toMatch(/if \(willOpen\) this\._fitSettingsPanel\(\)/);
    expect(STYLE).toMatch(/\.chatgml-settings-panel \{[\s\S]*overflow: hidden/);
    expect(STYLE).toMatch(/max-height: 70vh/);
    expect(STYLE).toMatch(/max-height: min\(70vh, calc\(100% - 12px\), 720px\)/);
    expect(STYLE).toMatch(/\.chatgml-settings-scroll \{[\s\S]*overflow-y: auto/);
    expect(STYLE).toMatch(/\.chatgml-settings-save \{[\s\S]*position: sticky/);
    expect(STYLE).toMatch(/\.chatgml-settings-save \{[\s\S]*bottom: 0/);
  });

  it('empty transient rails do not consume transcript space', () => {
    expect(STYLE).toMatch(/\.chatgml-activity:empty/);
    expect(STYLE).toMatch(/\.chatgml-tool-catalog:empty/);
    expect(STYLE).toMatch(/\.chatgml-sources:empty/);
    expect(STYLE).toMatch(/\.chatgml-trim-notice:empty/);
  });

  it('sessions start compact but keep active session visible', () => {
    expect(PANEL).toMatch(/chatgml-session-root chatgml-session-root--collapsed/);
    expect(PANEL).toMatch(/chatgml-session-active-title/);
    expect(PANEL).toMatch(/this\.sessionsCollapsed = true/);
    expect(PANEL).toMatch(/_refreshActiveSessionTitle/);
    expect(STYLE).toMatch(/\.chatgml-session-active-title/);
  });

  it('streaming token frames avoid full markdown rerenders', () => {
    expect(PANEL).toMatch(/ChatPanel\.prototype\._renderTokenFrame/);
    expect(PANEL).toMatch(/ChatPanel\.prototype\._setStreamingBodyText/);
    expect(PANEL).toMatch(/self\._renderTokenFrame\(\)/);
    expect(PANEL).toMatch(/if \(sb\) this\._setStreamingBodyText\(sb, s\.answer\)/);
    expect(PANEL).toMatch(/value\.indexOf\(previous\) === 0/);
    expect(PANEL).toMatch(/node\.nodeValue \+= suffix/);
    expect(PANEL).toMatch(/var wasNearBottom = this\._isNearBottom\(\)/);
    expect(PANEL).toMatch(/MarkdownApi\.renderMarkdown\(turn\.assistantText, asstBody\)/);
  });

  it('terminal errors clear busy instead of leaving Stop stuck on streaming', () => {
    expect(PANEL).toMatch(/this\.state\.busy = true/);
    expect(PANEL).toMatch(/this\._setBusy\(\!\!this\.state\.busy\)/);
    expect(PANEL).not.toMatch(/this\._setBusy\(this\.state\.outbox\.length > 0\)/);
    expect(PANEL).toMatch(/var isWorking = \!\!s\.busy \|\| hasRunningActivity/);
  });
});
