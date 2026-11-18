import { describe, expect, it } from 'vitest';
import { renderCard } from '../src/agent.js';
import { checkFirst, checkReply, firstFallback } from '../src/draft.js';
import { DAY, json, OWNER, rig, T0 } from './helpers.js';

const GOOD = 'Здравствуйте! Это Фирдавс из Fir Tech. У Cambridge запись на курс идёт только по звонку, поэтому вечером заявки теряются. Настроим бота для записи на пробный урок, от $250. Как сейчас обрабатываете вечерние заявки?';
const isReplyPrompt = (system: string) => system.includes('ответил');

describe('draft shape', () => {
  it('accepts a message with one hook, the approved price and one question', () => {
    expect(checkFirst(GOOD, 'от $250')).toBe(true);
  });
  it('rejects a wrong price, two questions, long dashes, placeholders and extra money', () => {
    expect(checkFirst(GOOD.replace('$250', '$99'), 'от $250')).toBe(false);
    expect(checkFirst(`${GOOD} Удобно?`, 'от $250')).toBe(false);
    expect(checkFirst(GOOD.replace('поэтому', '—'), 'от $250')).toBe(false);
    expect(checkFirst(GOOD.replace('от $250', 'от [цена]'), 'от $250')).toBe(false);
    expect(checkFirst(GOOD.replace('Как', 'Скидка 20 $ сегодня. Как'), 'от $250')).toBe(false);
  });
  it('fallback template passes its own check for every offer', () => {
    const { store } = rig();
    for (const p of store.pickNew(10)) {
      const price = p.offer.includes('Mini') ? 'от $500' : p.offer.includes('ИИ') ? 'от $300' : 'от $250';
      expect(checkFirst(firstFallback(p), price)).toBe(true);
    }
  });
  it('reply drafts carry no money', () => {
    expect(checkReply('Спасибо! Стоимость уточню: [цена]. Удобно в 11:00 или в 15:00?')).toBe(true);
    expect(checkReply('Это стоит 300 долларов')).toBe(false);
  });
});

describe('batch and cards', () => {
  it('uses the LLM draft when valid and sends a card with four buttons', async () => {
    const r = rig(() => json(GOOD), 1);
    await r.agent.batch();
    const card = r.messenger.sent[0]!;
    expect(card.chatId).toBe(OWNER);
    expect(card.text).toContain('#3 Cambridge');
    expect(card.text).toContain('Учебные центры и репетиторы · Бишкек');
    expect(card.text).toContain('Телефон: +996555000003');
    expect(card.text).toContain('от $250');
    expect(card.text).toContain(GOOD);
    expect(card.buttons!.flat().map((b) => b.text)).toEqual(['Скопировать', 'Править', 'Пропустить', 'Отправлено']);
    expect(r.store.get(3)).toMatchObject({ status: 'proposed', draftKind: 'first', draft: GOOD });
    expect(r.messenger.last()!.text).toMatch(/новых карточек 1/);
  });

  it('falls back to a template when the model returns garbage, and never fails the batch', async () => {
    const r = rig(() => 'sorry, no json');
    await r.agent.batch(2);
    const p = r.store.get(3)!;
    expect(p.draft).toContain('от $250');
    expect(p.draft).toContain('?');
    expect(r.store.stats().byStatus.proposed).toBe(2);
  });

  it('gives the model the price per offer (directions.ts)', async () => {
    const r = rig(() => 'x');
    await r.agent.batch(5);
    const prices = r.llm.calls.filter((c) => c.system.includes('ПЕРВОЕ')).map((c) => (JSON.parse(c.messages[0]!.content) as { price: string }).price);
    expect([...new Set(prices)].sort()).toEqual(['от $250', 'от $300', 'от $500']);
  });

  it('/next proposes one more card and says so when the base is empty', async () => {
    const r = rig();
    await r.agent.onCommand(OWNER, 'next', '');
    expect(r.store.stats().byStatus.proposed).toBe(1);
    for (let i = 0; i < 5; i++) await r.agent.onCommand(OWNER, 'next', '');
    expect(r.messenger.last()!.text).toMatch(/Новых бизнесов в базе нет/);
  });

  it('renders contacts in the card as in the CSV', () => {
    const r = rig();
    const c = renderCard(r.store.get(2)!, 'first', 'текст?');
    expect(c.text).toContain('Telegram: https://t.me/rosa_shop');
    expect(c.text).toContain('от $500');
  });
});

describe('buttons', () => {
  it('Copy resends the plain draft alone; Sent marks sent with a date; Skip skips', async () => {
    const r = rig(() => json(GOOD));
    await r.agent.batch(2);
    expect(await r.agent.onCallback(OWNER, 'pr:3:c')).toBe('Текст ниже');
    expect(r.messenger.last()).toEqual({ chatId: OWNER, text: GOOD });
    expect(await r.agent.onCallback(OWNER, 'pr:3:d')).toMatch(/отправленное/);
    expect(r.store.get(3)).toMatchObject({ status: 'sent', sentAt: T0, draft: null, sentText: GOOD });
    expect(await r.agent.onCallback(OWNER, 'pr:5:s')).toBe('Пропущено');
    expect(r.store.get(5)!.status).toBe('skipped');
    expect(await r.agent.onCallback(OWNER, 'pr:5:d')).toBe('Уже обработано');
  });

  it('Edit replaces the draft with the owner next message and shows the card again', async () => {
    const r = rig(() => json(GOOD));
    await r.agent.batch(1);
    await r.agent.onCallback(OWNER, 'pr:3:e');
    expect(await r.agent.onText(OWNER, 'Мой текст от $250. Идёт?')).toBe(true);
    expect(r.store.get(3)!.draft).toBe('Мой текст от $250. Идёт?');
    expect(r.messenger.last()!.text).toContain('Мой текст от $250. Идёт?');
    expect(await r.agent.onText(OWNER, 'ещё одно')).toBe(false);
  });

  it('ignores foreign callbacks and strangers', async () => {
    const r = rig();
    await r.agent.batch(1);
    expect(await r.agent.onCallback(999, 'pr:3:d')).toBe('Нет доступа');
    expect(r.store.get(3)!.status).toBe('proposed');
    expect(await r.agent.onCallback(OWNER, 'other:1')).toBeNull();
    expect(await r.agent.onText(999, 'правка')).toBe(false);
  });
});

