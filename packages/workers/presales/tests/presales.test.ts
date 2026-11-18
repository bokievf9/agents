import { MockLlm, openDb, type Payload } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { leadStoreFor } from '@fir/worker-lead-intake';
import { describe, expect, it } from 'vitest';
import { fillMarks, fallbackWording, wordingOk, type Wording } from '../src/docs.js';
import { DIRECTION_IDS, guessDirection, OFFERS, priceLabel, SUPPORT_MONTHLY_USD } from '../src/offers.js';
import { splitMessage } from '../src/split.js';
import { render } from '../src/template.js';
import { kindSpecs, KIND_PACK, onDecision, packMessages, PresalesWorker, storeFor } from '../src/worker.js';

const T0 = Date.UTC(2026, 10, 20, 5, 0);
const GOOD: Wording = {
  context: 'Cambridge: учебный центр в Бишкеке, запись на курсы идёт по звонкам.',
  problem: 'Вечером заявки теряются: администратор уже ушёл.',
  solution: 'Бот принимает запись круглосуточно. Стоимость: [цена], срок запуска [срок].',
  scope: ['Диалоги бота', 'Запись на пробный урок', 'Напоминания', 'Уведомления владельцу', 'Админ-панель', 'Тест и запуск'],
};

function rig(handler: ConstructorParameters<typeof MockLlm>[0] = () => JSON.stringify(GOOD), opts: ConstructorParameters<typeof PresalesWorker>[0] = {}) {
  const db = openDb(':memory:');
  const staged: { kind: string; payload: Payload; summary: string }[] = [];
  const llm = new MockLlm(handler);
  const ctx: WorkerCtx = {
    llm, db, tz: 'Asia/Tashkent', now: () => T0,
    requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
    log: () => undefined,
  };
  const worker = new PresalesWorker(opts);
  let n = 0;
  const task = (meta: Record<string, unknown>): Task => ({
    id: ++n, title: 'T', body: '', dept: 'sales', assigneeId: 'presales', creator: 'owner', parentId: null, status: 'running', priority: 0,
    dueAt: null, result: null, costUsd: 0, meta, tags: [], routineId: null, createdAt: 0, updatedAt: 0,
  });
  const lead = (over: Partial<{ origin: string; service: string }> = {}) =>
    leadStoreFor(ctx).upsert(1, {
      name: 'Cambridge', contact: '@cam', service: over.service ?? 'bots', niche: 'учебный центр', task: 'Нужен бот для записи на пробный урок', deadline: '', budget: '',
      origin: over.origin ?? '', temperature: 'warm', lang: 'ru', slots: [], chosenSlot: null, priceAsked: false,
    });
  return { db, ctx, staged, llm, worker, task, lead, run: (meta: Record<string, unknown>) => worker.run(task(meta), ctx), store: storeFor(ctx) };
}

/** Every dollar amount a proposal may contain, computed from the table only. */
function allowedAmounts(): Set<number> {
  const s = new Set<number>([SUPPORT_MONTHLY_USD]);
  for (const o of Object.values(OFFERS)) {
    s.add(o.fromUsd);
    if (o.teamUsd) s.add(o.teamUsd);
    s.add(Math.round(o.fromUsd / 2));
    s.add(o.fromUsd - Math.round(o.fromUsd / 2));
  }
  return s;
}
const amounts = (text: string) => [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));

