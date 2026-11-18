import { MockLlm, openDb } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { onApproved, renderCarousel, renderClip, storeFor, type Clip } from '@fir/worker-content-maker';
import { describe, expect, it } from 'vitest';
import { ManualPoster, PublishStore, PublisherWorker, assemblePacks, captionOf, groupByItem, publishedButtons, renderItemMessage } from '../src/index.js';

// Mon 2026-11-23 09:00 Tashkent
const NOW = Date.UTC(2026, 10, 23, 4, 0);
const cap = (t: string) => ({ text: `${t} подпись`, hashtags: ['#fir', '#боты'] });
const clip = (title: string): Clip => ({
  title, hook: 'Хук про запись', durationSec: 28,
  scenes: [1, 2, 3, 4].map((i) => ({ voice: `Голос ${i}`, subtitle: `Субтитр ${i}` })),
  cta: 'firtech.pro в профиле',
  captions: { instagram: cap('ig'), tiktok: cap('tt'), shorts: { title: 'Заголовок шортс', text: 'Текст шортс', hashtags: ['#shorts', '#боты'] } },
});

function setup() {
  const db = openDb(':memory:');
  const clock = { t: NOW };
  const ctx: WorkerCtx = { llm: new MockLlm(() => ''), db, tz: 'Asia/Tashkent', now: () => clock.t, requestApproval: () => Promise.resolve(0), log: () => undefined };
  const store = storeFor(ctx);
  /** An approved item planned for `date`, like the head's approval flow leaves it. */
  const approved = (title: string, date: string, type: 'clip' | 'carousel' = 'clip') => {
    const id = store.insertItem({ packId: null, seq: 1, total: 1, type, topicKey: `free:${title}`, topicText: title, plannedDate: date });
    const text = type === 'clip' ? renderClip(clip(title)) : renderCarousel({ title, slides: Array.from({ length: 6 }, (_, i) => ({ title: `С${i}`, lines: ['л'] })), cta: 'firtech.pro', captions: { instagram: cap('ig') } });
    store.setProposed(id, text, title);
    onApproved(store, { itemId: id, text }, false);
    return id;
  };
  const task = { id: 1, title: 't', body: '', dept: 'marketing', assigneeId: null, creator: 'routine', parentId: null, status: 'running', priority: 0, dueAt: null, result: null, costUsd: 0, meta: { action: 'daily' }, tags: [], routineId: null, createdAt: 0, updatedAt: 0 } as Task;
  return { ctx, db, clock, store, approved, task, worker: new PublisherWorker() };
}

describe('captionOf', () => {
  it('takes the platform section and splits trailing hashtags; Shorts keeps its title line', () => {
    const t = setup();
    t.approved('Запись ночью', '2026-11-23');
    const rows = t.store.readyRows();
    expect(captionOf(rows[0]!.text, 'instagram')).toEqual({ caption: 'ig подпись', hashtags: ['#fir', '#боты'] });
    expect(captionOf(rows[1]!.text, 'tiktok').caption).toBe('tt подпись');
    expect(captionOf(rows[2]!.text, 'shorts')).toEqual({ caption: 'Заголовок шортс\nТекст шортс', hashtags: ['#shorts', '#боты'] });
  });

  it('a text without markers is used whole, without hashtags', () => {
    expect(captionOf('просто текст', 'tiktok')).toEqual({ caption: 'просто текст', hashtags: [] });
  });
});

