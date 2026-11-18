import { describe, expect, it } from 'vitest';
import { Progress, mask, reasonRu } from '../src/progress.js';
import { OWNER, routedLlm, world } from './helpers.js';

const J = JSON.stringify;
const task = (title = 'Клип про барбершоп') => routedLlm({ intent: () => J({ type: 'task', title, dept: 'marketing' }) });

/** The owner gives a task; returns the world, the task and the id of the live message. */
async function given() {
  const w = world({ llm: task() });
  await w.director.onText('сделай клип про барбершоп');
  const t = w.hq.tasks({ dept: 'marketing' })[0]!;
  return { w, t, msg: w.messenger.sent[0]! };
}

describe('Progress: the live message of a task', () => {
  it('sends one message with what to expect, then edits it in place as the task moves', async () => {
    const { w, t } = await given();
    const p = w.director.progress;
    expect(w.messenger.sent).toHaveLength(1);
    expect(w.messenger.sent[0]!.text).toContain(`#${t.id} Маркетинг: «Клип про барбершоп»`);
    expect(w.messenger.sent[0]!.text).toContain('✅ принял · ⏳ ждёт голову отдела');
    expect(w.messenger.sent[0]!.text).toContain('Я обновлю это сообщение');
    expect(p.watching()).toEqual([t.id]);
    expect(w.hq.task(t.id)!.meta.progress).toMatchObject({ chatId: OWNER, messageId: 1 });

    // the head takes it, the content maker writes the script
    w.hq.setMeta(t.id, { action: 'topic' });
    w.hq.claim(t.id, 'marketing-head');
    const kid = w.hq.createTask({ title: 'Материал', dept: 'marketing', assigneeId: 'content-maker', creator: 'head', parentId: t.id, meta: { action: 'item' } });
    w.hq.claim(kid.id, 'content-maker');
    w.clock.t += 14_000;
    expect(await p.tick()).toBe(1);
    expect(w.messenger.textOf(1)).toContain(`#${t.id} Маркетинг`);
    expect(w.messenger.textOf(1)).toContain('✅ принял · ⏳ Контент-мейкер работает (14 с)');

    // the counter moves, so a running task is edited every 5 s, never faster
    expect(await p.tick()).toBe(0);
    w.clock.t += 5_000;
    expect(await p.tick()).toBe(1);
    expect(w.messenger.textOf(1)).toContain('Контент-мейкер работает (19 с)');
    w.hq.complete(kid.id, 'content-maker', 'готово');
    w.hq.complete(t.id, 'marketing-head', 'Сценарий: клиент пишет ночью, бот отвечает. Подпись для почты owner@example.com.', 'approval');
    expect(await p.tick()).toBe(0); // changed, but the last edit was just now
    w.clock.t += 5_000;
    expect(await p.tick()).toBe(1);
    const ready = w.messenger.textOf(1)!;
    expect(ready).toContain('✅ принял · ✅ сценарий готов (19 с) · 📋 в пачке на одобрение: /approve');
    expect(ready).toContain('Сценарий: клиент пишет ночью');
    expect(ready).not.toContain('owner@example.com');
    expect(w.messenger.edits).toHaveLength(3);
    // unchanged text: no edit however often it ticks
    expect(await p.tick()).toBe(0);

    w.hq.setStatus(t.id, 'done', 'owner');
    w.clock.t += 2_000;
    expect(await p.tick()).toBe(0);
    w.clock.t += 3_000;
    expect(await p.tick()).toBe(1);
    expect(w.messenger.textOf(1)).toContain('✅ готово (24 с)');
    // final state: watching stops, the message is not touched again
    expect(p.watching()).toEqual([]);
    expect(w.hq.task(t.id)!.meta.progress).toMatchObject({ closed: true });
    w.clock.t += 60_000;
    expect(await p.tick()).toBe(0);
    expect(w.messenger.sent).toHaveLength(1);
  });

  it('a failure says why in plain words and offers /retry, which puts the task back and sends a new live message', async () => {
    const { w, t } = await given();
    const p = w.director.progress;
    w.hq.claim(t.id, 'marketing-head');
    w.hq.block(t.id, 'marketing-head', 'Лимит расходов отдела marketing исчерпан');
    w.clock.t += 6_000;
    await p.tick();
    const failed = w.messenger.textOf(1)!;
    expect(failed).toContain('❌ не получилось: исчерпан лимит расходов отдела на месяц');
    expect(failed).toContain(`/retry ${t.id}`);
    expect(w.hq.task(t.id)!.status).toBe('blocked');

    await w.director.onCommand('retry', String(t.id));
    expect(w.hq.task(t.id)).toMatchObject({ status: 'inbox', assigneeId: null });
    expect(w.hq.pendingHeartbeats()).toBeGreaterThan(0);
    expect(w.messenger.sent).toHaveLength(2);
    expect(w.messenger.sent[1]!.text).toContain('Поставил заново в очередь отдела Маркетинг');
    expect(w.hq.task(t.id)!.meta.progress).toMatchObject({ messageId: 2 });
    expect(p.watching()).toEqual([t.id]);
  });

  it('/retry refuses tasks that are not stuck, unknown ids and closed tasks', async () => {
    const { w, t } = await given();
    await w.director.onCommand('retry', '');
    expect(w.messenger.last()!.text).toContain('Укажите номер задачи');
    await w.director.onCommand('retry', String(t.id));
    expect(w.messenger.last()!.text).toContain('не застряла');
    w.hq.setStatus(t.id, 'rejected', 'owner');
    await w.director.onCommand('retry', String(t.id));
    expect(w.messenger.last()!.text).toContain('уже закрыта');
  });

  it('survives a restart: a new tracker continues editing the same message', async () => {
    const { w, t } = await given();
    const again = new Progress({ hq: w.hq, messenger: w.messenger, ownerId: OWNER });
    expect(again.resume()).toBe(1);
    w.hq.claim(t.id, 'marketing-head');
    w.clock.t += 8_000;
    expect(await again.tick()).toBe(1);
    expect(w.messenger.edits.at(-1)).toMatchObject({ chatId: OWNER, messageId: 1 });
    expect(w.messenger.sent).toHaveLength(1);
  });

  it('stops after 2 hours and never tracks drill tasks', async () => {
    const { w, t } = await given();
    w.clock.t += 2 * 3_600_000 + 1000;
    await w.director.progress.tick();
    await w.director.progress.tick();
    expect(w.director.progress.watching()).toEqual([]);
    expect(w.hq.task(t.id)!.meta.progress).toMatchObject({ closed: true });
    const drill = w.hq.createTask({ title: 'Учения: x', dept: 'marketing', creator: 'owner', tags: ['drill'] });
    expect(await w.director.progress.track(drill)).toBe(false);
    expect(w.hq.task(drill.id)!.meta.progress).toBeUndefined();
  });

  it('a head command that creates a task turns its own reply into the live message', async () => {
    const w = world();
    w.director.commands.set('doc', {
      dept: 'backoffice',
      run: async () => {
        w.hq.createTask({ title: 'Договор: Тест', dept: 'marketing', creator: 'owner' });
        return 'Задача: договор. Черновик придёт в пачке.';
      },
    });
    await w.director.onCommand('doc', 'договор');
    expect(w.messenger.sent).toHaveLength(1);
    expect(w.messenger.sent[0]!.text).toBe('Задача: договор. Черновик придёт в пачке.');
    w.clock.t += 6_000;
    await w.director.progress.tick();
    expect(w.messenger.textOf(1)).toContain('Договор: Тест');
    expect(w.messenger.textOf(1)).toContain('Черновик придёт в пачке.');
  });
});

