import { describe, expect, it } from 'vitest';
import { leadStoreFor, nextSlots } from '@fir/worker-lead-intake';
import { DAY, GOOD, json, NOW, OWNER, routedLlm, salesWorld } from './sales-helpers.js';

const J = JSON.stringify;
const lead = (over: Record<string, unknown> = {}) => ({ name: 'Dilnoza', contact: '@dilnoza', service: 'bots', message: 'Нужен бот для салона, срочно', locale: 'ru', ...over });
const cycle = (w: ReturnType<typeof salesWorld>) => w.sales.onHeartbeat();

describe('seed', () => {
  it('creates the head, four workers and the daily routines; the head uses SALES_BOT_TOKEN', () => {
    const w = salesWorld({ budget: 5 });
    expect(w.hq.agent('sales-head')).toMatchObject({ dept: 'sales', role: 'head', bot: 'SALES_BOT_TOKEN', budgetUsdMonth: 5, bossId: 'director' });
    expect(w.hq.agents('sales').map((a) => a.id).sort()).toEqual(['lead-intake', 'presales', 'prospector', 'referral', 'sales-head']);
    expect(w.hq.routineByName('sales-daily-cards')).toMatchObject({ cron: '0 10 * * *', dept: 'sales' });
    expect(w.hq.routineByName('sales-followups')).toMatchObject({ cron: '5 10 * * *' });
    expect(w.hq.agent('sales-head')!.instructions).toContain('Чек-лист проверки ответа лиду');
  });
});

describe('lead from the webhook', () => {
  it('task -> worker -> review -> reply at level 1 goes to the owner at once; report and a hot-lead alert', async () => {
    const w = salesWorld({ groupTopics: true });
    const id = w.sales.createLeadTask(lead(), 'bots');
    expect(w.hq.pendingHeartbeats()).toBe(1);
    await cycle(w);
    const t = w.hq.task(id)!;
    expect(t.status).toBe('done');
    expect(t.result).toContain('Контакт: @dilnoza');
    expect(t.assigneeId).toBe('sales-head');
    // level 1: the approved reply was handed to the owner with the contact, no batch needed
    const msg = w.messenger.sent.find((m) => m.text.includes('ответ утверждён'))!;
    expect(msg.chatId).toBe(OWNER);
    expect(msg.text).toContain('@dilnoza');
    expect(msg.text).toContain('1)');
    // the report: topic and journal, without the contact
    const inSales = w.posted.filter((p) => p.threadId === 8);
    expect(inSales).toHaveLength(1);
    expect(inSales[0]).toMatchObject({ chatId: -1001 });
    expect(inSales[0]!.text).not.toContain('@dilnoza');
    expect(w.hq.reports(0)[0]!.dept).toBe('sales');
    expect(w.alerts[0]).toContain('Горячий лид #1');
    expect(w.alerts[0]).not.toContain('@dilnoza');
    expect(w.hq.costSummary(0)[0]!.dept).toBe('sales');
  });

  it('at REPLY_LEVEL 0 the reply waits in the Director batch and the trust counter applies', async () => {
    const w = salesWorld({ replyLevel: 0 });
    const id = w.sales.createLeadTask(lead({ message: 'Хочу сайт' }), 'web');
    await cycle(w);
    expect(w.hq.task(id)!.status).toBe('approval');
    expect(w.messenger.sent).toHaveLength(0); // the head never writes to the owner first
    expect(await w.director.sendApprovalBatch(false)).toBe(1);
    const card = w.messenger.sent.find((m) => m.buttons)!;
    expect(card.text).toContain('lead_reply');
    expect(card.buttons![0]!.map((b) => b.text)).toEqual(['Одобрить', 'Править', 'Отклонить']);
    const approval = w.queue.pending()[0]!;
    await w.decide('approve', approval.id);
    expect(w.hq.task(id)!.status).toBe('done');
    expect(w.queue.streak('lead_reply')).toBe(1);
    expect(w.messenger.last()!.text).toContain('ответ утверждён');
  });

  it('a price question: the reply goes now, the price is a locked proposal that cannot go out with a placeholder', async () => {
    const w = salesWorld();
    const id = w.sales.createLeadTask(lead({ message: 'Сколько стоит бот для салона?' }), 'bots');
    await cycle(w);
    expect(w.hq.task(id)!.status).toBe('approval'); // price proposal still open
    expect(w.queue.trustTable().find((r) => r.kind === 'lead_price')).toMatchObject({ locked: true, level: 0 });
    await w.director.sendApprovalBatch(false);
    const price = w.queue.pending()[0]!;
    expect(price.kind).toBe('lead_price');
    const before = w.messenger.sent.length;
    await w.decide('approve', price.id); // still has [цена]
    expect(w.messenger.sent.slice(before).some((m) => m.text.includes('ответ утверждён'))).toBe(false);
    expect(w.hq.task(id)!.status).toBe('blocked');
  });

  it('the filled price goes through after the owner edits it', async () => {
    const w = salesWorld();
    const id = w.sales.createLeadTask(lead({ message: 'Сколько стоит бот?' }), 'bots');
    await cycle(w);
    await w.director.sendApprovalBatch(false);
    const price = w.queue.pending()[0]!;
    await w.decide('edit', price.id);
    await w.queue.submitEdit(OWNER, 'Бот для салона: от $300, срок 2 недели.');
    await w.decide('approve', price.id);
    expect(w.hq.task(id)!.status).toBe('done');
    expect(leadStoreFor({ db: w.db, now: w.hq.now }).get(1)!.priceApproved).toBe(true);
    expect(w.messenger.last()!.text).toContain('от $300');
  });

  it('review: one rework with the feedback, then on; the lead stays one row', async () => {
    const w = salesWorld({ llm: routedLlm({ review: (_t, n) => (n === 1 ? J({ ok: false, issues: ['слишком длинно'] }) : '{"ok":true,"issues":[]}') }) });
    const id = w.sales.createLeadTask(lead(), 'bots');
    await cycle(w);
    expect(w.hq.task(id)!.meta.feedback).toBe('слишком длинно');
    expect(w.hq.events(id).some((e) => e.body.includes('Ревью, замечания'))).toBe(true);
    expect(w.hq.task(id)!.status).toBe('done');
    expect(leadStoreFor({ db: w.db, now: w.hq.now }).count()).toBe(1);
  });

  it('a task without a valid lead blocks and alerts', async () => {
    const w = salesWorld();
    const t = w.hq.createTask({ title: 'Лид', dept: 'sales', creator: 'routine', meta: { action: 'lead', lead: { name: '' } } });
    w.hq.wake('sales-head', 'task');
    await cycle(w);
    expect(w.hq.task(t.id)!.status).toBe('blocked');
    expect(w.alerts[0]).toContain(`#${t.id}`);
  });
});

