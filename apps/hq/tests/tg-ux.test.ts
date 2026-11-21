import { describe, expect, it } from 'vitest';
import { OffLlm, setupBotMenu, stripHtml, type Button } from '@fir/core';
import type { Api } from 'grammy';
import { HQ_PROFILE, KEYBOARD, menuCommand, parseNav } from '../src/tg.js';
import { TG_COMMANDS } from '../src/glue.js';
import { OWNER, world } from './helpers.js';

const texts = (b?: Button[][]) => (b ?? []).flat().map((x) => x.text);
const datas = (b?: Button[][]) => (b ?? []).flat().map((x) => x.data);
const at = (messageId: number) => ({ chatId: OWNER, messageId });

/** A world with two ordinary proposals and one locked (price) proposal, released as a batch. */
async function batch(textA = 'Пост A') {
  const w = world();
  w.hq.registerKind('post', { initialLevel: 0, execute: () => Promise.resolve() });
  w.hq.registerKind('price', { initialLevel: 0, locked: true, execute: () => Promise.resolve() });
  const ask = async (title: string, kind: string, text: string) => {
    const t = w.hq.createTask({ title, dept: 'marketing', creator: 'owner' });
    w.hq.claim(t.id, 'marketing-head');
    await w.hq.requestApproval(t.id, 'marketing-head', kind, { text }, `карточка ${title}`);
    return t;
  };
  const tasks = [await ask('A', 'post', textA), await ask('B', 'post', 'Пост B'), await ask('C', 'price', 'Цена: [цена]')];
  expect(await w.director.sendApprovalBatch(false)).toBe(3);
  const cardOf = (taskId: number) => {
    const id = w.hq.db.prepare('SELECT approval_id a FROM task_approvals WHERE task_id = ?').get(taskId) as { a: number };
    return { approvalId: id.a, messageId: w.queue.cardMessage(id.a)!.messageId };
  };
  return { w, tasks, cardOf };
}

describe('Telegram UX: command menu', () => {
  it('the one HQ bot registers two commands (/start, /pult) with Russian descriptions, its profile texts and the menu button; errors are only logged', async () => {
    const calls: { m: string; args: unknown[] }[] = [];
    const api = new Proxy({}, {
      get: (_t, m: string) => (...args: unknown[]) => {
        calls.push({ m, args });
        return m === 'setMyShortDescription' ? Promise.reject(new Error('flood')) : Promise.resolve(true);
      },
    }) as unknown as Api;
    const ok = await setupBotMenu(api, { commands: [], ownerCommands: { chatId: OWNER, commands: TG_COMMANDS }, description: HQ_PROFILE.description, shortDescription: HQ_PROFILE.short, menuButtonChatId: OWNER });
    expect(ok).toBe(4); // one step failed, the others went through
    const owner = calls.find((c) => c.m === 'setMyCommands' && (c.args[1] as { scope?: unknown })?.scope)!;
    expect(owner.args[1]).toEqual({ scope: { type: 'chat', chat_id: OWNER } });
    const list = owner.args[0] as { command: string; description: string }[];
    expect(list.map((x) => x.command)).toEqual(['start', 'pult']);
    expect(list.every((c) => /[а-яё]/i.test(c.description))).toBe(true);
    expect(calls.find((c) => c.m === 'setChatMenuButton')!.args[0]).toEqual({ chat_id: OWNER, menu_button: { type: 'commands' } });
    expect(HQ_PROFILE.description.length).toBeLessThanOrEqual(512);
    expect(HQ_PROFILE.short.length).toBeLessThanOrEqual(120);
    expect(HQ_PROFILE.description).toContain('Пульт');
  });

  it('legacy (Пульт commands, TG_APPROVAL_CARDS): /start of the Director shows the reply keyboard; its buttons map to the commands', async () => {
    const w = world();
    await w.director.onCommand('start');
    expect(w.messenger.options.at(-1)).toMatchObject({ html: true, keyboard: KEYBOARD });
    expect(KEYBOARD.rows.flat()).toEqual(['📥 Одобрения', '📋 Задачи', '📊 Статус', '🏢 Отделы', '🆘 Помощь']);
    expect(menuCommand('📥 Одобрения')).toBe('approve');
    expect(menuCommand(' Задачи ')).toBe('tasks');
    expect(menuCommand('сделай клип')).toBeNull();
    await w.director.onText('📊 Статус');
    expect(w.messenger.last()!.text).toContain('Сейчас в офисе');
  });
});

