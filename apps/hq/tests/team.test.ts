/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { MockChatLlm, OffLlm, type LlmChatRequest, type LlmClient, type ScriptedTurn } from '@fir/core';
import { runTool, teamPackIds, teamSpec, TEAM_KNOWN_TOOLS, type ToolCtx } from '@fir/fira';
import { describe, expect, it } from 'vitest';
import { seedBackoffice } from '../src/heads/backoffice.js';
import { seedSales } from '../src/heads/sales.js';
import { shellLinks } from '../src/links.js';
import { createTeamChat, parseMentions } from '../src/team-chat.js';
import { teamToolNames, teamTools, TeamTurn } from '../src/team-chat-tools.js';
import { derivePresence, nowPhrase, TEAM_ASSIGN, TEAM_IDS } from '../src/team-presence.js';
import { instructionsDir } from './helpers.js';
import { serve, shellWorld } from './shell-helpers.js';

type Script = ScriptedTurn[] | ((req: LlmChatRequest, n: number) => ScriptedTurn | Promise<ScriptedTurn>);

/** The Shell world with every department seeded (Sales and Back Office too), the team chat on a scripted model or with the model off. */
function teamWorld(script?: Script) {
  const chat = script ? new MockChatLlm(script) : undefined;
  const p = shellWorld({ admin: { llm: chat ?? new OffLlm() } });
  seedSales(p.w.hq, { instructionsDir, salesBudgetUsd: 0 });
  seedBackoffice(p.w.hq, { backofficeBudgetUsd: 0 }, () => 'Инструкция');
  const team = (p.admin as any).team as { chat: { idle(): Promise<void> }; standup: { run(at?: number): Promise<any> }; presence: { invalidate(): void } };
  return { ...p, chat, team };
}
const sys = (r: LlmChatRequest) => (typeof r.system === 'string' ? r.system : r.system.map((b) => b.text).join('\n'));
const lastToolResult = (llm: MockChatLlm, i: number) => JSON.parse((llm.chats[i]!.messages.at(-1)!.content as any[])[0].content);
const PII = /Иван|Петров|\+?992|example\.com|@ivan/u;

describe('team: packs and tool scopes', () => {
  it('every team member but Head of Marketing has a team pack; every pack tool is a known tool', () => {
    const ids = teamPackIds();
    expect(ids.sort()).toEqual(TEAM_IDS.filter((x) => x !== 'marketing-head').sort());
    for (const id of ids) {
      const s = teamSpec(id);
      expect(s.audience).toBe('owner');
      for (const t of s.role.tools) expect(TEAM_KNOWN_TOOLS).toContain(t);
    }
  });

  it('sales cannot read the finance tool; support cannot create a quote; reads stay with their roles', () => {
    expect(teamToolNames('sales-head')).not.toContain('money');
    expect(teamToolNames('presales')).not.toContain('money');
    expect(teamToolNames('support-head')).not.toContain('propose_quote');
    expect(teamToolNames('customer-support')).not.toContain('propose_quote');
    expect(teamToolNames('finance')).toContain('money');
    expect(teamToolNames('support-head')).toContain('tickets');
    expect(teamToolNames('sales-head')).toEqual(expect.arrayContaining(['leads', 'clients', 'quotes', 'propose_quote', 'schedule_call', 'client_note']));
    expect(teamToolNames('production-head')).toContain('projects');
    expect(teamToolNames('knowledge')).toContain('knowledge_search');
    expect(teamToolNames('content-maker')).toEqual(expect.arrayContaining(['content_feed', 'create_order']));
    // nobody publishes, pays or signs from the chat: no such tool exists for any role
    for (const id of teamPackIds()) for (const t of teamToolNames(id)) expect(t).not.toMatch(/publish|^pay|_pay|signature|contract|price_set/);
  });

  it('the registry holds only the role\'s tools; runTool refuses the rest', async () => {
    const p = teamWorld();
    const deps = { hq: p.w.hq, links: shellLinks(), assign: () => ({ ok: false as const, status: 404, error: 'x' }) };
    const sales = teamTools('sales-head', deps, { text: '', turn: new TeamTurn() });
    expect(Object.keys(sales)).not.toContain('money');
    expect(Object.keys(sales)).toContain('leads');
    const support = teamTools('support-head', deps, { text: '', turn: new TeamTurn() });
    expect(Object.keys(support)).not.toContain('propose_quote');
    const ctx = { companyId: 'firtech', agentId: 'x', conversationId: 'c', mode: 'live', lang: 'ru', now: () => 0, knowledge: null as any, outcome: { used: [], unknown: false } } as ToolCtx;
    expect(await runTool(sales, teamSpec('sales-head').role.tools, 'money', {}, ctx)).toMatchObject({ ok: false, error: 'not_allowed' });
  });
});

