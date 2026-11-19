import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KIT_SECTIONS, parseKitArg, renderKit, renderTiktok, renderYoutube, splitKit, tiktokProfileSchema, youtubeProfileSchema, postSchema, profileSchema, renderPost, renderProfile, renderStory, storySchema, editableParts, splitPlatforms, titleOf } from '../src/format.js';
import { lintText } from '../src/lint.js';
import { FORMAT_TOPICS, pickFormatTopics } from '../src/topics.js';
import { NICHES, PRODUCTS, TOPIC_NICHES, findNiche } from '../src/niches.js';
import { BANNER_SAFE, SIZES, framesOf, pngSize, renderFrame, renderItem } from '../src/render.js';
import { ARTICLE_KIND, IMAGE_TYPES, onApproved, storeFor } from '../src/worker.js';
import { postJson, profileJson, setup, storyJson, tiktokJson, youtubeJson } from './helpers.js';

describe('post, story and profile schemas', () => {
  it('a valid post parses, renders with the caption section and keeps its title', () => {
    const post = postSchema.parse(JSON.parse(postJson()));
    const text = renderPost(post);
    expect(text).toContain('Пост: Бот отвечает ночью');
    expect(text).toContain('== Instagram ==');
    expect(splitPlatforms(text).sections.instagram).toContain('@firtech_bot');
    expect(titleOf(text)).toBe('Бот отвечает ночью');
    expect(lintText(text, { noPrices: true })).toEqual([]);
  });

  it('post limits: title 60, caption 300-900, hashtags up to 5, one or two lines', () => {
    const bad = (o: Record<string, unknown>) => postSchema.safeParse({ ...JSON.parse(postJson()), ...o }).success;
    expect(bad({ title: 'я'.repeat(61) })).toBe(false);
    expect(bad({ caption: 'коротко' })).toBe(false);
    expect(bad({ caption: 'я'.repeat(901) })).toBe(false);
    expect(bad({ hashtags: ['#a', '#b', '#c', '#d', '#e', '#f'] })).toBe(false);
    expect(bad({ lines: ['а', 'б', 'в'] })).toBe(false);
    expect(bad({ hashtags: 'боты, салон' })).toBe(true);
  });

  it('story: 3-5 frames, the last one carries the call to action', () => {
    expect(storySchema.safeParse(JSON.parse(storyJson())).success).toBe(true);
    expect(storySchema.safeParse(JSON.parse(storyJson({ frames: [{ title: 'а', line: 'б' }, { title: 'в', line: 'г' }] }))).success).toBe(false);
    const noCta = JSON.parse(storyJson());
    noCta.frames[3] = { title: 'Хотите так же?', line: 'Пишите нам' };
    expect(storySchema.safeParse(noCta).success).toBe(false);
    const text = renderStory(storySchema.parse(JSON.parse(storyJson())));
    expect(text).toContain('История, 4 кадров');
    expect(text).toContain('Куда ведёт:');
  });

  it('profile pack: five highlights, three pinned ideas, a bio up to 150 characters', () => {
    const p = profileSchema.parse(JSON.parse(profileJson()));
    expect(p.highlights).toHaveLength(5);
    expect(renderProfile(p)).toContain('5. Связаться. Обложка: Напишите нам');
    expect(profileSchema.safeParse({ ...p, bio: 'я'.repeat(151) }).success).toBe(false);
    expect(profileSchema.safeParse({ ...p, highlights: p.highlights.slice(0, 4) }).success).toBe(false);
  });

  it('lint for posts: no prices at all, no «цифра дня», AI tells and long dashes still flagged', () => {
    expect(lintText('Бот стоит от $250. Напишите @firtech_bot', { noPrices: true })).toContain('цена в тексте: в этом материале цен нет');
    expect(lintText('Цифра дня: бот. @firtech_bot', { noPrices: true })).toContain('«цифра дня» не используем');
    expect(lintText('Это не бот, а помощник. @firtech_bot', { noPrices: true }).length).toBeGreaterThan(0);
    expect(lintText('Текст — с тире @firtech_bot', { noPrices: true })).toContain('длинное тире');
    expect(lintText('Просто текст', { noPrices: true })).toContain('нет @firtech_bot или firtech.pro в призыве');
    expect(editableParts('story')).toEqual(['script']);
    expect(editableParts('post')).toEqual(['script', 'instagram']);
  });
});

