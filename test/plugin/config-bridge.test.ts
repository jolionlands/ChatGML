import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../../plugin/config-bridge.js'), 'utf8');

describe('plugin/config-bridge.js process spawning', () => {
  it('uses shared Windows cmd wrapper for config commands', () => {
    expect(SRC).toMatch(/ChildProcess\.resolveBinary/);
    expect(SRC).toMatch(/ChildProcess\.wrapCmdForWindows/);
    expect(SRC).toMatch(/ChildProcess\.buildMinimalEnv/);
  });

  it('turns synchronous exec setup failures into callback errors', () => {
    expect(SRC).toMatch(/ConfigBridge\.prototype\._execCore/);
    expect(SRC).toMatch(/try\s*\{[\s\S]*execFile/);
    expect(SRC).toMatch(/catch\s*\(err\)\s*\{\s*cb\(err,\s*'',\s*''\)/);
  });

  it('mirrors MCP JSON through per-server config leaves, not a bare mcpServers field', () => {
    expect(SRC).toMatch(/SettingsTasks\.mcpCommandsFromJson/);
    expect(SRC).not.toMatch(/setConfigField\('mcpServers'/);
  });
});