describe('follow-ups', () => {
  it('proposes follow-up 1 after 3 days and 2 after 7, with buttons, then closes as no_reply', async () => {
    const r = rig(() => 'x', 1);
    await r.agent.batch();
    await r.agent.onCallback(OWNER, 'pr:3:d');
    r.messenger.sent.length = 0;

    r.clock.t = T0 + 2 * DAY;
    await r.agent.batch(0);
    expect(r.messenger.sent.filter((m) => m.buttons)).toHaveLength(0);

    r.clock.t = T0 + 3 * DAY;
    await r.agent.batch(0);
    expect(r.messenger.sent.find((m) => m.buttons)!.text).toContain('Дожим 1 (через 3 дн.)');
    expect(r.store.get(3)).toMatchObject({ followups: 1, draftKind: 'followup' });
    expect(await r.agent.onCallback(OWNER, 'pr:3:d')).toMatch(/отправленное/);
    expect(r.store.get(3)).toMatchObject({ status: 'sent', draft: null });

    r.clock.t = T0 + 7 * DAY;
    await r.agent.batch(0);
    expect(r.messenger.sent.at(-2)!.text).toContain('Дожим 2 (через 7 дн.)');
    await r.agent.onCallback(OWNER, 'pr:3:s');

    r.clock.t = T0 + 10 * DAY;
    expect((await r.agent.batch(0)).closed).toBe(1);
    expect(r.store.get(3)!.status).toBe('no_reply');
  });

  it('does not nag prospects that replied', async () => {
    const r = rig(() => 'x', 1);
    await r.agent.batch();
    await r.agent.onCallback(OWNER, 'pr:3:d');
    await r.agent.onCommand(OWNER, 'reply', '3');
    r.clock.t = T0 + 8 * DAY;
    expect((await r.agent.batch(0)).followups).toBe(0);
  });
});

describe('/reply', () => {
  it('marks a reply, asks for the text, drafts an answer without prices', async () => {
    const r = rig((req) => json(isReplyPrompt(req.system) ? 'Спасибо! Стоимость: [цена]. Удобно в 11:00 или в 15:00?' : GOOD), 1);
    await r.agent.batch();
    await r.agent.onCallback(OWNER, 'pr:3:d');
    await r.agent.onCommand(OWNER, 'reply', '3');
    expect(r.store.get(3)!.status).toBe('replied');
    expect(r.messenger.last()!.text).toMatch(/Перешлите текст ответа/);
    expect(await r.agent.onText(OWNER, 'Сколько стоит?')).toBe(true);
    const card = r.messenger.last()!;
    expect(card.text).toContain('Ответ на реплику #3');
    expect(card.text).toContain('[цена]');
    expect(card.buttons).toBeDefined();
    expect(await r.agent.onCallback(OWNER, 'pr:3:d')).toMatch(/Сначала замените/);
    await r.agent.onCallback(OWNER, 'pr:3:e');
    await r.agent.onText(OWNER, 'Стоимость от $250. Созвонимся в 11:00?');
    expect(await r.agent.onCallback(OWNER, 'pr:3:d')).toMatch(/отправленное/);
    expect(r.store.get(3)!.status).toBe('replied');
  });

  it('uses the template when the model names a price itself', async () => {
    const r = rig((req) => json(isReplyPrompt(req.system) ? 'Это стоит $300, берёте?' : GOOD), 1);
    await r.agent.batch();
    await r.agent.onCallback(OWNER, 'pr:3:d');
    await r.agent.onCommand(OWNER, 'reply', '3');
    await r.agent.onText(OWNER, 'Сколько?');
    expect(r.store.get(3)!.draft).not.toContain('$300');
    expect(r.store.get(3)!.draft).toContain('11:00');
  });

  it('refuses before sending and for a bad id', async () => {
    const r = rig();
    await r.agent.onCommand(OWNER, 'reply', '1');
    expect(r.messenger.last()!.text).toMatch(/только после «Отправлено»/);
    await r.agent.onCommand(OWNER, 'reply', 'abc');
    expect(r.messenger.last()!.text).toMatch(/Формат/);
  });
});

describe('commands', () => {
  it('stats and find answer the owner', async () => {
    const r = rig();
    await r.agent.onCommand(OWNER, 'stats', '');
    expect(r.messenger.last()!.text).toContain('Воронка, всего 5: новые 5');
    expect(r.messenger.last()!.text).toContain('Учебные центры и репетиторы (2)');
    await r.agent.onCommand(OWNER, 'find', 'ромашка');
    expect(r.messenger.last()!.text).toContain('#1 Кафе Ромашка');
    await r.agent.onCommand(OWNER, 'find', 'zzz');
    expect(r.messenger.last()!.text).toBe('Ничего не нашёл.');
  });

  it('command guard: only OWNER_TELEGRAM_ID gets anything, nothing changes for others', async () => {
    const r = rig();
    for (const name of ['batch', 'next', 'stats', 'find', 'reply', 'help']) await r.agent.onCommand(222, name, '1');
    expect(r.messenger.sent).toHaveLength(0);
    expect(r.llm.calls).toHaveLength(0);
    expect(r.store.stats().byStatus.new).toBe(5);
  });
});
