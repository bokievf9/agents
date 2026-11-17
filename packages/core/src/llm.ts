import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { LlmEnv } from './env.js';
import { errMsg, log } from './log.js';

/** fast: labelling, extraction, checks. smart: texts and dialogue. */
export type Tier = 'haiku' | 'sonnet';

/** Direct Anthropic mode defaults (Haiku 5.5 for labelling, Sonnet 5.5 for texts). */
export const CLAUDE_MODELS: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
};

export interface LlmRequest {
  tier: Tier;
  system: string;
  /** Alternating user/assistant turns, first is user. */
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
}

/** The only door to a language model. Agents depend on this, never on the SDK. */
export interface LlmClient {
  /** False when there is no key: callers must fall back to templates and heuristics. */
  readonly enabled: boolean;
  complete(req: LlmRequest): Promise<string>;
}

/** Honest "LLM off" mode: no key, no calls. `complete` throws so nobody mistakes it for an answer. */
export class OffLlm implements LlmClient {
  readonly enabled = false;
  complete(): Promise<string> {
    return Promise.reject(new Error('LLM off'));
  }
}

/**
 * Anthropic SDK client with a configurable baseURL. Through a gateway (OmniRoute) the model is a router
 * alias ("auto") and only plain Messages parameters are sent, since free providers behind it are unstable
 * and know nothing of Claude-only options. Direct to Anthropic: low effort, Sonnet with server-side fallback.
 */
export class AnthropicLlm implements LlmClient {
  readonly enabled = true;
  private readonly client: Anthropic;
  private readonly gateway: boolean;
  private readonly models: Record<Tier, string>;

  constructor(env: LlmEnv & { apiKey: string }) {
    this.gateway = Boolean(env.baseUrl);
    this.client = new Anthropic({
      apiKey: env.apiKey,
      ...(env.baseUrl ? { baseURL: env.baseUrl } : {}),
      timeout: env.timeoutMs,
      maxRetries: env.maxRetries,
    });
    const dflt = this.gateway ? { haiku: 'auto', sonnet: 'auto' } : CLAUDE_MODELS;
    this.models = { haiku: env.modelFast ?? dflt.haiku, sonnet: env.modelSmart ?? dflt.sonnet };
  }

  async complete(req: LlmRequest): Promise<string> {
    const params = {
      model: this.models[req.tier],
      max_tokens: req.maxTokens ?? 1024,
      system: req.system,
      messages: req.messages,
    };
    let res;
    if (this.gateway) {
      res = await this.client.messages.create(params);
    } else if (req.tier === 'sonnet' && this.models.sonnet.startsWith('claude-sonnet-5-5')) {
      // Direct: a safety decline is re-run by the API on a fallback model inside the same call.
      res = await this.client.beta.messages.create({
        ...params,
        output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } else {
      res = await this.client.messages.create({ ...params, output_config: { effort: 'low' } });
    }
    if (res.stop_reason === 'refusal') throw new Error('LLM refused');
    return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  }
}

/** Real client when a key is set, otherwise the honest off mode (logged once at start). */
export function createLlm(env: LlmEnv): LlmClient {
  if (!env.apiKey) {
    log('warn', 'LLM off: no LLM_API_KEY / ANTHROPIC_API_KEY, agent answers with templates');
    return new OffLlm();
  }
  const llm = new AnthropicLlm({ ...env, apiKey: env.apiKey });
  log('info', 'LLM on', { mode: env.baseUrl ? 'gateway' : 'anthropic' });
  return llm;
}

/** Calls the model but never throws: null means "use the template" (off, error, refusal, empty). */
export async function tryComplete(llm: LlmClient, req: LlmRequest): Promise<string | null> {
  if (!llm.enabled) return null;
  try {
    return (await llm.complete(req)) || null;
  } catch (e) {
    log('warn', 'LLM call failed, using template', { err: errMsg(e) });
    return null;
  }
}

/** First balanced-looking JSON object in a reply (models wrap it in prose or code fences). */
function jsonCandidate(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  return start >= 0 && end > start ? fenced.slice(start, end + 1) : null;
}

/**
 * Strict structured answer: parse, validate against the zod schema, and when the model returns garbage
 * ask again with the error (up to `attempts` calls). null when still invalid or the model is off or down:
 * callers fall back to heuristics. Free providers behind the gateway are flaky, so never trust one reply.
 */
export async function tryJson<S extends z.ZodType>(llm: LlmClient, req: LlmRequest, schema: S, attempts = 3): Promise<z.output<S> | null> {
  if (!llm.enabled) return null;
  const messages = [...req.messages];
  for (let i = 0; i < attempts; i++) {
    const raw = await tryComplete(llm, { ...req, messages });
    if (raw === null) continue;
    let problem: string;
    const candidate = jsonCandidate(raw);
    if (!candidate) problem = 'no JSON object found';
    else {
      try {
        const parsed = schema.safeParse(JSON.parse(candidate));
        if (parsed.success) return parsed.data;
        problem = parsed.error.issues.map((x) => `${x.path.join('.') || 'value'}: ${x.message}`).join('; ');
      } catch {
        problem = 'invalid JSON syntax';
      }
    }
    log('warn', 'LLM reply rejected, retrying', { attempt: i + 1, problem });
    messages.push({ role: 'assistant', content: raw }, { role: 'user', content: `Your reply was invalid (${problem}). Reply again with only the JSON object that matches the requested shape.` });
  }
  return null;
}

/** Test double: scripted replies, records requests. */
export class MockLlm implements LlmClient {
  readonly enabled = true;
  readonly calls: LlmRequest[] = [];
  constructor(private readonly handler: (req: LlmRequest, n: number) => string | Promise<string>) {}
  async complete(req: LlmRequest): Promise<string> {
    this.calls.push(req);
    return this.handler(req, this.calls.length);
  }
}
