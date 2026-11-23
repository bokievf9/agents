import { errMsg, log, migrate, roleTitle, type Db, type LlmClient } from '@fir/core';
import {
  HashEmbedder, InMemoryKnowledge, InMemoryLessons, firtechGuardContext, loadCompanyKnowledge, run, teamSpec, type Journal, type Knowledge, type Memory, type MemTurn,
  type PersonProfile,
} from '@fir/fira';
import { meterLlm } from '@fir/hq';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import type { MarketingChat } from './marketing-chat.js';
import { fail, ok } from './shell-crm.js';
import { todayIn } from './shell-week.js';
import { TEAM_HREF, teamTools, TeamTurn, type AssignResult, type TeamAction, type TeamCard, type TeamToolDeps } from './team-chat-tools.js';
import { isTeamId, TEAM_ASSIGN, TEAM_IDS, type TeamPresence } from './team-presence.js';

/**
 * The team chat (2026-11-24, contract `docs/admin-crm-api.md`, «Команда»): the marketing chat generalised to every agent. One thread per agent
 * (`team_chat`, keyed by `agent_id`), the agent's team pack (`packages/fira/role-packs/team/<id>.md`), its own tools only (`team-chat-tools.ts`), the
 * last 50 messages as the model's context, 25 s budget then `202 { pending }`. Head of Marketing keeps its own thread and engine (`marketing-chat.ts`):
 * `/admin/team/marketing-head/chat` reads and writes that same thread. `assign` gives an agent a task linked to the chat it came from; the agent
 * answers in its own chat and the task ends with that answer (writes it made land in Approvals or Tasks). `@<agentId>` or `@<Title>` in any chat
 * assigns the rest of the message to that agent. Chats belong to the owner only (`/admin/*` behind the admin token); every write is audited.
 */

export const TEAM_BUDGET_MS = 25_000;
export const TEAM_CONTEXT = 50;
/** An assignment made by an agent's own turn may assign once more, not deeper (no loops between agents). */
const MAX_DEPTH = 2;
const MAX_MENTIONS = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS team_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  cards TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'done',
  task_id INTEGER,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS team_chat_agent ON team_chat (agent_id, id);
