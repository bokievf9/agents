import { AsyncLocalStorage } from 'node:async_hooks';
import { priceFor, usdFor, zonedParts, type Db, type LlmChatRequest, type LlmClient, type LlmRequest, type LlmResult, type LlmTurn, type LlmUsage } from '@fir/core';

/**
 * «Демо только для вошедших» (2026-11-23): the demo of the site (the tabs `/chat` with `persona`, the preview `POST /agent/demo-<niche>/chat` and the lead's demo link) is used by
 * signed-in clients only, and every demo message is booked to the client in `demo_usage` (one row per client, source and day: calls, tokens, money). A client has a daily cap
 * (`DEMO_DAILY_PER_CLIENT`, default 30 messages, all sources together); the answer carries `limit`, `remaining` and `usage: {limit, used, remaining}` so the site can show «осталось N».
 * Counts and money only: never a text, a name or a contact in the table or the logs. Contract: `docs/admin-crm-api.md`, «Демо только для вошедших».
 */
export const DEFAULT_DEMO_DAILY = 30;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS demo_usage (
  client_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, source, day)
);
CREATE INDEX IF NOT EXISTS demo_usage_day ON demo_usage (day);
`;

export interface DemoUsageView {
  /** The cap of messages per day and how many of today's are used and left. */
  limit: number;
  used: number;
  remaining: number;
}

export interface DemoUsageBlock {
  /** Days counted (30). */
  days: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  today: number;
  /** Per source (`persona:salon`, `agent:demo-clinic`, `agent:ag_...`): messages and money. */
  bySource: { source: string; messages: number; usd: number }[];
}

interface Tally { in: number; out: number; usd: number }
const als = new AsyncLocalStorage<Tally>();

/** Wraps a client so the usage of every model call made INSIDE `DemoUsage.metered` lands in that call's tally (outside it nothing changes). */
export function tapLlm(llm: LlmClient): LlmClient {
  const note = (u: LlmUsage | undefined): void => {
    const t = als.getStore();
    if (!t || !u) return;
    t.in += u.inputTokens;
    t.out += u.outputTokens;
    t.usd += usdFor(priceFor(u.model).price, u.inputTokens, u.outputTokens, u.cacheReadTokens ?? 0);
  };
  const detailed = llm.completeDetailed?.bind(llm);
  const chat = llm.chat?.bind(llm);
  return {
    get enabled() {
      return llm.enabled;
    },
    complete: async (req: LlmRequest): Promise<string> => {
      if (!detailed) return llm.complete(req);
      const r = await detailed(req);
      note(r.usage);
      return r.text;
    },
    ...(detailed ? { completeDetailed: async (req: LlmRequest): Promise<LlmResult> => { const r = await detailed(req); note(r.usage); return r; } } : {}),
    ...(chat ? { chat: async (req: LlmChatRequest): Promise<LlmTurn> => { const r = await chat(req); note(r.usage); return r; } } : {}),
  };
}

export interface DemoUsageDeps {
  db: Db;
  now: () => number;
  tz: () => string;
  /** The daily cap per client (read at each call, so a settings change applies at once). */
  limit?: () => number;
}

export class DemoUsage {
  constructor(private readonly d: DemoUsageDeps) {
    d.db.exec(SCHEMA);
  }

  private day(offsetMs = 0): string {
    const p = zonedParts(this.d.now() - offsetMs, this.d.tz());
    return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }

  get limit(): number {
    const v = Math.floor(this.d.limit?.() ?? DEFAULT_DEMO_DAILY);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_DEMO_DAILY;
  }

  /**
   * The client a request names: by email (the cabinet account; created only when `opts.create` is not false, and the public agent routes never create one: M1),
   * else by `supabase_id` or the numeric HQ id. null: nobody identified (or an unknown id).
   */
  resolveClient(who: { email?: string | undefined; cabinetId?: string | undefined; name?: string | undefined; locale?: string | undefined }, opts: { create?: boolean } = {}): number | null {
    const db = this.d.db;
    const email = who.email?.trim().toLowerCase();
    if (email) {
      const t = this.d.now();
      if (opts.create !== false) db.prepare('INSERT OR IGNORE INTO cab_clients (email, name, locale, supabase_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(email, (who.name ?? '').trim().slice(0, 120), who.locale === 'en' ? 'en' : 'ru', who.cabinetId?.slice(0, 64) ?? '', t, t);
      return (db.prepare('SELECT id FROM cab_clients WHERE email = ?').get(email) as { id: number } | undefined)?.id ?? null;
    }
    const cid = who.cabinetId?.trim();
    if (!cid) return null;
    const bySupabase = db.prepare("SELECT id FROM cab_clients WHERE supabase_id = ? AND supabase_id != ''").get(cid) as { id: number } | undefined;
    if (bySupabase) return bySupabase.id;
    return /^\d{1,12}$/.test(cid) ? (db.prepare('SELECT id FROM cab_clients WHERE id = ?').get(Number(cid)) as { id: number } | undefined)?.id ?? null : null;
  }

  usedToday(clientId: number): number {
    return (this.d.db.prepare('SELECT COALESCE(SUM(calls), 0) n FROM demo_usage WHERE client_id = ? AND day = ?').get(clientId, this.day()) as { n: number }).n;
  }

  view(clientId: number): DemoUsageView {
    const used = this.usedToday(clientId);
    return { limit: this.limit, used, remaining: Math.max(0, this.limit - used) };
  }

  /** The fields every demo answer carries: flat `limit` and `remaining` plus the `usage` object (the site reads either form). */
  fields(clientId: number): Record<string, unknown> {
    const v = this.view(clientId);
    return { limit: v.limit, remaining: v.remaining, usage: v };
  }

  /**
   * Runs one demo message for a client: false (and nothing counted) when today's cap is spent; otherwise `fn` runs, and the message is booked in any case (a failed model call
   * costs the client's attempt too, like the agents' own counters) together with the tokens and money of the model calls `fn` made.
   */
  async metered<T>(clientId: number, source: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    if (this.usedToday(clientId) >= this.limit) return { ok: false };
    const tally: Tally = { in: 0, out: 0, usd: 0 };
    try {
      return { ok: true, value: await als.run(tally, fn) };
    } finally {
      this.d.db.prepare(
        `INSERT INTO demo_usage (client_id, source, day, calls, tokens_in, tokens_out, usd) VALUES (?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(client_id, source, day) DO UPDATE SET calls = calls + 1, tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out, usd = usd + excluded.usd`,
      ).run(clientId, source.slice(0, 80), this.day(), tally.in, tally.out, tally.usd);
    }
  }

  /** The 30 days of one client (the Shell card «Демо: N сообщений, $X за 30 дней»). */
  block(clientId: number, days = 30): DemoUsageBlock {
    const since = this.day((days - 1) * 86_400_000);
    return demoUsageBlock(this.d.db, clientId, since, this.day(), days);
  }

  /** The morning line: «Демо: N клиентов, M сообщений, $X» for the last day (yesterday and today so far: 24 hours of the local calendar), or null when nobody tried. */
  summaryLine(): string | null {
    const since = this.day(86_400_000);
    const r = this.d.db.prepare('SELECT COUNT(DISTINCT client_id) c, COALESCE(SUM(calls), 0) n, COALESCE(SUM(usd), 0) usd FROM demo_usage WHERE day >= ?').get(since) as { c: number; n: number; usd: number };
    if (r.n <= 0) return null;
    return `Демо на сайте за сутки: ${r.c} ${plural(r.c, 'клиент', 'клиента', 'клиентов')}, ${r.n} ${plural(r.n, 'сообщение', 'сообщения', 'сообщений')}, $${r.usd.toFixed(2)}.`;
  }
}

function demoUsageBlock(db: Db, clientId: number, since: string, today: string, days: number): DemoUsageBlock {
  const rows = db.prepare('SELECT source, SUM(calls) n, SUM(tokens_in) i, SUM(tokens_out) o, SUM(usd) usd FROM demo_usage WHERE client_id = ? AND day >= ? GROUP BY source ORDER BY n DESC').all(clientId, since) as
    { source: string; n: number; i: number; o: number; usd: number }[];
  const t = (db.prepare('SELECT COALESCE(SUM(calls), 0) n FROM demo_usage WHERE client_id = ? AND day = ?').get(clientId, today) as { n: number }).n;
  return {
    days, messages: rows.reduce((a, r) => a + r.n, 0), tokensIn: rows.reduce((a, r) => a + r.i, 0), tokensOut: rows.reduce((a, r) => a + r.o, 0),
    usd: Math.round(rows.reduce((a, r) => a + r.usd, 0) * 1e6) / 1e6, today: t, bySource: rows.slice(0, 20).map((r) => ({ source: r.source, messages: r.n, usd: Math.round(r.usd * 1e6) / 1e6 })),
  };
}

/** For the client 360 of the Shell, which has no `DemoUsage` object: the same block straight from the table (zeros while the table does not exist). */
export function demoUsageOf(db: Db, clientId: number, now: number, tz: string, days = 30): DemoUsageBlock {
  const day = (ms: number): string => { const p = zonedParts(ms, tz); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'demo_usage'").get() !== undefined;
  if (!exists) return { days, messages: 0, tokensIn: 0, tokensOut: 0, usd: 0, today: 0, bySource: [] };
  return demoUsageBlock(db, clientId, day(now - (days - 1) * 86_400_000), day(now), days);
}

const plural = (n: number, one: string, few: string, many: string): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
