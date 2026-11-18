import { MockLlm } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { ownerOnly } from '../src/guard.js';
import { OWNER, clipJson, setup, smartLlm } from './helpers.js';

describe('approval state machine', () => {
  it('approve: item becomes ready with one row per platform and a planned date', async () => {
    const { head, decide, store, messenger } = setup();
    await head.onCommand('topic', 'бот-администратор для барбершопа');
    const id = messenger.sent.find((m) => m.buttons)!.buttons![0]![0]!.data.split(':')[1]!;
    await decide('approve', Number(id));
    const rows = store.readyRows();
    expect(rows.map((r) => r.platform)).toEqual(['instagram', 'tiktok', 'shorts']);
    expect(rows[0]!.plannedDate).toBe('2026-11-19');
    expect(rows[1]!.text).toContain('TikTok:');
    expect(rows[1]!.text).not.toContain('Shorts:');
    expect(store.counts().ready).toBe(1);
    expect(head.queueText()).toContain('клип, Instagram + TikTok + Shorts');
  });

  it('edit replaces the text, then approve stores the edited text', async () => {
    const { head, decide, queue, store, messenger } = setup();
    await head.onCommand('topic', 'тема');
    const aid = queue.pending()[0]!.id;
    await decide('edit', aid);
    await queue.submitEdit(OWNER, 'Клип, 25 с: правка\nCTA: firtech.pro');
    await decide('approve', aid);
    const rows = store.readyRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text).toContain('правка');
    expect(store.counts().edited).toBe(1);
    expect(messenger.sent.some((m) => m.text.includes('Пришлите новый текст'))).toBe(true);
  });

  it('reject asks for a comment, regenerates once with it, and a second reject is final', async () => {
    const llm = smartLlm();
    const { head, decide, queue, store, messenger } = setup({ llm });
    await head.onCommand('topic', 'тема');
    const first = queue.pending()[0]!.id;
    await decide('reject', first);
    expect(messenger.last()!.text).toContain('Что не так');
    expect(store.counts().rejected).toBe(1);

    expect(await head.onText('слишком длинно, добавь цену')).toBe(true);
    const lastCall = (llm as MockLlm).calls.at(-1)!.messages[0]!.content;
    expect(lastCall).toContain('слишком длинно, добавь цену');
    const second = queue.pending()[0]!.id;
    expect(second).not.toBe(first);
    expect(messenger.last()!.text).toContain('вторая версия');

    await decide('reject', second);
    expect(messenger.last()!.text).toContain('во второй раз');
    expect(await head.onText('ещё комментарий')).toBe(false);
    expect(store.counts()).toMatchObject({ rejected: 2, regenerated: 1, ready: 0 });
  });

  it('/skip cancels the awaited comment', async () => {
    const { head, decide, queue } = setup();
    await head.onCommand('topic', 'тема');
    await decide('reject', queue.pending()[0]!.id);
    await head.onCommand('skip');
    expect(await head.onText('поздно')).toBe(false);
  });

  it('a text without an awaited comment is not consumed', async () => {
    const { head } = setup();
    expect(await head.onText('привет')).toBe(false);
  });

  it('approval of an already decided item is ignored; trust stays at level 0 (locked)', async () => {
    const { head, decide, queue } = setup({ llm: new MockLlm(() => clipJson()) });
    await head.onCommand('topic', 'тема');
    const id = queue.pending()[0]!.id;
    await decide('approve', id);
    expect(await queue.handle('approve', id, OWNER)).toBe('Уже обработано');
    expect(queue.level('content_item')).toBe(0);
  });
});

describe('commands and guard', () => {
  it('guard lets only the owner in a private chat through', async () => {
    const guard = ownerOnly(OWNER);
    let passed = 0;
    const next = async () => void passed++;
    await guard({ from: { id: OWNER }, chat: { type: 'private' } }, next);
    await guard({ from: { id: 7 }, chat: { type: 'private' } }, next);
    await guard({ from: { id: OWNER }, chat: { type: 'group' } }, next);
    await guard({}, next);
    expect(passed).toBe(1);
  });

  it('/queue and /stats on an empty database', async () => {
    const { head, messenger } = setup();
    await head.onCommand('queue');
    await head.onCommand('stats');
    expect(messenger.sent[0]!.text).toContain('нет');
    expect(messenger.sent[1]!.text).toContain('Одобрено: 0');
  });

  it('/topic without text shows usage; "карусель" prefix makes a carousel', async () => {
    const { head, messenger } = setup();
    await head.onCommand('topic', '');
    expect(messenger.last()!.text).toContain('Укажите тему');
    await head.onCommand('topic', 'карусель про цены');
    expect(messenger.last()!.text).toContain('карусель, Instagram');
  });
});
