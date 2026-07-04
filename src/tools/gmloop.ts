import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { defineTool, ToolError } from '../tool-error.js';
import type { ToolDef, ToolContext, ToolResult } from '../types.js';
import { resolveInsideRoot } from './sandbox.js';

const LiveEndpoint = z.enum(['status', 'health', 'ping', 'ready']);

const GmloopArgs = z.object({
  action: z
    .enum([
      'status',
      'lint',
      'format_check',
      'graph_doctor',
      'parse',
      'live_status',
      'live_discover',
      'live_attach',
      'live_wait_for_patch',
      'runner_status',
      'runner_logs',
    ])
    .optional()
    .describe('Read-only GMLoop action.'),
  path: z.string().optional().describe('Project-relative file/folder path for lint/format/parse.'),
  endpoint: LiveEndpoint.optional().describe('live_status endpoint: status, health, ping, or ready.'),
  logKind: z.enum(['runtime', 'compile', 'all']).optional().describe('runner_logs kind.'),
  errorsOnly: z.boolean().optional().describe('Only show runner error logs.'),
  filter: z.string().optional().describe('Substring filter for runner_logs.'),
});
type GmloopArgs = z.infer<typeof GmloopArgs>;
type GmloopAction = NonNullable<GmloopArgs['action']>;

const GmloopControlArgs = z.object({
  action: z
    .enum([
      'live_prepare',
      'live_build',
      'runner_start',
      'runner_stop',
      'runner_restart',
      'runner_pause',
      'runner_resume',
      'runner_clear_logs',
    ])
    .describe('GMLoop command action that can start/stop/build runtime state.'),
  path: z.string().optional().describe('Project-relative project root, .yyp, file, or folder path.'),
  debug: z.boolean().optional().describe('Start runner in debug mode when action is runner_start.'),
});
type GmloopControlArgs = z.infer<typeof GmloopControlArgs>;
type GmloopControlAction = GmloopControlArgs['action'];

const OUTPUT_LIMIT = 12000;