describe('prices come from the offers table only', () => {
  it('the proposal fills [цена] and [срок] from the table: site 7-10 days, bot 5-7, receptionist 7, mini app 14-21', async () => {
    const r = rig();
    r.lead();
    const res = await r.run({ leadId: 1 });
    expect(res.ok).toBe(true);
    const kp = r.staged[0]!.payload.kp as string;
    expect(kp).toContain('Стоимость: от $250, срок запуска 5-7 рабочих дней.');
    expect(kp).not.toMatch(/\[(цена|срок)\]/);
    expect(OFFERS.site.timeline).toBe('7-10 рабочих дней');
    expect(OFFERS.receptionist.timeline).toBe('7 рабочих дней');
    expect(OFFERS.miniapp.timeline).toBe('14-21 рабочий день');
  });

  it('a model that invents a price, a term or a long dash is replaced by the table wording', async () => {
    const bad = { ...GOOD, solution: 'Сделаем всё за $99 за 3 дня.' };
    const r = rig(() => JSON.stringify(bad));
    r.lead();
    await r.run({ leadId: 1 });
    const docs = [r.staged[0]!.payload.kp, r.staged[0]!.payload.estimate, r.staged[0]!.payload.contract].join('\n');
    expect(docs).not.toContain('$99');
    expect(docs).toContain('Предлагаем решение «Telegram-бот-администратор». Стоимость: от $250.');
    expect(wordingOk({ ...GOOD, problem: 'Это — проблема' })).toBe(false);
    expect(wordingOk({ ...GOOD, scope: [...GOOD.scope.slice(0, 5)] })).toBe(true);
  });

  it('garbage or too short scope from the model falls back to the default scope of the direction (5-8 bullets)', async () => {
    const r = rig(() => JSON.stringify({ ...GOOD, scope: ['one'] }));
    r.lead();
    await r.run({ leadId: 1 });
    const bullets = (r.staged[0]!.payload.kp as string).split('## Что входит')[1]!.split('## Сроки')[0]!.trim().split('\n');
    expect(bullets).toHaveLength(OFFERS.admin.scope.length);
    for (const id of DIRECTION_IDS) expect(OFFERS[id].scope.length).toBeGreaterThanOrEqual(5);
    for (const id of DIRECTION_IDS) expect(OFFERS[id].scope.length).toBeLessThanOrEqual(8);
  });

  it('every dollar amount in all three documents is in the table, for every direction', async () => {
    const ok = allowedAmounts();
    for (const id of DIRECTION_IDS) {
      const r = rig();
      r.lead({ origin: id });
      await r.run({ leadId: 1 });
      const p = r.staged[0]!.payload;
      expect(p.direction).toBe(id);
      for (const doc of [p.kp, p.estimate, p.contract] as string[]) {
        const found = amounts(doc);
        expect(found.length).toBeGreaterThan(0);
        for (const a of found) expect(ok.has(a), `${id}: $${a}`).toBe(true);
      }
    }
  });

  it('KP has the required parts: payment terms, support, validity; prepayment percent and validity are configurable', async () => {
    const r = rig(undefined, { prepaymentPercent: 30, validDays: 7 });
    r.lead();
    await r.run({ leadId: 1 });
    const kp = r.staged[0]!.payload.kp as string;
    expect(kp).toContain('Предоплата 30%, оставшиеся 70% после сдачи работы. Способы оплаты: Kaspi, Payme, Click, банковские карты, USDT.');
    expect(kp).toContain('$25 в месяц');
    expect(kp).toContain('Предложение действует 7 дней, до 27.11.2026');
    expect(kp).toContain('| Предоплата 30% | от $75 |');
    const dflt = rig();
    dflt.lead();
    await dflt.run({ leadId: 1 });
    expect(dflt.staged[0]!.payload.kp).toContain('до 04.12.2026');
    expect(dflt.staged[0]!.payload.kp).toContain('| Предоплата 50% | от $125 |');
  });
});

describe('direction choice', () => {
  it('source is the direction id; otherwise the service field; otherwise keywords in the text', () => {
    expect(guessDirection({ source: 'miniapp', service: 'bots' })).toBe('miniapp');
    expect(guessDirection({ source: 'instagram_bio', service: 'websites' })).toBe('site');
    expect(guessDirection({ service: 'unknown', text: 'нужен ИИ-приёмщик заявок из WhatsApp' })).toBe('receptionist');
    expect(guessDirection({ text: 'сделайте Mini App для магазина' })).toBe('miniapp');
    expect(guessDirection({})).toBe('admin');
  });
  it('fills marks only from the table', () => {
    expect(fillMarks('[цена] / [срок]', OFFERS.site)).toBe('от $150 / 7-10 рабочих дней');
    expect(priceLabel(OFFERS.content)).toBe('от $60 в месяц');
    expect(priceLabel(OFFERS.training)).toBe('от $150 за человека');
    expect(fallbackWording({ leadId: null, client: 'X', niche: '', request: '' }, OFFERS.site).scope).toEqual(OFFERS.site.scope);
  });
  it('template without a value for a variable is a bug', () => {
    expect(() => render('Привет {{name}}', {})).toThrow(/name/);
    expect(render('Привет {{name}}', { name: 'Ali' })).toBe('Привет Ali');
  });
});

