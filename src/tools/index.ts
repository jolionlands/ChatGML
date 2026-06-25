// src/tools/index.ts — tool registry, OpenAI tool-spec generation, and dispatch.
//
// `buildToolRegistry` assembles the read-only tools (+ the gated apply_patch stub unless
// `readOnly` is requested). `toOpenAiToolSpecs` turns each tool's zod schema into a JSON Schema for
// the `tools` request field (zod-to-json-schema, openApi3 target so `$schema` is omitted and
// `additionalProperties:false` is set). `dispatchTool` safe-parses the model-supplied JSON args
// (bad -> bad_args), honors ctx.signal (aborted), and wraps any thrown ToolError/Error into a
// `{ ok:false }` result envelope — a failing tool never crashes the agent loop.
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType } from 'zod';
import { ToolError } from '../tool-error.js';
import type {
  Tool,
  ToolRegistry,
  ToolContext,
  ToolResult,
  ToolSpec,
  Citation,
} from '../types.js';

import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { readTool } from './read.js';
import { searchTool } from './search.js';
import { graphTool } from './graph.js';
import { temporalTool } from './temporal.js';
import { editTool } from './edit.js';

export { globTool, grepTool, readTool, searchTool, graphTool, temporalTool, editTool };

const READ_TOOLS: readonly Tool[] = [
  globTool,
  grepTool,
  readTool,
  searchTool,
  graphTool,
  temporalTool,
] as unknown as readonly Tool[];

const GATED_TOOLS: readonly Tool[] = [editTool] as unknown as readonly Tool[];

export interface BuildRegistryOptions {
  /** When true, omit the gated apply_patch tool (a pure read-only agent). */
  readOnly?: boolean;
}

/** Build the tool registry (read-only tools, plus the gated edit stub unless readOnly). */
export function buildToolRegistry(opts: BuildRegistryOptions = {}): ToolRegistry {
  const map = new Map<string, Tool>();
  for (const t of READ_TOOLS) map.set(t.name, t);
  if (!opts.readOnly) {
    for (const t of GATED_TOOLS) map.set(t.name, t);
  }
  return map;
}

/** Convert a single zod schema to an OpenAI-style JSON Schema parameters object. */
function schemaToParameters(schema: ZodType<unknown>): Record<string, unknown> {
  const js = zodToJsonSchema(schema, {
    target: 'openApi3',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  // openApi3 target already omits `$schema` and sets additionalProperties:false on objects, but be
  // defensive: strip any $schema and force the top-level object to disallow extra props.
  delete js['$schema'];
  if (js['type'] === 'object') {
    js['additionalProperties'] = false;
    if (js['properties'] === undefined) js['properties'] = {};
  }
  return js;
}

/** Build the `tools` array for an OpenAI-compatible chat request from a registry. */
export function toOpenAiToolSpecs(registry: ToolRegistry): ToolSpec[] {
  const specs: ToolSpec[] = [];
  for (const tool of registry.values()) {
    specs.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: schemaToParameters(tool.schema as ZodType<unknown>),
      },
    });
  }
  return specs;
}

export interface DispatchResult {
  ok: boolean;
  content: string;
  citations?: Citation[];
  code?: string;
}

/**
 * Dispatch a single tool call by name with raw JSON-string arguments. Returns a `{ ok }` envelope.
 * Unknown tool / malformed args -> ok:false with code bad_args. Aborted signal -> aborted. A thrown
 * ToolError preserves its code; any other thrown Error becomes a generic ok:false.
 */
export async function dispatchTool(
  registry: ToolRegistry,
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<DispatchResult> {
  if (ctx.signal.aborted) {
    return { ok: false, content: 'aborted', code: 'aborted' };
  }
  const tool = registry.get(name);
  if (!tool) {
    return { ok: false, content: `unknown tool: ${name}`, code: 'bad_args' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = rawArgs.trim() === '' ? {} : JSON.parse(rawArgs);
  } catch {
    return { ok: false, content: `malformed JSON arguments for ${name}`, code: 'bad_args' };
  }

  const parsed = tool.schema.safeParse(parsedJson);
  if (!parsed.success) {
    const firstPath = parsed.error.issues[0]?.path.join('.') ?? '(root)';
    const msg = parsed.error.issues[0]?.message ?? 'invalid arguments';
    return { ok: false, content: `bad arguments for ${name} (${firstPath}): ${msg}`, code: 'bad_args' };
  }

  try {
    const result: ToolResult = await tool.execute(parsed.data, ctx);
    const out: DispatchResult = { ok: result.isError !== true, content: result.content };
    if (result.citations && result.citations.length > 0) out.citations = result.citations;
    return out;
  } catch (err) {
    if (err instanceof ToolError) {
      return { ok: false, content: err.message, code: err.code };
    }
    return { ok: false, content: `tool ${name} failed`, code: 'provider_error' };
  }
}
