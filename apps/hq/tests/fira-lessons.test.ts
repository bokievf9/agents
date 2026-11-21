import { MockChatLlm, openDb } from '@fir/core';
import { firtechGuardContext, InMemoryKnowledge, memoryStores, run, specOf } from '@fir/fira';
import { describe, expect, it } from 'vitest';
import { harvestLessons, SqliteLessons } from '../src/fira-lessons.js';
import { ReviewVersions } from '../src/review-versions.js';

const NOW = Date.UTC(2026, 10, 23, 9, 0);

function seed() {
  const db = openDb(':memory:');
  db.exec(`CREATE TABLE task_approvals (id INTEGER PRIMARY KEY, task_id INTEGER, dept TEXT, kind TEXT, payload TEXT, summary TEXT, created_at INTEGER);
    CREATE TABLE ch_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, client_id INTEGER, session_id TEXT, chat_id INTEGER, channel TEXT, text TEXT, at INTEGER);
    CREATE TABLE ch_inbound (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, text TEXT, why TEXT, at INTEGER);`);
  db.prepare('INSERT INTO task_approvals VALUES (7, 1, ?, ?, ?, ?, ?)').run('sales', 'lead_reply', '{}', 'Салон спрашивает, сколько стоит ИИ-администратор', NOW);
  db.prepare('INSERT INTO task_approvals VALUES (8, 1, ?, ?, ?, ?, ?)').run('marketing', 'content_item', '{}', 'Пост про салоны', NOW);
  const rv = new ReviewVersions(db, () => NOW);
  rv.add('ap_7', { text: { text: 'Стоит дёшево, сделаем за неделю.' }, media: [], note: 'владелец', author: 'owner' }, { text: { text: 'Стоит $100, сделаем быстро.' }, media: [], note: '', at: NOW - 1000 });
  rv.add('ap_8', { text: { text: 'Новый пост' }, media: [], note: 'владелец', author: 'owner' }, { text: { text: 'Старый пост' }, media: [], note: '', at: NOW - 1000 });
  db.prepare('INSERT INTO ch_inbound (chat_id, text, why, at) VALUES (?, ?, ?, ?)').run(55, 'А вы работаете с клиниками в Ташкенте?', 'handoff', NOW - 500);
  db.prepare('INSERT INTO ch_messages (chat_id, channel, text, at) VALUES (?, ?, ?, ?)').run(55, 'telegram', 'Да, работаем удалённо с клиниками в любом городе.', NOW);
  return db;
}

describe('lessons of the lead manager (fira_lessons)', () => {
  it('the owner\'s edit of a client-facing sales item and his thread answer become lessons; other kinds teach nothing; a second run adds nothing', async () => {
    const db = seed();
    const lessons = new SqliteLessons(db);
    expect(await harvestLessons(db, lessons, NOW)).toBe(2);
    expect(await harvestLessons(db, lessons, NOW)).toBe(0);
    const price = await lessons.near('firtech', 'firtech/lead-manager', 'lead-manager', 'сколько стоит администратор для салона', 3);
    expect(price[0]).toMatchObject({ question: 'Салон спрашивает, сколько стоит ИИ-администратор', bad: 'Стоит $100, сделаем быстро.', good: 'Стоит дёшево, сделаем за неделю.', tag: 'review' });
    const thread = await lessons.near('firtech', 'firtech/lead-manager', 'lead-manager', 'работаете с клиниками?', 3);
    expect(thread[0]).toMatchObject({ tag: 'thread', good: 'Да, работаем удалённо с клиниками в любом городе.' });
    expect(await lessons.near('firtech', 'firtech/lead-manager', 'lead-manager', 'погода', 3)).toEqual([]);
    expect(lessons.count()).toBe(2);
  });

  it('a close question brings the lesson into the per-turn block of the prompt (few-shot)', async () => {
    const db = seed();
    const lessons = new SqliteLessons(db);
    await harvestLessons(db, lessons, NOW);
    const llm = new MockChatLlm([{ text: 'Понял.' }]);
    const s = memoryStores();
    await run(specOf({ role: 'lead-manager', niche: 'it-services', company: 'firtech' }), { id: 'c', text: 'Сколько стоит ИИ-администратор для салона?', mode: 'anon', lang: 'ru' }, {
      llm, knowledge: new InMemoryKnowledge(), memory: s.memory, journal: s.journal, lessons, now: () => NOW, guard: firtechGuardContext('ru'),
    });
    const block = JSON.stringify(llm.chats[0]!.system);
    expect(block).toContain('Уроки (так компания просила отвечать на похожие вопросы)');
    expect(block).toContain('Стоит дёшево, сделаем за неделю.');
  });
});