function envValue(key: string): string {
  return process.env[key] || '';
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findOnPath(name: string): string {
  const parts = (process.env.PATH || '').split(path.delimiter);
  const suffixes = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  for (const dir of parts) {
    for (const ext of suffixes) {
      const p = path.join(dir, name + ext);
      if (fileExists(p)) return p;
    }
  }
  return '';
}

function runner(root: string): { cmd: string; prefix: string[]; label: string; setup?: string } {
  const configured = envValue('CHATGML_GMLOOP_BIN');
  if (configured && fileExists(configured)) {
    return /\.js$/i.test(configured)
      ? { cmd: 'node', prefix: [configured], label: `node ${configured}` }
      : { cmd: configured, prefix: [], label: configured };
  }
  const onPath = findOnPath('gmloop');
  if (onPath) return { cmd: onPath, prefix: [], label: onPath };
  const sibling = path.resolve(root, '..', 'GMLoop', 'src', 'cli', 'dist', 'index.js');
  if (fileExists(sibling)) return { cmd: 'node', prefix: [sibling], label: `node ${sibling}` };
  return { cmd: '', prefix: [], label: '', setup: 'Set CHATGML_GMLOOP_BIN or put gmloop on PATH.' };
}

function cap(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT / 2)}\n...[trimmed ${text.length - OUTPUT_LIMIT} chars]...\n${text.slice(-OUTPUT_LIMIT / 2)}`;
}

async function targetPath(args: { path?: string }, ctx: ToolContext): Promise<string> {
  if (!args.path) return ctx.root;
  return resolveInsideRoot(ctx.root, args.path);
}

function argvFor(action: GmloopAction, target: string, args: GmloopArgs): string[] {
  if (action === 'lint') return ['lint', target];
  if (action === 'format_check') return ['format', '--path', target];
  if (action === 'graph_doctor') return ['graph', 'doctor', '--path', target];
  if (action === 'parse') return ['parse', '--path', target];
  if (action === 'live_status')
    return ['live-reload', 'status', '--path', target, '--endpoint', args.endpoint || 'status'];
  if (action === 'live_discover') return ['live-reload', 'discover', '--path', target];
  if (action === 'live_attach') return ['live-reload', 'attach', '--path', target];
  if (action === 'live_wait_for_patch')
    return ['live-reload', 'wait-for-patch', '--path', target, '--timeout-ms', '10000'];
  if (action === 'runner_status') return ['runner', 'status', '--path', target];
  if (action === 'runner_logs') {
    const argv = ['runner', 'logs', '--path', target, '--kind', args.logKind || 'all'];
    if (args.errorsOnly) argv.push('--errors-only');
    if (args.filter) argv.push('--filter', args.filter);
    return argv;
  }
  return [];
}

function controlArgvFor(action: GmloopControlAction, target: string, args: GmloopControlArgs): string[] {
  if (action === 'live_prepare') return ['live-reload', 'prepare'];
  if (action === 'live_build') return ['live-reload', 'build', target];
  if (action === 'runner_start') {
    const argv = ['runner', 'start', '--path', target];
    if (args.debug) argv.push('--debug');
    return argv;
  }
  if (action === 'runner_stop') return ['runner', 'stop', '--path', target];
  if (action === 'runner_restart') return ['runner', 'restart', '--path', target];
  if (action === 'runner_pause') return ['runner', 'pause', '--path', target];
  if (action === 'runner_resume') return ['runner', 'resume', '--path', target];
  if (action === 'runner_clear_logs') return ['runner', 'clear-logs', '--path', target];
  return [];
}

async function runGmloop(
  action: string,
  ctx: ToolContext,
  argv: string[],
  timeoutMs = 120000,
): Promise<ToolResult> {
  const r = runner(ctx.root);
  if (!r.cmd) throw new ToolError('provider_error', `GMLoop not found. ${r.setup}`);
  const fullArgv = r.prefix.concat(argv);
  return new Promise<ToolResult>((resolve, reject) => {
    const proc = spawn(r.cmd, fullArgv, { cwd: ctx.root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: string[] = [];
    const timer = setTimeout(() => {
      proc.kill();
      reject(new ToolError('timeout', `gmloop ${action} timed out`));
    }, timeoutMs);
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (s: string) => chunks.push(s));
    proc.stderr.on('data', (s: string) => chunks.push(s));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new ToolError('provider_error', `failed to spawn gmloop: ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const out = cap(chunks.join(''));
      const content = `gmloop ${action} exit ${code ?? -1}\n${out}`;
      if (code === 0) resolve({ content });
      else reject(new ToolError('nonzero_exit', content));
    });
  });
}

export const gmloopTool: ToolDef<GmloopArgs> = defineTool<GmloopArgs>({
  name: 'gmloop_check',
  description:
    'Run safe GMLoop checks: lint, format_check, graph_doctor, parse, live-reload status/discovery, and runner status/logs. Never uses --write.',
  kind: 'read',
  schema: GmloopArgs,
  async execute(args: GmloopArgs, ctx: ToolContext): Promise<ToolResult> {
    const r = runner(ctx.root);
    const action = args.action || 'status';
    if (action === 'status') {
      return { content: r.cmd ? `GMLoop ready: ${r.label}` : `GMLoop not found. ${r.setup}` };
    }

    const target = await targetPath(args, ctx);
    return runGmloop(action, ctx, argvFor(action, target, args));
  },
});

export const gmloopControlTool: ToolDef<GmloopControlArgs> = defineTool<GmloopControlArgs>({
  name: 'gmloop_control',
  description:
    'Control GMLoop live-reload/runner commands: prepare/build, runner start/stop/restart/pause/resume, and clear logs.',
  kind: 'command',
  schema: GmloopControlArgs,
  async execute(args: GmloopControlArgs, ctx: ToolContext): Promise<ToolResult> {
    const target = await targetPath(args, ctx);
    return runGmloop(args.action, ctx, controlArgvFor(args.action, target, args), 180000);
  },
});