describe('Telegram UX: approval cards', () => {
  it('header with «approve all», one card per proposal: title, preview, three decision buttons', async () => {
    const { w, tasks } = await batch();
    const header = w.messenger.sent.find((m) => m.text.startsWith('Пачка на одобрение: 3'))!;
    expect(datas(header.buttons)).toEqual(['ap:all', 'ap:later']);
    const card = w.messenger.sent.find((m) => m.text.includes(`задача #${tasks[0]!.id}`))!;
    expect(card.text).toContain('<b>#');
    expect(card.text).toContain('Маркетинг · post');
    expect(card.text).toContain('<blockquote>Пост A</blockquote>');
    expect(texts(card.buttons)).toEqual(['✅ Одобрить', '✏️ Править', '❌ Отклонить']);
    const locked = w.messenger.sent.find((m) => m.text.includes(`задача #${tasks[2]!.id}`))!;
    expect(locked.text).toContain('🔒 только по одной');
  });

  it('approve: the card is edited in place to «Одобрено», no buttons left; a second press is stale', async () => {
    const { w, tasks, cardOf } = await batch();
    const a = cardOf(tasks[0]!.id);
    expect(await w.queue.handle('approve', a.approvalId, OWNER)).toBe('Одобрено');
    expect(await w.queue.settleCard(a.approvalId, at(a.messageId))).toBe(true);
    w.director.afterDecision();
    expect(stripHtml(w.messenger.textOf(a.messageId)!)).toMatch(/^✅ Одобрено · #\d+ · Маркетинг · post$/);
    expect(w.messenger.buttonsOf(a.messageId)).toBeUndefined();
    expect(w.hq.task(tasks[0]!.id)!.status).toBe('done');
    expect(await w.queue.handle('approve', a.approvalId, OWNER)).toBe('Уже обработано');
  });

  it('reject and edit: «Отклонено»; «Жду правку» keeps approve/reject; the edit text turns the old card into «Правка принята»', async () => {
    const { w, tasks, cardOf } = await batch();
    const a = cardOf(tasks[0]!.id);
    await w.queue.handle('edit', a.approvalId, OWNER);
    await w.queue.settleCard(a.approvalId, at(a.messageId));
    expect(w.messenger.textOf(a.messageId)).toContain('Жду правку');
    expect(texts(w.messenger.buttonsOf(a.messageId))).toEqual(['✅ Одобрить как есть', '❌ Отклонить']);
    expect(await w.queue.submitEdit(OWNER, 'Пост A, исправленный')).toBe(true);
    expect(stripHtml(w.messenger.textOf(a.messageId)!)).toContain('✏️ Правка принята, одобрите');
    expect(w.messenger.buttonsOf(a.messageId)).toBeUndefined();
    const fresh = w.queue.cardMessage(a.approvalId)!.messageId;
    expect(fresh).not.toBe(a.messageId);
    expect(w.messenger.textOf(fresh)).toContain('Пост A, исправленный');
    const b = cardOf(tasks[1]!.id);
    await w.queue.handle('reject', b.approvalId, OWNER);
    await w.queue.settleCard(b.approvalId, at(b.messageId));
    expect(w.messenger.textOf(b.messageId)).toContain('❌ <b>Отклонено</b>');
    expect(w.messenger.buttonsOf(b.messageId)).toBeUndefined();
  });

  it('«Одобрить все обычные» approves every ordinary card and skips the locked one; the header says so', async () => {
    const { w, tasks, cardOf } = await batch();
    const headerId = w.messenger.idAt(w.messenger.sent.findIndex((m) => m.text.startsWith('Пачка на одобрение')));
    expect(await w.director.onButton('ap:all', at(headerId))).toBe('Одобрено: 2');
    for (const t of tasks.slice(0, 2)) {
      expect(w.hq.task(t.id)!.status).toBe('done');
      expect(w.messenger.textOf(cardOf(t.id).messageId)).toContain('✅ <b>Одобрено</b>');
    }
    const locked = cardOf(tasks[2]!.id);
    expect(w.queue.get(locked.approvalId)!.status).toBe('pending');
    expect(texts(w.messenger.buttonsOf(locked.messageId))).toContain('✅ Одобрить');
    expect(stripHtml(w.messenger.textOf(headerId)!)).toContain('По одной осталось: 1');
    expect(w.messenger.buttonsOf(headerId)).toBeUndefined();
    expect(w.queue.streak('post')).toBe(2); // counted like two button presses
    expect(await w.director.onButton('ap:all', at(headerId))).toBe('Только по одной');
  });

  it('«👁 Полностью» expands a long card in place and «Свернуть» folds it back', async () => {
    const long = `${'Длинный текст поста. '.repeat(60)}КОНЕЦ`;
    const { w, tasks, cardOf } = await batch(long);
    const a = cardOf(tasks[0]!.id);
    expect(w.messenger.textOf(a.messageId)).not.toContain('КОНЕЦ');
    expect(datas(w.messenger.buttonsOf(a.messageId))).toContain(`ap:${a.approvalId}:f`);
    expect(await w.director.onButton(`ap:${a.approvalId}:f`, at(a.messageId))).toBe('Полный текст');
    expect(w.messenger.textOf(a.messageId)).toContain('КОНЕЦ');
    expect(texts(w.messenger.buttonsOf(a.messageId))).toEqual(['✅ Одобрить', '✏️ Править', '❌ Отклонить', '🔼 Свернуть']);
    await w.director.onButton(`ap:${a.approvalId}:s`, at(a.messageId));
    expect(w.messenger.textOf(a.messageId)).not.toContain('КОНЕЦ');
  });
});

describe('Telegram UX: tasks, status, departments', () => {
  it('/tasks pages by 10 with ◀ ▶ editing the same message; department filters on top', async () => {
    const w = world();
    for (let i = 1; i <= 23; i++) w.hq.createTask({ title: `Задача ${i} <b>`, dept: 'marketing', creator: 'owner' });
    await w.director.onCommand('tasks');
    const msg = w.messenger.last()!;
    const id = w.messenger.idAt(-1);
    expect(msg.text).toContain('стр. 1/3');
    expect(msg.text).toContain('&lt;b&gt;'); // titles are escaped
    expect(datas(msg.buttons)).toContain('pg:all:1');
    expect(datas([msg.buttons![0]!])).toEqual(['pg:all:0', 'pg:marketing:0']);
    expect(msg.buttons!.flat().filter((b) => b.data.startsWith('tk:'))).toHaveLength(10);
    const sent = w.messenger.sent.length;
    expect(await w.director.onButton('pg:all:1', at(id))).toBe('Стр. 2 из 3');
    expect(w.messenger.sent).toHaveLength(sent); // edited, not sent
    expect(w.messenger.textOf(id)).toContain('стр. 2/3');
    await w.director.onButton('pg:all:2', at(id));
    expect(w.messenger.buttonsOf(id)!.flat().filter((b) => b.data.startsWith('tk:'))).toHaveLength(3);
    expect(w.messenger.buttonsOf(id)!.flat().every((b) => Buffer.byteLength(b.data) <= 64)).toBe(true);
    expect(await w.director.onButton('pg:nope:0', at(id))).toBe('Устарело');
  });

  it('a task card: status, assignee, buttons by status; retry, journal, reject with a confirmation, back', async () => {
    const w = world();
    const t = w.hq.createTask({ title: 'Сломанная', dept: 'marketing', creator: 'owner' });
    w.hq.claim(t.id, 'marketing-head');
    w.hq.block(t.id, 'marketing-head', 'Сбой: нет ответа');
    await w.director.onCommand('tasks');
    const id = w.messenger.idAt(-1);
    expect(await w.director.onButton(`tk:${t.id}:o:all:0`, at(id))).toBe(`Задача #${t.id}`);
    const card = stripHtml(w.messenger.textOf(id)!);
    expect(card).toContain(`#${t.id} · Маркетинг`);
    expect(card).toContain('Статус: застряла');
    expect(card).toContain('Исполнитель: Голова маркетинга');
    expect(texts(w.messenger.buttonsOf(id))).toEqual(['🔁 Повторить', '❌ Отклонить', '📜 Журнал', '◀ Назад']);
    expect(await w.director.onButton(`tk:${t.id}:j:all:0`, at(id))).toBe('Журнал');
    expect(stripHtml(w.messenger.textOf(id)!)).toContain('застряла: сбой: нет ответа');
    expect(await w.director.onButton(`tk:${t.id}:r:all:0`, at(id))).toBe('🔁 Снова в очереди');
    expect(w.hq.task(t.id)!.status).toBe('inbox');
    expect(texts(w.messenger.buttonsOf(id))).not.toContain('🔁 Повторить');
    expect(await w.director.onButton(`tk:${t.id}:x:all:0`, at(id))).toBe('Подтвердите');
    expect(w.hq.task(t.id)!.status).toBe('inbox'); // nothing happens before «Да»
    expect(texts(w.messenger.buttonsOf(id))).toEqual(['❌ Да, отклонить', '◀ Нет']);
    expect(await w.director.onButton(`tk:${t.id}:X:all:0`, at(id))).toBe('❌ Отклонена');
    expect(w.hq.task(t.id)!.status).toBe('rejected');
    expect(texts(w.messenger.buttonsOf(id))).toEqual(['📜 Журнал', '◀ Назад']);
    await w.director.onButton('pg:all:0', at(id));
    expect(w.messenger.textOf(id)).toContain('Открытых задач нет');
    expect(await w.director.onButton('tk:99999:o:all:0', at(id))).toBe('Устарело');
  });

  it('/status has a button per department that opens its tasks; «Отделы» pauses and resumes in place', async () => {
    const w = world();
    w.hq.createTask({ title: 'Задача отдела', dept: 'marketing', creator: 'owner' });
    await w.director.onCommand('status');
    const id = w.messenger.idAt(-1);
    const st = w.messenger.last()!;
    expect(st.text).toContain('📊 <b>Сейчас в офисе:</b>');
    expect(texts(st.buttons)).toContain('Маркетинг · 1');
    expect(datas(st.buttons)).toContain('dp:list');
    await w.director.onButton('pg:marketing:0', at(id));
    expect(w.messenger.textOf(id)).toContain('Задача отдела');
    expect(w.messenger.textOf(id)).toContain('Маркетинг');
    await w.director.onText('🏢 Отделы');
    const dId = w.messenger.idAt(-1);
    expect(datas(w.messenger.last()!.buttons)).toContain('dp:marketing:o');
    await w.director.onButton('dp:marketing:o', at(dId));
    expect(texts(w.messenger.buttonsOf(dId))).toEqual(['⏸ Пауза', '📋 Задачи', '◀ Отделы']);
    expect(await w.director.onButton('dp:marketing:p', at(dId))).toBe('⏸ На паузе');
    expect(w.hq.agent('marketing-head')!.status).toBe('paused');
    expect(texts(w.messenger.buttonsOf(dId))[0]).toBe('▶ Возобновить');
    await w.director.onButton('dp:marketing:r', at(dId));
    expect(w.hq.agent('marketing-head')!.status).toBe('active');
    await w.director.onButton('dp:list', at(dId));
    expect(w.messenger.textOf(dId)).toContain('🏢 <b>Отделы</b>');
  });

  it('callback data is namespaced; unknown data is not the Director’s', async () => {
    const w = world();
    expect(parseNav('tk:12:o:marketing:3')).toEqual({ ns: 'tk', id: 12, op: 'o', filter: 'marketing', page: 3 });
    expect(parseNav('dp:list')).toEqual({ ns: 'dp', dept: null, op: 'list' });
    expect(parseNav('ap:5:a')).toBeNull(); // the core's decision buttons
    expect(await w.director.onButton('zz:1', at(1))).toBeNull();
  });
});

describe('Telegram UX: unknown input and presence', () => {
  it('unknown text and unknown commands get a short hint with the keyboard', async () => {
    const off = world({ llm: new OffLlm() });
    await off.director.onText('привет');
    expect(off.messenger.last()!.text).toContain('Кнопки внизу');
    expect(off.messenger.options.at(-1)).toMatchObject({ keyboard: KEYBOARD });
    await off.director.onCommand('nonsense');
    expect(off.messenger.last()!.text).toContain('Не знаю команды /nonsense');
    expect(off.messenger.options.at(-1)).toMatchObject({ keyboard: KEYBOARD });
  });

  it('through the owner channel: Telegram gets HTML, the inbox (website) plain text', async () => {
    const w = world({ presence: true });
    w.hq.createTask({ title: 'Задача', dept: 'marketing', creator: 'owner' });
    await w.channel!.asReply(() => w.director.onCommand('status'));
    expect(w.messenger.last()!.text).toContain('<b>');
    expect(w.messenger.options.at(-1)).toMatchObject({ html: true });
    const item = w.channel!.list().at(-1)!;
    expect(item.text).toContain('📊 Сейчас в офисе:');
    expect(item.text).not.toContain('<b>');
  });
});
