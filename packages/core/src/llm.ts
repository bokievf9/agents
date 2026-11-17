import Anthropic from '@anthropic-ai/sdk';
import { errMsg, log } from './log.js';

/** haiku: labelling, extraction, checks. sonnet: texts and dialogue. */
export type Tier = 'haiku' | 'sonnet';

export const MODELS: Record<Tier, string> = {
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

export class AnthropicLlm implements LlmClient {
  readonly enabled = true;
  private readonly client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(req: LlmRequest): Promise<string> {
    const params = {
      model: MODELS[req.tier],
      max_tokens: req.maxTokens ?? 1024,
      system: req.system,
      messages: req.messages,
      // Short answers: low effort. Thinking is left at the model default (no `disabled`, it is a 400 on 5.5).
      output_config: { effort: 'low' as const },
    };
    // Sonnet: server-side fallback on a safety decline, so the same call is re-run elsewhere (Claude API only).
    const res =
      req.tier === 'sonnet'
        ? await this.client.beta.messages.create({
            ...params,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
          })
        : await this.client.messages.create(params);
    if (res.stop_reason === 'refusal') throw new Error('LLM refused');
    return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  }
}

/** Real client when a key is set, otherwise the honest off mode (logged once at start). */
export function createLlm(apiKey: string | undefined): LlmClient {
  if (!apiKey) {
    log('warn', 'LLM off: ANTHROPIC_API_KEY is not set, agent answers with templates');
    return new OffLlm();
  }
  log('info', 'LLM on', { haiku: MODELS.haiku, sonnet: MODELS.sonnet });
  return new AnthropicLlm(apiKey);
}

/** Calls the model but never throws: null means "use the template" (off, error, refusal). */
export async function tryComplete(llm: LlmClient, req: LlmRequest): Promise<string | null> {
  if (!llm.enabled) return null;
  try {
    return (await llm.complete(req)) || null;
  } catch (e) {
    log('warn', 'LLM call failed, using template', { err: errMsg(e) });
    return null;
  }
}

/** Test double: scripted replies, records requests. */
export class MockLlm implements LlmClient {
  readonly enabled = true;
  readonly calls: LlmRequest[] = [];
  constructor(private readonly handler: (req: LlmRequest) => string | Promise<string>) {}
  async complete(req: LlmRequest): Promise<string> {
    this.calls.push(req);
    return this.handler(req);
  }
}
