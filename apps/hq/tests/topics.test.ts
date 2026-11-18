import { openDb } from '@fir/core';
import { Hq } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { Reporter } from '../src/reporter.js';
import { TOPIC_NAMES, TopicManager, type TopicsApi } from '../src/topics.js';

function setup(opts: { forum?: boolean; type?: string; manage?: boolean; env?: Record<string, number>; group?: number | undefined } = {}) {
  const hq = new Hq(openDb(':memory:'));
  const created: string[] = [];
  let next = 10;
  const api: TopicsApi = {
    getMe: () => Promise.resolve({ id: 5 }),
    getChat: () => Promise.resolve({ type: opts.type ?? 'supergroup', is_forum: opts.forum ?? true }),
    getChatMember: () => Promise.resolve({ status: 'administrator', can_manage_topics: opts.manage ?? true }),
    createForumTopic: (_id, name) => { created.push(name); return Promise.resolve({ message_thread_id: next++ }); },
  };
  const group = 'group' in opts ? opts.group : -100;
  return { hq, created, tm: new TopicManager(hq, group, opts.env ?? {}, api) };
}

describe('topics', () => {
  it('creates only the missing topics and stores the ids', async () => {
    const { tm, created, hq } = setup({ env: { marketing: 3 } });
    const r = await tm.ensure();
    expect(r.state).toBe('ok');
    expect(created).toEqual(Object.entries(TOPIC_NAMES).filter(([k]) => k !== 'marketing').map(([, n]) => n));
    expect(tm.topics().marketing).toBe(3);
    expect(Object.keys(tm.topics())).toHaveLength(7);
    expect(JSON.parse(hq.setting('hq_topics'))).not.toHaveProperty('marketing');
    expect((await tm.ensure()).created).toEqual([]); // idempotent
    expect(created).toHaveLength(6);
  });

  it('explains the two steps when the group is not a forum, and mentions it once in the summary', async () => {
    const { tm } = setup({ forum: false, type: 'group' });
    const r = await tm.ensure();
    expect(r.state).toBe('not_forum');
    expect(r.text).toContain('Темы');
    expect(r.text).toContain('Управление темами');
    expect(tm.summaryNote()).toContain('/topics');
    expect(tm.summaryNote()).toBeNull();
  });

  it('asks for the right when the bot cannot manage topics', async () => {
    const { tm, created } = setup({ manage: false });
    expect((await tm.ensure()).state).toBe('no_right');
    expect(created).toEqual([]);
  });

  it('handles the migration: new id in settings wins over env, one activity event', () => {
    const { tm, hq } = setup({ env: { general: 2 } });
    expect(tm.onGroupEvent({ chatId: -100, migrateTo: -1009 })).toBe(true);
    expect(tm.groupId()).toBe(-1009);
    expect(hq.activity().filter((a) => a.action === 'group_migrated')).toHaveLength(1);
    expect(tm.onGroupEvent({ chatId: -1009, migrateFrom: -100 })).toBe(false); // the twin update changes nothing
    expect(hq.activity().filter((a) => a.action === 'group_migrated')).toHaveLength(1);
    expect(tm.onGroupEvent({ chatId: -555, migrateTo: -1 })).toBe(false); // a foreign chat
  });

  it('learns hand-made topics by name, case-insensitively, without overriding known ones', () => {
    const { tm } = setup({ env: { sales: 4 } });
    expect(tm.onGroupEvent({ chatId: -100, threadId: 21, topicName: 'маркетинг' })).toBe(true);
    expect(tm.onGroupEvent({ chatId: -100, threadId: 22, topicName: 'SUPPORT' })).toBe(true);
    expect(tm.onGroupEvent({ chatId: -100, threadId: 23, topicName: 'Продажи' })).toBe(false);
    expect(tm.onGroupEvent({ chatId: -100, threadId: 24, topicName: 'Болталка' })).toBe(false);
    expect(tm.onGroupEvent({ chatId: -7, threadId: 25, topicName: 'Бэк-офис' })).toBe(false);
    expect(tm.topics()).toEqual({ sales: 4, marketing: 21, support: 22 });
  });

  it('the reporter uses the Director sender for a department without its own bot, with live ids', async () => {
    const { tm } = setup({ env: { general: 2 } });
    const sent: [number, number, string][] = [];
    const rep = new Reporter(() => tm.groupId(), () => tm.topics(), new Map(), (c, t, x) => Promise.resolve(void sent.push([c, t, x])));
    expect(await rep.post('sales', 'a')).toBe(false); // no topic yet
    tm.onGroupEvent({ chatId: -100, threadId: 30, topicName: 'Продажи' });
    expect(await rep.post('sales', 'b')).toBe(true);
    tm.onGroupEvent({ chatId: -100, migrateTo: -200 });
    tm.onGroupEvent({ chatId: -200, threadId: 31, topicName: 'Продажи' });
    await rep.post('sales', 'c');
    expect(sent).toEqual([[-100, 30, 'b'], [-200, 31, 'c']]);
  });
});
