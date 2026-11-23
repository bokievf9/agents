import { errMsg, log, migrate, type Db, type LlmClient } from '@fir/core';
import {
  HashEmbedder, InMemoryKnowledge, InMemoryLessons, firtechGuardContext, loadCompanyKnowledge, marketingHeadSpec, run, type AgentSpec, type Journal, type Knowledge, type Memory,
  type MemTurn, type PersonProfile,
} from '@fir/fira';
import { meterLlm } from '@fir/hq';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import { marketingTools, planCard, ruleCard, orderCard, Turn, type Action, type Card, type MarketingToolDeps } from './marketing-chat-tools.js';
import { cadenceSlots, planWeek } from './marketing-plans.js';
import { currentRules, RULES_AGENT } from './marketing-rules.js';
import { cadenceOf } from './settings.js';
import { fail, ok } from './shell-crm.js';
import { isoWeekOf, todayIn } from './shell-week.js';

/**
 * The marketing chat of the Shell (2026-11-24, contract `docs/admin-crm-api.md`, «Маркетинг-чат»): ONE thread of the owner with Fira as Head of Marketing
 * (`packages/fira/role-packs/marketing-head.md`). `POST /admin/marketing/chat { text }`: the owner's line is stored, Fira's `run()` answers with tools
 * (`marketing-chat-tools.ts`: read the feed, orders, calendar, campaigns, analytics; write a Studio order, a pending plan, its acceptance, a rules version,
 * the cadence), the reply carries cards and actions. 25 s budget: past it the answer is `202 { pending: id }` and lands in `GET` when ready. No model
 * (no key, down, over the limit): an honest answer from the data by code, the chips («План на неделю», «Покажи правила», «Что зашло за неделю»,
 * «Новая тема: …») still work. The last 50 messages are the model's context. The rules of the owner (`marketing-rules.ts`) are a block of every turn.
 */

