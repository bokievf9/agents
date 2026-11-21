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

/** Tokens the provider reported for one call, and the model that really answered (a gateway alias resolves to a real one). */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/** A reply with the provider's own usage. `usage` is absent when the provider did not report it. */
export interface LlmResult {
  text: string;
  usage?: LlmUsage;
}

// ---- native tool use (2026-11-22, for the Fira agent core) ----

/** Tiers of a tool conversation: the two of `complete` plus Opus for hard consultations (direct mode only; through the gateway it is the smart alias). */
export type ChatTier = Tier | 'opus';
export const CLAUDE_OPUS = 'claude-opus-5-5';

/** A tool the model may call: the Messages `tools` entry (JSON Schema of the input). */
export interface LlmToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
}

export type LlmTextBlock = { type: 'text'; text: string };
export type LlmToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type LlmToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type LlmBlock = LlmTextBlock | LlmToolUseBlock | LlmToolResultBlock;

export interface LlmChatMessage {
  role: 'user' | 'assistant';
  content: string | LlmBlock[];
}

/** One part of the system prompt; `cache: true` marks the end of the stable prefix (prompt cache, direct mode only). */
export interface LlmSystemBlock {
  text: string;
  cache?: boolean;
}

export type LlmToolChoice = { type: 'auto' } | { type: 'any' } | { type: 'none' } | { type: 'tool'; name: string };

export interface LlmChatRequest {
  tier: ChatTier;
  system: string | LlmSystemBlock[];
  messages: LlmChatMessage[];
  tools?: LlmToolDef[];
  toolChoice?: LlmToolChoice;
  maxTokens?: number;
}

/** What the model answered in one call: text and tool calls, why it stopped, and the usage when reported. */
export interface LlmTurn {
  content: (LlmTextBlock | LlmToolUseBlock)[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
  usage?: LlmUsage;
}

/** The text blocks of a turn joined (what a visitor would read). */
export const turnText = (t: LlmTurn): string => t.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
/** The tool calls of a turn, in order. */
export const turnToolUses = (t: LlmTurn): LlmToolUseBlock[] => t.content.filter((b): b is LlmToolUseBlock => b.type === 'tool_use');

/** The only door to a language model. Agents depend on this, never on the SDK. */
export interface LlmClient {
  /** False when there is no key: callers must fall back to templates and heuristics. */
  readonly enabled: boolean;
  /** Text only: what every caller uses. */
  complete(req: LlmRequest): Promise<string>;
  /** Same call with real usage, for cost accounting. Optional: clients without it are metered by estimate. */
  completeDetailed?(req: LlmRequest): Promise<LlmResult>;
  /** Native tool use (one model call). Optional: clients without it cannot run a Fira agent and the caller falls back. */
  chat?(req: LlmChatRequest): Promise<LlmTurn>;
}

/** Usage from a response (`usage` in Anthropic or OpenAI format, and the `model` that really answered). Null when missing. */
export function parseUsage(res: unknown, fallbackModel = ''): LlmUsage | null {
  if (typeof res !== 'object' || res === null) return null;
  const r = res as { usage?: unknown; model?: unknown };
  if (typeof r.usage !== 'object' || r.usage === null) return null;
  const u = r.usage as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  // Cache reads and writes are billed input too; count them so the total is not understated.
  // Anthropic format (`input_tokens`/`output_tokens`) or OpenAI format (`prompt_tokens`/`completion_tokens`): a gateway may return either
  const input = n(u.input_tokens ?? u.prompt_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
  const output = n(u.output_tokens ?? u.completion_tokens);
  if (input === 0 && output === 0) return null;
  return { inputTokens: input, outputTokens: output, model: typeof r.model === 'string' && r.model ? r.model : fallbackModel };
}

/** Honest "LLM off" mode: no key, no calls. `complete` throws so nobody mistakes it for an answer. */
export class OffLlm implements LlmClient {
  readonly enabled = false;
  complete(): Promise<string> {
    return Promise.reject(new Error('LLM off'));
  }
  completeDetailed(): Promise<LlmResult> {
    return Promise.reject(new Error('LLM off'));
  }
  chat(): Promise<LlmTurn> {
    return Promise.reject(new Error('LLM off'));
  }
}

const STOP: Record<string, LlmTurn['stopReason']> = { end_turn: 'end_turn', tool_use: 'tool_use', max_tokens: 'max_tokens', stop_sequence: 'end_turn' };

/** The content blocks of an SDK response that a turn keeps (text and tool calls; thinking and server blocks are dropped). */
export function turnOf(res: { content: readonly unknown[]; stop_reason?: string | null }, usage: LlmUsage | null): LlmTurn {
  const content: LlmTurn['content'] = [];
  for (const raw of res.content) {
    const b = raw as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') content.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
      const input = typeof b.input === 'object' && b.input !== null && !Array.isArray(b.input) ? (b.input as Record<string, unknown>) : {};
      content.push({ type: 'tool_use', id: b.id, name: b.name, input });
    }
  }
  const stopReason = STOP[res.stop_reason ?? ''] ?? 'other';
  return usage ? { content, stopReason, usage } : { content, stopReason };
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
    return (await this.completeDetailed(req)).text;
  }

