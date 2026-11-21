import { allowedAmounts as sitePrices, costsLine, FALLBACK_PRICES, MockLlm, openDb, setPrices, stagesFor, type Payload } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { leadStoreFor } from '@fir/worker-lead-intake';
import { describe, expect, it } from 'vitest';
import { fillMarks, fallbackWording, withPilot, wordingOk, type Wording } from '../src/docs.js';
import { priceBuilderCode } from '../src/estimate.js';
import { builderTotal, quotePackage } from '../src/package.js';
import { DIRECTION_IDS, guessDirection, OFFERS, priceLabel, supportMonthlyUsd } from '../src/offers.js';
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
  // 5, 10 and 15: the reference figures of the fixed conditions line (domain a year, hosting a month), not product prices
  const s = new Set<number>([supportMonthlyUsd(), ...sitePrices(), 5, 10, 15]);
  for (const o of Object.values(OFFERS)) {
    s.add(o.fromUsd);
    const q = quotePackage(o.id, o.title, '');
    s.add(q.totalUsd);
    for (const st of stagesFor(q.totalUsd, [o.id])) s.add(st.amountUsd);
    if (q.monthlyUsd) s.add(q.monthlyUsd);
  }
  return s;
}
const amounts = (text: string) => [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));

describe('prices come from the price list only', () => {
  it('a changed price list changes the proposal at once', async () => {
    setPrices({ ...FALLBACK_PRICES, products: { ...FALLBACK_PRICES.products, admin: 310 } });
    try {
      const r = rig();
      r.lead();
      await r.run({ leadId: 1 });
      expect(r.staged[0]!.payload.kp).toContain('Стоимость: $310,');
    } finally {
      setPrices(FALLBACK_PRICES);
    }
  });

  it('the proposal fills [цена] and [срок] from the table: site 7-10 days, bot 5-7, receptionist 7, mini app 14-21', async () => {
    const r = rig();
    r.lead();
    const res = await r.run({ leadId: 1 });
    expect(res.ok).toBe(true);
    const kp = r.staged[0]!.payload.kp as string;
    expect(kp).toContain('Стоимость: $290, срок запуска 5-7 рабочих дней.');
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
    expect(docs).toContain('Предлагаем решение «ИИ-администратор». Стоимость: $290.');
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
      expect(p.direction).toBe(id === 'agent' ? 'personal' : id); // the retired `agent` is offered as `personal`
      for (const doc of [p.kp, p.estimate, p.contract] as string[]) {
        const found = amounts(doc);
        expect(found.length).toBeGreaterThan(0);
        for (const a of found) expect(ok.has(a), `${id}: $${a}`).toBe(true);
      }
    }
  });

  it('KP has the required parts: stage table, payment rule, support, validity; validity is configurable', async () => {
    const r = rig(undefined, { validDays: 7 });
    r.lead();
    await r.run({ leadId: 1 });
    const kp = r.staged[0]!.payload.kp as string;
    expect(kp).toContain('| Этап | Что входит | Сумма |');
    expect(kp).toContain('| Этап 1 | Старт | $145 (50%) |');
    expect(kp).toContain('| Этап 2 | Запуск | $145 (50%) |');
    expect(kp).toContain('Небольшой проект оплачивается двумя этапами: 50% до начала работ ($145) и 50% до запуска и передачи доступов ($145).');
    expect(kp).toContain('Способы оплаты: USDT (сеть TRC20 или TON) или онлайн-кошелёк, который назван в смете.');
    expect(kp).toContain('Гарантия: если первый результат не понравился, мы возвращаем оплату первого этапа');
    expect(kp).not.toMatch(/Kaspi|Payme|Click|карт/i);
    expect(kp).not.toMatch(/Предоплата|после приёмки результата/);
    expect(kp).toContain('$20 в месяц');
    expect(kp).toContain('Предложение действует 7 дней, до 27.11.2026');
    const dflt = rig();
    dflt.lead();
    await dflt.run({ leadId: 1 });
    expect(dflt.staged[0]!.payload.kp).toContain('до 04.12.2026');
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
    expect(fillMarks('[цена] / [срок]', OFFERS.site, quotePackage('site', OFFERS.site.title, ''))).toBe('$150 / 7-10 рабочих дней');
    expect(priceLabel(OFFERS.content)).toBe('от $90 + $60 в месяц');
    expect(priceLabel(OFFERS.agent)).toBe('от $290 + $29 в месяц');
    expect(priceLabel(OFFERS.personal)).toBe('от $290 + $29 в месяц');
    expect(priceLabel(OFFERS.company)).toBe('от $1490 + $149 в месяц');
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

  it('the contract stub keeps blanks and the stage payment terms', async () => {
    const r = rig();
    r.lead();
    await r.run({ leadId: 1 });
    const c = r.staged[0]!.payload.contract as string;
    expect(c).toContain('Договор оказания услуг');
    expect(c).toContain('Оплата по этапам. Каждый этап оплачивается до его начала, последний этап до передачи доступов');
    expect(c).toContain('| Этап 1 | Старт | $145 (50%) |');
    expect(c).toContain('оплата первого этапа возвращается полностью');
    expect(c).toContain('USDT (сеть TRC20 или TON)');
    expect(c).toContain('30 дней');
    expect(c).toContain('Республика Таджикистан');
    expect(c).not.toMatch(/ИНН|______/);
    expect(c).not.toMatch(/\{\{/);
  });
});

describe('exact figures (owner decision 2026-11-19): one price for the chosen package, «от» only while prospecting', () => {
  it('the three documents state the exact price, the exact split and no «от»', async () => {
    const r = rig();
    r.lead();
    await r.run({ leadId: 1 });
    const p = r.staged[0]!.payload;
    for (const doc of [p.kp, p.estimate, p.contract] as string[]) expect(doc.replace(costsLine(), '')).not.toMatch(/(^|[^\p{L}])от \$/u);
    expect(p).toMatchObject({ totalUsd: 290, prepayUsd: 145, prepayPercent: 50 });
    expect(p.stages).toEqual(stagesFor(290, ['admin']));
    expect(p.kp).toContain('| ИИ-администратор | $290 |');
    expect(p.kp).toContain('| Этап 2 | Запуск | $145 (50%) |');
    expect(p.estimate).toContain('| Итого | $290 |');
    expect(p.contract).toContain('Стоимость Услуги в долларах США: $290 (цена точная');
    expect(p.contract).toContain('| Этап 1 | Старт | $145 (50%) |');
    expect(r.staged[0]!.summary).toContain('цена $290');
    expect(r.staged[0]!.summary).not.toContain('от $');
  });

  it('a site is the catalogue variant plus the add-ons the lead names, summed line by line', async () => {
    const r = rig();
    const lead2 = leadStoreFor(r.ctx).upsert(2, {
      name: 'Ali', contact: '@ali', service: 'websites', niche: 'магазин одежды', task: 'интернет-магазин на двух языках с онлайн-оплатой', deadline: '', budget: '',
      origin: 'site', temperature: 'warm', lang: 'ru', slots: [], chosenSlot: null, priceAsked: false,
    });
    await r.run({ leadId: lead2.id });
    const p = r.staged[0]!.payload;
    expect(p.totalUsd).toBe(700 + 40 + 60);
    expect(p.kp).toContain('| Интернет-магазин | $700 |');
    expect(p.kp).toContain('| Второй язык | $40 |');
    expect(p.kp).toContain('| Онлайн-оплата | $60 |');
    expect(p.kp).toContain('| Итого | $800 |');
    expect(p.stages).toEqual(stagesFor(800, ['site']));
    expect(p.prepayUsd).toBe(240);
    expect(p.kp).toContain('| Этап 2 | Все страницы и наполнение | $320 (40%) |');
    expect(p.kp).toContain('Оплата по этапам, каждый этап оплачивается до его начала, последний до передачи доступов: этап 1 «Структура и первый экран»: $240 (30%)');
    expect(quotePackage('site', 'Сайт', 'лендинг для салона').totalUsd).toBe(150);
    expect(quotePackage('site', 'Сайт', 'сайт компании с панелью для правок').totalUsd).toBe(350 + 100);
  });

  it('КП, смета and договор list the same stages with the same amounts (template project), the pack carries them, nothing says 50% outside a small project', async () => {
    const r = rig();
    const lead2 = leadStoreFor(r.ctx).upsert(2, {
      name: 'Ali', contact: '@ali', service: 'websites', niche: 'магазин', task: 'интернет-магазин', deadline: '', budget: '', origin: 'site', temperature: 'warm', lang: 'ru', slots: [], chosenSlot: null, priceAsked: false,
    });
    await r.run({ leadId: lead2.id });
    const p = r.staged[0]!.payload;
    expect(p.totalUsd).toBe(700);
    expect((p.stages as { amountUsd: number }[]).map((x) => x.amountUsd)).toEqual([210, 280, 210]);
    for (const doc of [p.kp, p.estimate, p.contract] as string[]) {
      expect(doc).toContain('| Этап 1 | Структура и первый экран | $210 (30%) |');
      expect(doc).toContain('| Этап 2 | Все страницы и наполнение | $280 (40%) |');
      expect(doc).toContain('| Этап 3 | Запуск, SEO, передача | $210 (30%) |');
      expect(doc).not.toContain('50%');
      expect(doc).not.toMatch(/Предоплата|предоплат/);
    }
    expect(p.contract).toContain('следующий счёт выставляется после приёмки предыдущего этапа');
    expect(r.staged[0]!.summary).toContain('Оплата по этапам (1: $210, 2: $280, 3: $210)');
  });

  it('a subscription has one setup stage and the monthly fee stays «вперёд»', async () => {
    const r = rig();
    r.lead({ origin: 'content' });
    await r.run({ leadId: 1 });
    const p = r.staged[0]!.payload;
    expect(p.stages).toEqual(stagesFor(90, ['content']));
    expect(p.kp).toContain('Настройка ($90) оплачивается до начала работ; ежемесячная плата, если она есть, вносится вперёд за месяц.');
  });

  it('subscriptions give an exact setup and an exact monthly fee; the Персональный ИИ plan follows the level of the build', () => {
    expect(quotePackage('content', 'Контент', '')).toMatchObject({ totalUsd: 90, monthlyUsd: 60 });
    // no options: the default two services, the first level; the retired `agent` quotes like `personal`
    expect(quotePackage('personal', 'Персональный ИИ', 'помощник для учёбы')).toMatchObject({ totalUsd: 290, monthlyUsd: 29 });
    expect(quotePackage('agent', 'Агент', 'помощник для учёбы')).toMatchObject({ totalUsd: 290, monthlyUsd: 29 });
    const at = (f: string) => quotePackage('personal', 'Персональный ИИ', `Сборка: https://firtech.pro/ru/builder?b=p.personal~f.personal.${f}`);
    expect(at('mail-calendar')).toMatchObject({ totalUsd: 290, monthlyUsd: 29 });
    expect(at('mail-calendar-tasks')).toMatchObject({ totalUsd: 490, monthlyUsd: 49 });
    expect(at('mail-voice')).toMatchObject({ totalUsd: 490, monthlyUsd: 49 });
    expect(at('mail-calendar-tasks-study-notes')).toMatchObject({ totalUsd: 790, monthlyUsd: 79 });
    expect(at('mail-memory')).toMatchObject({ totalUsd: 790, monthlyUsd: 79 });
  });

  it('a subscription proposal shows the monthly fee in the table and in the contract', async () => {
    const r = rig();
    r.lead({ origin: 'content' });
    await r.run({ leadId: 1 });
    const p = r.staged[0]!.payload;
    expect(p.monthlyUsd).toBe(60);
    expect(p.kp).toContain('| Ежемесячно (подписка) | $60 в месяц |');
    expect(p.contract).toContain('$90 + $60 в месяц');
  });

  it('the price changes with the price list, not with the code', async () => {
    setPrices({ ...FALLBACK_PRICES, catalog: { ...FALLBACK_PRICES.catalog, websites: { ...FALLBACK_PRICES.catalog.websites, variants: { ...FALLBACK_PRICES.catalog.websites.variants, landing: 175 } } } });
    try {
      expect(quotePackage('site', 'Сайт', '').totalUsd).toBe(175);
    } finally {
      setPrices(FALLBACK_PRICES);
    }
  });

  it('the builder total from the site is only compared: a different total is a warning on the card, never the price', async () => {
    expect(builderTotal('Сайт: Лендинг\nИтого: $350\nТексты')).toBe(350);
    expect(builderTotal('Total: $1,250')).toBe(1250);
    expect(builderTotal('нет итога')).toBeNull();
    const r = rig();
    const lead3 = leadStoreFor(r.ctx).upsert(3, {
      name: 'Dil', contact: '@dil', service: 'websites', niche: '', task: 'сайт', deadline: '', budget: '', origin: 'site', temperature: 'warm', lang: 'ru', slots: [], chosenSlot: null, priceAsked: false,
      estimate: 'Лендинг: одна страница\nИтого: $1',
    });
    await r.run({ leadId: lead3.id });
    expect(r.staged[0]!.payload.totalUsd).toBe(150);
    expect(r.staged[0]!.summary).toContain('в «Сборке проекта» клиент видел итог $1, в КП $150');
  });
});

describe('the conditions line: domain, hosting, server and paid third-party services are not in the price', () => {
  it('КП, смета and договор carry the default line; the guarantee and the stage rule stay', async () => {
    const r = rig();
    r.lead();
    await r.run({ leadId: 1 });
    const p = r.staged[0]!.payload;
    for (const doc of [p.kp, p.estimate, p.contract] as string[]) expect(doc).toContain(costsLine());
    expect(p.kp).toContain('## Что не входит в стоимость');
    expect(p.contract).toContain('Гарантия первого результата');
    expect(p.contract).toContain('Оплата по этапам.');
    expect(p.kp).toContain('Этап 1');
  });

  it('a client who has a domain and hosting gets the short line instead', async () => {
    const r = rig();
    const lead4 = leadStoreFor(r.ctx).upsert(4, {
      name: 'Own', contact: '@own', service: 'bots', niche: '', task: 'бот для записи', deadline: '', budget: '', origin: '', temperature: 'warm', lang: 'ru', slots: [], chosenSlot: null, priceAsked: false,
      hasDomain: true, hasHosting: true,
    });
    await r.run({ leadId: lead4.id });
    const p = r.staged[0]!.payload;
    const line = 'Домен и хостинг у заказчика есть, используем их; платные сторонние сервисы (SMS, API, платежи) оплачиваются отдельно.';
    for (const doc of [p.kp, p.estimate, p.contract] as string[]) {
      expect(doc).toContain(line);
      expect(doc).not.toContain('в сумму не входят');
    }
    expect(p).toMatchObject({ hasDomain: true, hasHosting: true });
  });

  it('a /kp text that says it is read for the same facts; no signal means the default line', async () => {
    const r = rig();
    await r.run({ text: 'Нужен сайт для кафе, домен и хостинг у меня есть' });
    expect(r.staged[0]!.payload.kp).toContain('Домен и хостинг у заказчика есть');
    const r2 = rig();
    await r2.run({ text: 'Нужен сайт для кафе' });
    expect(r2.staged[0]!.payload.kp).toContain(costsLine());
  });
});

describe('the flagships (2026-11-22): Персональный ИИ and ИИ-компания through the whole chain', () => {
  it('the drill: lead -> КП, смета, договор for each flagship; the amounts are the plans, the stages the templates', async () => {
    for (const [origin, total, monthly, stageShares] of [['personal', 290, 29, [100]], ['company', 1490, 149, [25, 25, 25, 25]]] as const) {
      const r = rig();
      r.lead({ origin });
      await r.run({ leadId: 1 });
      const p = r.staged[0]!.payload;
      expect(p).toMatchObject({ direction: origin, totalUsd: total, monthlyUsd: monthly });
      expect((p.stages as { share: number }[]).map((x) => x.share)).toEqual(stageShares);
      expect(p.prepayUsd).toBe(stageShares[0] === 100 ? total : Math.round(total * 0.25));
      for (const doc of [p.kp, p.estimate, p.contract] as string[]) {
        expect(doc, origin).toContain(`$${total}`);
        expect(doc, origin).toContain(`$${monthly}`);
        expect(doc, origin).not.toMatch(/Dono|Polly/);
      }
    }
  });

  it('ИИ-компания: four stages with the owner\'s names, the monthly row and the «по смете» note; the contract says the sum is fixed in the estimate', async () => {
    const r = rig();
    r.lead({ origin: 'company' });
    await r.run({ leadId: 1 });
    const p = r.staged[0]!.payload;
    for (const title of ['Карта компании и Директор', 'Первые отделы на ваших данных', 'Пульт, база знаний и каналы', 'Обучение команды и запуск']) expect(p.kp).toContain(title);
    expect(p.kp).toContain('Ежемесячно (подписка) | $149 в месяц');
    expect(p.kp).toContain('точную сумму фиксируем в Смете');
    expect(p.contract).toContain('фиксируется в Смете до подписания договора');
    expect(p.contract).not.toContain('цена точная для состава работ');
  });

  it('Персональный ИИ: one stage «Настройка» and the monthly fee, no «по смете» note', async () => {
    const r = rig();
    r.lead({ origin: 'personal' });
    await r.run({ leadId: 1 });
    const p = r.staged[0]!.payload;
    expect((p.stages as { id: string }[]).map((x) => x.id)).toEqual(['setup']);
    expect(p.kp).not.toContain('точную сумму фиксируем в Смете');
    expect(p.kp).toContain('Настройка ($290) оплачивается до начала работ');
  });

  it('a lead whose build names only a flagship gets it from the link (the old p.agent too)', () => {
    expect(guessDirection({ text: 'Сборка: https://firtech.pro/ru/builder?b=k.coffee~p.company~f.company.sales-pult' })).toBe('company');
    expect(guessDirection({ text: 'Сборка: https://firtech.pro/ru/builder?b=p.personal' })).toBe('personal');
    expect(guessDirection({ text: 'Сборка: https://firtech.pro/ru/builder?b=p.agent' })).toBe('personal');
    expect(guessDirection({ source: 'agent' })).toBe('personal');
    expect(guessDirection({ text: 'хотим всю компанию на агентах' })).toBe('company');
    expect(guessDirection({ text: 'нужен личный помощник' })).toBe('personal');
    // a mixed build is not a flagship-only one: the priced parts decide
    expect(guessDirection({ text: 'Сборка: https://firtech.pro/ru/builder?b=p.personal-site', service: 'websites' })).toBe('site');
  });

  it('a builder estimate lists the flagship «по смете» with its plan and keeps it out of the one-time total', () => {
    const e = priceBuilderCode('p.personal-site~f.personal.mail-calendar-voice~websites.landing')!;
    expect(e.quote.totalUsd).toBe(150);
    expect(e.onRequest).toEqual(['Персональный ИИ (Почта, Календарь, Голос; Плюс: $490 + $49/мес)']);
    const c = priceBuilderCode('p.company-site~f.company.sales-pult~websites.landing')!;
    expect(c.onRequest[0]).toBe('ИИ-компания (Продажи, Пульт; от $1 490 + $149/мес, точная сумма по смете)');
    expect(priceBuilderCode('p.agent-site~websites.landing')!.onRequest[0]).toMatch(/^Персональный ИИ \(Почта, Календарь; Старт: \$290 \+ \$29\/мес\)$/);
  });

  it('the pilot block: only in a flagship\'s КП and only when the package says so; the terms are written before the start, nothing is automatic', async () => {
    const without = rig();
    without.lead({ origin: 'company' });
    await without.run({ leadId: 1 });
    expect(without.staged[0]!.payload.kp).not.toContain('## Пилот');
    expect(without.staged[0]!.payload.pilot).toBe(false);
    const withIt = rig();
    withIt.lead({ origin: 'company' });
    await withIt.run({ leadId: 1, pilot: true });
    const kp = withIt.staged[0]!.payload.kp as string;
    expect(withIt.staged[0]!.payload.pilot).toBe(true);
    expect(kp).toContain('## Пилот');
    expect(kp).toContain('бесплатно, в обмен на ваш кейс и отзыв');
    expect(kp).toContain('Условия пилота');
    expect(kp).toContain('записываем до начала работ');
    expect(kp.indexOf('## Пилот')).toBeLessThan(kp.indexOf('## Срок действия'));
    // an ordinary product never gets it, even if asked
    const site = rig();
    site.lead({ origin: 'site' });
    await site.run({ leadId: 1, pilot: true });
    expect(site.staged[0]!.payload.kp).not.toContain('## Пилот');
    expect('pilot' in site.staged[0]!.payload).toBe(false);
    // the block goes in and out cleanly
    expect(withPilot(withPilot(kp, false), true)).toBe(kp);
    expect(withPilot(kp, false)).not.toContain('Пилот');
    expect(withPilot(withPilot(kp, true), true)).toBe(kp);
  });
});
