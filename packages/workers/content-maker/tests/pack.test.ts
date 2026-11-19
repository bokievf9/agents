import { MockLlm } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { carouselSchema, clipSchema, replacePart, splitPlatforms } from '../src/format.js';
import { DEFAULT_CADENCE, KIND, buildPackPlan, hasCarousel, isoWeek, queueText, statsText, storeFor, todayReport } from '../src/worker.js';
import { lintText } from '../src/lint.js';
import { OffLlm, carouselJson, clipJson, setup } from './helpers.js';

describe('pack generation', () => {
  it('plans 7 reels, 3 posts, 2 carousels and 5 stories: one draft item each, topics recorded', async () => {
    const { worker, ctx, task } = setup();
    const specs = (await worker.plan(task({ action: 'pack' }), ctx))!;
    expect(specs).toHaveLength(17);
    expect(specs[0]!.title).toContain('Материал 1 из 17: клип, пн 23.11');
    expect(specs.at(-1)!.title).toContain('вс 29.11');
    const count = (w: string) => specs.filter((s) => s.title.includes(`: ${w}, `)).length;
    expect([count('клип'), count('пост'), count('карусель'), count('история')]).toEqual([7, 3, 2, 5]);
    const store = storeFor(ctx);
    expect(store.packExists('2026-11-23')).toBe(true);
    expect(store.item(Number(specs[0]!.meta.itemId))).toMatchObject({ status: 'draft', plannedDate: '2026-11-23', seq: 1, total: 17 });
    // posts and stories get format topics (fmt:...), reels and carousels the direction x angle ones
    const keys = specs.map((s) => store.item(Number(s.meta.itemId))!);
    expect(keys.filter((i) => i.type === 'post' || i.type === 'story').every((i) => i.topicKey.startsWith('fmt:'))).toBe(true);
    expect(keys.filter((i) => i.type === 'clip' || i.type === 'carousel').every((i) => !i.topicKey.startsWith('fmt:'))).toBe(true);
  });

  it('a week that already has a pack plans nothing unless forced; other actions are not split', async () => {
    const { worker, ctx, task } = setup();
    await worker.plan(task({ action: 'pack' }), ctx);
    expect(await worker.plan(task({ action: 'pack' }), ctx)).toEqual([]);
    expect(await worker.plan(task({ action: 'pack', force: true }), ctx)).toHaveLength(17);
    expect(await worker.plan(task({ action: 'topic' }), ctx)).toBeNull();
  });

  it('plan throws with the LLM off and creates nothing', async () => {
    const { worker, ctx, task } = setup({ llm: new OffLlm() });
    await expect(worker.plan(task({ action: 'pack' }), ctx)).rejects.toThrow(/LLM off/);
    expect(storeFor(ctx).packExists('2026-11-23')).toBe(false);
  });

  it('run fills an item and stages exactly one approval with the text and item id', async () => {
    const { worker, ctx, task, staged } = setup();
    const specs = (await worker.plan(task({ action: 'pack' }), ctx))!;
    const res = await worker.run(task(specs[0]!.meta), ctx);
    expect(res.ok).toBe(true);
    expect(res.result).toContain('Пакет, материал 1 из 17');
    expect(staged).toHaveLength(1);
    expect(staged[0]!.kind).toBe(KIND);
    expect(staged[0]!.summary).toContain('клип, Instagram + TikTok + Shorts');
    expect(staged[0]!.summary).toContain('Выход: пн 23.11');
    expect(staged[0]!.payload).toMatchObject({ itemId: specs[0]!.meta.itemId });
    expect(String(staged[0]!.payload.text)).toContain('== TikTok ==');
    expect(storeFor(ctx).counts().proposed).toBe(1);
  });

  it('a topic task makes one standalone item (карусель prefix makes a carousel)', async () => {
    const { worker, ctx, task, staged } = setup();
    expect((await worker.run(task({ action: 'topic', topic: 'бот-администратор для барбершопа' }), ctx)).ok).toBe(true);
    expect(staged[0]!.summary).toContain('Отдельный материал');
    expect(staged[0]!.summary).toContain('Выход: чт 19.11');
    expect((await worker.run(task({ action: 'topic', topic: 'карусель про цены' }), ctx)).ok).toBe(true);
    expect(staged[1]!.summary).toContain('карусель, Instagram');
    expect((await worker.run(task({ action: 'topic', topic: '  ' }), ctx)).ok).toBe(false);
    expect((await worker.run(task({ action: 'wat' }), ctx)).ok).toBe(false);
  });

  it('rework: feedback goes into the prompt together with the previous text, same item is reused', async () => {
    const { worker, ctx, task, staged, llm } = setup();
    const first = await worker.run(task({ action: 'topic', topic: 'тема' }), ctx);
    expect(first.ok).toBe(true);
    const itemId = staged[0]!.payload.itemId;
    const res = await worker.run(task({ action: 'topic', itemId, feedback: 'слишком длинно, добавь цену' }), ctx);
    expect(res.ok).toBe(true);
    expect((llm as MockLlm).calls.at(-1)!.messages[0]!.content).toContain('слишком длинно, добавь цену');
    expect(staged[1]!.summary).toContain('вторая версия');
    expect(staged[1]!.payload.itemId).toBe(itemId);
  });

  it('with the LLM off, run fails with an explanation', async () => {
    const { worker, ctx, task } = setup({ llm: new OffLlm() });
    const res = await worker.run(task({ action: 'topic', topic: 'x' }), ctx);
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toContain('LLM off');
  });

  it('survives a model that returns garbage: the item fails, nothing is staged', async () => {
    const llm = new MockLlm(() => 'не json');
    const { worker, ctx, task, staged } = setup({ llm });
    const res = await worker.run(task({ action: 'topic', topic: 'x' }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('не дала валидный ответ');
    expect(staged).toHaveLength(0);
    expect(storeFor(ctx).counts().failed).toBe(1);
  });

  it('approval: the item becomes ready with one row per platform, planned date and the edited flag', async () => {
    const { worker, ctx, task, staged } = setup();
    await worker.run(task({ action: 'topic', topic: 'бот-администратор для барбершопа' }), ctx);
    const store = storeFor(ctx);
    const spec = worker.kindSpec(ctx, () => true);
    expect(spec).toMatchObject({ initialLevel: 0, keepManual: true }); // content is not money: never locked, never promoted
    expect(spec.locked).toBeFalsy();
    await spec.execute(staged[0]!.payload, 1);
    const rows = store.readyRows();
    expect(rows.map((r) => r.platform)).toEqual(['instagram', 'tiktok', 'shorts']);
    expect(rows[0]!.plannedDate).toBe('2026-11-19');
    expect(rows[1]!.text).toContain('TikTok:');
    expect(rows[1]!.text).not.toContain('Shorts:');
    expect(store.counts()).toMatchObject({ ready: 1, edited: 1 });
    expect(queueText(store)).toContain('клип, Instagram + TikTok + Shorts');
    expect(todayReport(store, '2026-11-19')).toContain('к выходу (1)');
    expect(todayReport(store, '2026-11-20')).toContain('нет');
    expect(statsText(store)).toContain('Одобрено: 1');
  });

  it('queue and stats on an empty database', () => {
    const { ctx } = setup();
    expect(queueText(storeFor(ctx))).toContain('нет');
    expect(statsText(storeFor(ctx))).toContain('Одобрено: 0');
  });

  it('a pack limited by config: 3 clips, nothing else', async () => {
    const { worker, ctx, task } = setup({ clipsPerWeek: 3, carouselsPerWeek: 0, postsPerWeek: 0, storiesPerWeek: 0 });
    expect(await worker.plan(task({ action: 'pack' }), ctx)).toHaveLength(3);
  });

  it('schemas: tolerant hashtags, duration bounds, slide counts', () => {
    const ok = clipSchema.safeParse({ ...JSON.parse(clipJson()), captions: { ...JSON.parse(clipJson()).captions, instagram: { text: 'a', hashtags: 'x y' } } });
    expect(ok.success && ok.data.captions.instagram.hashtags).toEqual(['#x', '#y']);
    expect(clipSchema.safeParse(JSON.parse(clipJson({ durationSec: 55 }))).success).toBe(false);
    expect(carouselSchema.safeParse({ ...JSON.parse(carouselJson()), slides: [{ title: 'a', lines: ['b'] }] }).success).toBe(false);
  });

  it('lint flags banned constructs, foreign prices and a missing firtech.pro', () => {
    expect(lintText('Это не бот, это сотрудник. firtech.pro')).toContain('оборот «это не X»');
    expect(lintText('Бот за $99. firtech.pro').some((i) => i.startsWith('цена не из справки'))).toBe(true);
    expect(lintText('Бот от $250. firtech.pro')).toEqual([]);
    // current site prices pass, the stale ones of the old table fail
    for (const ok of ['Бот-администратор от $290', 'Приёмщик от $220', 'Mini App от $660', 'Внедрение ИИ от $550', 'Контент от $90 и $60 в месяц', 'Dono $150 + $15 в месяц']) {
      expect(lintText(`${ok}. firtech.pro`), ok).toEqual([]);
    }
    for (const stale of ['$300', '$400', '$25', '$501']) expect(lintText(`Цена ${stale}. firtech.pro`).some((i) => i.startsWith('цена не из справки')), stale).toBe(true);
    expect(lintText('Просто текст')).toContain('нет firtech.pro в призыве');
  });

  it('splits platform sections of an approved text', () => {
    const { body, sections } = splitPlatforms('Тело\n\n== Instagram ==\nig\n#a\n\n== Shorts ==\nsh');
    expect(body).toBe('Тело');
    expect(sections).toEqual({ instagram: 'ig\n#a', shorts: 'sh' });
  });

  it('replacePart swaps one section and rebuilds the markers', () => {
    const t = 'Тело\n\n== Instagram ==\nig\n\n== TikTok ==\ntt';
    expect(replacePart(t, 'tiktok', 'новый')).toBe('Тело\n\n== Instagram ==\nig\n\n== TikTok ==\nновый');
    expect(replacePart(t, 'shorts', 'x')).toBeNull();
    expect(replacePart(t, 'script', 'Новое тело')).toBe('Новое тело\n\n== Instagram ==\nig\n\n== TikTok ==\ntt');
  });
});

describe('cadence', () => {
  it('ISO week numbers', () => {
    expect(isoWeek('2026-11-23')).toBe(48);
    expect(isoWeek('2026-11-30')).toBe(49);
    expect(isoWeek('2026-01-01')).toBe(1);
    expect(isoWeek('2027-01-01')).toBe(53);
  });

  it('carousel every other week at 0.5, every week at 1, never at 0', () => {
    const weeks = Array.from({ length: 8 }, (_, i) => 40 + i);
    expect(weeks.map((w) => hasCarousel(w, 0.5))).toEqual([true, false, true, false, true, false, true, false]);
    expect(weeks.every((w) => hasCarousel(w, 1))).toBe(true);
    expect(weeks.some((w) => hasCarousel(w, 0))).toBe(false);
  });

  it('default plan: a reel every day, posts Mon/Wed/Fri, carousels Tue/Fri, five story days', () => {
    const plan = buildPackPlan('2026-11-23');
    const days = (t: string) => plan.filter((p) => p.type === t).map((p) => p.day);
    expect(days('clip')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(days('post')).toEqual([0, 2, 4]);
    expect(days('carousel')).toEqual([1, 4]);
    expect(days('story')).toEqual([0, 1, 2, 4, 5]);
    expect(plan).toHaveLength(17);
    expect(DEFAULT_CADENCE).toEqual({ clipsPerWeek: 7, carouselsPerWeek: 2, postsPerWeek: 3, storiesPerWeek: 5 });
    expect(plan.map((p) => p.day)).toEqual([...plan.map((p) => p.day)].sort((a, b) => a - b));
  });

  it('a fractional carousel rate keeps the old behaviour; counts are configurable', () => {
    expect(buildPackPlan('2026-11-23', { ...DEFAULT_CADENCE, carouselsPerWeek: 0.5 }).filter((p) => p.type === 'carousel')).toHaveLength(1);
    expect(buildPackPlan('2026-11-30', { ...DEFAULT_CADENCE, carouselsPerWeek: 0.5 }).filter((p) => p.type === 'carousel')).toHaveLength(0);
    const plan = buildPackPlan('2026-11-23', { clipsPerWeek: 3, carouselsPerWeek: 1, postsPerWeek: 0, storiesPerWeek: 0 });
    expect(plan.filter((p) => p.type === 'clip').map((p) => p.day)).toEqual([0, 2, 4]);
    expect(plan.filter((p) => p.type === 'carousel')).toHaveLength(1);
    expect(plan).toHaveLength(4);
  });
});