describe('niche and topic tables', () => {
  it('mirror the catalogue: 56 niches in 10 categories, 10 products', () => {
    expect(NICHES).toHaveLength(56);
    expect(new Set(NICHES.map((n) => n.category)).size).toBe(10);
    expect(PRODUCTS).toHaveLength(10);
    expect(TOPIC_NICHES).toHaveLength(55);
    expect(findNiche('барбершоп')?.id).toBe('barber');
    expect(findNiche('стоматолог')?.id).toBe('dentist');
    expect(findNiche('/ru/solutions/carwash')?.id).toBe('carwash');
    expect(findNiche('нет такой')).toBeUndefined();
  });

  it('format topics alternate products and niches, rotate formats, never repeat a subject in one pack', () => {
    expect(FORMAT_TOPICS).toHaveLength(4 * 65);
    const picked = pickFormatTopics(new Map(), 8, () => 0.3);
    expect(new Set(picked.map((t) => t.key)).size).toBe(8);
    const subjects = picked.map((t) => t.key.split(':')[2]);
    expect(new Set(subjects).size).toBe(8);
    expect(new Set(picked.map((t) => t.key.split(':')[1])).size).toBe(4);
    const prod = new Set(PRODUCTS.map((p) => p.id));
    expect(subjects.map((s, i) => prod.has(s!) === (i % 2 === 0))).toEqual(Array(8).fill(true));
  });

  it('the least recently used topic goes first', () => {
    const all = pickFormatTopics(new Map(), 8, () => 0.3);
    const history = new Map(all.map((t, i) => [t.key, 1000 + i]));
    const next = pickFormatTopics(history, 8, () => 0.3);
    expect(next.some((t) => history.has(t.key))).toBe(false);
  });
});