describe('Scout: daily cards', () => {
  it('routine -> one task and one approval per card; the batch gives each card four buttons; routine is not held up', async () => {
    const w = salesWorld({ llm: routedLlm({ scout: () => json(GOOD) }), groupTopics: true, batchSize: 3 });
    const t = w.hq.runRoutine('sales-daily-cards')!;
    await cycle(w);
    expect(w.hq.task(t.id)).toMatchObject({ status: 'done' });
    const kids = w.hq.tasks({ parentId: t.id });
    expect(kids).toHaveLength(3);
    expect(kids.every((k) => k.status === 'approval' && k.assigneeId === 'prospector')).toBe(true);
    expect(w.messenger.sent).toHaveLength(0);
    expect(w.hq.queuedApprovals()).toHaveLength(3);
    expect(w.posted[0]!.text).toContain('Новых карточек 3');
    // the routine can fire again although the cards are not decided yet
    expect(w.hq.runRoutine('sales-daily-cards')).not.toBeNull();

    expect(await w.director.sendApprovalBatch(false)).toBe(3);
    const cards = w.messenger.sent.filter((m) => m.buttons);
    expect(cards).toHaveLength(3);
    expect(cards[0]!.text).toContain('[1/3] sales');
    expect(cards[0]!.text).toContain('#3 Cambridge');
    expect(cards[0]!.text).toContain(GOOD);
    expect(cards[0]!.buttons!.flat().map((b) => b.text)).toEqual(['Скопировать', 'Править', 'Пропустить', 'Отправлено']);
  });

  it('Copy sends the plain text; Sent marks sent with a date; Skip skips; Edit changes the text that counts as sent', async () => {
    const w = salesWorld({ llm: routedLlm({ scout: () => json(GOOD) }), batchSize: 3 });
    w.hq.runRoutine('sales-daily-cards');
    await cycle(w);
    await w.director.sendApprovalBatch(false);
    const [a, b, c] = w.queue.pending();
    expect(await w.sales.onCopy(a!.id)).toBe('Текст ниже');
    expect(w.messenger.last()).toEqual({ chatId: OWNER, text: GOOD });
    await w.decide('approve', a!.id);
    expect(w.store.get(3)).toMatchObject({ status: 'sent', sentAt: NOW, sentText: GOOD, draft: null });
    expect(w.hq.tasks({ status: 'done', dept: 'sales' }).some((t) => t.title.includes('Cambridge'))).toBe(true);
    expect(await w.sales.onCopy(a!.id)).toBe('Уже обработано');
    await w.decide('reject', b!.id);
    expect(w.store.get(5)!.status).toBe('skipped');
    await w.decide('edit', c!.id);
    await w.queue.submitEdit(OWNER, 'Мой текст от $250. Идёт?');
    expect(w.messenger.last()!.buttons!.flat().map((x) => x.text)).toContain('Отправлено'); // the card comes back with the same buttons
    await w.decide('approve', c!.id);
    expect(w.store.get(2)).toMatchObject({ status: 'sent', sentText: 'Мой текст от $250. Идёт?' });
    // never promoted by the counter: «Отправлено» only records what the owner sent himself
    expect(w.queue.trustTable().find((r) => r.kind === 'prospect_first')).toMatchObject({ locked: true, level: 0 });
  });

  it('LLM off: template drafts still come', async () => {
    const w = salesWorld({ llm: routedLlm(), batchSize: 2 });
    w.hq.runRoutine('sales-daily-cards');
    await cycle(w);
    expect(w.store.get(3)!.draft).toContain('от $250');
    expect(w.hq.queuedApprovals()).toHaveLength(2);
  });

  it('an empty base reports it instead of failing', async () => {
    const w = salesWorld({ csv: false });
    const t = w.hq.runRoutine('sales-daily-cards')!;
    await cycle(w);
    expect(w.hq.task(t.id)!.status).toBe('done');
    expect(w.hq.task(t.id)!.result).toContain('База пуста');
  });
});

