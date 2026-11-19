import { describe, expect, it } from 'vitest';
import { checkFirst, checkFollowup, checkReply, firstFallback } from '../src/draft.js';
import { cardButtons, KIND_FIRST, KIND_FOLLOWUP, KIND_REPLY, kindSpecs, markReplied, onDecision, renderSummary, statsText } from '../src/worker.js';
import { DAY, json, rig, T0 } from './helpers.js';

const GOOD = 'Здравствуйте! Это Фирдавс из Fir Tech. У Cambridge запись на курс идёт только по звонку, поэтому вечером заявки теряются. Настроим бота для записи на пробный урок, от $290. Как сейчас обрабатываете вечерние заявки?';
const isReplyPrompt = (system: string) => system.includes('ответил');

describe('draft shape', () => {
  it('accepts a message with one hook, the approved price and one question', () => {
    expect(checkFirst(GOOD, 'от $290')).toBe(true);
  });
  it('rejects a wrong price, two questions, long dashes, placeholders and extra money', () => {
    expect(checkFirst(GOOD.replace('$290', '$99'), 'от $290')).toBe(false);
    expect(checkFirst(`${GOOD} Удобно?`, 'от $290')).toBe(false);
    expect(checkFirst(GOOD.replace('поэтому', '—'), 'от $290')).toBe(false);
    expect(checkFirst(GOOD.replace('от $290', 'от [цена]'), 'от $290')).toBe(false);
    expect(checkFirst(GOOD.replace('Как', 'Скидка 20 $ сегодня. Как'), 'от $290')).toBe(false);
  });
  it('fallback template passes its own check for every offer', () => {
    const { store } = rig();
    for (const p of store.pickNew(10)) {
      const price = p.offer.includes('Mini') ? 'от $660' : p.offer.includes('ИИ') ? 'от $220' : 'от $290';
      expect(checkFirst(firstFallback(p), price)).toBe(true);
    }
  });
  it('reply drafts carry no money, follow-ups no placeholders', () => {
    expect(checkReply('Спасибо! Стоимость уточню: [цена]. Удобно в 11:00 или в 15:00?')).toBe(true);
    expect(checkReply('Это стоит 300 долларов')).toBe(false);
    expect(checkFollowup('Напомню про моё сообщение. Стоимость [цена]. Актуально?')).toBe(false);
  });
});

describe('batch', () => {
  it('uses a valid LLM draft, moves the prospect to proposed and stages one approval per card', async () => {
    const r = rig(() => json(GOOD), 1);
    const res = await r.run({ action: 'batch' });
    expect(res.ok).toBe(true);
    expect(res.result).toContain('Новых карточек 1');
    expect(r.staged).toHaveLength(1);
    const s = r.staged[0]!;
    expect(s.kind).toBe(KIND_FIRST);
    expect(s.payload).toEqual({ text: GOOD, prospectId: 3, draftKind: 'first' });
    expect(s.summary).toContain('#3 Cambridge');
    expect(s.summary).toContain('Учебные центры и репетиторы · Бишкек');
    expect(s.summary).toContain('Телефон: +996555000003');
    expect(s.summary).toContain('от $290');
    expect(r.store.get(3)).toMatchObject({ status: 'proposed', draftKind: 'first', draft: GOOD });
  });

  it('honours meta.limit and the default size; priority by niche', async () => {
    const r = rig(() => json(GOOD), 2);
    await r.run({ action: 'batch' });
    expect(r.staged.map((s) => s.payload.prospectId)).toEqual([3, 5]);
    await r.run({ action: 'batch', limit: 1 });
    expect(r.staged).toHaveLength(3);
    expect(r.store.get(2)!.status).toBe('proposed');
  });

  it('falls back to a template when the model returns garbage, and never fails the batch', async () => {
    const r = rig(() => 'sorry, no json');
    await r.run({ action: 'batch', limit: 2 });
    const p = r.store.get(3)!;
    expect(p.draft).toContain('от $290');
    expect(p.draft).toContain('?');
    expect(r.store.stats().byStatus.proposed).toBe(2);
  });

  it('gives the model the price per offer (directions.ts)', async () => {
    const r = rig(() => 'x');
    await r.run({ action: 'batch', limit: 5 });
    const prices = r.llm.calls.filter((c) => c.system.includes('ПЕРВОЕ')).map((c) => (JSON.parse(c.messages[0]!.content) as { price: string }).price);
    expect([...new Set(prices)].sort()).toEqual(['от $220', 'от $290', 'от $660']);
  });

  it('says so when the base is empty and rejects unknown actions', async () => {
    const r = rig();
    await r.run({ action: 'batch', limit: 99 });
    const res = await r.run({ action: 'batch' });
    expect(res.result).toMatch(/База пуста/);
    expect((await r.run({ action: 'dance' })).ok).toBe(false);
  });
});

