import type { Db } from '../db.js';
import type { LlmClient } from '../llm.js';
import type { Messenger } from '../messenger.js';
import type { ToolCache } from './cache.js';
import type { Files } from './files.js';
import type { HostQueue, Lookup, NetDeps, ToolFetch } from './http.js';
import { isConfigured } from './configured.js';
import { isAllowed, policyOf } from './policy.js';
import { withTool, type CallContext, type ToolJournal, type ToolResult } from './result.js';

/** Keys and places from the app config. Secrets come only from here (never from task data or arguments). */
export interface ToolsConfig {
  /** `DATA_DIR`: files live in `<dataDir>/renders` unless `rendersDir` says otherwise. */
  dataDir?: string | undefined;
  rendersDir?: string | undefined;
  knowledgeDir?: string | undefined;
  /** Public `/media/` links: `MEDIA_SECRET` (else `WEB_CHAT_TOKEN`) and the public base (`IG_PUBLIC_BASE`, e.g. https://hq.firtech.pro/media). */
  mediaSecret?: string | undefined;
  mediaBase?: string | undefined;
  braveSearchKey?: string | undefined;
  resendApiKey?: string | undefined;
  /** Sender of `email.send`, e.g. `Fir Tech <hello@firtech.pro>` (a domain verified in Resend). */
  emailFrom?: string | undefined;
  gscServiceAccountJson?: string | undefined;
  gscSiteUrl?: string | undefined;
  youtubeApiKey?: string | undefined;
  youtubeChannelId?: string | undefined;
  ytOauthClientJson?: string | undefined;
  ytRefreshToken?: string | undefined;
  trongridApiKey?: string | undefined;
  toncenterApiKey?: string | undefined;
  /** Optional Openverse OAuth client (higher limits and a bearer token); without them the anonymous API is used. */
  openverseClientId?: string | undefined;
  openverseClientSecret?: string | undefined;
}

/** Read-only CRM views of HQ (the app wires `createCrm(...).handle('GET', [panel], query)`); the body is `{ items: [...] }`. */
export type CrmReader = (panel: 'leads' | 'clients' | 'projects' | 'documents' | 'tickets', query: Record<string, string>) => unknown;

/** The YouTube upload quota counter (the Publisher's `pb_quota`), so tool uploads and auto-posting share one budget. */
export interface QuotaBook {
  used(day: string): number;
  add(day: string, units: number): void;
}

export interface ToolDeps {
  agentId: string;
  dept: string;
  taskId?: number | null | undefined;
  /** HQ (journal and settings). Without it calls are not journaled (tests, scripts). */
  journal?: ToolJournal | undefined;
  /** The shared SQLite (cache, lessons, events, mac queue). Without it: memory cache, those tools `not_configured`. */
  db?: Db | undefined;
  now?: () => number;
  /** The company's timezone (counters, events week). Default Asia/Dushanbe. */
  tz?: string;
  config?: ToolsConfig;
  /** The task-metered client of the head. */
  llm?: LlmClient | undefined;
  /** The head's messenger (an `OutboxMessenger` underneath) and the owner's chat: `telegram.*` writes only there. */
  messenger?: Messenger | undefined;
  ownerId?: number | undefined;
  /** The app registers the content-maker renderer here (core has no satori). */
  renderPng?: ((frame: unknown) => Promise<Uint8Array>) | undefined;
  crm?: CrmReader | undefined;
  youtubeQuota?: QuotaBook | undefined;
  /** Tests: fake network, resolver, sleep, queue, cache. */
  fetch?: ToolFetch | undefined;
  lookup?: Lookup | undefined;
  sleep?: (ms: number) => Promise<void>;
  queue?: HostQueue;
  cache?: ToolCache;
}

/** What every tool group gets from the registry. */
export interface Kit {
  deps: ToolDeps;
  cfg: ToolsConfig;
  cx: CallContext;
  net: NetDeps;
  cache: ToolCache;
  now: () => number;
  tz: string;
  /** The files group of the same toolbox (uploads read from it). */
  files: () => Files;
  /** Runs `fn` as tool `name`: department rights from the policy, `isConfigured`, retries from the policy limits, journal. */
  call<T>(name: string, fn: () => Promise<ToolResult<T>>, o?: { quiet?: boolean; retries?: number }): Promise<ToolResult<T>>;
}

export function makeCall(cx: CallContext, deps: ToolDeps): Kit['call'] {
  return (name, fn, o) => {
    const p = policyOf(name);
    return withTool(name, cx, { allowed: isAllowed(name, cx.dept), configured: isConfigured(name, deps), retries: o?.retries ?? p?.limits.retries ?? 0, quiet: o?.quiet ?? p?.quiet ?? false }, fn);
  };
}
