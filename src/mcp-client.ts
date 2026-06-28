// src/mcp-client.ts — lightweight MCP client (JSON-RPC over stdio).
//
// ChatGML can act as an MCP client, loading tools/resources from external MCP servers and invoking
// them on the model's behalf. This file implements the stdio transport (MVP); SSE is stubbed.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpServerConfig } from './types.js';

export type { McpServerConfig };

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResult {
  content: string;
  isError?: boolean;
}

export interface McpResource {
  uri: string;
  name?: string;
  mimeType?: string;
}

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * A minimal MCP client over stdio. After `initialize()` succeeds, callers may list tools, call
 * tools, and optionally list/read resources. All communication is JSON-RPC 2.0 over NDJSON.
 */
export class McpClient {
  private process?: ChildProcessWithoutNullStreams;
  private reqId = 0;
  private pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  /** Local NDJSON line buffer — tolerant of malformed lines (they're dropped, not thrown). */
  private buffer = '';
  private closed = false;
  private initPromise?: Promise<void>;
  private readonly timeoutMs: number;

  constructor(public readonly config: McpServerConfig) {
    this.timeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  /** Perform the MCP initialize handshake (idempotent). */
  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    if (this.config.disabled) {
      throw new Error(`MCP server ${this.config.name ?? '(unnamed)'} is disabled`);
    }
    if (this.config.url) {
      throw new Error('SSE MCP transport is not yet implemented');
    }
    const command = this.config.command;
    if (!command) {
      throw new Error(`MCP server ${this.config.name ?? '(unnamed)'} requires command or url`);
    }

    const proc = spawn(command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = proc;

    proc.stdout.on('data', (chunk: Buffer | string) => this.handleStdout(chunk));
    proc.stderr.on('data', (chunk: Buffer | string) => {
      // Surface diagnostics on stderr so a failing server is debuggable; do not treat stray stderr
      // as a fatal error because some servers log warnings there.
      process.stderr.write(chunk);
    });
    proc.on('error', (err) => this.rejectAll(err));
    proc.on('exit', (code) => {
      this.closed = true;
      if (code !== 0 && code !== null) {
        this.rejectAll(new Error(`MCP server ${this.config.name ?? ''} exited with code ${code}`));
      }
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'chatgml', version: '0.1.0' },
    });
  }

  private handleStdout(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line.trim()));
      } catch {
        // Drop the malformed line and keep going. A misbehaving server (or a corrupted chunk)
        // must NEVER stop the stream — a real response on the next line is still delivered.
      }
    }
    for (const raw of out) this.handleMessage(raw);
  }

  private handleMessage(msg: unknown): void {
    const obj = msg as
      | { id?: number | string; result?: unknown; error?: { code: number; message: string } }
      | null
      | undefined;
    if (!obj || typeof obj !== 'object') return;
    const id = obj.id;
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (obj.error) {
      pending.reject(new Error(obj.error.message));
    } else {
      pending.resolve(obj.result);
    }
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process || this.process.killed || this.closed) {
        reject(new Error(`MCP client ${this.config.name ?? ''} is not initialized`));
        return;
      }
      const id = ++this.reqId;
      this.pending.set(id, { resolve, reject });
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.process.stdin.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request '${method}' timed out after ${this.timeoutMs}ms`));
        }
      }, this.timeoutMs);
    });
  }

  /** List tools advertised by the server. */
  async toolsList(): Promise<McpTool[]> {
    const result = (await this.request('tools/list', {})) as { tools?: unknown[] } | undefined;
    const tools = result?.tools ?? [];
    return tools.map((t) => {
      const tool = t as Partial<McpTool>;
      return {
        name: tool.name ?? 'unknown',
        description: tool.description,
        inputSchema: tool.inputSchema,
      };
    });
  }

  /** List resources advertised by the server (optional). */
  async resourcesList(): Promise<McpResource[]> {
    const result = (await this.request('resources/list', {})) as
      | { resources?: unknown[] }
      | undefined;
    const resources = result?.resources ?? [];
    return resources.map((r) => {
      const res = r as Partial<McpResource>;
      return { uri: res.uri ?? '', name: res.name, mimeType: res.mimeType };
    });
  }

  /** Invoke a tool by name with JSON arguments. */
  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    const result = (await this.request('tools/call', { name, arguments: args })) as
      | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      | undefined;
    const parts = result?.content ?? [];
    const text = parts
      .map((p) => (p.type === 'text' ? (p.text ?? '') : JSON.stringify(p)))
      .join('\n');
    return { content: text, isError: result?.isError === true };
  }

  /** Read a resource by URI (optional). */
  async readResource(uri: string): Promise<string> {
    const result = (await this.request('resources/read', { uri })) as
      | { contents?: Array<{ text?: string }> }
      | undefined;
    const contents = result?.contents ?? [];
    return contents.map((c) => c.text ?? '').join('\n');
  }

  /** Terminate the server process and reject any pending requests. */
  close(): void {
    this.closed = true;
    if (this.process && !this.process.killed) {
      try {
        this.process.stdin.end();
      } catch {
        // ignore
      }
      this.process.kill();
    }
    this.rejectAll(new Error('MCP client closed'));
  }
}

/**
 * Initialize all configured MCP clients, skipping disabled servers and logging errors for servers
 * that fail to start. Returns a map keyed by the config record key.
 */
export async function createMcpClients(
  configs: Record<string, McpServerConfig> | undefined,
): Promise<Map<string, McpClient>> {
  const map = new Map<string, McpClient>();
  if (!configs) return map;
  for (const [key, cfg] of Object.entries(configs)) {
    if (cfg.disabled) continue;
    const client = new McpClient({ ...cfg, name: cfg.name ?? key });
    try {
      await client.initialize();
      map.set(key, client);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`mcp-client: failed to initialize server '${key}': ${message}\n`);
    }
  }
  return map;
}
