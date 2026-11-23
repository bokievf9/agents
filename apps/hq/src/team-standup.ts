import type { Cron } from 'croner';
import { errMsg, log, migrate, roleTitle, schedule, tryJson, zonedParts, zonedToMs, type LlmClient } from '@fir/core';
import { meterLlm, type Hq } from '@fir/hq';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import { containsClientData } from './office.js';
import { fail, ok } from './shell-crm.js';
import { todayIn } from './shell-week.js';
import { TEAM_IDS } from './team-presence.js';

/**
 * The morning stand-up of the team (2026-11-24, «Команда»): at 09:00 on the company's clock every active agent says two or three lines, built by
 * code from the data (what it closed in the last 24 h, what is in its queue, what waits for the owner), with numbers and `#id` only, never client
 * names or texts. With a model, one extra phrase per agent in its voice (`say`), written from those same lines. One post goes to the owner's inbox
 * (kind `standup`), `GET /admin/team/standup?date=` returns it; `POST /admin/team/standup/reply` answers an agent in its chat.
 */

export const STANDUP_CRON = '0 9 * * *';
const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS team_standup (
  date TEXT PRIMARY KEY,
  entries TEXT NOT NULL,
  posted_at INTEGER,
  inbox_id INTEGER
);
`;

export interface StandupEntry { agent: string; title: string; did: string[]; plan: string[]; need: string[]; say?: string }

export interface StandupDeps {
  hq: Hq;
  now: () => number;
  llm?: LlmClient | undefined;
  /** The owner's inbox (`OwnerChannel.notify('standup', text)`): returns its row id or 0. */
  notify?: ((text: string) => Promise<number>) | undefined;
  /** The owner's reply to an agent goes into that agent's chat. */
  reply?: ((agent: string, text: string) => Promise<AdminReply>) | undefined;
}

const ids = (xs: number[]) => xs.slice(0, 3).map((x) => `#${x}`).join(', ');
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const replyBody = z.object({ agent: z.string().min(1).max(64), text: z.string().trim().min(1).max(2000) }).strict();
const sayShape = z.record(z.string(), z.string().max(200));