describe('team: presence derivation', () => {
  it('off > working (task, chat, model) > waiting > idle; the phrase says the kind and a number', () => {
    const task = (meta: Record<string, unknown>, over: Partial<{ title: string; routineId: number | null }> = {}) => ({ id: 41, title: over.title ?? 'КП для Иван Петров +992 900 11 22 33', meta, routineId: over.routineId ?? null });
    expect(derivePresence({ paused: true, running: task({ action: 'kp' }), thinking: true, chatPending: true, waitingTaskId: 3 })).toEqual({ presence: 'off' });
    expect(derivePresence({ paused: false, running: task({ action: 'kp', leadId: 12 }), thinking: false, chatPending: false, waitingTaskId: null })).toEqual({ presence: 'working', now: 'пишу КП по заявке #12' });
    expect(derivePresence({ paused: false, running: null, thinking: false, chatPending: true, waitingTaskId: 3 })).toEqual({ presence: 'working', now: 'отвечаю владельцу в чате' });
    expect(derivePresence({ paused: false, running: null, thinking: true, chatPending: false, waitingTaskId: null }).presence).toBe('working');
    expect(derivePresence({ paused: false, running: null, thinking: false, chatPending: false, waitingTaskId: 3 })).toEqual({ presence: 'waiting', now: 'жду одобрения по задаче #3' });
    expect(derivePresence({ paused: false, running: null, thinking: false, chatPending: false, waitingTaskId: null })).toEqual({ presence: 'idle' });
    // no client data: the title of client work never shows; a routine title with a domain falls back to the number
    expect(nowPhrase(task({ action: 'ticket', ticketId: 7 }))).toBe('отвечаю на тикет #7');
    expect(nowPhrase(task({}))).toBe('работаю над задачей #41');
    expect(nowPhrase(task({}, { title: 'Аудит example.com', routineId: 2 }))).toBe('работаю над задачей #41');
    expect(nowPhrase(task({}, { title: 'Недельный отчёт маркетинга', routineId: 2 }))).toBe('Недельный отчёт маркетинга');
    expect(nowPhrase(task({ action: TEAM_ASSIGN }))).toBe('выполняю поручение #41');
  });
});

