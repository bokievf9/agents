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
  /** The company's timezone (market, clients, publishing): `TZ`, default Asia/Dushanbe. */
  tz: string;
  /** The owner's own timezone: digests, approval batch, alerts, quiet hours. `OWNER_TZ`, default Asia/Kuala_Lumpur. */
  ownerTz: string;
  dataDir: string;
  /** Approvals in a row without edits before a kind moves from level 0 to level 1. */
  trustThreshold: number;
  llm: LlmEnv;
}

/**
 * LLM settings. Priority (2026-11-22): `ANTHROPIC_API_KEY` set means direct Anthropic (Claude model ids) and `LLM_BASE_URL`
 * is ignored, unless `LLM_PROVIDER=gateway` (explicit way back to the gateway). Gateway mode (OmniRoute, Anthropic-compatible
 * POST /v1/messages): LLM_BASE_URL + LLM_API_KEY (the gateway's key, never Anthropic's), models default to "auto". Neither: "LLM off".
 */
export interface LlmEnv {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  modelFast: string | undefined;
  modelSmart: string | undefined;
  timeoutMs: number;
  maxRetries: number;
  /** The resolved mode (absent in hand-made configs: then it follows `baseUrl` and `apiKey`). */
  mode?: 'direct' | 'gateway' | 'off';
  /** Direct mode took priority over a `LLM_BASE_URL` that is also set (logged once at start). */
  gatewayIgnored?: boolean;
}

/** Picks the LLM mode from the environment: direct Anthropic beats the gateway unless `LLM_PROVIDER=gateway`. */
export function loadLlmEnv(env: NodeJS.ProcessEnv): LlmEnv {
  const common = {
    modelFast: optional(env, 'LLM_MODEL_FAST'),
    modelSmart: optional(env, 'LLM_MODEL_SMART'),
    timeoutMs: intEnv(env, 'LLM_TIMEOUT_MS', 30_000),
    maxRetries: intEnv(env, 'LLM_MAX_RETRIES', 2),
  };
  const anthropicKey = optional(env, 'ANTHROPIC_API_KEY');
  const gatewayUrl = optional(env, 'LLM_BASE_URL');
  const forceGateway = optional(env, 'LLM_PROVIDER')?.toLowerCase() === 'gateway';
  if (anthropicKey && !forceGateway) {
    return { ...common, baseUrl: undefined, apiKey: anthropicKey, mode: 'direct', gatewayIgnored: Boolean(gatewayUrl) };
  }
  // Gateway (or off): LLM_API_KEY is the gateway's key, never Anthropic's.
  const apiKey = optional(env, 'LLM_API_KEY');
  return { ...common, baseUrl: gatewayUrl, apiKey, mode: apiKey ? (gatewayUrl ? 'gateway' : 'direct') : 'off' };
}

export function loadBaseConfig(env: NodeJS.ProcessEnv = process.env): BaseConfig {
  const ownerId = Number(required(env, 'OWNER_TELEGRAM_ID'));
  if (!Number.isSafeInteger(ownerId)) throw new Error('OWNER_TELEGRAM_ID must be a number');
  const tz = optional(env, 'TZ') ?? 'Asia/Dushanbe';
  new Intl.DateTimeFormat('en-US', { timeZone: tz }); // throws on a bad zone
  const ownerTz = optional(env, 'OWNER_TZ') ?? 'Asia/Kuala_Lumpur';
  new Intl.DateTimeFormat('en-US', { timeZone: ownerTz }); // throws on a bad zone
  return {
    botToken: required(env, 'TELEGRAM_BOT_TOKEN'),
    ownerId,
    tz,
    ownerTz,
    dataDir: resolve(optional(env, 'DATA_DIR') ?? './data'),
    trustThreshold: intEnv(env, 'TRUST_THRESHOLD', 20),
    llm: loadLlmEnv(env),
  };
}