describe('Scout: follow-ups', () => {
  it('after 3 days a follow-up card comes; after 10 days without answer the prospect is closed', async () => {
    const w = salesWorld({ batchSize: 1 });
    w.hq.runRoutine('sales-daily-cards');
    await cycle(w);
    await w.director.sendApprovalBatch(false);
    await w.decide('approve', w.queue.pending()[0]!.id);
    expect(w.store.get(3)!.status).toBe('sent');

    w.clock.t = NOW + 3 * DAY;
    const t = w.hq.runRoutine('sales-followups')!;
    await cycle(w);
    expect(w.hq.task(t.id)!.status).toBe('done');
    expect(w.hq.queuedApprovals()).toHaveLength(1);
    expect(w.hq.queuedApprovals()[0]!.kind).toBe('prospect_followup');
    expect(w.store.get(3)!.followups).toBe(1);

    w.clock.t = NOW + 7 * DAY;
    w.hq.runRoutine('sales-followups');
    await cycle(w);
    expect(w.store.get(3)!.followups).toBe(2);

    w.clock.t = NOW + 10 * DAY;
    w.hq.runRoutine('sales-followups');
    await cycle(w);
    expect(w.store.get(3)!.status).toBe('no_reply');
  });
});

describe('/reply <id> through the Director', () => {
  async function sent3() {
    const w = salesWorld({ llm: routedLlm({ scout: (req) => json(req.system.includes('ответил') ? 'Спасибо! Стоимость: [цена]. Удобно в 11:00 или в 15:00?' : GOOD) }), batchSize: 1 });
    w.hq.runRoutine('sales-daily-cards');
    await cycle(w);
    await w.director.sendApprovalBatch(false);
    await w.decide('approve', w.queue.pending()[0]!.id);
    w.messenger.sent.length = 0;
    return w;
  }

  it('/reply 3, then the forwarded text: a reply task, a locked card with [цена] that cannot be marked sent', async () => {
    const w = await sent3();
    await w.director.onCommand('reply', '3');
    expect(w.store.get(3)!.status).toBe('replied');
    expect(w.messenger.last()!.text).toMatch(/Перешлите текст ответа/);
    await w.director.onText('Сколько стоит?');
    expect(w.messenger.last()!.text).toMatch(/Готовлю черновик/);
    await cycle(w);
    expect(w.hq.queuedApprovals()[0]!.kind).toBe('prospect_reply');
    await w.director.sendApprovalBatch(false);
    const card = w.messenger.sent.find((m) => m.buttons)!;
    expect(card.text).toContain('Ответ на реплику #3');
    expect(card.text).toContain('[цена]');
    expect(card.buttons!.flat().map((b) => b.text)).toEqual(['Скопировать', 'Править', 'Пропустить', 'Отправлено']);
    const ap = w.queue.pending()[0]!;
    await w.decide('approve', ap.id);
    expect(w.messenger.last()!.text).toMatch(/не выполнено/);
    expect(w.store.get(3)!.status).toBe('replied');
    expect(w.queue.level('prospect_reply')).toBe(0);
  });

  it('the intent sales_reply with the text in one message', async () => {
    const llm = routedLlm({ intent: () => J({ type: 'sales_reply', id: 3, text: 'Покажите пример' }), scout: () => json('Спасибо! Покажу на ваших данных. Удобно в 11:00 или в 15:00?') });
    const w = salesWorld({ llm, batchSize: 1 });
    w.hq.runRoutine('sales-daily-cards');
    await cycle(w);
    await w.director.sendApprovalBatch(false);
    await w.decide('approve', w.queue.pending()[0]!.id);
    await w.director.onText('Cambridge ответили: покажите пример');
    expect(w.store.get(3)!.status).toBe('replied');
    const t = w.hq.tasks({ dept: 'sales', status: 'inbox' })[0]!;
    expect(t.meta).toMatchObject({ action: 'reply', prospectId: 3, replyText: 'Покажите пример' });
    await cycle(w);
    expect(w.hq.queuedApprovals()[0]!.kind).toBe('prospect_reply');
  });

  it('refuses before the first message was sent, for an unknown id, and /skip cancels the wait', async () => {
    const w = salesWorld();
    await w.director.onCommand('reply', '1');
    expect(w.messenger.last()!.text).toMatch(/только после «Отправлено»/);
    await w.director.onCommand('reply', '999');
    expect(w.messenger.last()!.text).toMatch(/Не нашёл/);
    await w.director.onCommand('reply', 'abc');
    expect(w.messenger.last()!.text).toMatch(/Формат/);
    const x = await sent3();
    await x.director.onCommand('reply', '3');
    await x.director.onCommand('skip');
    expect(await x.sales.consume('просто текст')).toBe(false);
  });
});

