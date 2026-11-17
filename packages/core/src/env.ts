import { resolve } from 'node:path';

export function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]?.trim();
  if (!v) throw new Error(`Missing required env var ${key}`);
  return v;
}

export function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return env[key]?.trim() || undefined;
}

export function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const v = env[key]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer`);
  return n;
}

/** The shared part of every agent's config: Telegram, owner, timezone, data dir, trust threshold. */
export interface BaseConfig {
  botToken: string;
  ownerId: number;
  tz: string;
  dataDir: string;
  /** Approvals in a row without edits before a kind moves from level 0 to level 1. */
  trustThreshold: number;
  llm: LlmEnv;
}

/**
 * LLM settings. Gateway mode (OmniRoute, Anthropic-compatible POST /v1/messages): LLM_BASE_URL + LLM_API_KEY,
 * models default to "auto". Direct mode: ANTHROPIC_API_KEY (Claude model ids). Neither key: "LLM off".
 */
export interface LlmEnv {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  modelFast: string | undefined;
  modelSmart: string | undefined;
  timeoutMs: number;
  maxRetries: number;
}

export function loadBaseConfig(env: NodeJS.ProcessEnv = process.env): BaseConfig {
  const ownerId = Number(required(env, 'OWNER_TELEGRAM_ID'));
  if (!Number.isSafeInteger(ownerId)) throw new Error('OWNER_TELEGRAM_ID must be a number');
  const tz = optional(env, 'TZ') ?? 'Asia/Tashkent';
  new Intl.DateTimeFormat('en-US', { timeZone: tz }); // throws on a bad zone
  return {
    botToken: required(env, 'TELEGRAM_BOT_TOKEN'),
    ownerId,
    tz,
    dataDir: resolve(optional(env, 'DATA_DIR') ?? './data'),
    trustThreshold: intEnv(env, 'TRUST_THRESHOLD', 20),
    llm: {
      baseUrl: optional(env, 'LLM_BASE_URL'),
      apiKey: optional(env, 'LLM_API_KEY') ?? optional(env, 'ANTHROPIC_API_KEY'),
      modelFast: optional(env, 'LLM_MODEL_FAST'),
      modelSmart: optional(env, 'LLM_MODEL_SMART'),
      timeoutMs: intEnv(env, 'LLM_TIMEOUT_MS', 30_000),
      maxRetries: intEnv(env, 'LLM_MAX_RETRIES', 2),
    },
  };
}
