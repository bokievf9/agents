import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLIENT, OWNER, setup } from './helpers.js';

describe('lead scenario (LLM off)', () => {
  it('client writes, 3 questions, card to the owner, owner approves a price, client gets it', async () => {
    const { messenger, queue, say, store, leadsFile } = setup();

    await say('Здравствуйте, хочу бота для записи клиентов');
    await say('У меня барбершоп');
    // third and last question is the deadline; the answer finishes the dialogue
    await say('Нужно за 2 недели');

    const toClient = messenger.to(CLIENT);
    expect(toClient).toHaveLength(3); // business question, deadline question, call slots
    expect(toClient.at(-1)).toContain('1)');
    expect(toClient.at(-1)).toContain('2)');
    expect(toClient.filter((t) => t.includes('?'))).toHaveLength(toClient.length - 1);

    const card = messenger.to(OWNER).find((t) => t.startsWith('Лид #1'))!;
    expect(card).toContain('Ниша: салон красоты / барбершоп');
    expect(card).toContain('Задача: Здравствуйте, хочу бота для записи клиентов');
    expect(card).toMatch(/Срок: 2 недел/);
    expect(card).toContain('Контакт: @aziz');
    expect(card).toMatch(/ТЁПЛЫЙ|ГОРЯЧИЙ/);

    // The client asks the price: a holding answer at once, the real one only after the owner approves.
    await say('Сколько это будет стоить?');
    expect(messenger.to(CLIENT).at(-1)).toContain('подтверждаю с командой');
    const before = messenger.to(CLIENT).length;
    const proposal = queue.pending()[0]!;
    expect(proposal.kind).toBe('price_quote');
    expect(messenger.to(CLIENT)).toHaveLength(before);

    await queue.handle('edit', proposal.id, OWNER);
    await queue.submitEdit(OWNER, 'Бот для записи: 300 долларов, срок 2 недели.');
    await queue.handle('approve', proposal.id, OWNER);
    expect(messenger.to(CLIENT).at(-1)).toBe('Бот для записи: 300 долларов, срок 2 недели.');
    expect(store.get(1)!.priceApproved).toBe(true);

    const lines = readFileSync(leadsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: 1, niche: 'салон красоты / барбершоп', priceApproved: true, contact: '@aziz' });
  });

  it('asks at most three questions', async () => {
    const { messenger, say } = setup();
    for (const t of ['привет', 'ну', 'ага', 'угу', 'ок']) await say(t);
    const questions = messenger.to(CLIENT).filter((x) => x.includes('?'));
    expect(questions.length).toBeLessThanOrEqual(3);
  });

  it('a price draft with an unfilled placeholder is never sent', async () => {
    const { messenger, queue, say } = setup();
    await say('Сколько стоит сайт?');
    const p = queue.pending()[0]!;
    const sentBefore = messenger.to(CLIENT).length;
    expect(await queue.handle('approve', p.id, OWNER)).toBe('Ошибка выполнения');
    expect(messenger.to(CLIENT)).toHaveLength(sentBefore);
  });

  it('prices never go out at level 1 even after many approvals (locked)', async () => {
    const { queue } = setup();
    expect(queue.level('price_quote')).toBe(0);
    expect(queue.trustTable().find((r) => r.kind === 'price_quote')?.locked).toBe(true);
  });

  it('answers in English to an English client', async () => {
    const { messenger, say } = setup();
    await say('Hello, I need a website for my dental clinic');
    expect(messenger.to(CLIENT)[0]).toMatch(/What|When|Tell/);
  });

  it('at reply level 0 the first message waits for the owner', async () => {
    const { messenger, queue, say } = setup({ replyLevel: 0 });
    await say('Здравствуйте, нужен сайт для кафе');
    expect(messenger.to(CLIENT)).toHaveLength(0);
    const p = queue.pending()[0]!;
    expect(p.kind).toBe('client_reply');
    await queue.handle('approve', p.id, OWNER);
    expect(messenger.to(CLIENT)).toHaveLength(1);
  });

  it('client picks a slot, the owner is told, the card is re-exported', async () => {
    const { messenger, say, store } = setup();
    await say('Нужен интернет-магазин, срочно');
    await say('товары для дома');
    await say('1');
    // fields: niche guessed (магазин), task, deadline guessed -> card was sent already
    const lead = store.get(1)!;
    expect(lead.state).toBe('card_sent');
    await say('1');
    expect(store.get(1)!.chosenSlot).toBe(lead.slots[0]);
    expect(messenger.to(OWNER).some((t) => t.includes('выбрал звонок'))).toBe(true);
  });
});

describe('anti-spam', () => {
  it('ignores bots and flooding chats, without replying', async () => {
    const { messenger, say } = setup({ rateLimit: 3 });
    await say('Привет, нужен бот', CLIENT, true);
    expect(messenger.sent).toHaveLength(0);
    for (let i = 0; i < 10; i++) await say(`сообщение номер ${i} про сайт`);
    const stored = messenger.to(CLIENT).length;
    await say('ещё одно');
    expect(messenger.to(CLIENT)).toHaveLength(stored);
  });

  it('silent client after the first question still gets a card after 24 hours', async () => {
    const { messenger, agent, say, clock } = setup();
    await say('Хочу автоматизацию заявок');
    expect(await agent.finalizeStale()).toBe(0);
    clock.t += 25 * 3600_000;
    expect(await agent.finalizeStale()).toBe(1);
    expect(messenger.to(OWNER).some((x) => x.startsWith('Лид #1'))).toBe(true);
  });
});