CREATE INDEX IF NOT EXISTS team_chat_state ON team_chat (state, id);
`;

export interface TeamItem { id: number; role: 'owner' | 'agent'; text: string; at: string; cards?: TeamCard[] }
interface Row { id: number; agent_id: string; role: 'owner' | 'agent'; text: string; cards: string; actions: string; state: 'done' | 'pending'; at: number }
export interface TeamReply { id: number; text: string; cards: TeamCard[]; actions: TeamAction[] }

class ThreadMemory implements Memory {
  constructor(private readonly db: Db, private readonly agentId: string, private readonly beforeId: number) {}
  turns(): Promise<MemTurn[]> {
    const rows = this.db.prepare("SELECT role, text, at FROM team_chat WHERE agent_id = ? AND id < ? AND state = 'done' AND text != '' ORDER BY id DESC LIMIT ?").all(this.agentId, this.beforeId, TEAM_CONTEXT) as { role: string; text: string; at: number }[];
    return Promise.resolve(rows.reverse().map((r) => ({ role: r.role === 'owner' ? 'user' : 'assistant', text: r.text, at: r.at })));
  }
  append(): Promise<void> { return Promise.resolve(); }
  promote(): Promise<void> { return Promise.resolve(); }
  profile(): Promise<PersonProfile | null> { return Promise.resolve(null); }
  saveProfile(): Promise<void> { return Promise.resolve(); }
  sweep(): Promise<number> { return Promise.resolve(0); }
}

const quietJournal: Journal = { record: () => Promise.resolve() };
const postBody = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
const refSchema = z.object({ kind: z.enum(['task', 'lead', 'client', 'project', 'invoice', 'document', 'ticket', 'order', 'item']), id: z.union([z.number().int().positive(), z.string().min(1).max(40)]) }).strict();
const assignBody = z.object({ text: z.string().trim().min(3).max(2000), dueAt: z.string().max(40).optional(), refs: z.array(refSchema).max(10).optional() }).strict();
const iso = (ms: number) => new Date(ms).toISOString();
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The agents a message mentions (`@sales-head`, `@Head of Sales`), in order, at most three, never `self`; and the text without the mentions. */
export function parseMentions(text: string, known: readonly string[], self: string | null): { ids: string[]; rest: string } {
  const found: { id: string; at: number; len: number }[] = [];
  const lower = text.toLowerCase();
  for (const id of known) {
    const byId = new RegExp(`(^|[^\\p{L}\\p{N}_-])@${id}(?![\\p{L}\\p{N}_-])`, 'iu').exec(text);
    if (byId) found.push({ id, at: byId.index + byId[1]!.length, len: id.length + 1 });
    const title = `@${roleTitle(id).toLowerCase()}`;
    const i = lower.indexOf(title);
    // a whole mention: not inside an email or a word («ivan@presales.ru», «@presales-x»)
    if (i >= 0 && !/[\p{L}\p{N}_.-]/u.test(lower.charAt(i - 1)) && !/[\p{L}\p{N}_-]/u.test(lower.charAt(i + title.length))) found.push({ id, at: i, len: title.length });
  }
  found.sort((a, b) => a.at - b.at || b.len - a.len);
  // one span per mention (an id and a title can match the same «@presales»): the longest at a place wins, overlaps are dropped
  const spans: typeof found = [];
  for (const f of found) if (!spans.length || f.at >= spans[spans.length - 1]!.at + spans[spans.length - 1]!.len) spans.push(f);
  const ids: string[] = [];
  let rest = text;
  for (const f of spans) {
    if (f.id !== self && !ids.includes(f.id) && ids.length < MAX_MENTIONS) ids.push(f.id);
  }
  for (const f of [...spans].reverse()) rest = `${rest.slice(0, f.at)}${rest.slice(f.at + f.len)}`;
  return { ids, rest: rest.replace(/\s+/g, ' ').replace(/^[\s,:;.-]+/, '').trim() };
}

export interface TeamChatDeps extends Omit<TeamToolDeps, 'assign'> {
  llm?: LlmClient | undefined;
  /** Head of Marketing's own chat: the team routes of `marketing-head` read and write that thread. */
  marketingChat?: MarketingChat | null | undefined;
  knowledge?: Knowledge;
  budgetMs?: number;
  /** Late-bound: the presence (for the per-turn block and to refresh after a write). */
  presence?: () => TeamPresence | null;
}

export function createTeamChat(d: TeamChatDeps) {
  const { hq } = d;
  const db = hq.db;
  migrate(db, SCHEMA);
  const lessons = new InMemoryLessons();
  let knowledge: Knowledge | null = d.knowledge ?? null;
  const knowledgeOf = (): Knowledge => {
    if (knowledge) return knowledge;
    const k = new InMemoryKnowledge(new HashEmbedder());
    knowledge = k;
    try {
      void k.add(loadCompanyKnowledge('firtech', { now: hq.now() })).catch((e: unknown) => log('warn', 'team chat: company pack not loaded', { err: errMsg(e) }));
    } catch (e) {
      log('warn', 'team chat: company pack not loaded', { err: errMsg(e) });
    }
    return k;
  };
  db.prepare("UPDATE team_chat SET state = 'done', text = 'Ответ не успел сохраниться (перезапуск). Напишите ещё раз.' WHERE state = 'pending'").run();
  const running = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    running.add(p);
    void p.finally(() => running.delete(p)).catch(() => undefined);
    return p;
  };

  const exists = (id: string) => isTeamId(id) && hq.agent(id) !== undefined;
  const members = () => TEAM_IDS.filter((id) => hq.agent(id) !== undefined);
  const item = (r: Row): TeamItem => {
    const cards = JSON.parse(r.cards) as TeamCard[];
    return { id: r.id, role: r.role, text: r.text, at: iso(r.at), ...(cards.length ? { cards } : {}) };
  };
  const insert = (agentId: string, role: 'owner' | 'agent', text: string, state: 'done' | 'pending' = 'done', cards: TeamCard[] = [], actions: TeamAction[] = [], taskId: number | null = null): number =>
    Number(db.prepare('INSERT INTO team_chat (agent_id, role, text, cards, actions, state, task_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(agentId, role, text.slice(0, 8000), JSON.stringify(cards), JSON.stringify(actions), state, taskId, hq.now()).lastInsertRowid);
  const finish = (id: number, r: Omit<TeamReply, 'id'>) =>
    db.prepare("UPDATE team_chat SET text = ?, cards = ?, actions = ?, state = 'done', at = ? WHERE id = ?").run(r.text.slice(0, 8000), JSON.stringify(r.cards), JSON.stringify(r.actions), hq.now(), id);

  /** Agents with a turn being answered now (team threads and the marketing thread). */
  function pendingAgents(): Set<string> {
    const s = new Set((db.prepare("SELECT DISTINCT agent_id a FROM team_chat WHERE state = 'pending'").all() as { a: string }[]).map((r) => r.a));
    try {
      if (db.prepare("SELECT 1 FROM mk_chat WHERE state = 'pending' LIMIT 1").get()) s.add('marketing-head');
    } catch { /* no marketing thread yet */ }
    return s;
  }

  // ---- assignments ----
  function parseDue(v: string | undefined): number | null | 'bad' {
    if (v === undefined || v === '') return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : 'bad';
  }

  /** A task for `to`, linked to the chat it came from; the agent works it at once (its answer goes to its chat, the task ends with it). */
  function assign(from: string | null, to: string, text: string, o: { dueAt?: number | null; refs?: { kind: string; id: string | number }[]; depth?: number; sourceMessageId?: number } = {}): AssignResult {
    if (!exists(to)) return { ok: false, status: 404, error: 'unknown_agent' };
    const depth = o.depth ?? 0;
    if (depth >= MAX_DEPTH) return { ok: false, status: 409, error: 'too_deep: an assignment cannot be passed on again' };
    const agent = hq.agent(to)!;
    const t = hq.createTask({
      title: clip(`Поручение: ${text}`, 120), body: text.slice(0, 4000), dept: agent.dept, assigneeId: to, creator: from ? 'head' : 'owner', priority: 1, tags: ['team'],
      ...(o.dueAt ? { dueAt: o.dueAt } : {}),
      meta: { action: TEAM_ASSIGN, source: { kind: 'chat', agent: from, ...(o.sourceMessageId ? { messageId: o.sourceMessageId } : {}) }, depth: depth + 1, ...(o.refs?.length ? { refs: o.refs } : {}) },
    });
    // taken by the agent at once, so no head picks it from the queue
    hq.claim(t.id, to);
    hq.log(from ?? 'owner', 'team_assign', 'task', String(t.id), `to:${to}`);
    track(work(t.id));
    d.presence?.()?.invalidate();
    return { ok: true, task: { id: t.id, href: TEAM_HREF.task(t.id) } };
  }

  /** The agent answers its assignment in its own chat; the task ends with that answer (or is blocked with the reason). */
  async function work(taskId: number): Promise<void> {
    const t = hq.task(taskId);
    if (!t || t.status !== 'running' || !t.assigneeId) return;
    const to = t.assigneeId;
    const src = (t.meta.source ?? {}) as { agent?: string | null };
    const head = `Поручение #${t.id}${src.agent ? ` (из чата ${roleTitle(src.agent)})` : ''}: ${t.body || t.title}`;
    try {
      let said: string;
      if (to === 'marketing-head' && d.marketingChat) {
        const r = await d.marketingChat.post({ text: head.slice(0, 2000) });
        said = r.status === 200 ? String((r.body.reply as { text: string }).text) : 'Ответ готовится в чате Head of Marketing.';
      } else {
        const ownerRow = insert(to, 'owner', head, 'done', [], [], t.id);
        const agentRow = insert(to, 'agent', '', 'pending', [], [], t.id);
        const r = await answer(to, head, ownerRow, Number(t.meta.depth ?? 1));
        finish(agentRow, r);
        said = r.text;
      }
      const cur = hq.task(taskId);
      if (cur?.status === 'running') hq.complete(taskId, to, said.slice(0, 4000));
    } catch (e) {
      log('warn', 'team assignment failed', { task: taskId, err: errMsg(e) });
      const cur = hq.task(taskId);
      if (cur && cur.status === 'running') hq.block(taskId, to, `Сбой поручения: ${errMsg(e)}`.slice(0, 300));
    } finally {
      d.presence?.()?.invalidate();
    }
  }

  // assignments cut off by a restart (`recoverInterrupted` put them back to assigned): the agent takes them again
  for (const t of hq.tasks({ status: ['inbox', 'assigned'], limit: 500 }).filter((x) => x.meta.action === TEAM_ASSIGN && x.assigneeId)) {
    if (hq.claim(t.id, t.assigneeId!)) track(work(t.id));
  }

  /** `@agent …` in the owner's message: one assignment per mentioned agent. */
  function mentions(self: string, text: string, sourceMessageId: number): { cards: TeamCard[]; actions: TeamAction[]; note: string } {
    const m = parseMentions(text, members(), self);
    const cards: TeamCard[] = [];
    const actions: TeamAction[] = [];
    const lines: string[] = [];
    for (const id of m.ids) {
      const r = assign(self, id, m.rest.length >= 3 ? m.rest : text, { sourceMessageId });
      if (!r.ok) continue;
      cards.push({ kind: 'task', id: String(r.task.id), title: clip(`Поручение для ${roleTitle(id)}: ${m.rest || text}`, 120), href: r.task.href, meta: { agent: id } });
      actions.push({ type: 'task_assigned', ref: String(r.task.id) });
      lines.push(`${roleTitle(id)} получил поручение #${r.task.id}`);
    }
    return { cards, actions, note: lines.join('; ') };
  }

  // ---- one turn ----
  function context(agentId: string, note: string): string {
    const m = d.presence?.()?.member(agentId);
    const lines = [
      '## Сейчас',
      `- Сегодня ${todayIn(hq.now(), hq.tz)}. Ты ${roleTitle(agentId)} (id ${agentId}), отдел ${hq.agent(agentId)?.dept ?? ''}.`,
      ...(m ? [`- Твоя очередь: ${m.queue}; состояние: ${m.presence}${m.now ? ` (${m.now})` : ''}.`] : []),
      `- Команда (id для assign_agent): ${members().filter((x) => x !== agentId).join(', ')}.`,
      ...(note ? [`- В этом сообщении владелец уже раздал поручения: ${note}. Не дублируй их.`] : []),
    ];
    return lines.join('\n');
  }

  const toolDeps = (depth: number): TeamToolDeps => ({
    ...d,
    assign: (from, to, text) => assign(from, to, text, { depth }),
  });

  async function modelTurn(agentId: string, text: string, ownerId: number, depth: number, note: string): Promise<Omit<TeamReply, 'id'> | null> {
    if (!d.llm || !d.llm.enabled) return null;
    const turn = new TeamTurn();
    const out = await run(teamSpec(agentId), { id: `team:${agentId}`, text, mode: 'live', lang: 'ru', audience: 'owner' }, {
      llm: meterLlm(d.llm, hq, { agentId }), knowledge: knowledgeOf(), memory: new ThreadMemory(db, agentId, ownerId), lessons, journal: quietJournal, now: hq.now,
      tools: teamTools(agentId, toolDeps(depth), { text, turn }), guard: firtechGuardContext('ru'), system: context(agentId, note), historyTurns: TEAM_CONTEXT,
    });
    const actions = turn.allActions();
    if (out.fallback && !actions.length) return null;
    const said = out.fallback ? `Готово: ${actions.map((a) => `${a.type} ${a.ref ?? ''}`.trim()).join('; ')}.` : out.reply;
    return { text: said, cards: turn.out(), actions: actions.length ? actions : [{ type: 'none' }] };
  }

  /** No model: an honest answer from the data, by code. */
  function offline(agentId: string, note: string): Omit<TeamReply, 'id'> {
    const m = d.presence?.()?.member(agentId, true);
    const open = hq.tasks({ assigneeId: agentId, open: true, limit: 100 }).filter((t) => !t.tags.includes('drill'));
    const waiting = open.filter((t) => t.status === 'review' || t.status === 'approval').length;
    const parts = [
      'Модель сейчас недоступна, отвечаю по данным.',
      `Моих задач в работе: ${open.length}, ждут вашего решения: ${waiting}.`,
      ...(m?.now ? [`Сейчас: ${m.now}.`] : []),
      ...(note ? [`${note}.`] : []),
    ];
    const cards: TeamCard[] = open.slice(0, 3).map((t) => ({ kind: 'task', id: String(t.id), title: clip(t.title, 120), href: TEAM_HREF.task(t.id), meta: { status: t.status } }));
    return { text: parts.join(' '), cards, actions: [{ type: 'none' }] };
  }

  async function answer(agentId: string, text: string, ownerId: number, depth = 0, note = ''): Promise<Omit<TeamReply, 'id'>> {
    try {
      return (await modelTurn(agentId, text, ownerId, depth, note)) ?? offline(agentId, note);
    } catch (e) {
      log('warn', 'team chat turn failed', { agent: agentId, err: errMsg(e) });
      try {
        return offline(agentId, note);
      } catch {
        return { text: 'Не получилось ответить, попробуйте ещё раз.', cards: [], actions: [{ type: 'none' }] };
      }
    }
  }

  // ---- routes ----
  function get(agentId: string, query: URLSearchParams): AdminReply {
    if (!exists(agentId)) return fail(404, 'not_found');
    if (agentId === 'marketing-head' && d.marketingChat) {
      const r = d.marketingChat.get(query);
      if (r.status !== 200) return r;
      const items = (r.body.items as { id: number; role: string; text: string; at: string; cards?: unknown[] }[]).map((x) => ({ ...x, role: x.role === 'owner' ? 'owner' : 'agent' }));
      return ok({ items, pending: r.body.pending, rules: r.body.rules });
    }
    const limRaw = query.get('limit');
    const limit = limRaw === null || limRaw === '' ? 50 : /^\d{1,3}$/.test(limRaw) ? Math.min(Math.max(Number(limRaw), 1), 200) : NaN;
    if (!Number.isFinite(limit)) return fail(400, 'invalid', { hint: 'limit' });
    const beforeRaw = query.get('before');
    if (beforeRaw && !/^\d{1,12}$/.test(beforeRaw)) return fail(400, 'invalid', { hint: 'before' });
    const before = beforeRaw ? Number(beforeRaw) : Number.MAX_SAFE_INTEGER;
    const rows = (db.prepare("SELECT * FROM team_chat WHERE agent_id = ? AND id < ? AND state = 'done' ORDER BY id DESC LIMIT ?").all(agentId, before, limit) as Row[]).reverse();
    const pending = (db.prepare("SELECT id FROM team_chat WHERE agent_id = ? AND state = 'pending' ORDER BY id").all(agentId) as { id: number }[]).map((x) => x.id);
    return ok({ items: rows.map(item), pending });
  }

  async function post(agentId: string, body: unknown): Promise<AdminReply> {
    if (!exists(agentId)) return fail(404, 'not_found');
    const p = postBody.safeParse(body ?? {});
    if (!p.success) return fail(400, 'invalid', { maxChars: 2000 });
    const text = p.data.text;
    if (agentId === 'marketing-head' && d.marketingChat) {
      const m = mentions(agentId, text, 0);
      const r = await d.marketingChat.post({ text });
      if (r.status !== 200) return r;
      const reply = r.body.reply as { id: number; text: string; cards: TeamCard[] };
      return ok({ reply: { ...reply, cards: [...m.cards, ...reply.cards] }, actions: [...m.actions, ...((r.body.actions as TeamAction[]) ?? [])].filter((a, i, all) => a.type !== 'none' || all.length === 1) });
    }
    const ownerId = insert(agentId, 'owner', text);
    hq.log('owner', 'team_chat', 'agent', agentId, 'message');
    const m = mentions(agentId, text, ownerId);
    const agentRow = insert(agentId, 'agent', '', 'pending');
    const job = answer(agentId, text, ownerId, 0, m.note).then((r) => {
      const merged = { text: r.text, cards: [...m.cards, ...r.cards].slice(0, 10), actions: [...m.actions, ...r.actions].filter((a, i, all) => a.type !== 'none' || all.length === 1) };
      finish(agentRow, merged);
      d.presence?.()?.invalidate();
      return merged;
    });
    track(job);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((res) => {
      timer = setTimeout(() => res(null), d.budgetMs ?? TEAM_BUDGET_MS);
      timer.unref?.();
    });
    const r = await Promise.race([job, late]);
    if (timer) clearTimeout(timer);
    if (!r) return { status: 202, body: { ok: true, pending: agentRow } };
    return ok({ reply: { id: agentRow, text: r.text, cards: r.cards }, actions: r.actions });
  }

  function assignRoute(agentId: string, body: unknown): AdminReply {
    if (!exists(agentId)) return fail(404, 'not_found');
    const p = assignBody.safeParse(body ?? {});
    if (!p.success) return fail(400, 'invalid', { maxChars: 2000 });
    const due = parseDue(p.data.dueAt);
    if (due === 'bad') return fail(400, 'invalid', { hint: 'dueAt' });
    const r = assign(null, agentId, p.data.text, { dueAt: due, ...(p.data.refs ? { refs: p.data.refs } : {}) });
    return r.ok ? ok({ task: r.task }) : fail(r.status, r.error);
  }

  return {
    get, post, assign: assignRoute, assignFrom: assign, answer, pendingAgents, exists, members,
    /** Resolves when every background job (answers past the budget, assignments) is done: tests and a clean shutdown. */
    async idle(): Promise<void> {
      while (running.size) await Promise.allSettled([...running]);
    },
  };
}

export type TeamChat = ReturnType<typeof createTeamChat>;