describe('team: routes', () => {
  it('401 without the token on every route', async () => {
    const p = teamWorld();
    const s = await serve(p);
    for (const [m, path, body] of [
      ['GET', '/admin/team'], ['GET', '/admin/team/finance'], ['GET', '/admin/team/finance/chat'], ['POST', '/admin/team/finance/chat', { text: 'привет' }],
      ['POST', '/admin/team/finance/assign', { text: 'посчитай расходы' }], ['GET', '/admin/team/standup'], ['POST', '/admin/team/standup/reply', { agent: 'finance', text: 'ок' }],
    ] as const) expect((await s.http(m, path, body, {})).status).toBe(401);
    expect((await s.http('GET', '/admin/team')).status).toBe(200);
    await s.close();
  });

  it('GET /admin/team: the members in order with presence, queue, budget and kpi; no client data in now; cached 10 s', async () => {
    const p = teamWorld();
    const { hq } = p.w;
    const kp = hq.createTask({ title: 'КП для Иван Петров +992 900 11 22 33 example.com', dept: 'sales', assigneeId: 'presales', creator: 'head', meta: { action: 'kp', leadId: 12 } });
    hq.claim(kp.id, 'presales');
    const rev = hq.createTask({ title: 'Отчёт месяца', dept: 'support', assigneeId: 'finance', creator: 'head' });
    hq.claim(rev.id, 'finance');
    hq.complete(rev.id, 'finance', 'готово', 'review');
    hq.createTask({ title: 'Счёт клиенту', dept: 'support', assigneeId: 'billing', creator: 'head' });
    hq.setDeptStatus('backoffice', 'paused');
    const r = await p.call('GET', '/admin/team');
    expect(r.status).toBe(200);
    const ids = r.json.members.map((m: any) => m.id);
    expect(ids).toEqual(TEAM_IDS.filter((id) => hq.agent(id)));
    const by = Object.fromEntries(r.json.members.map((m: any) => [m.id, m]));
    expect(by.presales).toMatchObject({ title: 'Presales', dept: 'sales', presence: 'working', now: 'пишу КП по заявке #12' });
    expect(by.finance).toMatchObject({ presence: 'waiting', now: `жду одобрения по задаче #${rev.id}` });
    expect(by.billing).toMatchObject({ presence: 'idle', queue: 1 });
    expect(by['backoffice-head'].presence).toBe('off');
    expect(by.finance.lastResultAt).toBeTruthy();
    expect(by.finance.kpi).toEqual({ answers7d: 1, approvals7d: 0, rating7d: null });
    expect(Object.keys(by.presales).sort()).toEqual(['budget', 'dept', 'id', 'kpi', 'now', 'presence', 'queue', 'title']);
    expect(by.presales.budget).toEqual({ usedUsd: 0, limitUsd: 0 });
    expect(JSON.stringify(r.json.members.map((m: any) => m.now ?? ''))).not.toMatch(PII);
    // cache: a new running task shows after 10 s
    hq.complete(kp.id, 'presales', 'КП готово');
    expect((await p.call('GET', '/admin/team')).json.members.find((m: any) => m.id === 'presales').presence).toBe('working');
    p.w.clock.t += 10_001;
    expect((await p.call('GET', '/admin/team')).json.members.find((m: any) => m.id === 'presales').presence).toBe('idle');
  });

  it('GET /admin/team/:id: member, recent results, instructions; unknown and non-team ids 404; bad method 405', async () => {
    const p = teamWorld();
    const { hq } = p.w;
    const t = hq.createTask({ title: 'Сверка расходов', dept: 'support', assigneeId: 'finance', creator: 'head' });
    hq.claim(t.id, 'finance');
    hq.complete(t.id, 'finance', 'сверено');
    const r = await p.call('GET', '/admin/team/finance');
    expect(r.status).toBe(200);
    expect(r.json.member).toMatchObject({ id: 'finance', title: 'Finance' });
    expect(r.json.recent[0]).toMatchObject({ kind: 'task', title: 'Сверка расходов', href: `/admin/tasks?focus=${t.id}` });
    expect(Object.keys(r.json.instructions).sort()).toEqual(['updatedAt', 'version']);
    expect((await p.call('GET', '/admin/team/nobody')).status).toBe(404);
    expect((await p.call('GET', '/admin/team/referral')).status).toBe(404);
    expect((await p.call('DELETE', '/admin/team/finance')).status).toBe(405);
    expect((await p.call('GET', '/admin/team/finance/nope')).status).toBe(404);
  });

  it('chat with the model off: an honest answer from the data; the thread keeps both lines; bad query and body 400', async () => {
    const p = teamWorld();
    expect((await p.call('GET', '/admin/team/finance/chat')).json).toEqual({ ok: true, items: [], pending: [] });
    expect((await p.call('GET', '/admin/team/finance/chat?limit=x')).status).toBe(400);
    expect((await p.call('GET', '/admin/team/finance/chat?before=-1')).status).toBe(400);
    expect((await p.call('POST', '/admin/team/finance/chat', { text: '' })).status).toBe(400);
    expect((await p.call('POST', '/admin/team/finance/chat', { text: 'x', extra: 1 })).status).toBe(400);
    const r = await p.call('POST', '/admin/team/finance/chat', { text: 'Что у тебя в работе?' });
    expect(r.status).toBe(200);
    expect(r.json.reply.text).toMatch(/^Модель сейчас недоступна, отвечаю по данным\. Моих задач в работе: 0/);
    expect(r.json.actions).toEqual([{ type: 'none' }]);
    const g = await p.call('GET', '/admin/team/finance/chat');
    expect(g.json.items.map((i: any) => i.role)).toEqual(['owner', 'agent']);
    expect(g.json.items[1].id).toBe(r.json.reply.id);
    // threads are per agent
    expect((await p.call('GET', '/admin/team/billing/chat')).json.items).toEqual([]);
    // audit of the chat message
    expect(p.w.hq.activity(20).some((a) => a.action === 'team_chat' && a.objectId === 'finance')).toBe(true);
  });

  it('Head of Marketing: the team route reads and writes the marketing thread (role agent)', async () => {
    const p = teamWorld();
    const r = await p.call('POST', '/admin/team/marketing-head/chat', { text: 'Покажи правила' });
    expect(r.status).toBe(200);
    const g = await p.call('GET', '/admin/team/marketing-head/chat');
    expect(g.json.items.map((i: any) => i.role)).toEqual(['owner', 'agent']);
    expect((await p.call('GET', '/admin/marketing/chat')).json.items).toHaveLength(2);
  });
});

