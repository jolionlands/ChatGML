// test/helpers/tool-context.ts — build a ToolContext for tool tests.
import type { ToolContext, AgentEvent, ApprovalRequest, Scope, IgnoreFilter } from '../../src/types.js';
import type { MemoryProvider } from '../../src/memory/provider.js';

const ALLOW_ALL: IgnoreFilter = { ignores: () => false };

const NOOP_MEMORY: MemoryProvider = {
  id: 'local',
  capabilities: new Set(['upsert', 'search', 'graph', 'temporal', 'remember', 'recall']),
  async upsert() {},
  async search() {
    return [];
  },
  async graphNeighbors() {
    return [];
  },
  async temporalQuery() {
    return [];
  },
  async remember() {},
  async recall() {
    return [];
  },
};

export interface FakeCtxOptions {
  root: string;
  scope?: Scope;
  memory?: MemoryProvider;
  ignore?: IgnoreFilter;
  approval?: 'gated' | 'auto';
  signal?: AbortSignal;
  searchMinScore?: number;
  requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
}

export interface FakeCtx {
  ctx: ToolContext;
  events: AgentEvent[];
  logs: Array<{ level: string; msg: string }>;
}

export function makeToolContext(opts: FakeCtxOptions): FakeCtx {
  const events: AgentEvent[] = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const ctx: ToolContext = {
    root: opts.root,
    scope: opts.scope ?? { repo: 'test' },
    memory: opts.memory ?? NOOP_MEMORY,
    approval: opts.approval ?? 'gated',
    ignore: opts.ignore ?? ALLOW_ALL,
    signal: opts.signal ?? new AbortController().signal,
    searchMinScore: opts.searchMinScore,
    emit(e) {
      events.push(e);
    },
    async requestApproval(req) {
      return opts.requestApproval ? opts.requestApproval(req) : false;
    },
    log(level, msg) {
      logs.push({ level, msg });
    },
  };
  return { ctx, events, logs };
}