describe('card', () => {
  it('has the four buttons: Copy (own data), Edit, Skip, Sent (core data)', () => {
    expect(cardButtons(7).flat()).toEqual([
      { text: 'Скопировать', data: 'pc:7:c' }, { text: 'Править', data: 'ap:7:e' },
      { text: 'Пропустить', data: 'ap:7:r' }, { text: 'Отправлено', data: 'ap:7:a' },
    ]);
    expect(kindSpecs({ db: rig().db, now: () => T0 })[KIND_FIRST]!.buttons!(7, {})).toEqual(cardButtons(7));
  });

  it('renders contacts and the price as in the CSV', () => {
    const { store } = rig();
    const text = renderSummary(store.get(2)!, 'first', 'текст?');
    expect(text).toContain('Telegram: https://t.me/rosa_shop');
    expect(text).toContain('от $660');
  });

  it('all three kinds are locked at level 0 (the approval only records the owner send)', () => {
    const specs = kindSpecs({ db: rig().db, now: () => T0 });
    for (const k of [KIND_FIRST, KIND_FOLLOWUP, KIND_REPLY]) expect(specs[k]).toMatchObject({ initialLevel: 0, locked: true });
  });
});

describe('approval outcomes', () => {
  it('Sent marks the prospect sent with a date and keeps the sent text; Skip skips', async () => {
    const r = rig(() => json(GOOD));
    await r.run({ action: 'batch', limit: 2 });
    const specs = kindSpecs(r.ctx);
    await specs[KIND_FIRST]!.execute({ text: `${GOOD} `.trim(), prospectId: 3 }, 1);
    expect(r.store.get(3)).toMatchObject({ status: 'sent', sentAt: T0, draft: null, sentText: GOOD });
    onDecision(r.ctx, { kind: KIND_FIRST, payload: { prospectId: 5 } }, 'rejected');
    expect(r.store.get(5)).toMatchObject({ status: 'skipped', draft: null });
  });

  it('an edited text is what counts as sent', async () => {
    const r = rig(() => json(GOOD));
    await r.run({ action: 'batch', limit: 1 });
    await kindSpecs(r.ctx)[KIND_FIRST]!.execute({ text: 'Мой текст от $290. Идёт?', prospectId: 3 }, 1);
    expect(r.store.get(3)!.sentText).toBe('Мой текст от $290. Идёт?');
  });

  it('refuses text with [цена]; a failed first card goes back to the new ones', async () => {
    const r = rig(() => json(GOOD));
    await r.run({ action: 'batch', limit: 1 });
    await expect(kindSpecs(r.ctx)[KIND_FIRST]!.execute({ text: 'Цена [цена]', prospectId: 3 }, 1)).rejects.toThrow(/цена/);
    expect(r.store.get(3)!.status).toBe('proposed');
    onDecision(r.ctx, { kind: KIND_FIRST, payload: { prospectId: 3 } }, 'failed');
    expect(r.store.get(3)).toMatchObject({ status: 'new', draft: null });
    expect(r.store.pickNew(1)[0]!.id).toBe(3);
  });
});

