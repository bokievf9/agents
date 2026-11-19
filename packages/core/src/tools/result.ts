import { errMsg, log } from '../log.js';
import { zonedParts } from '../time.js';

/**
 * The one result shape of every agent tool (spec: `docs/tools.md`). A tool never throws: whatever goes wrong comes back as
 * `ok: false` with a code, a short message (no secrets, no client text) and whether a retry may help.
 */
export const TOOL_ERROR_CODES = [
  'not_allowed', 'not_configured', 'invalid', 'rate_limited', 'timeout', 'network', 'blocked', 'too_large', 'not_found', 'upstream', 'internal',
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolOk<T> {
  ok: true;
  value: T;
}
export interface ToolFail {
  ok: false;
  error: ToolErrorCode;
  message: string;
  retryable: boolean;
  /** The HTTP status of the answer that failed, when there was one (a 404 page, a 503 API). */
  status?: number;
}
export type ToolResult<T> = ToolOk<T> | ToolFail;

export const okv = <T>(value: T): ToolOk<T> => ({ ok: true, value });

/** Codes worth a retry by default: the same call may well work a moment later. */
const RETRYABLE: ReadonlySet<ToolErrorCode> = new Set(['rate_limited', 'timeout', 'network']);

export function fail(error: ToolErrorCode, message: string, o: { retryable?: boolean; status?: number } = {}): ToolFail {
  const retryable = o.retryable ?? (RETRYABLE.has(error) || (error === 'upstream' && o.status !== undefined && o.status >= 500));
  return { ok: false, error, message: message.slice(0, 300), retryable, ...(o.status !== undefined ? { status: o.status } : {}) };
}

/** The failure for an HTTP status that is not a success: 404/410 `not_found`, 429 `rate_limited`, everything else `upstream`. */
export function failStatus(status: number, what: string): ToolFail {
  if (status === 404 || status === 410) return fail('not_found', `${what}: HTTP ${status}`, { status });
  if (status === 429) return fail('rate_limited', `${what}: HTTP 429`, { status });
  return fail('upstream', `${what}: HTTP ${status}`, { status });
}

/** The six departments of the company (the Director counts as one for tool rights). */
export const DEPARTMENTS = ['marketing', 'sales', 'support', 'production', 'backoffice', 'director'] as const;
export type Dept = (typeof DEPARTMENTS)[number];

/** Where calls are written: the HQ journal (`activity`) and settings (daily counters). `Hq` fits this shape. */
export interface ToolJournal {
  log(agentId: string | null, action: string, objectType?: string, objectId?: string, detail?: string): void;
  setting(key: string): string;
  setSetting(key: string, value: string): void;
}

/** One tool's counters of a day: calls, failures, failures by code. */
export interface ToolDayStats {
  calls: number;
  errors: number;
  codes: Partial<Record<ToolErrorCode, number>>;
}

export const statsKey = (day: string): string => `tools.stats.${day}`;

/** `YYYY-MM-DD` of `ms` in `tz`. */
export function dayIn(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** The counters of every tool for one day (empty when nothing was called or the setting is unreadable). */
export function readToolStats(journal: Pick<ToolJournal, 'setting'>, day: string): Record<string, ToolDayStats> {
  try {
    const raw = journal.setting(statsKey(day));
    return raw ? (JSON.parse(raw) as Record<string, ToolDayStats>) : {};
  } catch {
    return {};
  }
}

function bump(journal: ToolJournal, day: string, name: string, code: ToolErrorCode | 'ok'): void {
  const all = readToolStats(journal, day);
  const s = all[name] ?? { calls: 0, errors: 0, codes: {} };
  s.calls++;
  if (code !== 'ok') {
    s.errors++;
    s.codes[code] = (s.codes[code] ?? 0) + 1;
  }
  all[name] = s;
  journal.setSetting(statsKey(day), JSON.stringify(all));
}

/** Who calls: written into the journal line. */
export interface CallContext {
  agentId: string;
  dept: string;
  taskId?: number | null | undefined;
  journal?: ToolJournal | undefined;
  now: () => number;
  /** The company's timezone: the day of the counters. */
  tz: string;
  /** Secret values that must never appear in a message (keys, tokens): replaced with `***`. */
  secrets?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
}

export interface WithToolOptions {
  /** Is the caller's department allowed? false: `not_allowed` without running anything. */
  allowed: boolean;
  /** Is the tool set up (keys, adapters)? false: `not_configured` without running anything. */
  configured?: boolean;
  /** Extra attempts after a `retryable` failure (default 0), with backoff `backoffMs`, 2x, 4x (default 500 ms). */
  retries?: number;
  backoffMs?: number;
  /** No `activity` line (cheap local tools: cache, prices); the day counters are still kept. */
  quiet?: boolean;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function scrub(message: string, secrets: readonly string[] = []): string {
  let m = message;
  for (const s of secrets) if (s && s.length >= 4) m = m.split(s).join('***');
  return m;
}

/**
 * Runs one tool call: rights, configuration, the call itself with everything caught, retries on `retryable` only, the
 * duration, one `activity` line (`tool:<name>`, detail «code ms», never arguments) and the day counters. Never throws.
 */
export async function withTool<T>(name: string, cx: CallContext, o: WithToolOptions, fn: () => Promise<ToolResult<T>>): Promise<ToolResult<T>> {
  const started = cx.now();
  let res: ToolResult<T>;
  if (!o.allowed) res = fail('not_allowed', `${name}: not allowed for department ${cx.dept}`);
  else if (o.configured === false) res = fail('not_configured', `${name}: not configured`);
  else {
    const sleep = cx.sleep ?? realSleep;
    const retries = Math.max(0, o.retries ?? 0);
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fn();
      } catch (e) {
        res = fail('internal', `${name}: ${errMsg(e)}`, { retryable: false });
      }
      if (res.ok || !res.retryable || attempt >= retries) break;
      await sleep((o.backoffMs ?? 500) * 2 ** attempt);
    }
  }
  if (!res.ok) res = { ...res, message: scrub(res.message, cx.secrets) };
  const ms = Math.max(0, cx.now() - started);
  const code = res.ok ? 'ok' : res.error;
  if (cx.journal) {
    try {
      if (!o.quiet || !res.ok) cx.journal.log(cx.agentId, `tool:${name}`, cx.taskId ? 'task' : undefined, cx.taskId ? String(cx.taskId) : undefined, `${code} ${ms}ms`);
      bump(cx.journal, dayIn(cx.now(), cx.tz), name, code);
    } catch (e) {
      log('warn', 'tool journal failed', { tool: name, err: errMsg(e).slice(0, 120) });
    }
  }
  return res;
}
