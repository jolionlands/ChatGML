// src/tools/mcp.ts — wrap external MCP tools into ChatGML's ToolDef contract.
import { z } from 'zod';
import type { Tool, ToolResult } from '../types.js';
import type { McpClient, McpTool } from '../mcp-client.js';

/**
 * Build ToolDef wrappers for every tool advertised by the connected MCP clients. Each wrapped tool
 * is named `mcp_<server>_<toolName>`, carries the external server's inputSchema for OpenAI spec
 * generation, and delegates execution to the MCP client.
 */
export async function wrapMcpTools(clients: Map<string, McpClient>): Promise<Tool[]> {
  const tools: Tool[] = [];
  for (const [serverKey, client] of clients) {
    const serverName = client.config.name ?? serverKey;
    let mcpTools: McpTool[];
    try {
      mcpTools = await client.toolsList();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `mcp-tools: failed to list tools for server '${serverName}': ${message}\n`,
      );
      continue;
    }
    for (const mcpTool of mcpTools) {
      tools.push(createMcpTool(client, serverName, mcpTool));
    }
  }
  return tools;
}

function createMcpTool(client: McpClient, serverName: string, mcpTool: McpTool): Tool {
  const prefixedName = `mcp_${serverName}_${mcpTool.name}`;
  return {
    name: prefixedName,
    description: mcpTool.description ?? `MCP tool ${mcpTool.name} on ${serverName}`,
    schema: z.record(z.unknown()),
    kind: 'mcp',
    server: serverName,
    inputSchema: mcpTool.inputSchema,
    async execute(args): Promise<ToolResult> {
      const res = await client.callTool(mcpTool.name, args);
      return { content: res.content, isError: res.isError === true };
    },
  };
}
