// test/helpers/fake-agent.ts — a controllable AgentLike for serve + cli tests.
import type { AgentLike } from '../../src/agent.js';
import type { AgentEvent } from '../../src/types.js';
import type { InEvent } from '../../src/protocol.js';

export interface FakeAgentScript {
  /** Events to emit BEFORE the release gate (e.g. an early token). */
  before?: AgentEvent[];
  /** Events to emit AFTER release() (e.g. the answer). When omitted, emit immediately. */
  after?: AgentEvent[];
}

/**
 * A FakeAgent that emits scripted events. With a `release()` gate, `after` events are withheld until
 * the test calls release(), making the serve-cancel test deterministic: send user, await the first
 * token, send cancel, assert the run's signal fired and no further events arrived pre-release.
 */
export class FakeAgent implements AgentLike {
  readonly approvals: Array<{ id: string; approved: boolean }> = [];
  cancelled = false;
  lastSignalAborted = false;
  private releaseResolvers: Array<() => void> = [];

  constructor(private readonly script: FakeAgentScript = {}) {}

  release(): void {
    const rs = this.releaseResolvers;
    this.releaseResolvers = [];
    for (const r of rs) r();
  }

  run(_command: InEvent, signal: AbortSignal): AsyncIterable<AgentEvent> {
    // Register the release gate synchronously at call time (so release() before iteration works),
    // then delegate to a generator method where `this` is available directly (no this-alias).
    const gate =
      this.script.after !== undefined
        ? new Promise<void>((resolve) => this.releaseResolvers.push(resolve))
        : Promise.resolve();
    return this.runGen(signal, gate);
  }

  private async *runGen(signal: AbortSignal, gate: Promise<void>): AsyncGenerator<AgentEvent> {
    for (const e of this.script.before ?? []) {
      yield e;
    }
    if (this.script.after !== undefined) {
      await gate;
    }
    if (signal.aborted) {
      this.lastSignalAborted = true;
      yield { type: 'status', phase: 'cancelled' } as AgentEvent;
      return;
    }
    for (const e of this.script.after ?? []) {
      yield e;
    }
  }

  resolveApproval(id: string, approved: boolean): void {
    this.approvals.push({ id, approved });
  }

  cancel(): void {
    this.cancelled = true;
  }
}
