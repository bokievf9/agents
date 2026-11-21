import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalQueue, MemoryMessenger, MockLlm, openDb, type Button, type LlmClient } from '@fir/core';
import { Hq, type Worker } from '@fir/hq';
import { ProspectorWorker } from '@fir/worker-prospector';
import { describe, expect, it } from 'vitest';
import { ClientEngine, type ClientSinks, type ClientTransport, type From } from '../src/client/engine.js';
import { gatewayGate } from '../src/client/shared.js';
import { RateLimiter } from '../src/client/sanitize.js';
import { WebChatEngine, type ChatRequest } from '../src/client/web.js';
import { SalesHead, seedSales } from '../src/heads/sales.js';
import { guardedLead, LostLeads, STALE_LEAD_MS } from '../src/lost-leads.js';
import { seedOrg } from '../src/org.js';
import { Reporter } from '../src/reporter.js';
import { createWebhook } from '../src/webhook.js';
import { instructionsDir, NOW, OWNER, routedLlm } from './sales-helpers.js';

/**
 * A lead, a chat message or an audit request that was ACCEPTED (the visitor got a normal answer) but fails before the owner sees it is never silent:
 * an `activity` row of kind `lost_lead`, the contact kept, and ONE summary alert an hour. And when the model gateway is down the visitor gets the
 * scripted «принял, менеджер ответит в рабочее время», never an error, and the request is still recorded.
 */
const HOUR = 3_600_000;
const LEAD = { name: 'Dilnoza', contact: '@dilnoza', service: 'bots', budget: '', message: 'Нужен бот для салона', locale: 'ru' };
const down: LlmClient = { enabled: true, complete: () => Promise.reject(new Error('503 gateway down')) };
const hanging: LlmClient = { enabled: true, complete: () => new Promise<string>(() => undefined) };

function core(llm: LlmClient = routedLlm()) {
  const clock = { t: NOW };
  const db = openDb(':memory:');
  const messenger = new MemoryMessenger();
  const hq = new Hq(db, { now: () => clock.t });
  const queue = new ApprovalQueue(db, messenger, OWNER, 20, () => clock.t);
  hq.attachQueue(queue);
  seedOrg(hq, { instructionsDir, marketingBudgetUsd: 0 });
  seedSales(hq, { instructionsDir, salesBudgetUsd: 0 });
  const reporter = new Reporter(undefined, {}, new Map());
  const lost = new LostLeads(hq);
  const alerts: string[] = [];
  hq.onAlert((t) => void alerts.push(t));
  const sales = (leads?: Worker) => new SalesHead({ hq, llm, queue, messenger, ownerId: OWNER, reporter, prospector: new ProspectorWorker(), lost, ...(leads ? { leads } : {}) });
  const lostRows = () => hq.activity(200).filter((a) => a.action === 'lost_lead');
  return { clock, db, messenger, hq, queue, reporter, lost, alerts, sales, lostRows };
}

