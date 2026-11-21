/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { afterEach, describe, expect, it } from 'vitest';
import { ClarifyStore, CLARIFY_WAIT_MS } from '../../src/clarify.js';
import { TOKENS, drillWorld, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

/**
 * ИИ-менеджер заявок 2.0, part 3 (2026-11-22): a cabinet lead with gaps is asked at most three questions BEFORE the КП, in its thread and by email, as a `lead_reply`
 * item of level 1 the owner sees in the review center; the client's messages feed the КП; after 24 hours without an answer the КП is made with the assumptions listed.
 */
useGuard();
let w: DrillWorld;
afterEach(async () => { await w?.close(); });

const GAPPED = { name: 'Rustam Gap', contact: '@rustam_gap', service: 'unknown', budget: '', message: 'Хочу что-то для бизнеса', locale: 'ru', source: 'form', clientEmail: 'rustam.gap@example.com', cabinetId: 'sb-gap', clientName: 'Рустам' };
const CLEAR = { name: 'Anvar Clear', contact: '@anvar_clear', service: 'bots', budget: '$300-500', message: 'Нужен бот для записи клиентов в барбершоп, они пишут в Instagram', locale: 'ru', source: 'miniapp', clientEmail: 'anvar.clear@example.com', cabinetId: 'sb-clear', clientName: 'Анвар' };

const post = async (body: object) => {
  const r = await w.http('POST', '/lead', body, { 'x-lead-token': TOKENS.lead });
  return (await r.json()) as { leadId: number };
};
const cabinet = async (email: string) => (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(email)}`)).json;
const items = async (kind: string) => ((await w.adm('GET', '/admin/review?status=all&limit=200')).json.items as any[]).filter((i) => i.kind === kind);
const kpTasks = (leadId: number) => w.hq.tasks({ dept: 'sales', limit: 500 }).filter((t) => t.meta.action === 'kp' && t.meta.leadId === leadId);

describe('clarifying questions before the КП', () => {
  it('a lead with gaps: three questions to the thread and the email, a level-1 lead_reply for the owner, no КП yet', async () => {
    w = await drillWorld({ flow: true });
    const { leadId } = await post(GAPPED);
    await w.beat();
    await w.beat();

    // the questions: at most three, in the order scope, niche, goal (the channel did not fit)
    const cab = await cabinet(GAPPED.clientEmail);
    const asked = (cab.leads[0].replies as any[]).find((r) => /Чтобы подготовить предложение точнее/.test(r.text));
    expect(asked, 'the questions are in the lead thread').toBeDefined();
    expect(asked.text).toMatch(/1\. Что именно вам нужно/);
    expect(asked.text).toMatch(/2\. Чем занимается ваш бизнес/);
    expect(asked.text).toMatch(/3\. Какую задачу/);
    expect(asked.text).not.toMatch(/4\./);
    expect(asked.text).toMatch(/через сутки подготовим предложение с допущениями/);
    // the email carries the same questions
    const mail = w.emails.find((e) => /Несколько вопросов по вашей заявке/.test(e.subject));
    expect(mail).toMatchObject({ to: GAPPED.clientEmail });
    expect(mail!.text).toContain('1. Что именно вам нужно');

    // the owner sees them in the review center as a lead_reply of level 1 that needed no approval
    const rows = (await items('lead_reply')).filter((i) => i.meta.clarify);
    expect(rows).toHaveLength(1);
    expect(rows[0].meta.clarify.questions).toHaveLength(3);
    expect(rows[0].meta.lead.id).toBe(leadId);
    expect(rows[0].status).not.toBe('pending');
    expect(w.queue.pending().some((r) => r.kind === 'lead_reply' && r.payload.clarify === true)).toBe(false);

    // the КП waits
    expect(kpTasks(leadId)).toHaveLength(0);
    expect(await items('presales_pack')).toHaveLength(0);
    const store = new ClarifyStore(w.db, w.hq.now);
    expect(store.byLead(leadId)).toMatchObject({ status: 'asked', gaps: ['scope', 'niche', 'goal', 'channel'] });
    expect(store.count()).toEqual({ asked: 1, answered: 0, assumed: 0 });

    // one round per lead: more heartbeats ask nothing again
    await w.beat();
    expect((await items('lead_reply')).filter((i) => i.meta.clarify)).toHaveLength(1);
    expect(w.emails.filter((e) => /Несколько вопросов/.test(e.subject))).toHaveLength(1);
  });

  it('the client answers in the thread: the answers go into the lead and the КП is made from them', async () => {
    w = await drillWorld({ flow: true });
    const { leadId } = await post(GAPPED);
    await w.beat();
    const cid = (await cabinet(GAPPED.clientEmail)).client.id as number;
    await w.beat();
    expect(kpTasks(leadId)).toHaveLength(0);
    w.clock.t += 60_000;
    const reply = await w.adm('POST', `/admin/clients/${cid}/leads/${leadId}/messages`, { text: 'У меня барбершоп в Душанбе. Нужен бот для записи, клиенты пишут в Instagram и теряются вечером.' });
    expect(reply.status).toBe(200);
    await w.beat();
    await w.beat();
    const store = new ClarifyStore(w.db, w.hq.now);
    expect(store.byLead(leadId)).toMatchObject({ status: 'answered' });
    expect(store.byLead(leadId)!.answers).toMatch(/барбершоп в Душанбе/);
    const lead = w.db.prepare('SELECT task, niche FROM li_leads WHERE id = ?').get(leadId) as { task: string; niche: string };
    expect(lead.task).toMatch(/Уточнения клиента: У меня барбершоп в Душанбе/);
    expect(lead.niche).toMatch(/салон красоты \/ барбершоп/);
    expect(kpTasks(leadId)).toHaveLength(1);
    expect(kpTasks(leadId)[0]!.meta).toMatchObject({ clarified: 'answers', auto: true });
    // the pack reached the owner, built from the lead with the answers
    const pack = (await items('presales_pack'))[0];
    expect(pack, 'the КП card').toBeDefined();
    expect(pack.text.body).not.toMatch(/Допущения/);
  });

  it('no answer for 24 hours: the КП is proposed with the assumptions listed in the КП and the estimate', async () => {
    w = await drillWorld({ flow: true });
    const { leadId } = await post(GAPPED);
    await w.beat();
    await w.beat();
    w.clock.t += CLARIFY_WAIT_MS - 60_000;
    await w.beat();
    expect(kpTasks(leadId)).toHaveLength(0);
    w.clock.t += 120_000;
    await w.beat();
    await w.beat();
    const store = new ClarifyStore(w.db, w.hq.now);
    expect(store.byLead(leadId)).toMatchObject({ status: 'assumed' });
    expect(kpTasks(leadId)[0]!.meta).toMatchObject({ clarified: 'assumptions' });
    expect((kpTasks(leadId)[0]!.meta.assumptions as string[]).length).toBe(3);
    const pack = (await items('presales_pack'))[0];
    expect(pack).toBeDefined();
    const docs = pack.text.documents as { key: string; body: string }[];
    for (const key of ['kp', 'estimate']) expect(docs.find((d) => d.key === key)!.body, key).toMatch(/Допущения \(клиент не ответил на уточняющие вопросы/);
    expect(docs.find((d) => d.key === 'kp')!.body).toMatch(/- ниша: типовой малый бизнес в сфере услуг/);
    expect(docs.find((d) => d.key === 'contract')!.body).not.toMatch(/Допущения/);
    // the owner is told in the sales topic
    expect(w.posted.some((p) => p.dept === 'sales' && /не ответил на вопросы за 24 часа/.test(p.text))).toBe(true);
  });

  it('a lead whose service and goal are clear is not held back: no questions, the КП as before', async () => {
    w = await drillWorld({ flow: true });
    const { leadId } = await post(CLEAR);
    await w.beat();
    await w.beat();
    expect(new ClarifyStore(w.db, w.hq.now).byLead(leadId)).toBeUndefined();
    expect(kpTasks(leadId)).toHaveLength(1);
    expect(w.emails.filter((e) => /Несколько вопросов/.test(e.subject))).toEqual([]);
  });

  it('a failing email is journaled and the thread still carries the questions', async () => {
    w = await drillWorld({ flow: true });
    w.emailFail.on = true;
    await post(GAPPED);
    await w.beat();
    await w.beat();
    const cab = await cabinet(GAPPED.clientEmail);
    expect((cab.leads[0].replies as any[]).some((r) => /Чтобы подготовить предложение точнее/.test(r.text))).toBe(true);
    expect(w.emails).toEqual([]);
    const j = w.db.prepare("SELECT detail FROM activity WHERE action = 'clarify_sent'").all() as { detail: string }[];
    expect(j.length).toBe(1);
    expect(j[0]!.detail).toMatch(/email_failed/);
  });
});

describe('lead enrichment on the cards', () => {
  it('every lead of the CRM and of a review item carries the summary, the product family, the niche, the intent score and the builder link', async () => {
    w = await drillWorld({ flow: true });
    const link = '/ru/builder?b=k.barber~p.adminbot~g.booking';
    const { leadId } = await post({ ...CLEAR, estimate: `Пакет: Бот-администратор\nНиша: барбершоп\nСборка: https://firtech.pro${link}\nИтого: $300` });
    await w.beat();
    const crm = (await w.adm('GET', '/admin/crm/leads')).json;
    const row = (crm.items as any[]).find((l) => l.id === leadId);
    expect(row.enrichment).toMatchObject({ builderLink: link, intentScore: expect.any(Number) });
    expect(row.enrichment.summary.length).toBeGreaterThan(0);
    expect(row.enrichment.summary.length).toBeLessThanOrEqual(3);
    expect(row.enrichment.productFamily).toBe('bot');
    const reply = (await items('lead_reply'))[0];
    expect(reply.meta.lead.enrichment).toMatchObject({ builderLink: link });
    // the card text of the approval carries the same lines
    const card = (w.db.prepare("SELECT summary FROM task_approvals WHERE kind = 'lead_reply' ORDER BY id").get() as { summary: string }).summary;
    expect(card).toMatch(/Намерение: \d+\/100/);
    expect(card).toContain(`Сборка, которую предложил приёмщик: ${link}`);
  });

  it('a lead from the chat brings its own enrichment: the three lines, the family, the niche, the score, the link of the conversation', async () => {
    w = await drillWorld({ flow: true });
    const enrichment = { summary: ['Бизнес: салон красоты; задача: вечерние заявки.', 'Подходит: ИИ-администратор; каналы: instagram; срок: не назван.', 'Предложено: сборку по ссылке; контакт оставил; вопросов в диалоге: 2.'], productFamily: 'admin', niche: 'салон красоты', intentScore: 71, builderLink: '/ru/builder?b=k.salon~p.adminbot' };
    const task = w.sales.createLeadTask({ name: 'Посетитель веб-чата', contact: '@chat_lead', service: 'bots', product: 'ИИ-администратор', budget: '', message: 'Задача (словами клиента): вечерние заявки', estimate: '', locale: 'ru', slot: '', source: 'web', enrichment }, 'bots');
    await w.beat();
    const lead = w.db.prepare('SELECT id FROM li_leads WHERE task_id = ?').get(task) as { id: number };
    const row = ((await w.adm('GET', '/admin/crm/leads')).json.items as any[]).find((l) => l.id === lead.id);
    expect(row.enrichment).toEqual(enrichment);
    const item = (await items('lead_reply')).find((i) => i.meta.lead.id === lead.id);
    expect(item.meta.lead.enrichment).toEqual(enrichment);
    const card = (w.db.prepare("SELECT summary FROM task_approvals WHERE kind = 'lead_reply' ORDER BY id DESC").get() as { summary: string }).summary;
    expect(card).toMatch(/Разговор:\n\s+Бизнес: салон красоты/);
    expect(card).toContain('Семейство продукта: admin');
    expect(card).toContain('Намерение: 71/100');
  });
});