  async completeDetailed(req: LlmRequest): Promise<LlmResult> {
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
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
    const usage = parseUsage(res, params.model);
    return usage ? { text, usage } : { text };
  }

  /**
   * Native tool use. Through the gateway: plain parameters only (system as one string, no cache marks, Opus is the smart alias).
   * Direct: the system as blocks with `cache_control` on the stable prefix, low effort, Opus as `claude-opus-5-5`.
   */
  async chat(req: LlmChatRequest): Promise<LlmTurn> {
    const model = req.tier === 'opus' ? (this.gateway ? this.models.sonnet : CLAUDE_OPUS) : this.models[req.tier];
    const blocks = typeof req.system === 'string' ? [{ text: req.system }] : req.system;
    const system = this.gateway
      ? blocks.map((b) => b.text).join('\n\n')
      : blocks.map((b) => ({ type: 'text' as const, text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}) }));
    const choice = req.toolChoice;
    const params = {
      model,
      max_tokens: req.maxTokens ?? 1024,
      system,
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools } : {}),
      ...(req.tools?.length && choice ? { tool_choice: choice } : {}),
    };
    const res = this.gateway
      ? await this.client.messages.create(params as Parameters<Anthropic['messages']['create']>[0] & { stream?: false })
      : await this.client.messages.create({ ...params, output_config: { effort: 'low' } } as Parameters<Anthropic['messages']['create']>[0] & { stream?: false });
    if (res.stop_reason === 'refusal') throw new Error('LLM refused');
    return turnOf(res, parseUsage(res, model));
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

/**
 * Test double: scripted replies, records requests. With `usage` it also reports usage through `completeDetailed`
 * (the way the real client does); without it, the client looks like one that reports nothing.
 */
export class MockLlm implements LlmClient {
  readonly enabled = true;
  readonly calls: LlmRequest[] = [];
  readonly completeDetailed?: (req: LlmRequest) => Promise<LlmResult>;
  constructor(
    private readonly handler: (req: LlmRequest, n: number) => string | Promise<string>,
    usage?: LlmUsage | ((req: LlmRequest, text: string) => LlmUsage),
  ) {
    if (usage) {
      this.completeDetailed = async (req) => {
        const text = await this.complete(req);
        return { text, usage: typeof usage === 'function' ? usage(req, text) : usage };
      };
    }
  }
  async complete(req: LlmRequest): Promise<string> {
    this.calls.push(req);
    return this.handler(req, this.calls.length);
  }
}

/** Calls the model with tools but never throws: null means "fall back" (off, no `chat`, error, refusal). */
export async function tryChat(llm: LlmClient, req: LlmChatRequest): Promise<LlmTurn | null> {
  if (!llm.enabled || !llm.chat) return null;
  try {
    return await llm.chat(req);
  } catch (e) {
    log('warn', 'LLM tool call failed, falling back', { err: errMsg(e) });
    return null;
  }
}

/** A scripted model turn for `MockChatLlm`: a reply text, tool calls, or both. */
export interface ScriptedTurn {
  text?: string;
  tools?: { name: string; input?: Record<string, unknown> }[];
}

/**
 * Test double for tool use: each `chat` call returns the next scripted turn (or what the handler builds), records the request. `complete`
 * answers from the same script with its text, so code that mixes both works in tests. Ids of tool calls are `tu_<call>_<index>`.
 */
export class MockChatLlm implements LlmClient {
  readonly enabled = true;
  readonly chats: LlmChatRequest[] = [];
  readonly calls: LlmRequest[] = [];
  private readonly next: (req: LlmChatRequest, n: number) => ScriptedTurn | Promise<ScriptedTurn>;

  constructor(script: ScriptedTurn[] | ((req: LlmChatRequest, n: number) => ScriptedTurn | Promise<ScriptedTurn>), private readonly usage?: LlmUsage) {
    this.next = Array.isArray(script) ? (_r, n) => script[Math.min(n, script.length) - 1] ?? { text: '' } : script;
  }

  async chat(req: LlmChatRequest): Promise<LlmTurn> {
    this.chats.push(req);
    const n = this.chats.length;
    const s = await this.next(req, n);
    const content: LlmTurn['content'] = [];
    if (s.text) content.push({ type: 'text', text: s.text });
    (s.tools ?? []).forEach((t, i) => content.push({ type: 'tool_use', id: `tu_${n}_${i}`, name: t.name, input: t.input ?? {} }));
    const turn: LlmTurn = { content, stopReason: s.tools?.length ? 'tool_use' : 'end_turn' };
    return this.usage ? { ...turn, usage: this.usage } : turn;
  }

  async complete(req: LlmRequest): Promise<string> {
    this.calls.push(req);
    const s = await this.next({ tier: req.tier, system: req.system, messages: req.messages }, this.calls.length + this.chats.length);
    return s.text ?? '';
  }
}
