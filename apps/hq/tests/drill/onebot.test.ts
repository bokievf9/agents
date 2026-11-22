/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXEC_TOOL_DEFS } from '@fir/fira';
import { actionRequest, isTrivial } from '../../src/assistant.js';
import { CABINET_LEAD, LEAD, seedEverything } from './seed.js';
import { OWNER, TOKENS, drillWorld, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

/**
 * The contract of 2026-11-22 (пункт 13 ревью владельца): one HQ bot in Telegram. It only reminds (new client, lead, approval, payment, stage,
 * signature, call, the reminder alerts, the summaries) in one or two lines with a link, and answers any question from the data of HQ; nothing is
 * decided or done in Telegram, approval cards never go there, decisions are the review API.
 */
const g = useGuard();
const CONTACTS = ['@dilnoza_k', 'anvar.k@example.com', '+992', '@roza_salon', '@zarina', 'Нужен бот для записи'];
const ctx = { companyId: 'firtech', agentId: 'firtech/executive-assistant', conversationId: 't', mode: 'live' as const, lang: 'ru', now: () => 0, knowledge: null as any, outcome: { used: [], unknown: false } };

describe('the one HQ bot over the whole office', () => {
  let w: DrillWorld;
  let tgBefore: number;
  beforeAll(async () => {
    w = await drillWorld({ flow: true });
    for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
    await w.notices.scan(); // the first scan only marks the empty office
    tgBefore = w.tg.sent.length;
    await seedEverything(w);
    await w.http('POST', '/admin/clients', { email: CABINET_LEAD.clientEmail, name: 'Anvar K', supabaseId: 'sb-1' }, { 'x-admin-token': TOKENS.admin });
    await w.http('POST', '/lead', CABINET_LEAD, { 'x-lead-token': TOKENS.lead });
    for (let i = 0; i < 3; i++) await w.beat();
    await w.notices.scan();
  }, 90_000);
  afterAll(async () => { await w?.close(); });

  it('no approval card and no Director message reached Telegram: only reminders, each one or two lines with a link, without contacts and client texts', () => {
    const out = w.tg.sent.slice(tgBefore);
    expect(out.length).toBeGreaterThan(0);
    for (const m of out) {
      expect(m.buttons ?? [], m.text).toEqual([]);
      expect(m.text.split('\n').length, m.text).toBeLessThanOrEqual(2);
      expect(m.text, m.text).toMatch(/https:\/\/firtech\.pro\/admin/);
      for (const c of CONTACTS) expect(m.text, `${c} in «${m.text}»`).not.toContain(c);
    }
    // the cards are in the review list and in the inbox of the Пульт
    expect(w.queue.pending().length + w.hq.queuedApprovals().length).toBeGreaterThan(5);
    expect(w.channel.list({ limit: 200 }).some((m) => m.kind === 'approval')).toBe(true);
    const kinds = out.map((m) => m.text.split(':')[0]);
    // the first scan of the day found several of a kind at once: one group line each (names may be there, contacts never)
    expect(kinds).toEqual(expect.arrayContaining(['Новый клиент в кабинете', 'Новые заявки', 'На одобрение']));
    expect(out.find((m) => m.text.startsWith('Новые заявки'))!.text).toContain('«Dilnoza Karimova»');
  });

  it('within 5 minutes the same kind waits; after them one line, a group when there are several', async () => {
    const n = w.tg.sent.length;
    await w.notices.scan();
    expect(w.tg.sent.length).toBe(n); // nothing new, nothing again
    for (const name of ['Malika', 'Rustam']) await w.http('POST', '/lead', { ...LEAD, name, contact: `@${name.toLowerCase()}_x` }, { 'x-lead-token': TOKENS.lead });
    for (let i = 0; i < 3; i++) await w.beat();
    w.clock.t += 60_000;
    await w.notices.scan();
    expect(w.tg.sent.slice(n).filter((m) => /заявк/.test(m.text))).toEqual([]);
    w.clock.t += 5 * 60_000;
    await w.notices.scan();
    const group = w.tg.sent.slice(n).map((m) => m.text).filter((t) => /заявк/.test(t));
    expect(group).toHaveLength(1);
    expect(group[0]).toMatch(/^Новые заявки: 2 \(#\d+ «Malika»; #\d+ «Rustam»\)\./);
    expect(group[0]).not.toMatch(/@malika|@rustam/);
  });

  it('a decision through the review API sends nothing to Telegram; a paid stage is a reminder at once, with stage and sum', async () => {
    const item = ((await w.adm('GET', '/admin/review?status=all&limit=200')).json.items as any[]).find((i) => i.kind === 'lead_reply' && i.status === 'pending');
    expect(item).toBeDefined();
    const n = w.tg.sent.length;
    const r = await w.adm('POST', `/admin/review/${item.id}`, { action: 'reject' });
    expect(r.status).toBe(200);
    expect(w.tg.sent.length).toBe(n);
    w.db.prepare("INSERT INTO bl_invoices (number, year, seq, client, amount_usd, due_date, status, created_at, paid_at, stage_no) VALUES ('FT-2026-901', 2026, 901, 'Anvar K', 87, '2026-11-30', 'paid', ?, ?, 1)").run(w.clock.t, w.clock.t);
    await w.notices.scan();
    expect(w.tg.sent.at(-1)!.text).toMatch(/^Оплата пришла: Anvar K, этап 1, \$87 \(счёт FT-2026-901\)\./);
    expect(g.errors()).toEqual([]);
  });

  it('every tool of the assistant reads the real stores, carries a link and never a contact or a client text', async () => {
    const tools = (w.assistant as any).tools as Record<string, { run: (i: Record<string, unknown>, c: typeof ctx) => Promise<any> }>;
    expect(Object.keys(tools).sort()).toEqual([...Object.keys(EXEC_TOOL_DEFS), 'price_list'].sort());
    const inputs: Record<string, Record<string, unknown>[]> = {
      leads: [{}, { period: 'today' }, { period: 'month', query: 'Dilnoza' }, { id: 1 }, { id: 99999 }], projects: [{}, { query: 'Dilnoza' }, { id: 1 }], clients: [{}, { query: 'anvar' }],
      money: [{}, { period: 'month' }], llm_costs: [{}, { period: 'today' }], tasks: [{}, { dept: 'sales' }, { dept: 'nope' }], director_history: [{ limit: 5 }], shell_link: [{ screen: 'review', id: 3 }, { screen: 'bogus' }],
    };
    for (const [name, t] of Object.entries(tools)) {
      for (const input of inputs[name] ?? [{}]) {
        const r = await t.run(input, ctx);
        const json = JSON.stringify(r);
        if (name === 'tasks' && input.dept === 'nope') { expect(r.ok).toBe(false); continue; }
        expect(r.ok, `${name} ${json.slice(0, 200)}`).toBe(true);
        if (name !== 'price_list' && name !== 'shell_link') expect(json, name).toContain('https://firtech.pro/admin');
        for (const c of CONTACTS) expect(json, `${name} leaks ${c}`).not.toContain(c);
      }
    }
    const overview = (await tools.hq_overview!.run({}, ctx)).value;
    expect(overview.today.leads).toBeGreaterThanOrEqual(2);
    expect(overview.approvalsWaiting).toBeGreaterThan(0);
    const lead = (await tools.leads!.run({ id: 1 }, ctx)).value.lead;
    expect(lead).toMatchObject({ id: 1, name: 'Dilnoza Karimova', link: 'https://firtech.pro/admin/clients?tab=pipeline&focus=1' });
    expect((await tools.shell_link!.run({ screen: 'review', id: 3 }, ctx)).value.url).toBe('https://firtech.pro/admin/approvals?id=ap_3');
  });

  it('a question in the bot: the model calls a tool, the answer goes to Telegram, the spend is in costs, the exchange in the history and the memory', async () => {
    w.assistantScript.next = (req, n) => {
      if (n === 0) return { tools: [{ name: 'approvals_queue' }] };
      const result = JSON.stringify(req.messages.at(-1)!.content);
      const waiting = /\\"waiting\\":(\d+)/.exec(result)?.[1];
      return { text: `Ждут одобрения ${waiting}. https://firtech.pro/admin/approvals` };
    };
    const costs = () => (w.db.prepare("SELECT COUNT(*) c FROM costs WHERE agent_id = 'director'").get() as { c: number }).c;
    const before = costs();
    const n = w.tg.sent.length;
    await w.say('что висит?');
    await w.settle();
    const answer = w.tg.sent.slice(n);
    expect(answer).toHaveLength(1);
    expect(answer[0]!.text).toMatch(/^Ждут одобрения \d+\. https:\/\/firtech\.pro\/admin\/approvals$/);
    expect(costs()).toBe(before + 2); // two model calls: the tool round and the answer
    const hist = (await w.adm('GET', '/admin/director/history?limit=5')).json.items as { role: string; text: string }[];
    expect(hist.slice(-2).map((h) => h.role)).toEqual(['owner', 'hq']);
    expect(hist.at(-2)!.text).toBe('что висит?');
    expect(w.assistant.memory.all().slice(-2).map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(w.chatCalls.at(-1)!.tier).toBe('sonnet');
    w.assistantScript.next = null;
  });

  it('the memory keeps the last 10 questions and answers and sends them to the model; a count question goes to Haiku', async () => {
    for (let i = 0; i < 12; i++) await w.assistant.answer(`вопрос ${i}`);
    const kept = w.assistant.memory.all();
    expect(kept).toHaveLength(20);
    expect(kept[0]!.text).toBe('вопрос 2');
    const calls = w.chatCalls.length;
    await w.assistant.answer('Сколько заявок сегодня?');
    const first = w.chatCalls[calls]!;
    expect(first.tier).toBe('haiku');
    expect(first.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').length).toBe(11); // 10 kept questions and this one
  });

  it('no logs of the texts: the owner\'s questions and the answers stay out of every log line', () => {
    expect(g.leaks(['что висит?', 'вопрос 11', 'Ждут одобрения'])).toEqual([]);
  });
});

describe('what counts as a request to act, and as a trivial question', () => {
  it.each([
    ['Одобри КП для Шифо', 'review'], ['пожалуйста, отклони счёт', 'review'], ['Ответь Лоле, что всё готово', 'chats'], ['напиши клиенту про макет', 'chats'],
    ['отметь оплату FT-2026-014', 'money'], ['выставь счёт за второй этап', 'money'], ['прими этап 2 у Лолы', 'projects'], ['создай задачу маркетингу', 'tasks'], ['сделай пост про ИИ', 'tasks'],
    ['можешь поставить сводку на 9:30', 'settings'],
  ])('«%s» goes to %s', (text, screen) => {
    expect(actionRequest(text)?.screen).toBe(screen);
  });
  it.each(['что висит?', 'Сколько заявок сегодня?', 'как дела у проекта Лолы', 'кто ждёт ответа', 'Статус', 'одобрения'])('«%s» is a question', (text) => {
    expect(actionRequest(text)).toBeNull();
  });
  it('trivial: short «сколько» questions only', () => {
    expect(isTrivial('Сколько заявок сегодня?')).toBe(true);
    expect(isTrivial('сколько потратили на LLM и почему так много в маркетинге, разбери по отделам и по дням')).toBe(false);
    expect(isTrivial('что висит?')).toBe(false);
  });
});

describe('the one HQ bot without a model', () => {
  it('LLM off or down: the question gets the main numbers said by code; the memory keeps that answer, not a hand-off phrase', async () => {
    const w = await drillWorld({ withServer: false, gatewayDown: true });
    await w.http('POST', '/lead', LEAD, { 'x-lead-token': TOKENS.lead }).catch(() => undefined);
    const reply = await w.assistant.answer('что нового?');
    expect(reply).toMatch(/^Модель сейчас недоступна, коротко по данным: заявок сегодня \d+, новых клиентов \d+, ждёт одобрения \d+, застряло задач \d+\. Shell: https:\/\/firtech\.pro\/admin\/inbox$/);
    expect(w.assistant.memory.all().at(-1)!.text).toBe(reply);
    expect(w.tg.to(OWNER)).toEqual([]); // answer() itself sends nothing; the glue does
    await w.close();
  });
});
