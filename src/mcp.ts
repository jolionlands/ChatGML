// src/mcp.ts — MCP (Model Context Protocol) server over stdio.
//
// Exposes ChatGML's GML-aware tool registry (glob, grep, read_file, search_code,
// graph_neighbors, temporal_query, and sandboxed apply_patch) as MCP tools so ANY MCP-speaking
// agent IDE (Cline, ZooCode, Cursor, Claude Code, Copilot Chat, pi, openclaw) can use ChatGML's
// GML-aware index + retrieval. This is the LEVERAGE route: the agent IDE owns the chat/diff UX
// and human approval; ChatGML owns the GML-aware code-graph retrieval + sandboxed writes.
//
// The protocol is JSON-RPC 2.0 over NDJSON (one JSON object per line on stdio) — the standard MCP
// stdio transport. We implement it manually (no @modelcontextprotocol/sdk dependency) to keep the
// dep surface minimal, consistent with the project's no-pickle/no-eval stance. The surface is small:
//   initialize -> server info + capabilities
//   tools/list -> the ChatGML tool registry as MCP tool definitions
//   tools/call -> dispatch one tool by name with JSON arguments; return MCP content blocks
//   notifications/initialized -> no-op (ready signal)
//   shutdown -> exit 0
//
// apply_patch in MCP mode auto-applies (the agent IDE's OWN diff-approval UX is the human gate —
// Cline/Cursor show the proposed edit and ask the user BEFORE the tool executes). The edit tool's
// forceGate backstop (whole-file rewrite / mass deletion) still LOGS a warning but resolves true:
// the agent IDE is the human-in-the-loop, not ChatGML's gate.
import { NdjsonDecoder } from './protocol.js';
import type { AgentEvent, Config, ToolRegistry, ToolContext } from './types.js';
import type { MemoryProvider } from './memory/provider.js';
import type { IgnoreFilter } from './types.js';
import { makeScope } from './memory/types.js';
import { buildIgnoreFilter } from './index/files.js';
import { toOpenAiToolSpecs, dispatchTool } from './tools/index.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_NAME = 'chatgml';
export const MCP_SERVER_VERSION = '0.1.0';

export interface McpTransport {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  diagnostics?: NodeJS.WritableStream;
}

export interface McpServerDeps {
  tools: ToolRegistry;
  config: Config;
  memory: MemoryProvider;
  ignore?: IgnoreFilter;
}

/**
 * Run the MCP server loop over a Transport until the input stream ends or a shutdown is requested.
 * Returns when EOF is reached. All diagnostics go to stderr (stdout is JSON-RPC ONLY).
 */