describe('rendering to PNG', () => {
  it('renders each kind at its size without a browser', async () => {
    for (const kind of ['post', 'slide', 'story', 'cover'] as const) {
      const png = await renderFrame({ kind, title: 'Бот отвечает ночью', lines: ['Клиент пишет в 2:00'], index: 1, total: 3 });
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(pngSize(png)).toEqual(SIZES[kind]);
    }
    expect(SIZES.post).toEqual({ width: 1080, height: 1350 });
    expect(SIZES.story).toEqual({ width: 1080, height: 1920 });
  });

  it('frames come from the item text: post, carousel (+ the call to action), story, profile covers', () => {
    const post = renderPost(postSchema.parse(JSON.parse(postJson())));
    expect(framesOf('post', post)).toEqual([{ kind: 'post', title: 'Бот отвечает ночью', lines: ['Клиент пишет в два часа ночи.', 'Утром мастер видит запись.'] }]);
    const story = framesOf('story', renderStory(storySchema.parse(JSON.parse(storyJson()))));
    expect(story).toHaveLength(4);
    expect(story[3]).toMatchObject({ kind: 'story', title: 'Хотите так же?', index: 4, total: 4 });
    const covers = framesOf('profile', renderProfile(profileSchema.parse(JSON.parse(profileJson()))));
    expect(covers).toHaveLength(5);
    expect(covers[0]).toMatchObject({ kind: 'cover', title: 'Какие боты делаем' });
    const carousel = 'Карусель, 2 слайдов: т\n\n1. Один\n   строка\n2. Два\n   строка\n\nCTA: Пишите firtech.pro\n\n== Instagram ==\nподпись #a';
    const slides = framesOf('carousel', carousel);
    expect(slides).toHaveLength(3);
    expect(slides[2]).toMatchObject({ title: 'Дальше', lines: ['Пишите firtech.pro'], total: 3 });
    expect(framesOf('post', 'сломанный текст')).toEqual([]);
    expect(framesOf('clip', 'x')).toEqual([]);
  });

  it('approval renders the files and stores their paths on the Instagram row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'renders-'));
    const { worker, ctx, task, staged } = setup({ rendersDir: dir });
    const res = await worker.run(task({ action: 'topic', topic: 'пост бот ночью' }), ctx);
    expect(res.ok).toBe(true);
    expect(staged[0]!.kind).toBe('content_item');
    const itemId = Number(staged[0]!.payload.itemId);
    expect(storeFor(ctx).item(itemId)!.type).toBe('post');
    const spec = worker.kindSpec(ctx, () => false);
    await spec.execute(staged[0]!.payload, 1);
    const row = storeFor(ctx).rowsOfItem(itemId)[0]!;
    expect(row).toMatchObject({ platform: 'instagram', status: 'ready' });
    expect(row.files).toEqual([join(dir, String(itemId), '1.png')]);
    expect(pngSize(readFileSync(row.files[0]!))).toEqual({ width: 1080, height: 1350 });
  });

  it('a render failure never blocks the approval: the item is ready without files', async () => {
    const { worker, ctx, task, staged } = setup({ rendersDir: '/dev/null/nope' });
    await worker.run(task({ action: 'topic', topic: 'история бот ночью' }), ctx);
    const itemId = Number(staged[0]!.payload.itemId);
    await worker.kindSpec(ctx, () => false).execute(staged[0]!.payload, 1);
    const row = storeFor(ctx).rowsOfItem(itemId)[0]!;
    expect(row.status).toBe('ready');
    expect(row.files).toEqual([]);
  });

  it('reels are never rendered; image types are post, carousel, story, profile', () => {
    expect(IMAGE_TYPES).toEqual(['post', 'carousel', 'story', 'profile']);
    expect(ARTICLE_KIND).toBe('article');
    void onApproved;
    void renderItem;
  });
});

describe('profile pack', () => {
  it('action profile drafts one item of type profile and stages one approval', async () => {
    const { worker, ctx, task, staged } = setup();
    const res = await worker.run(task({ action: 'profile' }), ctx);
    expect(res.ok).toBe(true);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.kind).toBe('content_item');
    expect(String(staged[0]!.payload.text)).toContain('Био:');
    expect(storeFor(ctx).item(Number(staged[0]!.payload.itemId))!.type).toBe('profile');
  });

  it('a free topic with a prefix picks the type: пост, история, карусель', async () => {
    for (const [topic, type] of [['пост про бота', 'post'], ['история про запись', 'story'], ['карусель про бота', 'carousel'], ['просто тема', 'clip']] as const) {
      const { worker, ctx, task, staged } = setup();
      await worker.run(task({ action: 'topic', topic }), ctx);
      expect(storeFor(ctx).item(Number(staged[0]!.payload.itemId))!.type).toBe(type);
    }
  });
});

