import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { executeCommandTool } from '../../src/tools/exec.js';
import { createApprovalGate } from '../../src/agent.js';
import { makeToolContext } from '../helpers/tool-context.js';
import { makeTmpRepo } from '../helpers/fakes.js';
import type { AgentEvent } from '../../src/types.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();

  constructor() {
    super();
    (this.stdout as EventEmitter & { setEncoding?: (e: string) => void }).setEncoding = () => {};
    (this.stderr as EventEmitter & { setEncoding?: (e: string) => void }).setEncoding = () => {};
  }
}

async function untilSpawned(): Promise<void> {
  for (let i = 0; i < 100 && vi.mocked(spawn).mock.calls.length === 0; i++) {
    await Promise.resolve();
  }
}

describe('execute_command', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function makeGate(autoApprove: boolean) {
    const events: AgentEvent[] = [];
    const gate = createApprovalGate({ autoApprove, emit: (e) => events.push(e) });
    return { gate, events };
  }

  it('emits command_request and streams stdout when approved', async () => {
    const repo = makeTmpRepo({});
    const { gate, events: gateEvents } = makeGate(true);
    const { ctx, events: ctxEvents } = makeToolContext({
      root: repo.root,
      approval: 'gated',
      requestApproval: (req) => gate.request(req),
    });

    const proc = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const p = executeCommandTool.execute({ command: 'echo hello' }, ctx);
    await untilSpawned();
    proc.stdout.emit('data', 'hello\n');
    proc.emit('close', 0, null);

    const res = await p;
    expect(res.isError).not.toBe(true);
    expect(res.content).toContain('Exit code 0');
    expect(res.content).toContain('hello');

    expect(gateEvents.some((e) => e.type === 'command_request' && e.command === 'echo hello')).toBe(
      true,
    );
    expect(
      ctxEvents.some(
        (e) => e.type === 'command_output' && e.stream === 'stdout' && e.text === 'hello\n',
      ),
    ).toBe(true);
    expect(ctxEvents.some((e) => e.type === 'command_exit' && e.code === 0)).toBe(true);

    repo.cleanup();
  });

  it('returns a nonzero exit as an error with the aggregated output', async () => {
    const repo = makeTmpRepo({});
    const { gate } = makeGate(true);
    const { ctx } = makeToolContext({
      root: repo.root,
      approval: 'gated',
      requestApproval: (req) => gate.request(req),
    });

    const proc = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const p = executeCommandTool.execute({ command: 'some-failing-cmd' }, ctx);
    await untilSpawned();
    proc.stderr.emit('data', 'error message\n');
    proc.emit('close', 1, null);

    await expect(p).rejects.toThrow('Exit code 1');

    repo.cleanup();
  });

  it('times out a long-running command and reports timeout', async () => {
    vi.useFakeTimers();
    const repo = makeTmpRepo({});
    const { gate } = makeGate(true);
    const { ctx } = makeToolContext({
      root: repo.root,
      approval: 'gated',
      requestApproval: (req) => gate.request(req),
    });

    const proc = new FakeChildProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const p = executeCommandTool.execute({ command: 'sleep 30', timeout: 1000 }, ctx);
    await untilSpawned();
    vi.advanceTimersByTime(1000);
    proc.emit('close', null, 'SIGTERM');

    await expect(p).rejects.toThrow('timed out');

    vi.useRealTimers();
    repo.cleanup();
  });

  it('rejects commands containing dangerous tokens or shell metacharacters', async () => {
    const { ctx } = makeToolContext({ root: '/r' });

    await expect(executeCommandTool.execute({ command: 'rm -rf /' }, ctx)).rejects.toThrow(
      'dangerous',
    );
    await expect(
      executeCommandTool.execute({ command: 'git push origin main' }, ctx),
    ).rejects.toThrow('dangerous');
    await expect(executeCommandTool.execute({ command: 'echo a && echo b' }, ctx)).rejects.toThrow(
      'dangerous',
    );
    await expect(executeCommandTool.execute({ command: 'echo $(ls)' }, ctx)).rejects.toThrow(
      'dangerous',
    );
  });

  it('rejects a cwd that escapes the project root', async () => {
    const repo = makeTmpRepo({});
    const { ctx } = makeToolContext({ root: repo.root });

    await expect(
      executeCommandTool.execute({ command: 'echo hi', cwd: '../escape' }, ctx),
    ).rejects.toMatchObject({ code: 'sandbox_escape' });

    repo.cleanup();
  });

  it('returns a non-error message when approval is rejected', async () => {
    const { ctx } = makeToolContext({
      root: '/r',
      approval: 'gated',
      requestApproval: async () => ({ approved: false }),
    });

    const res = await executeCommandTool.execute({ command: 'echo hi' }, ctx);
    expect(res.isError).not.toBe(true);
    expect(res.content).toContain('not approved');
  });
});