describe('free-text tasks and limits', () => {
  it('the owner can ask for the funnel; unknown tasks are blocked with a report', async () => {
    const w = salesWorld({ llm: routedLlm({ split: (t) => (t.includes('воронк') ? '{"action":"stats"}' : '{"action":"none"}') }) });
    const a = w.hq.createTask({ title: 'Покажи воронку Разведчика', dept: 'sales', creator: 'owner' });
    const b = w.hq.createTask({ title: 'Сделай логотип', dept: 'sales', creator: 'owner' });
    w.hq.wake('sales-head', 'task');
    await cycle(w);
    expect(w.hq.task(a.id)!.result).toContain('Воронка, всего 5');
    expect(w.hq.task(b.id)!.status).toBe('blocked');
    expect(w.hq.reports(0).some((r) => r.body.includes('не для продаж'))).toBe(true);
  });

  it('the department limit blocks work; a paused department does nothing', async () => {
    const w = salesWorld({ budget: 1 });
    w.hq.recordCost({ taskId: null, agentId: 'sales-head', model: 'x', inputTokens: 1, outputTokens: 1, usd: 2 });
    const id = w.sales.createLeadTask(lead(), 'bots');
    await cycle(w);
    expect(w.hq.task(id)!.status).toBe('blocked');
    const w2 = salesWorld();
    w2.hq.setDeptStatus('sales', 'paused');
    const id2 = w2.sales.createLeadTask(lead(), 'bots');
    await cycle(w2);
    expect(w2.hq.task(id2)!.status).toBe('inbox');
  });

  it('with no group and no bot the reports stay in the journal only', async () => {
    const w = salesWorld();
    w.sales.createLeadTask(lead(), 'bots');
    await cycle(w);
    expect(w.posted).toHaveLength(0);
    expect(w.hq.reports(0).length).toBeGreaterThan(0);
    expect(nextSlots(NOW, 'Asia/Tashkent', ['11:00', '15:00'])).toHaveLength(2);
  });
});
