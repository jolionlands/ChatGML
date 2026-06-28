// src/tools/exec.ts — execute_command: approval-gated, sandboxed command execution.
//
// The model proposes a command to run inside the project root. This tool:
//   1. rejects dangerous tokens and shell metacharacters before any spawn;
//   2. sandboxes the working directory to the project root via resolveInsideRoot;
//   3. requests human approval via ctx.requestApproval (emits command_request through the gate);
//   4. spawns the command WITHOUT a shell (shell:false) and streams stdout/stderr as command_output
//      events, capped at the last 8KB for the LLM result;
//   5. returns nonzero exits / timeouts / signals as ToolErrors with the matching ToolErrorCode.
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { defineTool, ToolError } from '../tool-error.js';
import type { ToolDef, ToolResult, ToolContext } from '../types.js';
import { resolveInsideRoot } from './sandbox.js';

const CommandArgs = z.object({
  command: z.string().min(1).max(4096),
  cwd: z.string().optional(),
  timeout: z.number().int().positive().max(60000).optional(),
});
type CommandArgs = z.infer<typeof CommandArgs>;

const COMBINED_OUTPUT_LIMIT = 8192;

const DANGEROUS_TOKENS = [
  'rm',
  'sudo',
  'dd',
  'mkfs',
  'git push',
  'npm publish',
  'Remove-Item',
  'Format-Volume',
  'shutdown',
  'Set-ExecutionPolicy',
];

const SHELL_METACHAR_PATTERN = /[;&|]|&&|\|\||\$\(|\$\{|`/;

function validateCommand(command: string): void {
  const lower = command.toLowerCase();
  for (const token of DANGEROUS_TOKENS) {
    if (lower.includes(token.toLowerCase())) {
      throw new ToolError('bad_args', `command rejected: dangerous token "${token}"`);
    }
  }
  if (SHELL_METACHAR_PATTERN.test(command)) {
    throw new ToolError('bad_args', 'command rejected: dangerous shell metacharacter');
  }
}

function parseCommand(command: string): { file: string; args: string[] } {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new ToolError('bad_args', 'empty command');
  }
  return { file: parts[0]!, args: parts.slice(1) };
}

function aggregateOutput(chunks: string[]): string {
  const combined = chunks.join('');
  if (combined.length <= COMBINED_OUTPUT_LIMIT) return combined;
  return combined.slice(-COMBINED_OUTPUT_LIMIT);
}

export const executeCommandTool: ToolDef<CommandArgs> = defineTool<CommandArgs>({
  name: 'execute_command',
  description:
    'Execute a shell command inside the project root. APPROVAL-GATED: the command is run only after the user approves it.',
  kind: 'command',
  schema: CommandArgs,
  async execute(args: CommandArgs, ctx: ToolContext): Promise<ToolResult> {
    validateCommand(args.command);

    let cwd: string;
    try {
      cwd = args.cwd ? await resolveInsideRoot(ctx.root, args.cwd) : ctx.root;
    } catch (err) {
      throw new ToolError('sandbox_escape', `cwd escapes the project root: ${args.cwd}`);
    }

    const id = ctx.toolCallId ?? 'cmd-unknown';

    let approved = ctx.preApproved === true;
    if (!approved) {
      const resolution = await ctx.requestApproval({
        id,
        kind: 'exec',
        command: args.command,
        cwd,
      });
      approved = resolution.approved;
    }

    if (!approved) {
      return {
        content: `command not approved: ${args.command}`,
        isError: false,
      };
    }

    const { file, args: argv } = parseCommand(args.command);
    const timeoutMs = args.timeout ?? 30000;

    return new Promise<ToolResult>((resolve, reject) => {
      const proc = spawn(file, argv, {
        cwd,
        shell: false,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const chunks: string[] = [];
      let killedByTimeout = false;

      const timeout = setTimeout(() => {
        killedByTimeout = true;
        proc.kill();
      }, timeoutMs);

      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');

      proc.stdout.on('data', (text: string) => {
        chunks.push(text);
        ctx.emit({ type: 'command_output', id, stream: 'stdout', text });
      });

      proc.stderr.on('data', (text: string) => {
        chunks.push(text);
        ctx.emit({ type: 'command_output', id, stream: 'stderr', text });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(new ToolError('provider_error', `failed to spawn command: ${err.message}`));
      });

      proc.on('close', (code, signal) => {
        clearTimeout(timeout);
        ctx.emit({ type: 'command_exit', id, code: code ?? -1 });

        if (killedByTimeout) {
          reject(
            new ToolError('timeout', `command timed out after ${timeoutMs}ms: ${args.command}`),
          );
          return;
        }

        if (signal) {
          reject(
            new ToolError('interrupted', `command terminated by signal ${signal}: ${args.command}`),
          );
          return;
        }

        const output = aggregateOutput(chunks);
        const content = `Exit code ${code ?? -1}\n${output}`;
        if (code !== 0) {
          reject(new ToolError('nonzero_exit', content));
        } else {
          resolve({ content, isError: false });
        }
      });
    });
  },
});
