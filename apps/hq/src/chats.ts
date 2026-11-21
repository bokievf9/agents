import { errMsg, log, migrate } from '@fir/core';
import type { Hq } from '@fir/hq';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import { addCabMessage, addThreadMessage, ensureCabinetTables } from './cabinet.js';
import type { ClientChannel } from './client/channel.js';
import { fail, ok } from './pult-crm.js';

/**
 * Chats with clients: one thread per client, merged from the cabinet (`cab_clients`, `cab_messages`), the leads and their replies, the support tickets,
 * the website chat sessions and the @firtech_bot dialogues. Join order: cabinet client id, else the same contact (email, @handle, phone), else the same chat
 * session. Texts of anonymous website and bot dialogues are not stored by design (only a masked summary), so such a thread has no messages until the
 * person becomes a lead, a ticket or a cabinet client. The owner's reply goes out on the client's last channel without an approval (he wrote it himself).
 * Contract: `docs/admin-crm-api.md`, section «Ревью-центр (2026-11-21)».
 */
export interface ChatsDeps {
  hq: Hq;
  now: () => number;
  client?: Pick<ClientChannel, 'send'> | undefined;
  webReply?: ((sessionId: string, text: string) => boolean) | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ch_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  client_id INTEGER,
  session_id TEXT,
  chat_id INTEGER,
  channel TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ch_messages_lead ON ch_messages (lead_id);
CREATE TABLE IF NOT EXISTS ch_unread (
  thread_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
`;

export type ChatChannel = 'web' | 'telegram' | 'cabinet';
export type ChatFrom = 'client' | 'hq' | 'owner';
interface Message { id: string; at: number; from: ChatFrom; channel: ChatChannel; text: string; attachments: unknown[] }

/**
 * `thread`: the cabinet thread the answer goes to (`lead` = the request thread, `support`, `project-<id>`). `replyTo`: the id of the message the owner answers
 * (`cab_12`, `ct_7`, ...). Without `thread` the thread is taken from `replyTo`, else from the client's last message; only when a client with several threads gives
 * nothing to go by is it `422 thread_required`.
 */
const replyBody = z.object({
  text: z.string().trim().min(1).max(2000),
  thread: z.string().regex(/^(lead|support|project-\d{1,9})$/).optional(),
  replyTo: z.string().regex(/^[a-z]{1,4}_\d{1,12}(_[qa])?$/).optional(),
}).strict();
const iso = (ms: number) => new Date(ms).toISOString();
const oneLine = (s: string, n = 120) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};
const OPEN_WINDOW_MS = 7 * 86_400_000;

/** One key per identity of a person: an email, a Telegram handle or a phone number, however the contact was written. */
export function contactKey(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const tme = /(?:t\.me|telegram\.me)\/@?([a-z0-9_]{3,})/.exec(s);
  if (tme) return `tg:${tme[1]}`;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return `em:${s}`;
  if (/^@?[a-z][a-z0-9_]{2,}$/.test(s)) return `tg:${s.replace(/^@/, '')}`;
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 7 && /^[+\d\s()-]+$/.test(s)) return `ph:${digits}`;
  return null;
}

class Union {
  private readonly parent = new Map<string, string>();
  find(a: string): string {
    if (!this.parent.has(a)) this.parent.set(a, a);
    let r = a;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    for (let x = a; x !== r; ) {
      const next = this.parent.get(x)!;
      this.parent.set(x, r);
      x = next;
    }
    return r;
  }
  join(a: string, b: string | null): void {
    if (b === null) return;
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
  nodes(): string[] {
    return [...this.parent.keys()];
  }
}

interface Lead { id: number; taskId: number; name: string; contact: string; clientId: number | null; origin: string; task: string; createdAt: number; chatId: number | null; sessionId: string | null }
interface Thread {
  id: string;
  aliases: string[];
  clientId: number | null;
  name: string;
  email: string | null;
  contact: string;
  channels: ChatChannel[];
  messages: Message[];
  lastAt: number;
  leadId: number | null;
  ticketId: number | null;
  openTicket: boolean;
  chatIds: number[];
  sessionIds: string[];
  textsStored: boolean;
  summary: string;
}

export function createChats(d: ChatsDeps) {
  const { hq, now } = d;
  const db = hq.db;
  migrate(db, SCHEMA);
  const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
  const all = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];

  const originChannel = (origin: string, l: Lead): ChatChannel =>
    /telegram|tg|bot/i.test(origin) || l.chatId !== null ? 'telegram' : /cabinet/i.test(origin) ? 'cabinet' : 'web';

  /** Builds every thread from the tables (all small: leads, tickets, a cabinet's messages); nothing here reads or logs a text outside the owner's answer. */
  function build(): Thread[] {
    ensureCabinetTables(db);
    const u = new Union();
    const clients = has('cab_clients') ? all<{ id: number; email: string; name: string; telegram: string }>('SELECT id, email, name, telegram FROM cab_clients') : [];
    const leads: Lead[] = has('li_leads')
      ? all<{ id: number; task_id: number; name: string; contact: string; client_id: number | null; origin: string; task: string; created_at: number; chat_id: number | null; session_id: string | null }>(
        `SELECT l.id, l.task_id, l.name, l.contact, l.client_id, l.origin, l.task, l.created_at,
                json_extract(t.meta, '$.lead.chatId') chat_id, json_extract(t.meta, '$.lead.sessionId') session_id
         FROM li_leads l LEFT JOIN tasks t ON t.id = l.task_id`,
      ).map((r) => ({ id: r.id, taskId: r.task_id, name: r.name, contact: r.contact, clientId: r.client_id, origin: r.origin, task: r.task, createdAt: r.created_at, chatId: typeof r.chat_id === 'number' ? r.chat_id : null, sessionId: typeof r.session_id === 'string' ? r.session_id : null }))
      : [];
    const tickets = has('cs_tickets')
      ? all<{ id: number; client_name: string; contact: string; text: string; status: string; created_at: number; answered_at: number | null; answer: string | null; lead_id: number | null }>('SELECT id, client_name, contact, text, status, created_at, answered_at, answer, lead_id FROM cs_tickets')
      : [];
    const cabMsgs = all<{ id: number; client_id: number; lead_id: number; from: 'client' | 'manager'; text: string; at: number; ticket_id: number | null; author: string }>('SELECT id, client_id, lead_id, "from", text, at, ticket_id, author FROM cab_messages');
    // Cabinet v3: the client's messages in his project and support threads (the agent thread is his own business, not shown here)
    const tmsgs = all<{ id: number; client_id: number; thread: string; from: 'client' | 'manager' | 'agent'; text: string; at: number; author: string }>(
      "SELECT id, client_id, thread, \"from\", text, at, author FROM cab_tmsgs WHERE thread NOT LIKE 'agent-%' ORDER BY id",
    );
    const sessions = has('web_chat_sessions') ? all<{ id: string; summary: string; created_at: number; updated_at: number }>('SELECT id, summary, created_at, updated_at FROM web_chat_sessions') : [];
    const bots = has('cb_chats') ? all<{ chat_id: number; username: string; summary: string; last_at: number }>('SELECT chat_id, username, summary, last_at FROM cb_chats') : [];
    const owner = all<{ id: number; lead_id: number | null; client_id: number | null; session_id: string | null; chat_id: number | null; channel: ChatChannel; text: string; at: number }>('SELECT * FROM ch_messages');
    const replies = has('approvals')
      ? all<{ id: number; payload: string; decided_at: number | null }>("SELECT a.id, a.payload, a.decided_at FROM approvals a WHERE a.kind IN ('lead_reply', 'lead_price') AND a.status = 'executed'")
      : [];

    // identities
    for (const c of clients) {
      u.join(`c:${c.id}`, contactKey(c.email) ? `k:${contactKey(c.email)}` : null);
      u.join(`c:${c.id}`, contactKey(c.telegram) ? `k:${contactKey(c.telegram)}` : null);
      u.find(`c:${c.id}`);
    }
    for (const l of leads) {
      u.find(`l:${l.id}`);
      if (l.clientId !== null) u.join(`l:${l.id}`, `c:${l.clientId}`);
      const k = contactKey(l.contact);
      if (k) u.join(`l:${l.id}`, `k:${k}`);
      if (l.chatId !== null) u.join(`l:${l.id}`, `g:${l.chatId}`);
      if (l.sessionId !== null) u.join(`l:${l.id}`, `w:${l.sessionId}`);
    }
    for (const t of tickets) {
      u.find(`t:${t.id}`);
      if (t.lead_id !== null) u.join(`t:${t.id}`, `l:${t.lead_id}`);
      const k = contactKey(t.contact);
      if (k) u.join(`t:${t.id}`, `k:${k}`);
    }
    for (const s of sessions) u.find(`w:${s.id}`);
    for (const b of bots) {
      u.find(`g:${b.chat_id}`);
      const k = contactKey(b.username);
      if (k) u.join(`g:${b.chat_id}`, `k:${k}`);
    }
    for (const m of cabMsgs) {
      u.join(`c:${m.client_id}`, `l:${m.lead_id}`);
    }
    for (const m of owner) {
      const anchor = m.client_id !== null ? `c:${m.client_id}` : m.lead_id !== null ? `l:${m.lead_id}` : m.session_id !== null ? `w:${m.session_id}` : m.chat_id !== null ? `g:${m.chat_id}` : null;
      if (anchor) {
        u.find(anchor);
        if (m.lead_id !== null) u.join(anchor, `l:${m.lead_id}`);
        if (m.session_id !== null) u.join(anchor, `w:${m.session_id}`);
        if (m.chat_id !== null) u.join(anchor, `g:${m.chat_id}`);
      }
    }

    const groups = new Map<string, string[]>();
    for (const n of u.nodes()) groups.set(u.find(n), [...(groups.get(u.find(n)) ?? []), n]);
    const threads: Thread[] = [];
    const leadById = new Map(leads.map((l) => [l.id, l]));
    for (const members of groups.values()) {
      const ids = (p: string) => members.filter((m) => m.startsWith(`${p}:`)).map((m) => m.slice(2));
      const clientIds = ids('c').map(Number).sort((a, b) => a - b);
      const leadIds = ids('l').map(Number).sort((a, b) => a - b);
      const ticketIds = ids('t').map(Number).sort((a, b) => a - b);
      const sessionIds = ids('w');
      const chatIds = ids('g').map(Number);
      if (clientIds.length + leadIds.length + ticketIds.length + sessionIds.length + chatIds.length === 0) continue;
      const myLeads = leadIds.map((i) => leadById.get(i)!).filter(Boolean);
      const myClients = clients.filter((c) => clientIds.includes(c.id));
      const myTickets = tickets.filter((t) => ticketIds.includes(t.id));
      const id = clientIds.length ? `c${clientIds[0]}` : leadIds.length ? `l${leadIds[0]}` : ticketIds.length ? `t${ticketIds[0]}` : sessionIds.length ? `w${sessionIds[0]}` : `g${chatIds[0]}`;
      const aliases = [...clientIds.map((x) => `c${x}`), ...leadIds.map((x) => `l${x}`), ...ticketIds.map((x) => `t${x}`), ...sessionIds.map((x) => `w${x}`), ...chatIds.map((x) => `g${x}`)];

      const messages: Message[] = [];
      const channels = new Set<ChatChannel>();
      const cabHere = cabMsgs.filter((m) => clientIds.includes(m.client_id));
      const cabTickets = new Set(cabHere.map((m) => m.ticket_id).filter((x): x is number => x !== null));
      for (const m of cabHere) {
        channels.add('cabinet');
        messages.push({ id: `cab_${m.id}`, at: m.at, from: m.from === 'client' ? 'client' : m.author === 'owner' ? 'owner' : 'hq', channel: 'cabinet', text: m.text, attachments: [] });
      }
      for (const m of tmsgs.filter((x) => clientIds.includes(x.client_id))) {
        channels.add('cabinet');
        messages.push({ id: `ct_${m.id}`, at: m.at, from: m.from === 'client' ? 'client' : m.author === 'owner' ? 'owner' : 'hq', channel: 'cabinet', text: m.text, attachments: [] });
      }
      for (const l of myLeads) {
        const ch = originChannel(l.origin, l);
        channels.add(ch);
        if (l.task.trim()) messages.push({ id: `lead_${l.id}`, at: l.createdAt, from: 'client', channel: ch, text: l.task, attachments: [] });
      }
      for (const t of myTickets) {
        if (cabTickets.has(t.id)) continue;
        const lead = t.lead_id !== null ? leadById.get(t.lead_id) : undefined;
        const ch: ChatChannel = lead ? originChannel(lead.origin, lead) : 'web';
        channels.add(ch);
        messages.push({ id: `tk_${t.id}_q`, at: t.created_at, from: 'client', channel: ch, text: t.text, attachments: [] });
        if (t.answer && t.answered_at !== null) messages.push({ id: `tk_${t.id}_a`, at: t.answered_at, from: 'hq', channel: ch, text: t.answer, attachments: [] });
      }
      for (const r of replies) {
        const p = JSON.parse(r.payload) as { leadId?: unknown; text?: unknown };
        if (typeof p.leadId !== 'number' || !leadIds.includes(p.leadId) || typeof p.text !== 'string') continue;
        const sent = p.text.trim();
        // a cabinet client already has this text from the cabinet thread
        if (cabHere.some((m) => m.from === 'manager' && m.lead_id === p.leadId && m.text.trim() === sent)) continue;
        const l = leadById.get(p.leadId)!;
        messages.push({ id: `rp_${r.id}`, at: r.decided_at ?? l.createdAt, from: 'hq', channel: originChannel(l.origin, l), text: p.text, attachments: [] });
      }
      for (const m of owner) {
        const mine = (m.client_id !== null && clientIds.includes(m.client_id)) || (m.lead_id !== null && leadIds.includes(m.lead_id)) || (m.session_id !== null && sessionIds.includes(m.session_id)) || (m.chat_id !== null && chatIds.includes(m.chat_id));
        if (!mine) continue;
        channels.add(m.channel);
        messages.push({ id: `ow_${m.id}`, at: m.at, from: 'owner', channel: m.channel, text: m.text, attachments: [] });
      }
      if (chatIds.length) channels.add('telegram');
      if (sessionIds.length) channels.add('web');
      if (myClients.length) channels.add('cabinet');
      messages.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

      const bot = bots.filter((b) => chatIds.includes(b.chat_id)).sort((a, b) => b.last_at - a.last_at)[0];
      const sess = sessions.filter((s) => sessionIds.includes(s.id)).sort((a, b) => b.updated_at - a.updated_at)[0];
      const newest = myLeads.sort((a, b) => b.id - a.id)[0];
      const client = myClients[0];
      const firstEmail = client?.email || members.find((m) => m.startsWith('k:em:'))?.slice(5) || null;
      const name = client?.name || newest?.name || myTickets[0]?.client_name || (bot?.username ? `@${bot.username}` : '') || 'Посетитель сайта';
      const contact = newest?.contact || client?.telegram || (bot?.username ? `@${bot.username}` : '') || myTickets[0]?.contact || firstEmail || '';
      const lastAt = Math.max(0, messages.at(-1)?.at ?? 0, bot?.last_at ?? 0, sess?.updated_at ?? 0, newest?.createdAt ?? 0);
      threads.push({
        id, aliases, clientId: client?.id ?? null, name, email: firstEmail, contact, channels: [...channels], messages, lastAt, leadId: newest?.id ?? null,
        ticketId: myTickets.sort((a, b) => b.id - a.id)[0]?.id ?? null, openTicket: myTickets.some((t) => t.status === 'open'), chatIds, sessionIds,
        textsStored: messages.length > 0 || myLeads.length > 0 || myTickets.length > 0 || myClients.length > 0, summary: bot?.summary || sess?.summary || '',
      });
    }
    return threads.sort((a, b) => b.lastAt - a.lastAt || a.id.localeCompare(b.id));
  }

  /** Client messages after the last owner or HQ message; a thread the owner marked unread counts at least 1 until somebody answers it. */
  const unreadOf = (t: Thread, flags: Map<string, number> = unreadFlags()): number => {
    const lastAnswer = t.messages.filter((m) => m.from !== 'client').at(-1)?.at ?? -1;
    const n = t.messages.filter((m) => m.from === 'client' && m.at > lastAnswer).length;
    if (n > 0) return n;
    const flagged = [t.id, ...t.aliases].some((a) => (flags.get(a) ?? -2) >= lastAnswer);
    return flagged ? 1 : 0;
  };
  function unreadFlags(): Map<string, number> {
    return new Map((all<{ thread_id: string; at: number }>('SELECT thread_id, at FROM ch_unread')).map((r) => [r.thread_id, r.at]));
  }

  const threadView = (t: Thread, flags: Map<string, number> = unreadFlags()) => {
    const last = t.messages.at(-1);
    return {
      id: t.id, client: { id: t.clientId, name: t.name, email: t.email, contact: t.contact }, channels: t.channels, lastAt: t.lastAt ? iso(t.lastAt) : null, unread: unreadOf(t, flags),
      preview: last ? oneLine(last.text) : oneLine(t.summary), leadId: t.leadId, ticketId: t.ticketId, textsStored: t.textsStored, openTicket: t.openTicket,
    };
  };
  const find = (id: string): Thread | undefined => build().find((t) => t.id === id || t.aliases.includes(id));

  function list(query: URLSearchParams): AdminReply {
    const status = query.get('status') ?? 'open';
    if (status !== 'open' && status !== 'all') return fail(400, 'invalid', { allowed: ['open', 'all'] });
    const limRaw = query.get('limit');
    const limit = limRaw === null || limRaw === '' ? 50 : /^\d+$/.test(limRaw) ? Math.min(Math.max(Number(limRaw), 1), 200) : NaN;
    if (!Number.isFinite(limit)) return fail(400, 'invalid', { hint: 'limit' });
    const curRaw = query.get('cursor');
    if (curRaw && !/^\d+$/.test(curRaw)) return fail(400, 'invalid', { hint: 'cursor' });
    const from = curRaw ? Number(curRaw) : 0;
    const t = now();
    const flags = unreadFlags();
    const open = build().filter((x) => status === 'all' || unreadOf(x, flags) > 0 || x.openTicket || t - x.lastAt <= OPEN_WINDOW_MS);
    const page = open.slice(from, from + limit);
    return ok({ items: page.map((x) => threadView(x, flags)), unread: open.filter((x) => unreadOf(x, flags) > 0).length, nextCursor: from + limit < open.length ? String(from + limit) : null });
  }

  function get(id: string): AdminReply {
    const t = find(id);
    if (!t) return fail(404, 'not_found');
    // `thread`: the cabinet thread of the message (`lead` for everything that is not a thread message: the request, a ticket, Telegram, the site chat, the owner's own lines)
    return ok({ thread: threadView(t), messages: t.messages.map((m) => ({ id: m.id, at: iso(m.at), from: m.from, channel: m.channel, thread: threadOfMessage(m.id) ?? 'lead', text: m.text, attachments: m.attachments })) });
  }

  /** `POST /admin/chats/:id/unread`: the owner marks the client unread again. Already unread: nothing changes. The mark lasts until somebody answers. */
  function markUnread(id: string): AdminReply {
    const t = find(id);
    if (!t) return fail(404, 'not_found');
    if (unreadOf(t) === 0) db.prepare('INSERT INTO ch_unread (thread_id, at) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET at = excluded.at').run(t.id, now());
    hq.log('owner', 'chat_unread', 'chat', t.id, 'marked');
    const fresh = find(t.id) ?? t;
    return ok({ thread: threadView(fresh) });
  }

  /** The cabinet thread a message id belongs to: `lead` (a request-thread message), a `cab_tmsgs` thread name, or null when it is not a cabinet message. */
  function threadOfMessage(mid: string): string | null {
    const m = /^(cab|ct)_(\d+)$/.exec(mid);
    if (!m) return null;
    if (m[1] === 'cab') return 'lead';
    const r = db.prepare('SELECT thread FROM cab_tmsgs WHERE id = ?').get(Number(m[2])) as { thread: string } | undefined;
    return r && !r.thread.startsWith('agent-') ? r.thread : null;
  }

  /** The cabinet threads the client has: the request thread (when a lead is linked) and every project or support thread with messages. */
  function threadsOf(t: Thread, hasCabinet: boolean): string[] {
    const set = new Set<string>();
    if (hasCabinet) set.add('lead');
    for (const m of t.messages) {
      const th = threadOfMessage(m.id);
      if (th) set.add(th);
    }
    return [...set];
  }

  /** `lead`, a thread name, `ambiguous` (several threads and nothing to go by) or `undefined` (the old routing: one thread or none). */
  function resolveThread(t: Thread, thread: string | undefined, replyTo: string | undefined, hasCabinet: boolean): string | undefined {
    if (thread !== undefined) return t.clientId === null && thread !== 'lead' ? undefined : thread;
    const all = threadsOf(t, hasCabinet);
    if (replyTo !== undefined) {
      const th = threadOfMessage(replyTo);
      if (th) return th;
    }
    if (all.length <= 1) return all[0] !== undefined && all[0] !== 'lead' && t.clientId !== null ? all[0] : undefined;
    // several threads: the one the client wrote in last (a message that came by Telegram or the site chat is the request thread's: the old routing)
    const last = [...t.messages].reverse().find((m) => m.from === 'client');
    if (!last) return 'ambiguous';
    return threadOfMessage(last.id) ?? 'lead';
  }

  async function reply(id: string, body: unknown): Promise<AdminReply> {
    const t = find(id);
    if (!t) return fail(404, 'not_found');
    const parsed = replyBody.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid');
    const { text } = parsed.data;
    const lead = t.leadId !== null ? (has('li_leads') ? (db.prepare('SELECT id, task_id, client_id FROM li_leads WHERE id = ?').get(t.leadId) as { id: number; task_id: number; client_id: number | null } | undefined) : undefined) : undefined;
    const meta = lead ? (hq.task(lead.task_id)?.meta.lead as { chatId?: unknown; sessionId?: unknown } | undefined) : undefined;
    const chatId = t.chatIds[0] ?? (typeof meta?.chatId === 'number' ? meta.chatId : undefined);
    const sessionId = t.sessionIds[0] ?? (typeof meta?.sessionId === 'string' ? meta.sessionId : undefined);
    const hasCabinet = t.clientId !== null && lead !== undefined;
    // the cabinet thread of the answer: asked for, else the one of the message answered, else the one the client wrote in last (`lead` = the request thread, `undefined` = the old routing)
    const asked = resolveThread(t, parsed.data.thread, parsed.data.replyTo, hasCabinet);
    if (asked === 'ambiguous') return fail(422, 'thread_required', { threads: threadsOf(t, hasCabinet) });
    const target = asked === 'lead' ? undefined : asked;
    // the client's last channel first (where he wrote last), then the others that have an address
    const lastIn = [...t.messages].reverse().find((m) => m.from === 'client')?.channel;
    const order = [...new Set<ChatChannel>([...(lastIn ? [lastIn] : []), 'telegram', 'web', 'cabinet'])];
    let via: ChatChannel | 'none' = 'none';
    for (const ch of target === undefined ? order : []) {
      try {
        if (ch === 'telegram' && chatId !== undefined && d.client) {
          await d.client.send(chatId, text);
          via = 'telegram';
        } else if (ch === 'web' && sessionId !== undefined && d.webReply?.(sessionId, text)) via = 'web';
        else if (ch === 'cabinet' && hasCabinet) via = 'cabinet';
      } catch (e) {
        log('warn', 'owner chat reply not delivered', { thread: t.id, channel: ch, err: errMsg(e) });
      }
      if (via !== 'none') break;
    }
    // the cabinet thread keeps every reply to a cabinet client (his own channel); without a cabinet the reply is kept here
    let stored: Message;
    if (target !== undefined && t.clientId !== null) {
      // an answer in the thread the client wrote in (project or support): his own channel, so the cabinet is where it lands
      const at = now();
      const id = addThreadMessage(db, at, { clientId: t.clientId, thread: target, from: 'manager', text, by: 'owner' });
      via = 'cabinet';
      stored = { id: `ct_${id}`, at, from: 'owner', channel: 'cabinet', text, attachments: [] };
    } else if (hasCabinet) {
      const at = now();
      const cabId = addCabMessage(db, at, { clientId: t.clientId!, leadId: lead!.id, from: 'manager', text, by: 'owner' });
      stored = { id: `cab_${cabId}`, at, from: 'owner', channel: 'cabinet', text, attachments: [] };
    } else {
      const at = now();
      const r = db.prepare('INSERT INTO ch_messages (lead_id, client_id, session_id, chat_id, channel, text, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(lead?.id ?? null, t.clientId, sessionId ?? null, chatId ?? null, via === 'none' ? (t.channels[0] ?? 'web') : via, text, at);
      stored = { id: `ow_${Number(r.lastInsertRowid)}`, at, from: 'owner', channel: via === 'none' ? (t.channels[0] ?? 'web') : via, text, attachments: [] };
    }
    const sent = via !== 'none';
    // the lead's journal: its task and the activity log (ids and the channel; the text only in the task journal the owner reads)
    if (lead && hq.task(lead.task_id)) hq.comment(lead.task_id, 'owner', `Ответ владельца (${via}${sent ? '' : ', не доставлен'}): ${text.slice(0, 2000)}`);
    hq.log('owner', 'chat_reply', 'chat', t.id, `${via}:${sent ? 'sent' : 'not_sent'}`);
    return ok({ sent, via, message: { id: stored.id, at: iso(stored.at), from: 'owner', channel: stored.channel, text, attachments: [] }, thread: threadView(find(t.id) ?? t) });
  }

  return { list, get, reply, markUnread };
}