describe('Progress: wording helpers', () => {
  it('masks contacts, keys and tokens', () => {
    expect(mask('пишите a.b@mail.ru или +7 (999) 123-45-67')).toBe('пишите [почта] или [номер]');
    expect(mask('ключ sk-abcdefghijklmnopqrstuvwxyz1234')).toContain('[ключ]');
    expect(mask('1234567890:AAH_abcdefghijklmnopqrstuvwxyz012345')).toBe('[токен]');
  });
  it('explains reasons in Russian', () => {
    expect(reasonRu('Нужен строитель: задача для Claude Code')).toContain('нужен строитель');
    expect(reasonRu('ECONNRESET at socket')).toMatch(/^внутренняя ошибка/);
    expect(reasonRu('')).toBe('причина не записана');
    expect(reasonRu('Сбой: сайт не отвечает')).toBe('сбой: сайт не отвечает');
  });
});

describe('/status and /tasks in words', () => {
  it('/status: per department counts, last events in words, next routine', async () => {
    const w = world();
    const a = w.hq.createTask({ title: 'Первая', dept: 'marketing', creator: 'owner' });
    w.hq.claim(a.id, 'marketing-head');
    w.hq.complete(a.id, 'marketing-head', 'результат', 'approval');
    const b = w.hq.createTask({ title: 'Вторая', dept: 'marketing', creator: 'owner' });
    w.hq.claim(b.id, 'marketing-head');
    w.hq.block(b.id, 'marketing-head', 'Сбой: нет ответа');
    w.hq.createTask({ title: 'Третья', dept: 'marketing', creator: 'owner' });
    await w.director.onCommand('status');
    const text = w.messenger.last()!.text;
    expect(text).toContain('Маркетинг: работает 1 · ждут вас 1 · застряли 1');
    expect(text).toContain('Последнее:');
    expect(text).toMatch(/• \d\d:\d\d #\d Маркетинг: застряла: сбой: нет ответа/);
    expect(text).toMatch(/Дальше по расписанию: .*Маркетинг: /);
    expect(text.split('Последнее:')[1]!.split('\n\n')[0]!.trim().split('\n')).toHaveLength(3);
    expect(text).toContain('Расходы за месяц');
  });

  it('/tasks: the last event of every task in words', async () => {
    const w = world();
    const a = w.hq.createTask({ title: 'Ждёт вас', dept: 'marketing', creator: 'owner' });
    w.hq.claim(a.id, 'marketing-head');
    w.hq.complete(a.id, 'marketing-head', 'r', 'approval');
    const b = w.hq.createTask({ title: 'Застряла', dept: 'marketing', creator: 'owner' });
    w.hq.claim(b.id, 'marketing-head');
    w.hq.block(b.id, 'marketing-head', 'Сбой: нет ответа');
    w.hq.createTask({ title: 'Учения: x', dept: 'marketing', creator: 'owner', tags: ['drill'] });
    await w.director.onCommand('tasks');
    const text = w.messenger.last()!.text;
    expect(text).toContain(`#${a.id} Маркетинг: Ждёт вас\n  ждёт вас в /approve`);
    expect(text).toContain(`#${b.id} Маркетинг: Застряла\n  застряла: сбой: нет ответа (повторить: /retry ${b.id})`);
    expect(text).not.toContain('Учения');
  });

  it('/help is the compact cheat sheet', async () => {
    const w = world();
    await w.director.onCommand('help');
    const text = w.messenger.last()!.text;
    for (const c of ['/status', '/tasks', '/approve', '/retry <id>', 'группе HQ']) expect(text).toContain(c);
  });
});
