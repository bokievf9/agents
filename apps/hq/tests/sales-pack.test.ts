import { describe, expect, it } from 'vitest';
import { leadStoreFor } from '@fir/worker-lead-intake';
import { webLeadSchema } from '../src/webhook.js';
import { DAY, OWNER, routedLlm, salesWorld } from './sales-helpers.js';

const WORDING = {
  context: 'Cambridge: учебный центр в Бишкеке.',
  problem: 'Заявки теряются вечером.',
  solution: 'Бот принимает запись круглосуточно. Стоимость: [цена].',
  scope: ['Диалоги', 'Запись', 'Напоминания', 'Уведомления', 'Админ-панель', 'Запуск'],
};
const world = () => {
  const w = salesWorld({ llm: routedLlm({ scout: (req) => (req.system.includes('Ты пресейл') ? JSON.stringify(WORDING) : 'not json') }) });
  w.director.onSalesCommand = (name, arg) => w.sales.salesCommand(name, arg);
  return w;
};
const cmd = (w: ReturnType<typeof world>, name: string, arg = '') => w.director.onCommand(name, arg);
const lastToOwner = (w: ReturnType<typeof world>) => w.messenger.to(OWNER).at(-1)!;

describe('/kp', () => {
  it('owner text to one approval with three documents, copy button sends them, approve marks them approved', async () => {
    const w = world();
    await cmd(w, 'kp', 'Салон красоты в Алматы хочет сайт с записью');
    expect(lastToOwner(w)).toContain('Готовлю КП');
    await w.sales.onHeartbeat();
    expect(w.hq.tasks({ dept: 'sales' })[0]!.status).toBe('approval');
    expect(await w.director.sendApprovalBatch(false)).toBe(1);
    const card = w.messenger.sent.find((m) => m.text.includes('presales_pack'))!;
    expect(card.text).toContain('presales_pack (уровень 0');
    expect(card.buttons!.flat().map((b) => b.data)).toEqual(['pc:1:c', 'ap:1:r', 'ap:1:a']);
    expect(w.queue.trustTable().find((t) => t.kind === 'presales_pack')).toMatchObject({ locked: true, level: 0 });

    const before = w.messenger.sent.length;
    expect(await w.sales.onCopy(1)).toBe('Документы ниже');
    const docs = w.messenger.sent.slice(before).map((m) => m.text);
    expect(docs).toHaveLength(3);
    expect(docs[0]).toContain('# Коммерческое предложение');
    expect(docs[0]).toContain('от $150');
    expect(docs[1]).toContain('# Смета');
    expect(docs[2]).toContain('Договор оказания услуг');

    await w.decide('approve', 1);
    expect(w.hq.tasks({ dept: 'sales' })[0]!.status).toBe('done');
    expect(await w.sales.onCopy(1)).toBe('Уже обработано');
  });

  it('by lead id: unknown lead is refused at once; a known lead gets the pack with the lead on the card', async () => {
    const w = world();
    await cmd(w, 'kp', '77');
    expect(lastToOwner(w)).toContain('Лид 77 не найден');
    await cmd(w, 'kp', '');
    expect(lastToOwner(w)).toContain('Формат: /kp');
    const id = w.sales.createLeadTask({ name: 'Dilnoza', contact: '@dil', service: 'bots', message: 'Нужен бот для салона', locale: 'ru', source: '' }, 'bots');
    await w.sales.onHeartbeat();
    const lead = leadStoreFor({ db: w.db, now: w.hq.now }).byTask(id)!;
    await cmd(w, 'kp', `#${lead.id}`);
    await w.sales.onHeartbeat();
    await w.director.sendApprovalBatch(false);
    expect(w.queue.pending().some((a) => a.kind === 'presales_pack' && a.summary.includes(`лид #${lead.id} Dilnoza`))).toBe(true);
  });
});