export async function runMcpServer(deps: McpServerDeps, transport: McpTransport): Promise<void> {
  const { input, output } = transport;
  const diag = transport.diagnostics ?? process.stderr;
  const decoder = new NdjsonDecoder();
  let shutdownRequested = false;

  const scope = makeScope(deps.config.scope);
  const ignore = deps.ignore ?? (await buildIgnoreFilter(deps.config.index.root));
  const controller = new AbortController();
  // Filter the advertised tools by the active mode so an `ask`-mode MCP server does not advertise
  // apply_patch / execute_command. (The MCP approval model is always auto-apply — the agent IDE
  // owns the human gate — so a gated tool advertised here would silently apply without a human
  // check on this side. Filter it out unless the mode actually allows it.)
  const toolSpecs = toOpenAiToolSpecs(deps.tools, deps.config.mode);

  // Build a ToolContext with auto-approval: the agent IDE's own diff UX is the human gate.
  // requestApproval always resolves true (the agent IDE confirmed the edit before calling the tool).
  // log() captures warnings (forceGate backstop from the destructive-edit risk assessment) so a
  // high-risk auto-applied edit is reflected in the tool result text, not silently dropped — the
  // agent IDE's transcript shows the user that an injection-style edit was applied despite auto.
  const makeCtx = (): { ctx: ToolContext; warnings: string[] } => {
    const warnings: string[] = [];
    const ctx: ToolContext = {
      root: deps.config.index.root,
      scope,
      memory: deps.memory,
      approval: 'auto',
      ignore,
      signal: controller.signal,
      ...(deps.config.search.minScore !== undefined
        ? { searchMinScore: deps.config.search.minScore }
        : {}),
      emit: (_e: AgentEvent) => {
        /* MCP has no streaming event channel; tool results are returned synchronously. */
      },
      requestApproval: async () => ({ approved: true }),
      log: (_level, msg, _meta) => {
        if (typeof msg === 'string' && msg.length > 0) warnings.push(msg);
      },
    };
    return { ctx, warnings };
  };

  const send = (obj: unknown): void => {
    output.write(JSON.stringify(obj) + '\n');
  };

  const sendResult = (id: unknown, result: unknown): void => {
    send({ jsonrpc: '2.0', id, result });
  };
  const sendError = (id: unknown, code: number, message: string): void => {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  };

  const handle = async (id: unknown, method: string, params: unknown): Promise<void> => {
    switch (method) {
      case 'initialize': {
        sendResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
          capabilities: {
            tools: { listChanged: false },
          },
        });
        return;
      }
      case 'notifications/initialized': {
        // A notification (no id); no response needed.
        return;
      }
      case 'tools/list': {
        const tools = toolSpecs.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          inputSchema: t.function.parameters,
        }));
        sendResult(id, { tools });
        return;
      }
      case 'tools/call': {
        const p = params as { name?: string; arguments?: unknown } | undefined;
        const name = p?.name;
        if (typeof name !== 'string' || name === '') {
          sendError(id, -32602, 'tools/call requires a non-empty "name"');
          return;
        }
        const args = p?.arguments ?? {};
        const rawArgs = typeof args === 'string' ? args : JSON.stringify(args);
        const { ctx, warnings } = makeCtx();
        const result = await dispatchTool(deps.tools, name, rawArgs, ctx);
        // MCP tool result: { content: [{type:'text', text}], isError }
        const textParts: string[] = [result.content];
        // Surface forceGate warnings (destructive-edit backstop fired even in auto mode) so the
        // agent IDE's transcript shows the user that a high-risk edit auto-applied.
        if (warnings.length > 0) {
          textParts.push('', 'Warnings:');
          for (const w of warnings) textParts.push(`  - ${w}`);
        }
        // Surface citations as a footer so the agent IDE shows source paths/line ranges.
        if (result.citations && result.citations.length > 0) {
          textParts.push('', 'Sources:');
          for (const c of result.citations) {
            const loc =
              c.path !== undefined
                ? c.startLine !== undefined
                  ? `${c.path}:${c.startLine}-${c.endLine ?? c.startLine}`
                  : c.path
                : '(memory)';
            textParts.push(`  - ${loc}`);
          }
        }
        sendResult(id, {
          content: [{ type: 'text', text: textParts.join('\n') }],
          isError: result.ok !== true,
        });
        return;
      }
      case 'shutdown': {
        shutdownRequested = true;
        sendResult(id, {});
        controller.abort();
        return;
      }
      default: {
        sendError(id, -32601, `method not found: ${method}`);
      }
    }
  };

  const processLine = async (raw: unknown): Promise<void> => {
    const obj = raw as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown } | null;
    if (typeof obj !== 'object' || obj === null) return;
    if (typeof obj.method !== 'string') return;
    // A notification has no id; a request has one. Both are handled, but notifications get no response.
    const id = obj.id;
    await handle(id, obj.method, obj.params);
  };

  try {
    for await (const chunk of input) {
      for (const raw of decoder.push(chunk as Buffer | string)) {
        await processLine(raw);
      }
      if (shutdownRequested) break;
    }
    // EOF: flush any trailing line.
    for (const raw of decoder.flush()) {
      await processLine(raw);
    }
  } catch (err) {
    diag.write(`mcp: input stream error: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    controller.abort();
    if (deps.memory.close) await deps.memory.close();
  }
}
