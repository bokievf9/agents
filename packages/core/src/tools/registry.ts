import { ToolCache } from './cache.js';
import { createChain, createEmail, createMacPoster, createTelegram, type Chain, type Email, type MacPoster, type Telegram } from './channels.js';
import { createClock, type Clock } from './clock.js';
import { isConfigured } from './configured.js';
import { createDataTools, createLlmTools, type DataTools, type LlmTools } from './data.js';
import { createFiles, type Files } from './files.js';
import { createGoogle, type Google } from './google.js';
import { sharedHostQueue } from './http.js';
import { makeCall, type Kit, type ToolDeps, type ToolsConfig } from './kit.js';
import { createMedia, type Media } from './media.js';
import { TOOL_POLICY, isAllowed, policyOf, type ToolLimits } from './policy.js';
import { dayIn, fail, okv, readToolStats, withTool, type CallContext, type Dept, type ToolJournal, type ToolResult } from './result.js';
import { createText, type TextTools } from './text.js';
import { createWeb, type Web } from './web.js';

export interface CacheTools {
  /** The cached value (any JSON) or null on a miss. */
  get(key: string): Promise<ToolResult<unknown>>;
  /** Keeps a JSON value for `ttlMs` (at most 64 KB). */
  set(key: string, value: unknown, ttlMs: number): Promise<ToolResult<true>>;
  del(key: string): Promise<ToolResult<true>>;
}

/** The toolbox of one agent (`ctx.tools`). Every method answers a `ToolResult` and never throws (the clock answers plain values). */
export interface Tools {
  readonly agentId: string;
  readonly dept: string;
  web: Web;
  cache: CacheTools;
  files: Files;
  media: Media;
  llm: LlmTools;
  prices: DataTools['prices'];
  playbook: DataTools['playbook'];
  knowledge: DataTools['knowledge'];
  crm: DataTools['crm'];
  events: DataTools['events'];
  chain: Chain;
  google: Google;
  telegram: Telegram;
  email: Email;
  mac: { poster: MacPoster };
  clock: Clock;
  text: TextTools;
  /** Is the tool set up (keys, adapters) and allowed for this department. */
  can(name: string): boolean;
  configured(name: string): boolean;
  /** Calls a tool by its dotted name; an unknown name or one outside the department is `not_allowed` (journaled). */
  call(name: string, ...args: unknown[]): Promise<ToolResult<unknown>>;
  /** Tools of this department. */
  list(): string[];
}

const KEY_RE = /^[\w:.\-/]{1,200}$/;

/**
 * The single toolbox factory. A head builds one per worker run (`createTools({ agentId, dept, taskId, journal: hq, db, config, llm, ... })`);
 * tests pass fakes (`fetch`, `lookup`, `now`, `db`) and work without a network.
 */