describe('team: model tools by role', () => {
  it('sales-head asking for money gets not_allowed; support-head cannot start a КП (nothing is created)', async () => {
    const p = teamWorld((req, n) => {
      const s = sys(req);
      if (n === 1 && s.includes('Head of Sales')) return { tools: [{ name: 'money', input: {} }] };
      if (n === 3 && s.includes('Head of Support')) return { tools: [{ name: 'propose_quote', input: { leadId: 1 } }] };
      return { text: 'Не могу.' };
    });
    p.lead('Иван');
    await p.call('POST', '/admin/team/sales-head/chat', { text: 'Сколько денег пришло?' });
    expect(lastToolResult(p.chat!, 1)).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(p.chat!.chats[0]!.tools!.map((t) => t.name)).not.toContain('money');
    await p.call('POST', '/admin/team/support-head/chat', { text: 'Сделай КП по заявке 1' });
    expect(lastToolResult(p.chat!, 3)).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(p.w.hq.tasks({ dept: 'sales', limit: 50 }).filter((t) => t.meta.action === 'kp')).toHaveLength(0);
  });

  it('propose_quote (sales-head): the Sales kp task (Presales then Approvals), task and lead cards, audit; a second ask reuses it', async () => {
    const p = teamWorld((_req, n) => (n % 2 === 1 ? { tools: [{ name: 'propose_quote', input: { leadId: 1, note: 'акцент на запись' } }] } : { text: 'Запустила КП.' }));
    const l = p.lead('Иван');
    const r = await p.call('POST', '/admin/team/sales-head/chat', { text: 'Сделай КП по заявке 1' });
    const kp = p.w.hq.tasks({ dept: 'sales', limit: 50 }).filter((t) => t.meta.action === 'kp');
    expect(kp).toHaveLength(1);
    expect(kp[0]!.meta).toMatchObject({ action: 'kp', leadId: l.id, via: 'team-chat', note: 'акцент на запись' });
    expect(r.json.actions).toEqual([{ type: 'quote_proposed', ref: String(kp[0]!.id) }]);
    expect(r.json.reply.cards.map((c: any) => c.kind)).toEqual(['task', 'lead']);
    expect(p.w.hq.activity(30).some((a) => a.agentId === 'sales-head' && a.action === 'team_propose_quote' && a.detail === 'chat')).toBe(true);
    await p.call('POST', '/admin/team/sales-head/chat', { text: 'И ещё раз' });
    expect(p.w.hq.tasks({ dept: 'sales', limit: 50 }).filter((t) => t.meta.action === 'kp')).toHaveLength(1);
  });

  it('draft_reply (support-head): a Support ticket task (Customer Support drafts into Approvals); client_note appends to the card', async () => {
    const p = teamWorld((_req, n) => (n === 1 ? { tools: [{ name: 'draft_reply', input: { ticketId: 1, note: 'вежливо' } }, { name: 'client_note', input: { kind: 'ticket', id: 1, text: 'просит перенос' } }] } : { text: 'Готовлю ответ.' }));
    const tk = p.cs.addTicket({ clientName: 'Иван', text: 'Сайт не открывается', money: false });
    const r = await p.call('POST', '/admin/team/support-head/chat', { text: 'Ответь на тикет 1' });
    const t = p.w.hq.tasks({ dept: 'support', limit: 50 }).find((x) => x.meta.action === 'ticket');
    expect(t!.meta).toMatchObject({ ticketId: tk.id, via: 'team-chat' });
    expect(String(t!.meta.args)).toContain('Пожелание владельца к ответу: вежливо');
    expect(r.json.actions.map((a: any) => a.type)).toEqual(['reply_drafted', 'note_added']);
    const note = p.w.hq.db.prepare("SELECT note FROM crm_notes WHERE kind = 'ticket' AND ref_id = ?").get(tk.id) as { note: string };
    expect(note.note).toMatch(/\[\d{4}-\d{2}-\d{2} support-head\] просит перенос/);
  });

  it('202 past the budget: the answer lands in GET when ready', async () => {
    const p = teamWorld();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const slow: LlmClient = new MockChatLlm(async () => { await gate; return { text: 'Готово, посчитала.' }; });
    const chat = createTeamChat({ hq: p.w.hq, links: shellLinks(), llm: slow, budgetMs: 5 });
    const r = await chat.post('finance', { text: 'Посчитай расходы' });
    expect(r.status).toBe(202);
    const pendingId = r.body.pending as number;
    expect(chat.get('finance', new URLSearchParams()).body.pending).toEqual([pendingId]);
    expect(chat.pendingAgents().has('finance')).toBe(true);
    release();
    await chat.idle();
    const items = chat.get('finance', new URLSearchParams()).body.items as any[];
    expect(items.at(-1)).toMatchObject({ id: pendingId, role: 'agent', text: 'Готово, посчитала.' });
  });
});