export function createStandup(d: StandupDeps) {
  const { hq } = d;
  const db = hq.db;
  migrate(db, SCHEMA);
  let job: Cron | null = null;
  const q = <T>(sql: string, ...args: unknown[]): T[] => {
    try {
      return db.prepare(sql).all(...args) as T[];
    } catch {
      return [];
    }
  };

  /** 09:00 of `date` on the company's clock. */
  const nineOf = (date: string): number => {
    const [y, mo, dd] = date.split('-').map(Number) as [number, number, number];
    return zonedToMs(y, mo, dd, 9, 0, hq.tz);
  };

  /** The lines of every active agent, by code. `at`: the moment of the stand-up (the last 24 h before it count as «сделал»). */
  function build(at: number): StandupEntry[] {
    const since = at - DAY;
    const open = hq.tasks({ open: true, limit: 5000 }).filter((t) => !t.tags.includes('drill'));
    const asked = new Set(q<{ task_id: number }>("SELECT task_id FROM task_approvals WHERE state IN ('queued', 'asked')").map((r) => r.task_id));
    const routines = hq.routines().filter((r) => r.enabled);
    const out: StandupEntry[] = [];
    for (const id of TEAM_IDS) {
      const a = hq.agent(id);
      if (!a || a.status !== 'active' || hq.headOf(a.dept)?.status === 'paused') continue;
      const did: string[] = [];
      const plan: string[] = [];
      const need: string[] = [];
      const closed = q<{ task_id: number }>("SELECT DISTINCT task_id FROM task_events WHERE kind = 'result' AND actor = ? AND at >= ? AND at <= ? ORDER BY task_id", id, since, at).map((r) => r.task_id);
      if (closed.length) did.push(`закрыл ${closed.length} ${plural(closed.length, 'задачу', 'задачи', 'задач')} (${ids(closed)})`);
      const approved = q<{ n: number }>(
        "SELECT COUNT(*) n FROM task_approvals t JOIN tasks k ON k.id = t.task_id WHERE t.state = 'executed' AND t.created_at >= ? AND t.created_at <= ? AND k.assignee_id = ?", since, at, id,
      )[0]?.n ?? 0;
      if (approved) did.push(`владелец одобрил ${approved} ${plural(approved, 'результат', 'результата', 'результатов')}`);
      const chats = q<{ n: number }>("SELECT COUNT(*) n FROM team_chat WHERE agent_id = ? AND role = 'agent' AND state = 'done' AND at >= ? AND at <= ?", id, since, at)[0]?.n ?? 0;
      if (chats) did.push(`ответил в чате ${chats} ${plural(chats, 'раз', 'раза', 'раз')}`);

      const mine = open.filter((t) => t.assigneeId === id);
      const work = mine.filter((t) => t.status === 'inbox' || t.status === 'assigned' || t.status === 'running').map((t) => t.id);
      if (work.length) plan.push(`в работе ${work.length} (${ids(work)})`);
      if (a.role === 'head') {
        const queued = open.filter((t) => t.dept === a.dept && t.status === 'inbox' && !t.assigneeId).length;
        if (queued) plan.push(`в очереди отдела ${queued}`);
        const today = routines.filter((r) => r.dept === a.dept && !containsClientData(r.title)).slice(0, 1);
        for (const r of today) plan.push(`по расписанию: ${r.title.slice(0, 60)}`);
      }

      const waits = mine.filter((t) => asked.has(t.id) || t.status === 'review' || t.status === 'approval').map((t) => t.id);
      if (waits.length) need.push(`ваше решение по ${ids(waits)}${waits.length > 3 ? ` и ещё ${waits.length - 3}` : ''}`);
      const blocked = mine.filter((t) => t.status === 'blocked').map((t) => t.id);
      if (blocked.length) need.push(`заблокировано ${blocked.length} (${ids(blocked)})`);

      if (!did.length && !plan.length && !need.length && a.role === 'worker') continue;
      if (!plan.length) plan.push('новых задач нет');
      out.push({ agent: id, title: roleTitle(id, a.title), did, plan, need });
    }
    return out;
  }

  /** One phrase per agent in its voice, from the code lines only (no client data goes in). Null without a model. */
  async function voices(entries: StandupEntry[]): Promise<Record<string, string> | null> {
    if (!d.llm?.enabled || !entries.length) return null;
    const lines = entries.map((e) => `${e.agent} (${e.title}): сделал: ${e.did.join('; ') || 'ничего'}; план: ${e.plan.join('; ')}; нужно от владельца: ${e.need.join('; ') || 'ничего'}`);
    return tryJson(meterLlm(d.llm, hq, { agentId: 'director' }), {
      tier: 'haiku', maxTokens: 900,
      system: 'Ты пишешь утреннюю планёрку команды ИИ-агентов Fir Tech. Для каждого агента одна короткая фраза от первого лица в голосе его должности, только из данных строки, без новых фактов, цифр и имён. Без эмодзи и длинных тире. Ответ: JSON-объект { "<id агента>": "<фраза>" }.',
      messages: [{ role: 'user', content: lines.join('\n') }],
    }, sayShape);
  }

  const view = (date: string, entries: StandupEntry[], postedAt: number | null) => ({
    date, entries, ...(postedAt !== null ? { postedToInboxAt: new Date(postedAt).toISOString() } : {}),
  });

  function stored(date: string): { entries: StandupEntry[]; postedAt: number | null } | null {
    const r = db.prepare('SELECT entries, posted_at FROM team_standup WHERE date = ?').get(date) as { entries: string; posted_at: number | null } | undefined;
    return r ? { entries: JSON.parse(r.entries) as StandupEntry[], postedAt: r.posted_at } : null;
  }

  function text(date: string, entries: StandupEntry[]): string {
    const out = [`Планёрка ${date.slice(8, 10)}.${date.slice(5, 7)}`];
    for (const e of entries) {
      out.push('', `${e.title}${e.say ? `: ${e.say}` : ''}`);
      if (e.did.length) out.push(`Сделал: ${e.did.join('; ')}.`);
      out.push(`План: ${e.plan.join('; ')}.`);
      if (e.need.length) out.push(`Нужно от вас: ${e.need.join('; ')}.`);
    }
    return out.join('\n');
  }

  /** The routine: builds today's stand-up, posts it once to the inbox. Returns the stored view. */
  async function run(at = d.now()): Promise<ReturnType<typeof view>> {
    const date = todayIn(at, hq.tz);
    const have = stored(date);
    if (have?.postedAt) return view(date, have.entries, have.postedAt);
    const entries = build(at);
    try {
      const say = await voices(entries);
      if (say) for (const e of entries) if (typeof say[e.agent] === 'string' && say[e.agent]!.trim() && !containsClientData(say[e.agent]!)) e.say = say[e.agent]!.trim().slice(0, 200);
    } catch (e) {
      log('warn', 'standup voices failed', { err: errMsg(e) });
    }
    let inboxId = 0;
    if (d.notify) inboxId = await d.notify(text(date, entries)).catch((e: unknown) => { log('warn', 'standup post failed', { err: errMsg(e) }); return 0; });
    const postedAt = d.notify ? d.now() : null;
    db.prepare('INSERT INTO team_standup (date, entries, posted_at, inbox_id) VALUES (?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET entries = excluded.entries, posted_at = excluded.posted_at, inbox_id = excluded.inbox_id')
      .run(date, JSON.stringify(entries), postedAt, inboxId || null);
    hq.log('director', 'team_standup', 'standup', date, `agents:${entries.length}`);
    log('info', 'team standup', { date, agents: entries.length });
    return view(date, entries, postedAt);
  }

  /** `GET /admin/team/standup?date=`: the stored stand-up of that day; today without one yet: the live lines (not posted). */
  function get(query: URLSearchParams): AdminReply {
    const today = todayIn(d.now(), hq.tz);
    const date = query.get('date') || today;
    if (!DATE.test(date)) return fail(400, 'invalid', { hint: 'date' });
    const s = stored(date);
    if (s) return ok(view(date, s.entries, s.postedAt));
    if (date !== today) return fail(404, 'not_found');
    const p = zonedParts(d.now(), hq.tz);
    const at = p.h >= 9 ? d.now() : Math.min(d.now(), nineOf(date));
    return ok(view(date, build(at), null));
  }

  async function reply(body: unknown): Promise<AdminReply> {
    const p = replyBody.safeParse(body ?? {});
    if (!p.success) return fail(400, 'invalid', { maxChars: 2000 });
    if (!(TEAM_IDS as readonly string[]).includes(p.data.agent) || !hq.agent(p.data.agent)) return fail(404, 'not_found');
    if (!d.reply) return fail(503, 'unavailable');
    hq.log('owner', 'team_standup_reply', 'agent', p.data.agent);
    return d.reply(p.data.agent, `Ответ на планёрку: ${p.data.text}`);
  }

  return {
    build, run, get, reply,
    /** The 09:00 job on the company's clock (call again after a clock change). */
    start(): void {
      job?.stop();
      job = schedule('team-standup', STANDUP_CRON, hq.tz, async () => { await run(); });
    },
    stop(): void {
      job?.stop();
      job = null;
    },
  };
}

export type Standup = ReturnType<typeof createStandup>;