describe('the lead path: accepted with HTTP 200, then failing before the owner sees it', () => {
  const crashing: Worker = { id: 'lead-intake', run: () => Promise.reject(new Error('boom: модель вернула мусор')) };

  async function post(url: string, body: unknown) {
    const r = await fetch(`${url}/lead`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lead-token': 'tok' }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as { ok: boolean; id?: number } };
  }

  it('POST /lead answers 200, the head fails: a lost_lead row with the reason, the contact kept, ONE hourly alert with the count', async () => {
    const w = core();
    const sales = w.sales(crashing);
    const server = createWebhook(guardedLead(w.lost, (l) => sales.createLeadTask({ ...l }, l.service)), 'tok');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const a = await post(url, LEAD);
      expect(a).toMatchObject({ status: 200, json: { ok: true } }); // the visitor was told «ok»
      await sales.onHeartbeat();
      expect(w.hq.task(a.json.id!)!.status).toBe('blocked');
      const rows = w.lostRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'lost_lead', objectType: 'lead' });
      expect(rows[0]!.detail).toContain('boom');
      expect(JSON.stringify(rows)).not.toContain('Нужен бот для салона'); // reasons only, never the person's words
      expect(w.lost.recent()[0]).toMatchObject({ source: 'lead', contact: '@dilnoza', text: '' });

      // the owner hears about it once an hour, with the count, the reason and the contact
      expect(await w.lost.flush()).toBe(1);
      expect(w.alerts.filter((t) => t.includes('не доставлено'))).toHaveLength(1);
      expect(w.alerts.at(-1)).toMatch(/^1 обращение не доставлено владельцу, причина: форма сайта: /);
      expect(w.alerts.at(-1)).toContain('@dilnoza');
      // a second one in the same hour waits for the next summary
      await post(url, { ...LEAD, name: 'Blanche', contact: '@blanche' });
      await sales.onHeartbeat();
      expect(await w.lost.flush()).toBe(0);
      expect(w.alerts.filter((t) => t.includes('не доставлено'))).toHaveLength(1);
      w.clock.t += HOUR + 1;
      expect(await w.lost.flush()).toBe(1);
      expect(w.alerts.at(-1)).toContain('@blanche');
      expect(await w.lost.flush()).toBe(0); // nothing new
    } finally {
      server.close();
    }
  });

  it('three failures in the hour are one alert: «3 обращения не доставлены», the reasons grouped', async () => {
    const w = core();
    w.lost.record('lead', 'сбой A', { contact: '@a' });
    w.lost.record('lead', 'сбой A', { contact: '@b' });
    w.lost.record('chat', 'сбой B', { contact: 'x@y.uz' });
    expect(await w.lost.flush()).toBe(3);
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0]).toMatch(/^3 обращения не доставлены владельцу, причина: форма сайта: сбой A \(2\); веб-чат: сбой B\./);
    expect(w.alerts[0]).toContain('@a, @b, x@y.uz');
  });

  it('the form gets its error when the task cannot be made, and the contact is still kept', async () => {
    const w = core();
    const server = createWebhook(guardedLead(w.lost, () => { throw new Error('база недоступна'); }), 'tok');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const r = await post(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, LEAD);
      expect(r.status).toBe(500);
      expect(w.lost.recent()[0]).toMatchObject({ source: 'lead', contact: '@dilnoza', text: 'Нужен бот для салона' });
      expect(w.lostRows()[0]!.detail).toContain('база недоступна');
    } finally {
      server.close();
    }
  });

  it('a lead nobody took for 15 minutes (a paused department) is recorded once; a handled one never', async () => {
    const w = core();
    const sales = w.sales();
    const stuck = sales.createLeadTask(LEAD, 'bots');
    w.hq.setDeptStatus('sales', 'paused');
    expect(w.lost.watchStale()).toBe(0); // too early
    w.clock.t += STALE_LEAD_MS + 1;
    expect(w.lost.watchStale()).toBe(1);
    expect(w.lost.watchStale()).toBe(0); // once
    expect(w.hq.task(stuck)!.meta.lostMarked).toBe(true);
    expect(w.lostRows()[0]!.detail).toMatch(/не обработана 15 мин \(статус задачи: (inbox|assigned)\)/);
    w.hq.setDeptStatus('sales', 'active');
    const fine = sales.createLeadTask({ ...LEAD, contact: '@fine' }, 'bots');
    await sales.onHeartbeat();
    expect(w.hq.task(fine)!.status).not.toBe('inbox');
    w.clock.t += 2 * HOUR;
    expect(w.lost.watchStale()).toBe(0);
  });

  it('the safety net never breaks the path it watches', () => {
    const w = core();
    w.db.exec('DROP TABLE lost_leads');
    expect(() => w.lost.record('lead', 'x')).not.toThrow();
  });
});

describe('the morning summary', () => {
  it('counts what did not reach the owner in the last day', () => {
    const w = core();
    expect(w.lost.summaryLine()).toBeNull();
    w.lost.record('lead', 'сбой');
    w.lost.record('chat', 'сбой');
    expect(w.lost.summaryLine()).toContain('Обращений не дошло до вас за сутки: 2');
    w.clock.t += 25 * HOUR;
    expect(w.lost.summaryLine()).toBeNull();
  });
});

describe('the audit path: a request that cannot be prepared', () => {
  it('an audit that fails (the site did not open) is a lost request with the contact', async () => {
    const w = core();
    w.lost.record('audit', 'аудит сайта не подготовлен (сайт не открылся или сбой)', { contact: '@auditor', ref: 'аудит #1' });
    expect(await w.lost.flush()).toBe(1);
    expect(w.alerts[0]).toContain('заявка на аудит: аудит сайта не подготовлен');
    expect(w.alerts[0]).toContain('@auditor');
  });
});