export function createTools(deps: ToolDeps): Tools {
  const now = deps.now ?? Date.now;
  const tz = deps.tz ?? 'Asia/Dushanbe';
  const cfg: ToolsConfig = deps.config ?? {};
  const secrets = [cfg.openverseClientId, cfg.openverseClientSecret, cfg.braveSearchKey, cfg.resendApiKey, cfg.youtubeApiKey, cfg.ytRefreshToken, cfg.trongridApiKey, cfg.toncenterApiKey, cfg.mediaSecret].filter((s): s is string => Boolean(s));
  const cx: CallContext = { agentId: deps.agentId, dept: deps.dept, taskId: deps.taskId, journal: deps.journal, now, tz, secrets, ...(deps.sleep ? { sleep: deps.sleep } : {}) };
  const cache = deps.cache ?? new ToolCache(deps.db, now);
  let files: Files | undefined;
  const k: Kit = {
    deps, cfg, cx, now, tz, cache,
    net: { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.lookup ? { lookup: deps.lookup } : {}), queue: deps.queue ?? sharedHostQueue },
    files: () => (files ??= createFiles(k)),
    call: makeCall(cx, deps),
  };
  const data = createDataTools(k);
  const userKey = (key: string) => `u:${key}`;
  const cacheTools: CacheTools = {
    get: (key) => k.call('cache.get', async () => (typeof key === 'string' && KEY_RE.test(key) ? okv(cache.getJson<unknown>(userKey(key))) : fail('invalid', 'key: 1..200 of [A-Za-z0-9_:.-/]'))),
    set: (key, value, ttlMs) =>
      k.call('cache.set', async () => {
        if (typeof key !== 'string' || !KEY_RE.test(key)) return fail('invalid', 'key: 1..200 of [A-Za-z0-9_:.-/]');
        if (!(Number.isFinite(ttlMs) && ttlMs > 0 && ttlMs <= 30 * 86_400_000)) return fail('invalid', 'ttlMs: up to 30 days');
        let text: string;
        try {
          text = JSON.stringify(value);
        } catch {
          return fail('invalid', 'value is not JSON');
        }
        if (text === undefined) return fail('invalid', 'value is not JSON');
        return cache.set(userKey(key), text, ttlMs) ? okv(true as const) : fail('too_large', 'value over 64 KB');
      }),
    del: (key) =>
      k.call('cache.del', async () => {
        if (typeof key !== 'string' || !KEY_RE.test(key)) return fail('invalid', 'key: 1..200 of [A-Za-z0-9_:.-/]');
        cache.del(userKey(key));
        return okv(true as const);
      }),
  };
  const web = createWeb(k);
  const tools: Tools = {
    agentId: deps.agentId,
    dept: deps.dept,
    web,
    cache: cacheTools,
    files: k.files(),
    media: createMedia(k, web),
    llm: createLlmTools(k),
    prices: data.prices,
    playbook: data.playbook,
    knowledge: data.knowledge,
    crm: data.crm,
    events: data.events,
    chain: createChain(k),
    google: createGoogle(k),
    telegram: createTelegram(k),
    email: createEmail(k),
    mac: { poster: createMacPoster(k) },
    clock: createClock(now, tz),
    text: createText(k),
    configured: (name) => Boolean(policyOf(name)) && isConfigured(name, deps),
    can: (name) => isAllowed(name, deps.dept) && isConfigured(name, deps),
    list: () => TOOL_POLICY.filter((p) => isAllowed(p.name, deps.dept)).map((p) => p.name),
    call: (name, ...args) => {
      const fn = lookupFn(tools, name);
      if (!fn || !policyOf(name)) return withTool(String(name).slice(0, 60), cx, { allowed: false }, () => Promise.resolve(fail('not_allowed', 'unknown tool')));
      if (name.startsWith('clock.')) {
        if (!isAllowed(name, deps.dept)) return withTool(name, cx, { allowed: false }, () => Promise.resolve(fail('not_allowed', 'not allowed')));
        return Promise.resolve(okv((fn as (...a: unknown[]) => unknown)(...args)));
      }
      return (fn as (...a: unknown[]) => Promise<ToolResult<unknown>>)(...args);
    },
  };
  return tools;
}

/** `web.search` -> tools.web.search (bound), or undefined. */
function lookupFn(tools: Tools, name: string): ((...a: unknown[]) => unknown) | undefined {
  if (typeof name !== 'string' || !/^[a-z]+(\.[a-zA-Z]+){1,2}$/.test(name)) return undefined;
  const parts = name.split('.');
  let obj: unknown = tools;
  for (const p of parts.slice(0, -1)) {
    obj = obj && typeof obj === 'object' && Object.hasOwn(obj, p) ? (obj as Record<string, unknown>)[p] : undefined;
  }
  const last = parts[parts.length - 1]!;
  const fn = obj && typeof obj === 'object' && Object.hasOwn(obj, last) ? (obj as Record<string, unknown>)[last] : undefined;
  return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).bind(obj) : undefined;
}

/** Every tool name the registry exposes (for the completeness test). */
export function registryNames(): string[] {
  const t = createTools({ agentId: 'probe', dept: 'director' });
  const out: string[] = [];
  const rec = (o: Record<string, unknown>, prefix: string) => {
    for (const [key, v] of Object.entries(o)) {
      if (['agentId', 'dept', 'can', 'configured', 'call', 'list'].includes(key) && prefix === '') continue;
      if (key === 'absolute') continue; // helper of files, not a tool
      if (typeof v === 'function') out.push(`${prefix}${key}`);
      else if (v && typeof v === 'object') rec(v as Record<string, unknown>, `${prefix}${key}.`);
    }
  };
  rec(t as unknown as Record<string, unknown>, '');
  return out.sort();
}

export interface ToolInfo {
  name: string;
  departments: readonly Dept[];
  configured: boolean;
  callsToday: number;
  errorsToday: number;
  limits: ToolLimits;
  env: readonly string[];
  summary: string;
}

/** The listing of `/admin/company`: rights, set-up state, today's counters and limits of every tool. */
export function toolCatalog(deps: Omit<ToolDeps, 'agentId' | 'dept'> & { journal?: ToolJournal }, at = (deps.now ?? Date.now)()): ToolInfo[] {
  const stats = deps.journal ? readToolStats(deps.journal, dayIn(at, deps.tz ?? 'Asia/Dushanbe')) : {};
  return TOOL_POLICY.map((p) => ({
    name: p.name, departments: p.departments, configured: isConfigured(p.name, deps), callsToday: stats[p.name]?.calls ?? 0, errorsToday: stats[p.name]?.errors ?? 0,
    limits: p.limits, env: p.env, summary: p.summary,
  }));
}