describe('publish packs', () => {
  it('assembles one pack per platform for items whose date has arrived; future items wait', () => {
    const t = setup();
    t.approved('Сегодня', '2026-11-23');
    t.approved('Завтра', '2026-11-24');
    const packs = assemblePacks(t.ctx, '2026-11-23');
    expect(packs.map((p) => [p.title, p.platform])).toEqual([['Сегодня', 'instagram'], ['Сегодня', 'tiktok'], ['Сегодня', 'shorts']]);
    expect(packs.every((p) => p.files.length === 0 && p.hashtags.length >= 2)).toBe(true);
    expect(groupByItem(packs)).toHaveLength(1);
  });

  it('stage 2 hook: a render lookup fills the file reference', () => {
    const t = setup();
    const id = t.approved('Сегодня', '2026-11-23');
    const packs = assemblePacks(t.ctx, '2026-11-23', (item, platform) => (item === id && platform === 'tiktok' ? '/data/render/1-tiktok.mp4' : null));
    expect(packs.map((p) => p.files)).toEqual([[], ['/data/render/1-tiktok.mp4'], []]);
  });

  it('the message carries caption, hashtags and one «Опубликовано» button per platform; overdue is marked', () => {
    const t = setup();
    t.approved('Запись ночью', '2026-11-21');
    const group = groupByItem(assemblePacks(t.ctx, '2026-11-23'))[0]!;
    const text = renderItemMessage(group, '2026-11-23');
    expect(text).toContain('Публикуем: клип «Запись ночью» (план был 21.11, не отмечено)');
    expect(text).toContain('== TikTok ==\ntt подпись\n#fir #боты');
    expect(text).toContain('Файл: пока готовит человек');
    const buttons = publishedButtons(group);
    expect(buttons[0]!.map((b) => b.text)).toEqual(['Опубликовано: Instagram', 'Опубликовано: TikTok', 'Опубликовано: Shorts']);
    expect(buttons[0]![0]!.data).toMatch(/^pb:\d+$/);
  });

  it('a carousel is Instagram only', () => {
    const t = setup();
    t.approved('Карусель', '2026-11-23', 'carousel');
    expect(assemblePacks(t.ctx, '2026-11-23').map((p) => [p.type, p.platform])).toEqual([['carousel', 'instagram']]);
  });
});

describe('Publisher: sending and the «Опубликовано» state', () => {
  it('packsToSend skips what was already sent today and offers it again the next day', () => {
    const t = setup();
    t.approved('Сегодня', '2026-11-23');
    const [g] = t.worker.packsToSend(t.ctx);
    expect(g).toHaveLength(3);
    t.worker.markSent(t.ctx, g!);
    expect(t.worker.packsToSend(t.ctx)).toEqual([]);
    t.clock.t = NOW + 86_400_000;
    expect(t.worker.packsToSend(t.ctx)).toHaveLength(1); // still not published: a reminder
  });

  it('markPublished stores published_at and platform, closes the row, and a second press changes nothing', () => {
    const t = setup();
    t.approved('Сегодня', '2026-11-23');
    const [g] = t.worker.packsToSend(t.ctx);
    const tiktok = g!.find((p) => p.platform === 'tiktok')!;
    expect(t.worker.markPublished(t.ctx, tiktok.readyId)).toEqual({ ok: true, text: 'Отмечено: TikTok' });
    expect(new PublishStore(t.db).get(tiktok.readyId)).toMatchObject({ platform: 'tiktok', publishedAt: NOW });
    expect(t.store.readyRows().map((r) => r.platform)).toEqual(['instagram', 'shorts']);
    expect(t.worker.markPublished(t.ctx, tiktok.readyId)).toEqual({ ok: false, text: 'Уже отмечено' });
    expect(t.worker.markPublished(t.ctx, 9999).ok).toBe(false);
    t.clock.t = NOW + 86_400_000;
    expect(t.worker.packsToSend(t.ctx)[0]!.map((p) => p.platform)).toEqual(['instagram', 'shorts']); // published one is gone
    expect(new PublishStore(t.db).publishedBetween(NOW - 1, NOW + 1)).toEqual([{ platform: 'tiktok', n: 1 }]);
  });

  it('run reports what goes out today, or that nothing does', async () => {
    const t = setup();
    expect((await t.worker.run(t.task, t.ctx)).result).toContain('одобренных материалов нет');
    t.approved('Запись ночью', '2026-11-23');
    const res = await t.worker.run(t.task, t.ctx);
    expect(res.ok).toBe(true);
    expect(res.result).toContain('Пакеты публикации (3 платформ, 1 материалов');
    expect(res.result).toContain('Instagram + TikTok + Shorts');
    expect((await t.worker.run({ ...t.task, meta: { action: 'wat' } }, t.ctx)).ok).toBe(false);
  });

  it('the stage 2 interface exists but the manual poster never posts', async () => {
    await expect(new ManualPoster('instagram').post()).rejects.toThrow(/manual/);
  });
});