describe('message splitting', () => {
  it('keeps short text whole and splits at paragraph boundaries under 4096', () => {
    expect(splitMessage('короткий')).toEqual(['короткий']);
    const para = 'а'.repeat(1500);
    const parts = splitMessage([para, para, para, para].join('\n\n'));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join('\n\n')).toBe([para, para, para, para].join('\n\n'));
  });
  it('hard-cuts a text without any break', () => {
    const parts = splitMessage('я'.repeat(10_000));
    expect(parts.map((p) => p.length)).toEqual([4096, 4096, 1808]);
  });
  it('a pack becomes ordered messages: kp, estimate, contract, each within the limit', () => {
    const msgs = packMessages({ kp: 'К'.repeat(5000), estimate: 'смета', contract: 'договор' });
    expect(msgs.map((m) => m.length)).toEqual([4096, 904, 5, 7]);
  });
});

describe('the pack and its approval', () => {
  it('one locked level-0 approval for all three documents; documents are drafts', async () => {
    const r = rig();
    r.lead();
    const res = await r.run({ leadId: 1 });
    expect(res.ok).toBe(true);
    expect(r.staged).toHaveLength(1);
    expect(r.staged[0]!.kind).toBe(KIND_PACK);
    expect(r.staged[0]!.summary).toContain('лид #1 Cambridge');
    expect(r.staged[0]!.payload.text).toBeUndefined();
    const docs = r.store.byLead(1);
    expect(docs.map((d) => [d.kind, d.status])).toEqual([['kp', 'draft'], ['estimate', 'draft'], ['contract', 'draft']]);
    const spec = kindSpecs(r.ctx)[KIND_PACK]!;
    expect(spec.initialLevel).toBe(0);
    expect(spec.locked).toBe(true);
    expect(spec.buttons!(7, {}).flat().map((b) => b.data)).toEqual(['pc:7:c', 'ap:7:r', 'ap:7:a']);
  });

  it('approve marks the documents approved, a second approve fails; reject marks them rejected', async () => {
    const r = rig();
    r.lead();
    await r.run({ leadId: 1 });
    const payload = r.staged[0]!.payload;
    const spec = kindSpecs(r.ctx)[KIND_PACK]!;
    await spec.execute(payload, 1);
    expect(r.store.byLead(1).every((d) => d.status === 'approved' && d.decidedAt === T0)).toBe(true);
    await expect(spec.execute(payload, 1)).rejects.toThrow();

    const r2 = rig();
    r2.lead();
    await r2.run({ leadId: 1 });
    onDecision(r2.ctx, { kind: KIND_PACK, payload: r2.staged[0]!.payload }, 'rejected');
    expect(r2.store.byLead(1).every((d) => d.status === 'rejected')).toBe(true);
  });

  it('a new pack for the same lead supersedes the old draft', async () => {
    const r = rig();
    r.lead();
    await r.run({ leadId: 1 });
    await r.run({ leadId: 1 });
    const docs = r.store.byLead(1);
    expect(docs.filter((d) => d.status === 'superseded')).toHaveLength(3);
    expect(docs.filter((d) => d.status === 'draft')).toHaveLength(3);
    await expect(kindSpecs(r.ctx)[KIND_PACK]!.execute(r.staged[0]!.payload, 1)).rejects.toThrow();
  });

  it('works from the owner text without a lead; fails clearly without lead or text', async () => {
    const r = rig();
    const res = await r.run({ text: 'Салон красоты в Алматы хочет сайт с записью' });
    expect(res.ok).toBe(true);
    expect(r.staged[0]!.payload.direction).toBe('site');
    expect(r.staged[0]!.payload.leadId).toBeNull();
    expect(r.staged[0]!.summary).toContain('по запросу владельца');
    expect((await r.run({})).ok).toBe(false);
    expect((await r.run({ leadId: 99 })).error).toContain('не найден');
  });

  it('the contract stub keeps blanks and the prepayment terms', async () => {
    const r = rig();
    r.lead();
    await r.run({ leadId: 1 });
    const c = r.staged[0]!.payload.contract as string;
    expect(c).toContain('Договор оказания услуг № ______');
    expect(c).toContain('Предоплата 50% (от $125)');
    expect(c).toContain('Kaspi, Payme, Click, банковские карты, USDT');
    expect(c).not.toMatch(/\{\{/);
  });
});