describe('start kit (Instagram, YouTube, TikTok)', () => {
  it('YouTube and TikTok sections parse; the site link and limits are enforced', () => {
    const yt = youtubeProfileSchema.parse(JSON.parse(youtubeJson()));
    expect(yt.handle).toBe('@firtech');
    expect(renderYoutube(yt)).toContain('Баннер, заголовок: Боты и сайты для малого бизнеса');
    expect(youtubeProfileSchema.safeParse({ ...yt, description: 'д'.repeat(1001) }).success).toBe(false);
    expect(youtubeProfileSchema.safeParse({ ...yt, description: 'Описание без ссылки. '.repeat(10) }).success).toBe(false);
    expect(youtubeProfileSchema.safeParse({ ...yt, playlists: yt.playlists.slice(0, 2) }).success).toBe(false);
    expect(youtubeProfileSchema.safeParse({ ...yt, shorts: yt.shorts.slice(0, 4) }).success).toBe(false);
    const tt = tiktokProfileSchema.parse(JSON.parse(tiktokJson()));
    expect(tt.bio.length).toBeLessThanOrEqual(80);
    expect(renderTiktok(tt)).toContain('Что закрепить:');
    expect(tiktokProfileSchema.safeParse({ ...tt, bio: 'б'.repeat(81) + ' firtech.pro' }).success).toBe(false);
    expect(tiktokProfileSchema.safeParse({ ...tt, bio: 'Боты для бизнеса без ссылки' }).success).toBe(false);
    expect(tiktokProfileSchema.safeParse({ ...tt, hashtagSets: tt.hashtagSets.slice(0, 4) }).success).toBe(false);
  });

  it('the kit text splits back into sections; an old Instagram-only text counts as Instagram', () => {
    const ig = renderProfile(profileSchema.parse(JSON.parse(profileJson())));
    const kit = renderKit({ instagram: ig, youtube: renderYoutube(youtubeProfileSchema.parse(JSON.parse(youtubeJson()))), tiktok: renderTiktok(tiktokProfileSchema.parse(JSON.parse(tiktokJson()))) });
    expect(titleOf(kit)).toBe('Instagram + YouTube + TikTok');
    expect(Object.keys(splitKit(kit))).toEqual(KIT_SECTIONS);
    expect(splitKit(kit).youtube).toContain('Хэндл: @firtech');
    expect(Object.keys(splitKit(ig))).toEqual(['instagram']);
    expect(parseKitArg('')).toEqual(KIT_SECTIONS);
    expect(parseKitArg('YouTube')).toEqual(['youtube']);
    expect(parseKitArg('тикток')).toEqual(['tiktok']);
    expect(parseKitArg('vk')).toBeNull();
  });

  it('banner is 2560x1440 and the text frame sits in the 1546x423 safe area', async () => {
    expect(SIZES.banner).toEqual({ width: 2560, height: 1440 });
    expect(BANNER_SAFE).toEqual({ width: 1546, height: 423, x: 507, y: 508.5 });
    const png = await renderFrame({ kind: 'banner', title: 'Боты и сайты для малого бизнеса', lines: ['Запись и заявки без ручной работы'] });
    expect(pngSize(png)).toEqual({ width: 2560, height: 1440 });
    const dir = mkdtempSync(join(tmpdir(), 'kit-'));
    const kit = renderKit({ instagram: renderProfile(profileSchema.parse(JSON.parse(profileJson()))), youtube: renderYoutube(youtubeProfileSchema.parse(JSON.parse(youtubeJson()))) });
    const files = await renderItem(dir, 7, 'profile', kit);
    expect(files).toHaveLength(6);
    expect(files[0]).toContain(join('profile-instagram', '7'));
    expect(files[5]).toBe(join(dir, 'profile-youtube', '7', 'banner.png'));
    expect(pngSize(readFileSync(files[5]!))).toEqual({ width: 2560, height: 1440 });
    expect(framesOf('profile', kit).filter((f) => f.kind === 'banner')).toHaveLength(1);
  });

  it('a profile run drafts all three platforms into one card; /profile youtube scopes to one section', async () => {
    const all = setup();
    await all.worker.run(all.task({ action: 'profile' }), all.ctx);
    expect(all.staged).toHaveLength(1);
    expect(all.staged[0]!.summary).toMatch(/Instagram \+ YouTube \+ TikTok/);
    expect(Object.keys(splitKit(String(all.staged[0]!.payload.text)))).toEqual(KIT_SECTIONS);
    const yt = setup();
    await yt.worker.run(yt.task({ action: 'profile', platform: 'youtube' }), yt.ctx);
    const text = String(yt.staged[0]!.payload.text);
    expect(Object.keys(splitKit(text))).toEqual(['youtube']);
    expect(yt.staged[0]!.summary).not.toContain('TikTok');
    expect(storeFor(yt.ctx).item(Number(yt.staged[0]!.payload.itemId))!.topicKey).toBe('profile:youtube');
  });
});