describe('team: assign and mentions', () => {
  it('POST assign: a task for the agent linked to the chat, the agent answers in its chat, the task ends with the answer; heads leave it alone', async () => {
    const p = teamWorld();
    expect((await p.call('POST', '/admin/team/presales/assign', { text: 'x' })).status).toBe(400);
    expect((await p.call('POST', '/admin/team/presales/assign', { text: 'Проверь КП', dueAt: 'never' })).status).toBe(400);
    expect((await p.call('POST', '/admin/team/nobody/assign', { text: 'Проверь КП' })).status).toBe(404);
    const r = await p.call('POST', '/admin/team/presales/assign', { text: 'Проверь КП по заявке 3', dueAt: '2026-12-01T10:00:00+05:00', refs: [{ kind: 'lead', id: 3 }] });
    expect(r.status).toBe(200);
    const id = r.json.task.id;
    expect(r.json.task).toEqual({ id, href: `/admin/tasks?focus=${id}` });
    await p.team.chat.idle();
    const t = p.w.hq.task(id)!;
    expect(t).toMatchObject({ assigneeId: 'presales', dept: 'sales', creator: 'owner', status: 'done' });
    expect(t.meta).toMatchObject({ action: TEAM_ASSIGN, source: { kind: 'chat', agent: null }, refs: [{ kind: 'lead', id: 3 }] });
    expect(t.dueAt).toBe(Date.parse('2026-12-01T10:00:00+05:00'));
    expect(t.result).toMatch(/^Модель сейчас недоступна/);
    const g = await p.call('GET', '/admin/team/presales/chat');
    expect(g.json.items.map((i: any) => [i.role, i.text.slice(0, 12)])).toEqual([['owner', `Поручение #${id}`.slice(0, 12)], ['agent', 'Модель сейча']]);
    expect(p.w.hq.activity(30).some((a) => a.action === 'team_assign' && a.objectId === String(id) && a.detail === 'to:presales')).toBe(true);
  });

  it('an assignment left assigned by a restart is not taken by the head', async () => {
    const p = teamWorld();
    const t = p.w.hq.createTask({ title: 'Поручение: x', dept: 'sales', assigneeId: 'sales-head', creator: 'owner', meta: { action: TEAM_ASSIGN, source: { kind: 'chat', agent: null } } });
    const sales = new (await import('../src/heads/sales.js')).SalesHead({ hq: p.w.hq, llm: new OffLlm(), queue: p.w.queue, messenger: p.w.channel!, ownerId: 1, reporter: p.w.reporter } as any);
    await sales.onHeartbeat();
    expect(p.w.hq.task(t.id)!.status).toBe('assigned');
  });

  it('the agent\'s answer to an assignment can act with its own tools (propose_quote) and the result is in Tasks', async () => {
    const p = teamWorld((req, n) => (n === 1 ? { tools: [{ name: 'propose_quote', input: { leadId: 1 } }] } : { text: `КП запущено. ${sys(req).includes('Presales') ? '' : ''}`.trim() }));
    p.lead('Иван');
    const r = await p.call('POST', '/admin/team/presales/assign', { text: 'Сделай КП по заявке 1' });
    await p.team.chat.idle();
    expect(p.w.hq.task(r.json.task.id)).toMatchObject({ status: 'done', result: 'КП запущено.' });
    expect(p.w.hq.tasks({ dept: 'sales', limit: 50 }).some((t) => t.meta.action === 'kp' && t.meta.leadId === 1)).toBe(true);
  });

  it('@mentions: by id and by title, self ignored, at most three, the rest of the text is the task', () => {
    const known = [...TEAM_IDS];
    expect(parseMentions('@presales подготовь КП по заявке 3', known, 'sales-head')).toEqual({ ids: ['presales'], rest: 'подготовь КП по заявке 3' });
    expect(parseMentions('@Head of Support, проверь тикеты', known, 'finance')).toEqual({ ids: ['support-head'], rest: 'проверь тикеты' });
    expect(parseMentions('@finance сам себе', known, 'finance').ids).toEqual([]);
    expect(parseMentions('@seo @analyst @publisher @deployer глянуть', known, null).ids).toEqual(['seo', 'analyst', 'publisher']);
    expect(parseMentions('пишите на ivan@presales.ru', known, null).ids).toEqual([]);
    expect(parseMentions('@presales-x нет такого', known, null).ids).toEqual([]);
  });

  it('a mention in any chat creates the assignment to that agent; the reply carries its card and action', async () => {
    const p = teamWorld();
    const r = await p.call('POST', '/admin/team/sales-head/chat', { text: '@presales подготовь КП по заявке 3' });
    const assigned = p.w.hq.tasks({ assigneeId: 'presales', limit: 10 }).find((t) => t.meta.action === TEAM_ASSIGN)!;
    expect(assigned.meta).toMatchObject({ source: { kind: 'chat', agent: 'sales-head' } });
    expect(assigned.body).toBe('подготовь КП по заявке 3');
    expect(r.json.actions).toEqual([{ type: 'task_assigned', ref: String(assigned.id) }]);
    expect(r.json.reply.cards[0]).toMatchObject({ kind: 'task', id: String(assigned.id), meta: { agent: 'presales' } });
    await p.team.chat.idle();
    expect((await p.call('GET', '/admin/team/presales/chat')).json.items[0].text).toBe(`Поручение #${assigned.id} (из чата Head of Sales): подготовь КП по заявке 3`);
    // by title, from the marketing thread too
    await p.call('POST', '/admin/team/marketing-head/chat', { text: '@Head of Support проверь, что с тикетами' });
    expect(p.w.hq.tasks({ assigneeId: 'support-head', limit: 10 }).some((t) => t.meta.action === TEAM_ASSIGN)).toBe(true);
    await p.team.chat.idle();
  });
});