describe('referrals', () => {
  it('/referral then /paid then approval of the reward: proposed, paid, rewarded; no reward before paid', async () => {
    const w = world();
    await cmd(w, 'referral', 'Cambridge');
    expect(lastToOwner(w)).toContain('Формат: /referral');
    await cmd(w, 'referral', 'Cambridge -> Blanche');
    expect(lastToOwner(w)).toContain('#1 Cambridge привёл(а) Blanche');
    expect(lastToOwner(w)).toContain('месяц сопровождения бесплатно');
    await cmd(w, 'referral', 'cambridge -> blanche');
    expect(lastToOwner(w)).toContain('Уже записано');
    await cmd(w, 'referrals');
    expect(lastToOwner(w)).toContain('ждём оплату 1');
    expect(w.queue.pending()).toHaveLength(0);

    await cmd(w, 'paid', '5');
    expect(lastToOwner(w)).toContain('Не нашёл');
    await cmd(w, 'paid', '1');
    expect(lastToOwner(w)).toContain('оплата отмечена');
    await cmd(w, 'paid', '1');
    expect(lastToOwner(w)).toContain('уже ждёт');
    expect(await w.director.sendApprovalBatch(false)).toBe(1);
    const card = w.messenger.sent.find((m) => m.text.includes('referral_reward'))!;
    expect(card.text).toContain('(уровень 0');
    expect(card.text).toContain('Начислить: месяц сопровождения бесплатно');
    await w.decide('approve', 1);
    await cmd(w, 'referrals');
    expect(lastToOwner(w)).toContain('награда применена 1');
    await cmd(w, 'paid', '1');
    expect(lastToOwner(w)).toContain('награда уже применена');
  });

  it('a lead with source ref:<client> becomes a referral once, and is reported', async () => {
    const w = world();
    w.sales.createLeadTask({ name: 'Blanche', contact: '@blanche', service: 'bots', message: 'Нужен бот', locale: 'ru', source: 'ref:cambridge' }, 'bots');
    await w.sales.onHeartbeat();
    await cmd(w, 'referrals');
    expect(lastToOwner(w)).toContain('#1 cambridge привёл(а) Blanche');
    expect(w.hq.reports(0).some((r) => r.body.includes('Рекомендация #1'))).toBe(true);
    // the same lead worked again (rework) does not duplicate
    const lead = leadStoreFor({ db: w.db, now: w.hq.now }).recent(1)[0]!;
    await cmd(w, 'referral', `cambridge -> ${lead.id}`);
    expect(lastToOwner(w)).toContain('Уже записано');
  });

  it('the daily routine reminds in the report (morning summary) after 3 days, silent before', async () => {
    const w = world();
    expect(w.hq.routineByName('sales-referral-reminders')).toMatchObject({ cron: '30 9 * * *', dept: 'sales' });
    await cmd(w, 'referral', 'Cambridge -> Blanche');
    const run = async () => {
      w.hq.createTask({ title: 'Напоминания по рекомендациям', dept: 'sales', creator: 'routine', meta: { action: 'referral_reminders' } });
      w.hq.wake('sales-head', 'schedule');
      await w.sales.onHeartbeat();
    };
    await run();
    expect(w.hq.reports(0).filter((r) => r.body.includes('ждут оплаты'))).toHaveLength(0);
    w.clock.t += 3 * DAY;
    await run();
    expect(w.hq.reports(0).filter((r) => r.body.includes('ждут оплаты'))[0]!.body).toContain('/paid 1');
    expect(w.director.morningSummary()).toContain('Рекомендации ждут оплаты');
  });
});

describe('plumbing', () => {
  it('the form accepts source=ref:<client> and still rejects junk', () => {
    const base = { name: 'A', contact: '@a1' };
    expect(webLeadSchema.safeParse({ ...base, source: 'ref:cambridge' }).success).toBe(true);
    expect(webLeadSchema.safeParse({ ...base, source: 'ref:' }).success).toBe(false);
    expect(webLeadSchema.safeParse({ ...base, source: `ref:${'x'.repeat(36)}` }).success).toBe(false);
    expect(webLeadSchema.safeParse({ ...base, source: 'ref:Bad Name' }).success).toBe(false);
  });
});
