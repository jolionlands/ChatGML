import type { ChatLane } from './types.js';
import { LlmClient, LlmError } from './llm.js';
import type { ChatRequest, ChatResult, StreamDelta } from './llm.js';

export interface LlmLike {
  chatStream(req: ChatRequest): AsyncGenerator<StreamDelta, ChatResult, void>;
}

export type NamedChatLane = ChatLane & { providerName?: string };

const FAILOVER_STATUSES = new Set([429, 502, 503, 504]);

export function isFailoverableLlmError(err: unknown): err is LlmError {
  if (!(err instanceof LlmError)) return false;
  if (err.status !== undefined) return FAILOVER_STATUSES.has(err.status);
  return err.code === 'network';
}

export function makeFailoverLlm(
  primaryLane: NamedChatLane,
  fallbackLanes: NamedChatLane[],
  makeLlm: (lane: NamedChatLane) => LlmLike = (lane) => new LlmClient(lane),
): LlmLike {
  const lanes = [primaryLane, ...dedupeLanes(primaryLane, fallbackLanes)];
  if (lanes.length === 1) return makeLlm(primaryLane);
  return new FailoverLlm(lanes, makeLlm);
}

export class FailoverLlm implements LlmLike {
  private readonly clients = new Map<string, LlmLike>();

  constructor(
    private readonly lanes: NamedChatLane[],
    private readonly makeLlm: (lane: NamedChatLane) => LlmLike,
  ) {}

  async *chatStream(req: ChatRequest): AsyncGenerator<StreamDelta, ChatResult, void> {
    let lastErr: unknown;
    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i]!;
      let emitted = false;
      try {
        const gen = this.clientFor(lane).chatStream(req);
        let next = await gen.next();
        while (!next.done) {
          emitted = true;
          yield next.value;
          next = await gen.next();
        }
        return next.value;
      } catch (err) {
        lastErr = err;
        const nextLane = this.lanes[i + 1];
        if (emitted || !nextLane || !isFailoverableLlmError(err)) throw err;
        req.onFailover?.({
          status: err.status,
          fromModel: lane.model,
          toModel: nextLane.model,
          toBaseURL: nextLane.baseURL,
          reason:
            err.status !== undefined
              ? lane.providerName
                ? `${lane.providerName} returned HTTP ${err.status}`
                : `HTTP ${err.status}`
              : lane.providerName
                ? `${lane.providerName} stream failed before output`
                : 'network stream failed before output',
        });
      }
    }
    throw lastErr;
  }

  private clientFor(lane: NamedChatLane): LlmLike {
    const key = laneKey(lane);
    let client = this.clients.get(key);
    if (!client) {
      client = this.makeLlm(lane);
      this.clients.set(key, client);
    }
    return client;
  }
}

export function knownProviderFallbackLanes(
  env: NodeJS.ProcessEnv,
  primaryLane: ChatLane,
): NamedChatLane[] {
  const lanes: NamedChatLane[] = [];
  const explicit = explicitFallbackLane(env);
  if (explicit) lanes.push(explicit);
  if (env['OPENROUTER_API_KEY']) {
    lanes.push({
      providerName: 'OpenRouter',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: env['OPENROUTER_API_KEY'],
      model: env['CHATGML_FALLBACK_OPENROUTER_MODEL'] || 'minimax/minimax-m3',
      temperature: primaryLane.temperature,
      maxTokens: primaryLane.maxTokens,
    });
  }
  if (env['MINIMAX_API_KEY']) {
    lanes.push({
      providerName: 'MiniMax',
      baseURL: env['CHATGML_FALLBACK_MINIMAX_BASE_URL'] || 'https://api.minimax.io/v1',
      apiKey: env['MINIMAX_API_KEY'],
      model: env['CHATGML_FALLBACK_MINIMAX_MODEL'] || 'MiniMax-M3',
      temperature: primaryLane.temperature,
      maxTokens: primaryLane.maxTokens,
    });
  }
  if (env['NVIDIA_API_KEY'] && env['CHATGML_FALLBACK_NVIDIA_MODEL']) {
    lanes.push({
      providerName: 'NVIDIA',
      baseURL: env['CHATGML_FALLBACK_NVIDIA_BASE_URL'] || 'https://integrate.api.nvidia.com/v1',
      apiKey: env['NVIDIA_API_KEY'],
      model: env['CHATGML_FALLBACK_NVIDIA_MODEL'],
      temperature: primaryLane.temperature,
      maxTokens: primaryLane.maxTokens,
    });
  }
  if (
    env['MAVEROS_API_KEY'] &&
    env['CHATGML_FALLBACK_MAVEROS_BASE_URL'] &&
    env['CHATGML_FALLBACK_MAVEROS_MODEL']
  ) {
    lanes.push({
      providerName: 'Maveros',
      baseURL: env['CHATGML_FALLBACK_MAVEROS_BASE_URL'],
      apiKey: env['MAVEROS_API_KEY'],
      model: env['CHATGML_FALLBACK_MAVEROS_MODEL'],
      temperature: primaryLane.temperature,
      maxTokens: primaryLane.maxTokens,
    });
  }
  return dedupeLanes(primaryLane, lanes);
}

export function dedupeLanes(primaryLane: ChatLane, lanes: NamedChatLane[]): NamedChatLane[] {
  const seen = new Set([laneKey(primaryLane)]);
  const out: NamedChatLane[] = [];
  for (const lane of lanes) {
    if (!lane.baseURL || !lane.model) continue;
    const key = laneKey(lane);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lane);
  }
  return out;
}

function explicitFallbackLane(env: NodeJS.ProcessEnv): NamedChatLane | null {
  const baseURL = env['CHATGML_FALLBACK_CHAT_BASE_URL'];
  const model = env['CHATGML_FALLBACK_CHAT_MODEL'];
  if (!baseURL || !model) return null;
  const apiKey = resolveEnvSecret(env['CHATGML_FALLBACK_CHAT_API_KEY'], env);
  return {
    providerName: env['CHATGML_FALLBACK_CHAT_PROVIDER'] || 'fallback',
    baseURL,
    model,
    ...(apiKey ? { apiKey } : {}),
    temperature: Number.isFinite(Number(env['CHATGML_FALLBACK_CHAT_TEMPERATURE']))
      ? Number(env['CHATGML_FALLBACK_CHAT_TEMPERATURE'])
      : 0.2,
  };
}

function resolveEnvSecret(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('env:')) return env[value.slice('env:'.length)];
  return value;
}

function laneKey(lane: ChatLane): string {
  return `${lane.baseURL.replace(/\/+$/, '').toLowerCase()}|${lane.model.toLowerCase()}`;
}