export const CHAT_BUDGET_MS = 25_000;
export const CONTEXT_MESSAGES = 50;
const AGENT = RULES_AGENT;
const CONVERSATION = 'owner-marketing';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mk_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  cards TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'done',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mk_chat_state ON mk_chat (state, id);
`;

export interface ChatItem { id: number; role: 'owner' | 'fira'; text: string; at: string; cards?: Card[] }
interface Row { id: number; role: 'owner' | 'fira'; text: string; cards: string; actions: string; state: 'done' | 'pending'; at: number }

/** Fira's `Memory` over the thread: the last `CONTEXT_MESSAGES` finished messages before the owner's current one; the chat writes its rows itself. */
class ThreadMemory implements Memory {
  constructor(private readonly db: Db, private readonly beforeId: number) {}
  turns(): Promise<MemTurn[]> {
    const rows = this.db.prepare("SELECT role, text, at FROM mk_chat WHERE id < ? AND state = 'done' AND text != '' ORDER BY id DESC LIMIT ?").all(this.beforeId, CONTEXT_MESSAGES) as { role: string; text: string; at: number }[];
    return Promise.resolve(rows.reverse().map((r) => ({ role: r.role === 'owner' ? 'user' : 'assistant', text: r.text, at: r.at })));
  }
  append(): Promise<void> {
    return Promise.resolve();
  }
  promote(): Promise<void> {
    return Promise.resolve();
  }
  profile(): Promise<PersonProfile | null> {
    return Promise.resolve(null);
  }
  saveProfile(): Promise<void> {
    return Promise.resolve();
  }
  sweep(): Promise<number> {
    return Promise.resolve(0);
  }
}

const quietJournal: Journal = { record: () => Promise.resolve() };
const postBody = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
const acceptBody = z.object({ planId: z.union([z.number().int().positive(), z.string().regex(/^\d{1,9}$/)]).transform(Number) }).strict();

export interface MarketingChatDeps extends MarketingToolDeps {
  /** The company's model client (metered here as agent `marketing-head`, the department's limit applies); absent or off: the offline answers. */
  llm?: LlmClient | undefined;
  /** The company pack for `knowledge_search`; absent: loaded once from `company-packs/firtech`. */
  knowledge?: Knowledge;
  budgetMs?: number;
}

export interface Reply { id: number; text: string; cards: Card[]; actions: Action[] }

export function createMarketingChat(d: MarketingChatDeps) {
  const { hq } = d;
  const db = hq.db;
  migrate(db, SCHEMA);
  const spec: AgentSpec = marketingHeadSpec();
  const lessons = new InMemoryLessons();
  let knowledge: Knowledge | null = d.knowledge ?? null;
  const knowledgeOf = (): Knowledge => {
    if (knowledge) return knowledge;
    const k = new InMemoryKnowledge(new HashEmbedder());
    knowledge = k;
    try {
      void k.add(loadCompanyKnowledge('firtech', { now: hq.now() })).catch((e: unknown) => log('warn', 'marketing chat: company pack not loaded', { err: errMsg(e) }));
    } catch (e) {
      log('warn', 'marketing chat: company pack not loaded', { err: errMsg(e) });
    }
    return k;
  };
  // a turn still running (past the budget) keeps its pending row; a restart leaves it pending: closed at start with an honest line
  db.prepare("UPDATE mk_chat SET state = 'done', text = 'Ответ не успел сохраниться (перезапуск). Напишите ещё раз.' WHERE state = 'pending'").run();

  const iso = (ms: number) => new Date(ms).toISOString();
  const item = (r: Row): ChatItem => {
    const cards = JSON.parse(r.cards) as Card[];
    return { id: r.id, role: r.role, text: r.text, at: iso(r.at), ...(cards.length ? { cards } : {}) };
  };
  const insert = (role: 'owner' | 'fira', text: string, state: 'done' | 'pending' = 'done', cards: Card[] = [], actions: Action[] = []): number =>
    Number(db.prepare('INSERT INTO mk_chat (role, text, cards, actions, state, at) VALUES (?, ?, ?, ?, ?, ?)').run(role, text.slice(0, 8000), JSON.stringify(cards), JSON.stringify(actions), state, hq.now()).lastInsertRowid);
  const finish = (id: number, r: Omit<Reply, 'id'>) =>
    db.prepare("UPDATE mk_chat SET text = ?, cards = ?, actions = ?, state = 'done', at = ? WHERE id = ?").run(r.text.slice(0, 8000), JSON.stringify(r.cards), JSON.stringify(r.actions), hq.now(), id);

  /** The per-turn block next to the rules: what waits for the owner's decision and the cadence. */
  function context(): string {
    const rules = currentRules(hq);
    const pending = d.plans.list({ status: 'pending', limit: 3 });
    const c = cadenceOf(hq);
    const dow = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    const lines = [
      rules.block,
      '',
      '## Сейчас',
      `- Сегодня ${todayIn(hq.now(), hq.tz)}, неделя ${isoWeekOf(todayIn(hq.now(), hq.tz))}.`,
      `- Ритм публикаций: ${c.days.map((x) => dow[x]).join(', ')} в ${c.time}, площадки ${c.platforms.join(', ')}.`,
      pending.length ? `- Ждут решения владельца: ${pending.map((p) => `план #${p.id} на ${p.week} (${p.slots.length} слотов)`).join('; ')}.` : '- Планов на решении нет.',
    ];
    return lines.join('\n');
  }

  /** One turn through the model; null when there was no model answer and nothing was done (the caller answers offline). */
  async function modelTurn(text: string, ownerId: number): Promise<Omit<Reply, 'id'> | null> {
    if (!d.llm || !d.llm.enabled) return null;
    const turn = new Turn();
    const out = await run(spec, { id: CONVERSATION, text, mode: 'live', lang: 'ru', audience: 'owner' }, {
      llm: meterLlm(d.llm, hq, { agentId: AGENT }), knowledge: knowledgeOf(), memory: new ThreadMemory(db, ownerId), lessons, journal: quietJournal, now: hq.now,
      tools: marketingTools(d, { text, turn }), guard: firtechGuardContext('ru'), system: context(), historyTurns: CONTEXT_MESSAGES,
    });
    if (out.fallback && !turn.actions.length) return null;
    const said = out.fallback ? doneLine(turn) : out.reply;
    return { text: said, cards: turn.out(), actions: turn.actions.length ? turn.actions : [{ type: 'none' }] };
  }

  /** The model gave no words but the tools did something: say what, by code. */
  function doneLine(turn: Turn): string {
    const parts = turn.actions.map((a) => ({
      order_created: `заказ #${a.ref} ушёл в студию`, plan_proposed: `план #${a.ref} ждёт вашего решения`, plan_accepted: `план #${a.ref} принят, заказы в студии`,
      rule_updated: `правила обновлены (${a.ref})`, schedule_changed: 'ритм публикаций обновлён', none: '',
    })[a.type]).filter(Boolean);
    return parts.length ? `Готово: ${parts.join('; ')}.` : 'Готово.';
  }

  /** No model: the chips and the main numbers by code, honestly. */
  async function offline(text: string): Promise<Omit<Reply, 'id'>> {
    const t = text.trim().toLowerCase();
    const turn = new Turn();
    const tools = marketingTools(d, { text, turn });
    const ctx = { companyId: 'firtech', agentId: spec.id, conversationId: CONVERSATION, mode: 'live' as const, lang: 'ru', now: hq.now, knowledge: knowledgeOf(), outcome: { used: [], unknown: false } };
    const head = 'Модель сейчас недоступна, отвечаю по данным.';
    const done = (said: string): Omit<Reply, 'id'> => ({ text: `${head} ${said}`, cards: turn.out(), actions: turn.actions.length ? turn.actions : [{ type: 'none' }] });
    const topic = /^нов(?:ая|ую)\s+тем[аыу]\s*[:\-–]?\s*(.{3,})$/iu.exec(text.trim());
    if (topic && d.content) {
      const r = d.content.createOrder({ mode: 'prompt', prompt: topic[1]!.trim().slice(0, 1000) }, 'chat');
      if (r.status === 200) {
        const o = (r.body as { order: { id: number; mode: string; type: string | null; prompt: string; state: string; fromItemId: number | null } }).order;
        turn.card(orderCard(o));
        turn.act({ type: 'order_created', ref: String(o.id) });
        return done(`Заказ #${o.id} ушёл в студию, материал придёт в ревью-центр.`);
      }
    }
    if (/правил/u.test(t)) {
      const r = currentRules(hq);
      turn.card(ruleCard(r.version, r.firaVoice));
      return done(`Правила, версия ${r.version}:\n${r.text}`);
    }
    if (/план/u.test(t)) {
      const week = planWeek('next', hq.now(), hq.tz)!;
      const slots = cadenceSlots(db, hq.now(), week, cadenceOf(hq));
      const p = d.plans.propose(week, slots);
      turn.card(planCard(p));
      turn.act({ type: 'plan_proposed', ref: String(p.id) });
      return done(`План на ${week} по ритму публикаций: ${p.slots.map((s) => `${s.day.slice(8, 10)}.${s.day.slice(5, 7)} ${s.type}: ${s.topic}`).join('; ')}. Принять можно кнопкой на карточке.`);
    }
    await tools.marketing_analytics!.run({}, ctx);
    const pending = Number((db.prepare("SELECT COUNT(*) n FROM task_approvals WHERE kind = 'content_item' AND state = 'asked'").get() as { n: number } | undefined)?.n ?? 0);
    const working = Number((db.prepare("SELECT COUNT(*) n FROM tasks WHERE json_extract(meta, '$.studio') IS NOT NULL AND status NOT IN ('done', 'rejected', 'blocked')").get() as { n: number }).n);
    const leadsCard = turn.cards.find((c) => c.id.startsWith('leads:'));
    const leads = leadsCard?.meta?.value ?? 0;
    return done(`Ждут одобрения материалов: ${pending}; заказов в студии в работе: ${working}; заявок за неделю: ${leads}. Правила: версия ${currentRules(hq).version}.`);
  }

  async function answer(text: string, ownerId: number): Promise<Omit<Reply, 'id'>> {
    try {
      return (await modelTurn(text, ownerId)) ?? (await offline(text));
    } catch (e) {
      log('warn', 'marketing chat turn failed', { err: errMsg(e) });
      try {
        return await offline(text);
      } catch {
        return { text: 'Не получилось ответить, попробуйте ещё раз.', cards: [], actions: [{ type: 'none' }] };
      }
    }
  }

  /** `GET /admin/marketing/chat?limit=50&before=<id>`: the thread, oldest first, the finished messages only; the rules' version. */
  function get(query: URLSearchParams): AdminReply {
    const limRaw = query.get('limit');
    const limit = limRaw === null || limRaw === '' ? 50 : /^\d{1,3}$/.test(limRaw) ? Math.min(Math.max(Number(limRaw), 1), 200) : NaN;
    if (!Number.isFinite(limit)) return fail(400, 'invalid', { hint: 'limit' });
    const beforeRaw = query.get('before');
    if (beforeRaw && !/^\d{1,12}$/.test(beforeRaw)) return fail(400, 'invalid', { hint: 'before' });
    const before = beforeRaw ? Number(beforeRaw) : Number.MAX_SAFE_INTEGER;
    const rows = (db.prepare("SELECT * FROM mk_chat WHERE id < ? AND state = 'done' ORDER BY id DESC LIMIT ?").all(before, limit) as Row[]).reverse();
    const r = currentRules(hq);
    const pending = (db.prepare("SELECT id FROM mk_chat WHERE state = 'pending' ORDER BY id").all() as { id: number }[]).map((x) => x.id);
    return ok({ items: rows.map(item), rules: { version: r.version, updatedAt: r.updatedAt === null ? null : iso(r.updatedAt) }, pending });
  }

  /** `POST /admin/marketing/chat { text }`: the reply within the budget, else `202 { pending }`. */
  async function post(body: unknown): Promise<AdminReply> {
    const p = postBody.safeParse(body ?? {});
    if (!p.success) return fail(400, 'invalid', { maxChars: 2000 });
    const ownerId = insert('owner', p.data.text);
    const firaId = insert('fira', '', 'pending');
    const work = answer(p.data.text, ownerId).then((r) => {
      finish(firaId, r);
      return r;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((res) => {
      timer = setTimeout(() => res(null), d.budgetMs ?? CHAT_BUDGET_MS);
      timer.unref?.();
    });
    const r = await Promise.race([work, late]);
    if (timer) clearTimeout(timer);
    if (!r) return { status: 202, body: { ok: true, pending: firaId } };
    return ok({ reply: { id: firaId, text: r.text, cards: r.cards }, actions: r.actions });
  }

  /** A line of Fira in the thread (the plan accepted by the Shell's button). */
  function note(text: string, cards: Card[], actions: Action[]): number {
    return insert('fira', text, 'done', cards, actions);
  }

  /** `POST /admin/marketing/plan/accept { planId }`: the slots go to the calendar, one Studio order each; the thread gets Fira's line. */
  function accept(body: unknown): AdminReply {
    const p = acceptBody.safeParse(body ?? {});
    if (!p.success) return fail(400, 'invalid');
    const r = d.plans.accept(p.data.planId, d.order ?? null);
    if (!r.ok) return fail(r.status, r.error);
    const card = planCard(r.plan);
    const actions: Action[] = [{ type: 'plan_accepted', ref: String(r.plan.id) }, ...r.orders.map((id): Action => ({ type: 'order_created', ref: String(id) }))];
    note(`План #${r.plan.id} на ${r.plan.week} принят: ${r.orders.length} заказов ушли в студию, материалы придут в ревью-центр.`, [card], actions);
    return ok({ plan: r.plan, orders: r.orders, cards: [card], actions });
  }

  /** `GET /admin/marketing/plan/:id` and `GET /admin/marketing/plans?status=`. */
  function planView(id: string): AdminReply {
    if (!/^\d{1,9}$/.test(id)) return fail(404, 'not_found');
    const pl = d.plans.get(Number(id));
    return pl ? ok({ plan: { ...pl, createdAt: iso(pl.createdAt), acceptedAt: pl.acceptedAt === null ? null : iso(pl.acceptedAt) } }) : fail(404, 'not_found');
  }
  function planList(query: URLSearchParams): AdminReply {
    const st = query.get('status');
    if (st && !['pending', 'accepted', 'dropped'].includes(st)) return fail(400, 'invalid', { hint: 'status' });
    const items = d.plans.list({ ...(st ? { status: st as 'pending' | 'accepted' | 'dropped' } : {}), limit: 30 });
    return ok({ items: items.map((pl) => ({ ...pl, createdAt: iso(pl.createdAt), acceptedAt: pl.acceptedAt === null ? null : iso(pl.acceptedAt) })) });
  }

  return { get, post, accept, planView, planList, note, answer };
}

export type MarketingChat = ReturnType<typeof createMarketingChat>;