describe('follow-ups', () => {
  it('prepares follow-up 1 after 3 days and 2 after 7, then closes as no_reply after 10', async () => {
    const r = rig(() => 'x', 1);
    await r.run({ action: 'batch' });
    await kindSpecs(r.ctx)[KIND_FIRST]!.execute({ text: r.store.get(3)!.draft!, prospectId: 3 }, 1);
    r.staged.length = 0;

    r.clock.t = T0 + 2 * DAY;
    await r.run({ action: 'followups' });
    expect(r.staged).toHaveLength(0);

    r.clock.t = T0 + 3 * DAY;
    await r.run({ action: 'followups' });
    expect(r.staged[0]!.kind).toBe(KIND_FOLLOWUP);
    expect(r.staged[0]!.summary).toContain('Дожим 1 (через 3 дн.)');
    expect(r.store.get(3)).toMatchObject({ followups: 1, draftKind: 'followup' });
    await kindSpecs(r.ctx)[KIND_FOLLOWUP]!.execute({ text: r.staged[0]!.payload.text, prospectId: 3 }, 2);
    expect(r.store.get(3)).toMatchObject({ status: 'sent', draft: null });

    r.clock.t = T0 + 7 * DAY;
    await r.run({ action: 'followups' });
    expect(r.staged[1]!.summary).toContain('Дожим 2 (через 7 дн.)');
    onDecision(r.ctx, { kind: KIND_FOLLOWUP, payload: { prospectId: 3 } }, 'rejected');
    expect(r.store.get(3)!.status).toBe('sent');

    r.clock.t = T0 + 10 * DAY;
    expect((await r.run({ action: 'followups' })).result).toContain('закрыто без ответа 1');
    expect(r.store.get(3)!.status).toBe('no_reply');
  });

  it('does not nag prospects that replied', async () => {
    const r = rig(() => 'x', 1);
    await r.run({ action: 'batch' });
    await kindSpecs(r.ctx)[KIND_FIRST]!.execute({ text: r.store.get(3)!.draft!, prospectId: 3 }, 1);
    expect(markReplied(r.store, 3).ok).toBe(true);
    r.clock.t = T0 + 8 * DAY;
    r.staged.length = 0;
    await r.run({ action: 'followups' });
    expect(r.staged).toHaveLength(0);
  });
});

describe('reply flow', () => {
  async function sent3(handler: Parameters<typeof rig>[0]) {
    const r = rig(handler, 1);
    await r.run({ action: 'batch' });
    await kindSpecs(r.ctx)[KIND_FIRST]!.execute({ text: r.store.get(3)!.draft!, prospectId: 3 }, 1);
    r.staged.length = 0;
    return r;
  }

  it('marks a reply and drafts an answer without prices', async () => {
    const r = await sent3((req) => json(isReplyPrompt(req.system) ? 'Спасибо! Стоимость: [цена]. Удобно в 11:00 или в 15:00?' : GOOD));
    expect(markReplied(r.store, 3).ok).toBe(true);
    expect(r.store.get(3)!.status).toBe('replied');
    const res = await r.run({ action: 'reply', prospectId: 3, replyText: 'Сколько стоит?' });
    expect(res.ok).toBe(true);
    const s = r.staged[0]!;
    expect(s.kind).toBe(KIND_REPLY);
    expect(s.summary).toContain('Ответ на реплику #3');
    expect(s.summary).toContain('[цена]');
    expect(s.payload.text).toContain('[цена]');
    // «Отправлено» with the placeholder does not go through; after the owner's edit it does
    await expect(kindSpecs(r.ctx)[KIND_REPLY]!.execute(s.payload, 5)).rejects.toThrow();
    await kindSpecs(r.ctx)[KIND_REPLY]!.execute({ ...s.payload, text: 'Стоимость от $290. Созвонимся в 11:00?' }, 5);
    expect(r.store.get(3)).toMatchObject({ status: 'replied', draft: null });
  });

  it('uses the template when the model names a price itself', async () => {
    const r = await sent3((req) => json(isReplyPrompt(req.system) ? 'Это стоит $777, берёте?' : GOOD));
    markReplied(r.store, 3);
    await r.run({ action: 'reply', prospectId: 3, replyText: 'Сколько?' });
    expect(r.store.get(3)!.draft).not.toContain('$777');
    expect(r.store.get(3)!.draft).toContain('11:00');
  });

  it('refuses before sending, for a bad id, and without the reply text', async () => {
    const r = rig();
    expect(markReplied(r.store, 1)).toMatchObject({ ok: false, reason: 'status' });
    expect(markReplied(r.store, 999)).toMatchObject({ ok: false, reason: 'unknown' });
    expect((await r.run({ action: 'reply', prospectId: 1, replyText: '' })).ok).toBe(false);
    expect((await r.run({ action: 'reply', prospectId: 99, replyText: 'x' })).ok).toBe(false);
  });
});

describe('stats', () => {
  it('shows the funnel by status and niche', () => {
    const { store } = rig();
    expect(statsText(store)).toContain('Воронка, всего 5: новые 5');
    expect(statsText(store)).toContain('Учебные центры и репетиторы (2)');
  });
});