describe('the chat path: the visitor is told «принято», the failure is recorded', () => {
  function chat(llm: LlmClient, o: { sinks?: Partial<ClientSinks>; gatewayDown?: () => boolean; llmTimeoutMs?: number } = {}) {
    const c = core(llm);
    const leads: Record<string, unknown>[] = [];
    const sinks: ClientSinks = {
      createLead: (lead) => (leads.push(lead), leads.length),
      createTicket: () => Promise.resolve(1), findClient: () => null, leadSlots: () => null, ...o.sinks,
    };
    const engine = new WebChatEngine({
      db: c.db, now: () => c.clock.t, tz: () => c.hq.tz, llm, gate: new RateLimiter(1, 300, () => c.clock.t, () => c.hq.tz),
      instructions: readFileSync(join(instructionsDir, 'client-bot.md'), 'utf8'), sinks, conversation: false, onLost: (s, r, i) => c.lost.record(s, r, i),
      ...(o.gatewayDown ? { gatewayDown: o.gatewayDown } : {}), ...(o.llmTimeoutMs ? { llmTimeoutMs: o.llmTimeoutMs } : {}),
    });
    const say = async (message: string, extra: Partial<ChatRequest> = {}) => {
      const out = await engine.handle({ sessionId: 'visitor-0001-abcd', locale: 'ru', message, ...extra }, '1.1.1.1');
      if (out.kind !== 'ok') throw new Error(`the visitor got ${out.kind}`);
      return out.body;
    };
    return { ...c, engine, leads, say };
  }
  const intake = async (w: ReturnType<typeof chat>) => {
    await w.say('/start');
    await w.say('/btn intake');
    await w.say('/btn need:bot');
    await w.say('/btn deadline:urgent');
    await w.say('/btn budget:mid');
    return w.say('@dilnoza_salon');
  };

  it('Sales cannot take the lead: the visitor still sees the normal «заявка принята», the contact and the words are kept, the owner is alerted', async () => {
    const w = chat(routedLlm(), { sinks: { createLead: () => { throw new Error('продажи недоступны'); } } });
    const done = await intake(w);
    expect(done).toMatchObject({ ok: true, state: 'done', leadCreated: true });
    expect(done.reply).toContain('Готово, заявка принята');
    const rows = w.lostRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toContain('заявка не создана: продажи недоступны');
    expect(w.lost.recent()[0]).toMatchObject({ source: 'chat', contact: '@dilnoza_salon' });
    expect(w.lost.recent()[0]!.text).toContain('Нужно: Telegram-бот');
    await w.lost.flush();
    expect(w.alerts[0]).toMatch(/1 обращение не доставлено владельцу, причина: веб-чат: заявка не создана/);
    expect(w.alerts[0]).toContain('@dilnoza_salon');
  });

  it('the chat itself fails on a message: never a 503, the scripted answer goes out and the message is recorded', async () => {
    const w = chat(routedLlm());
    w.engine.store.sweep = () => { throw new Error('база занята'); };
    const r = await w.say('Здравствуйте, нужен бот');
    expect(r.reply).toBe('Принял, менеджер ответит в рабочее время. Оставьте контакт (Telegram @username, телефон или email), и мы напишем вам первыми.');
    expect(w.lostRows()[0]!.detail).toContain('веб-чат не обработал сообщение: база занята');
    expect(w.lost.recent()[0]!.text).toBe('Здравствуйте, нужен бот');
  });
});