describe('team: stand-up', () => {
  it('the routine builds lines by code, posts one inbox item (kind standup), GET returns it; no client data; once a day', async () => {
    const p = teamWorld();
    const { hq } = p.w;
    const done = hq.createTask({ title: 'Ответ Иван Петров +992 900 11 22 33', dept: 'support', assigneeId: 'customer-support', creator: 'head', meta: { action: 'ticket', ticketId: 5 } });
    hq.claim(done.id, 'customer-support');
    hq.complete(done.id, 'customer-support', 'ответ готов');
    const wait = hq.createTask({ title: 'КП Иван', dept: 'sales', assigneeId: 'presales', creator: 'head', meta: { action: 'kp', leadId: 4 } });
    hq.claim(wait.id, 'presales');
    hq.complete(wait.id, 'presales', 'черновик', 'review');
    const blocked = hq.createTask({ title: 'Счёт Иван', dept: 'support', assigneeId: 'billing', creator: 'head' });
    hq.claim(blocked.id, 'billing');
    hq.block(blocked.id, 'billing', 'нет реквизитов');
    const before = (await p.call('GET', '/admin/team/standup')).json;
    expect(before.postedToInboxAt).toBeUndefined();
    const v = await p.team.standup.run();
    expect(v.postedToInboxAt).toBeTruthy();
    const by = Object.fromEntries(v.entries.map((e: any) => [e.agent, e]));
    expect(by['customer-support'].did[0]).toBe(`закрыл 1 задачу (#${done.id})`);
    expect(by.presales.need[0]).toBe(`ваше решение по #${wait.id}`);
    expect(by.billing.need[0]).toBe(`заблокировано 1 (#${blocked.id})`);
    expect(by['sales-head'].plan.length).toBeGreaterThan(0);
    const inbox = p.w.channel!.list({ limit: 50 }).filter((i) => i.kind === 'standup');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.text).toMatch(/^Планёрка \d{2}\.\d{2}/);
    expect(inbox[0]!.text).not.toMatch(PII);
    expect(JSON.stringify(v.entries)).not.toMatch(PII);
    const g = await p.call('GET', '/admin/team/standup');
    expect(g.json).toMatchObject({ ok: true, date: v.date, postedToInboxAt: v.postedToInboxAt });
    expect(g.json.entries[0]).toEqual(expect.objectContaining({ agent: expect.any(String), did: expect.any(Array), plan: expect.any(Array), need: expect.any(Array) }));
    await p.team.standup.run();
    expect(p.w.channel!.list({ limit: 50 }).filter((i) => i.kind === 'standup')).toHaveLength(1);
    expect((await p.call('GET', '/admin/team/standup?date=bad')).status).toBe(400);
    expect((await p.call('GET', '/admin/team/standup?date=2020-01-01')).status).toBe(404);
    // the hub shows the stand-up as an info line
    expect((await p.call('GET', '/admin/hub')).json.inbox.some((i: any) => i.id.startsWith('inbox:') && i.title.startsWith('Планёрка'))).toBe(true);
  });

  it('with a model: one phrase per agent in its voice (`say`), from the code lines only', async () => {
    const p = teamWorld(() => ({ text: '{"director":"Слежу за всеми отделами, срочного нет."}' }));
    const v = await p.team.standup.run();
    expect(v.entries.find((e: any) => e.agent === 'director').say).toBe('Слежу за всеми отделами, срочного нет.');
    const req = p.chat!.calls[0]!;
    expect(req.messages[0]!.content).not.toMatch(PII);
  });

  it('reply: the owner\'s answer goes into that agent\'s chat; bad body 400, unknown agent 404', async () => {
    const p = teamWorld();
    const r = await p.call('POST', '/admin/team/standup/reply', { agent: 'finance', text: 'Посчитай итоги недели' });
    expect(r.status).toBe(200);
    expect(r.json.reply.text).toMatch(/^Модель сейчас недоступна/);
    const g = await p.call('GET', '/admin/team/finance/chat');
    expect(g.json.items[0]).toMatchObject({ role: 'owner', text: 'Ответ на планёрку: Посчитай итоги недели' });
    expect((await p.call('POST', '/admin/team/standup/reply', { agent: 'finance' })).status).toBe(400);
    expect((await p.call('POST', '/admin/team/standup/reply', { agent: 'nobody', text: 'x' })).status).toBe(404);
  });
});

describe('team: office and hub', () => {
  it('GET /admin/hub and GET /admin/office carry presence and now per agent (for the hover line)', async () => {
    const p = teamWorld();
    const t = p.w.hq.createTask({ title: 'Тикет Иван Петров', dept: 'support', assigneeId: 'customer-support', creator: 'head', meta: { action: 'ticket', ticketId: 9 } });
    p.w.hq.claim(t.id, 'customer-support');
    const hub = await p.call('GET', '/admin/hub');
    expect(hub.json.team['customer-support']).toEqual({ presence: 'working', now: 'отвечаю на тикет #9' });
    expect(hub.json.team.finance).toEqual({ presence: 'idle' });
    const office = await p.call('GET', '/admin/office');
    expect(office.json.team['customer-support'].now).toBe('отвечаю на тикет #9');
    expect(JSON.stringify(office.json.team)).not.toMatch(PII);
  });
});