describe('the gateway is down: the visitor gets the scripted answer and the request is still recorded', () => {
  function chatWith(llm: LlmClient, o: Parameters<typeof webChat>[1] = {}) {
    return webChat(llm, o);
  }
  function webChat(llm: LlmClient, o: { gatewayDown?: () => boolean; llmTimeoutMs?: number } = {}) {
    const c = core(llm);
    const leads: Record<string, unknown>[] = [];
    const engine = new WebChatEngine({
      db: c.db, now: () => c.clock.t, tz: () => c.hq.tz, llm, gate: new RateLimiter(1, 300, () => c.clock.t, () => c.hq.tz),
      instructions: readFileSync(join(instructionsDir, 'client-bot.md'), 'utf8'),
      sinks: { createLead: (lead) => (leads.push(lead), leads.length), createTicket: () => Promise.resolve(1), findClient: () => null, leadSlots: () => null },
      onLost: (s, r, i) => c.lost.record(s, r, i), ...o,
    });
    const say = async (message: string) => {
      const out = await engine.handle({ sessionId: 'visitor-0001-abcd', locale: 'ru', message }, '1.1.1.1');
      if (out.kind !== 'ok') throw new Error(`the visitor got ${out.kind}`);
      return out.body;
    };
    return { ...c, engine, leads, say };
  }

  it('web chat: a question while the model is down: «Принял, менеджер ответит в рабочее время», then the contact makes the lead with the question', async () => {
    const w = chatWith(down);
    await w.say('/start');
    const r = await w.say('Сколько займёт интеграция с вашей CRM?');
    expect(r.reply).toContain('Принял, менеджер ответит в рабочее время');
    expect(r.state).toBe('contact');
    const done = await w.say('@dilnoza_salon');
    expect(done).toMatchObject({ ok: true, state: 'done', leadCreated: true });
    expect(w.leads).toHaveLength(1);
    expect(String(w.leads[0]!.message)).toContain('интеграция с вашей CRM');
    expect(w.leads[0]).toMatchObject({ contact: '@dilnoza_salon', source: 'web' });
    expect(w.lostRows()).toHaveLength(0); // nothing was lost: the lead exists
  });

  it('web chat in English; a model that never answers is cut at the timeout, not waited for', async () => {
    const w = chatWith(hanging, { llmTimeoutMs: 30 });
    const t0 = Date.now();
    await w.say('/start');
    const r = await w.say('How long does a bot take?');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.reply).toContain('Принял, менеджер ответит');
    const en = webChat(hanging, { llmTimeoutMs: 30 });
    await en.engine.handle({ sessionId: 'visitor-0002-abcd', locale: 'en', message: '/start' }, '1.1.1.1');
    const out = await en.engine.handle({ sessionId: 'visitor-0002-abcd', locale: 'en', message: 'How long does a bot take?' }, '1.1.1.1');
    expect(out.kind === 'ok' && out.body.reply).toContain('a manager will reply during business hours');
  });

  it('a gateway known to be down is not even called; one probe a minute lets the way back open', async () => {
    let calls = 0;
    const llm: LlmClient = { enabled: true, complete: () => (calls++, Promise.reject(new Error('503'))) };
    const clock = { t: 100_000 };
    const gate = gatewayGate(() => true, () => clock.t);
    const w = chatWith(llm, { gatewayDown: gate });
    await w.say('/start');
    expect((await w.say('А вы делаете приложения?')).reply).toContain('Принял, менеджер ответит'); // the probe: let through, it fails
    expect(calls).toBe(1);
    await w.say('Хорошо, жду.'); // the visitor is in the contact step now: no model needed
    await w.say('@dilnoza_salon');
    await w.say('/start');
    await w.say('А ещё сайты делаете?');
    expect(calls).toBe(1); // inside the minute the gateway is not called at all
    clock.t += 60_001;
    await w.say('/start');
    await w.say('И боты?');
    expect(calls).toBe(2); // the next probe
    // and the way back: a gate that sees the gateway up never blocks
    expect(gatewayGate(() => false, () => 0)()).toBe(false);
  });

  describe('the Telegram client bot', () => {
    class Transport implements ClientTransport {
      readonly sent: { chatId: number; html: string; buttons?: Button[][] }[] = [];
      private n = 0;
      send(chatId: number, html: string, buttons?: Button[][]) {
        this.sent.push({ chatId, html, ...(buttons ? { buttons } : {}) });
        return Promise.resolve(++this.n);
      }
      edit() { return Promise.resolve(); }
      clearButtons() { return Promise.resolve(); }
      typing() { return Promise.resolve(); }
      to(chatId: number) { return this.sent.filter((m) => m.chatId === chatId); }
    }
    const ME: From = { chatId: 555_001, username: 'dilnoza_salon', firstName: 'Dilnoza', langCode: 'ru' };

    function bot(llm: LlmClient, o: { createLead?: ClientSinks['createLead']; gatewayDown?: () => boolean } = {}) {
      const c = core(llm);
      const transport = new Transport();
      const leads: Record<string, unknown>[] = [];
      const engine = new ClientEngine({
        db: c.db, now: () => c.clock.t, tz: () => c.hq.tz, transport, llm, ownerId: OWNER, instructions: readFileSync(join(instructionsDir, 'client-bot.md'), 'utf8'),
        sinks: { createLead: o.createLead ?? ((lead) => (leads.push(lead), leads.length)), createTicket: () => Promise.resolve(1), findClient: () => null, leadSlots: () => null },
        onLost: (s, r, i) => c.lost.record(s, r, i), ...(o.gatewayDown ? { gatewayDown: o.gatewayDown } : {}),
      });
      return { ...c, engine, transport, leads };
    }

    it('a question while the model is down: the scripted «Принял», a lead record for the question (once per chat), the owner told; a second question only forwards', async () => {
      const w = bot(down);
      await w.engine.onText(ME, 'Можно ли подключить вашего бота к нашей CRM?');
      const toClient = w.transport.to(ME.chatId).map((m) => m.html);
      expect(toClient.at(-1)).toBe('<b>Принял</b>\nМенеджер ответит в рабочее время. Ответ придёт сюда, в этот чат.');
      expect(toClient.join('\n')).not.toMatch(/ошибк|error|не удалось/i);
      expect(w.leads).toHaveLength(1);
      expect(String(w.leads[0]!.message)).toContain('подключить вашего бота к нашей CRM');
      expect(w.leads[0]).toMatchObject({ chatId: ME.chatId, service: 'other', contact: '@dilnoza_salon' });
      expect(w.transport.to(OWNER).some((m) => m.html.includes('Заявка в клиентском боте'))).toBe(true);
      await w.engine.onText(ME, 'И ещё: сколько это по времени?');
      expect(w.leads).toHaveLength(1); // the chat already has a lead
      expect(w.transport.to(OWNER).at(-1)!.html).toContain('Вопрос без ответа (модель недоступна)');
      expect(w.transport.to(ME.chatId).at(-1)!.html).toContain('Принял');
    });

    it('a gateway known to be down is not called at all; the bot still answers', async () => {
      let calls = 0;
      const llm: LlmClient = { enabled: true, complete: () => (calls++, Promise.resolve('Да.')) };
      const w = bot(llm, { gatewayDown: () => true });
      await w.engine.onText(ME, 'Вы делаете сайты?');
      expect(calls).toBe(0);
      expect(w.transport.to(ME.chatId).at(-1)!.html).toContain('Принял');
    });

    it('Sales cannot take the lead: the client was told «принято», the owner gets the text at once and the failure is recorded with the contact', async () => {
      const w = bot(routedLlm(), { createLead: () => { throw new Error('продажи недоступны'); } });
      await w.engine.onCommand(ME, 'start', '');
      await w.engine.onButton(ME, 'm:discuss', w.engine.store.get(ME.chatId)!.card!);
      await w.engine.onButton(ME, 'n:bot', w.engine.store.get(ME.chatId)!.card!);
      await w.engine.onButton(ME, 'd:urgent', w.engine.store.get(ME.chatId)!.card!);
      await w.engine.onButton(ME, 'b:mid', w.engine.store.get(ME.chatId)!.card!);
      await w.engine.onButton(ME, 'h:none', w.engine.store.get(ME.chatId)!.card!);
      expect(w.lost.recent()[0]).toMatchObject({ source: 'bot', contact: '@dilnoza_salon' });
      expect(w.transport.to(OWNER).some((m) => m.html.includes('Заявка не дошла до продаж'))).toBe(true);
    });
  });

  it('the lead path itself works without the gateway: the Sales head makes the lead record and the reply from templates', async () => {
    const w = core(down);
    const sales = w.sales();
    const id = sales.createLeadTask(LEAD, 'bots');
    await sales.onHeartbeat();
    expect(w.hq.task(id)).toMatchObject({ status: 'done' });
    expect(w.hq.task(id)!.result).toContain('Контакт: @dilnoza');
    expect(w.lostRows()).toHaveLength(0);
  });
});

describe('the model for visitors is metered and bounded', () => {
  it('MockLlm sanity: an answering model works as before (no scripted fallback)', async () => {
    const llm = new MockLlm(() => 'Да, делаем Telegram-ботов для салонов: запись, напоминания и отзывы. Расскажете, как сейчас идёт запись?');
    const c = core(llm);
    const engine = new WebChatEngine({
      db: c.db, now: () => c.clock.t, tz: () => c.hq.tz, llm, gate: new RateLimiter(1, 300, () => c.clock.t, () => c.hq.tz),
      instructions: readFileSync(join(instructionsDir, 'client-bot.md'), 'utf8'), sinks: { createLead: () => 1, createTicket: () => Promise.resolve(1), findClient: () => null, leadSlots: () => null },
    });
    await engine.handle({ sessionId: 'visitor-0009-abcd', locale: 'ru', message: '/start' }, '1.1.1.1');
    const out = await engine.handle({ sessionId: 'visitor-0009-abcd', locale: 'ru', message: 'Делаете ботов для салонов?' }, '1.1.1.1');
    expect(out.kind === 'ok' && out.body.reply).toContain('Telegram-ботов');
  });
});
