import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { storeFor } from '@fir/worker-content-maker';
import { blogApi } from '../src/blog.js';
import { DIRECTOR_COMMANDS } from '../src/tg.js';
import { COMMAND_NAMES } from '../src/commands.js';
import { OWNER, openPack, world } from './helpers.js';

const NEW_PACK = { postsPerWeek: 3, storiesPerWeek: 5, carouselsPerWeek: 2 };
const cycle = (w: ReturnType<typeof world>) => w.marketing.onHeartbeat();
const store = (w: ReturnType<typeof world>) => storeFor({ db: w.db, now: w.hq.now });

describe('Instagram page: the weekly pack', () => {
  it('7 reels, 3 posts, 2 carousels, 5 stories: 17 subtasks, each one approval of kind content_item', async () => {
    const w = world({ cadence: NEW_PACK });
    const t = w.hq.runRoutine('marketing-weekly-pack')!;
    await cycle(w);
    const kids = w.hq.tasks({ parentId: t.id });
    expect(kids).toHaveLength(17);
    expect(kids.every((k) => k.status === 'approval')).toBe(true);
    // the 17 proposals are held back: ONE card (kind content_pack) stands for them in the batch
    const types = w.hq.heldApprovals().map((a) => store(w).item(Number(a.payload.itemId))!.type);
    const n = (x: string) => types.filter((y) => y === x).length;
    expect([n('clip'), n('post'), n('carousel'), n('story')]).toEqual([7, 3, 2, 5]);
    expect(w.hq.heldApprovals().every((a) => a.kind === 'content_item')).toBe(true);
    expect(w.hq.queuedApprovals().map((a) => a.kind)).toEqual(['content_pack']);
    expect(w.hq.task(t.id)!.result).toContain('материалов 17, на одобрение 17');
  });

  it('the card of a post shows the whole text of the material; approval renders PNG files and stores the paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-renders-'));
    const w = world({ cadence: NEW_PACK, rendersDir: dir });
    w.hq.runRoutine('marketing-weekly-pack');
    await cycle(w);
    await w.director.sendApprovalBatch(false);
    await openPack(w);
    const post = w.queue.pending().find((a) => store(w).item(Number(a.payload.itemId))!.type === 'post')!;
    expect(String(post.payload.text)).toContain('На картинке:');
    expect(String(post.payload.text)).toContain('== Instagram ==');
    await w.decide('approve', post.id);
    const item = Number(post.payload.itemId);
    const row = store(w).rowsOfItem(item)[0]!;
    expect(row.files).toEqual([join(dir, String(item), '1.png')]);
    expect(existsSync(row.files[0]!)).toBe(true);
    const story = w.queue.pending().find((a) => store(w).item(Number(a.payload.itemId))!.type === 'story')!;
    await w.decide('approve', story.id);
    expect(store(w).rowsOfItem(Number(story.payload.itemId))[0]!.files).toHaveLength(4);
  });
});

describe('Publisher message of the day', () => {
  async function approvedDay(dir?: string) {
    const w = world({ cadence: NEW_PACK, ...(dir ? { rendersDir: dir } : {}) });
    w.hq.runRoutine('marketing-weekly-pack');
    await cycle(w);
    await w.director.sendApprovalBatch(false);
    await openPack(w);
    for (const a of [...w.queue.pending()]) {
      if (store(w).item(Number(a.payload.itemId))!.plannedDate === '2026-11-23') await w.decide('approve', a.id);
    }
    w.messenger.sent.length = 0;
    w.clock.t = Date.UTC(2026, 10, 23, 4, 30); // Mon 09:30 Tashkent
    return w;
  }

  it('a header with counts, then per item the album and the text with «Опубликовано»', async () => {
    const w = await approvedDay(mkdtempSync(join(tmpdir(), 'hq-day-')));
    w.hq.runRoutine('marketing-daily-today');
    await cycle(w);
    const texts = w.messenger.sent.map((m) => m.text);
    expect(texts[0]).toMatch(/^Сегодня публикуем: .*рилс.*пост.*истори/);
    expect(w.messenger.photos.length).toBeGreaterThanOrEqual(2);
    expect(w.messenger.photos.every((p) => p.chatId === OWNER && p.files.every((f) => f.endsWith('.png')))).toBe(true);
    const withButtons = w.messenger.sent.filter((m) => m.buttons?.flat().some((b) => b.data.startsWith('pb:')));
    expect(withButtons.length).toBe(3); // reel, post, story
    expect(withButtons.map((m) => m.text.split('\n')[0]).join('|')).toMatch(/клип.*\|.*пост.*\|.*история/);
  });

  it('when pictures cannot be sent the text still goes out with a clear note', async () => {
    const w = await approvedDay(mkdtempSync(join(tmpdir(), 'hq-day-')));
    (w.messenger as unknown as { sendPhotos?: unknown }).sendPhotos = undefined;
    w.hq.runRoutine('marketing-daily-today');
    await cycle(w);
    const posts = w.messenger.sent.filter((m) => m.text.startsWith('Публикуем: пост'));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain('Альбом с картинками не отправился');
  });

  it('without a renderer the text says the pictures are not made', async () => {
    const w = await approvedDay();
    w.hq.runRoutine('marketing-daily-today');
    await cycle(w);
    expect(w.messenger.photos).toHaveLength(0);
    expect(w.messenger.sent.some((m) => m.text.includes('Картинки не созданы'))).toBe(true);
  });
});

describe('/profile', () => {
  it('creates a profile task; the pack goes to one approval; approval renders five covers 1080x1920', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-profile-'));
    const w = world({ rendersDir: dir });
    expect(await w.marketing.command('profile', '')).toContain('задача #');
    await cycle(w);
    const queued = w.hq.queuedApprovals();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.kind).toBe('content_item');
    expect(String(queued[0]!.payload.text)).toContain('Био:');
    await w.director.sendApprovalBatch(false);
    await w.decide('approve', w.queue.pending()[0]!.id);
    const item = Number(queued[0]!.payload.itemId);
    const files = store(w).rowsOfItem(item)[0]!.files;
    expect(files).toHaveLength(6); // five covers and the YouTube banner
    expect(files.some((f) => f.includes('profile-youtube'))).toBe(true);
    expect(String(queued[0]!.payload.text)).toMatch(/## YouTube[\s\S]*## TikTok/);
  });

  it('/profile youtube makes one section, an unknown platform is explained', async () => {
    const w = world();
    expect(await w.marketing.command('profile', 'vk')).toContain('Не понял платформу');
    expect(await w.marketing.command('profile', 'youtube')).toContain('YouTube');
    await cycle(w);
    const queued = w.hq.queuedApprovals();
    expect(queued).toHaveLength(1);
    const text = String(queued[0]!.payload.text);
    expect(text).toContain('Хэндл: @firtech');
    expect(text).not.toContain('## TikTok');
  });

  it('the Director command list knows /profile and /article, the menu stays within 20 commands', () => {
    expect(COMMAND_NAMES).toEqual(expect.arrayContaining(['profile', 'article']));
    expect(DIRECTOR_COMMANDS.map((c) => c.command)).toContain('profile');
    expect(DIRECTOR_COMMANDS.length).toBeLessThanOrEqual(20);
  });
});

describe('Blog articles', () => {
  async function proposed(niche = '') {
    const w = world();
    expect(await w.marketing.command('article', niche)).toContain('задача #');
    await cycle(w);
    await w.director.sendApprovalBatch(false);
    return w;
  }

  it('/article <ниша> writes one article for that niche; the card has title, description, headings and a short start', async () => {
    const w = await proposed('барбершоп');
    const card = w.messenger.sent.find((m) => m.buttons?.flat().some((b) => /^ap:\d+:a$/.test(b.data)))!;
    expect(card.text).toContain('Статья дня, ниша «Барбершоп»');
    expect(card.buttons!.flat().map((b) => b.text)).toEqual(expect.arrayContaining(['✅ Одобрить', '✏️ Переписать', '❌ Отклонить']));
    expect(card.text).toContain('Разделы:');
    expect(card.text).toContain('Описание:');
    expect(store(w).articles()[0]).toMatchObject({ niche: 'barber', status: 'proposed' });
    expect(String(w.queue.pending()[0]!.payload.text).length).toBeLessThanOrEqual(700);
    expect(w.queue.pending()[0]!.kind).toBe('article');
    expect(w.queue.level('article')).toBe(0);
  });

  it('an unknown niche is refused without a task', async () => {
    const w = world();
    expect(await w.marketing.command('article', 'космос')).toContain('Не нашёл нишу');
    expect(w.hq.tasks({ dept: 'marketing' })).toHaveLength(0);
  });

  it('approval publishes the article at once: published, the approval day, a slug from the English title, no builder task, a carousel and a reel queued for the pack', async () => {
    const w = await proposed('барбершоп');
    await w.decide('approve', w.queue.pending()[0]!.id);
    const row = store(w).articles()[0]!;
    expect(row).toMatchObject({ status: 'approved', published: true, date: '2026-11-18', packQueued: true, slug: 'a-booking-bot-for-your-business-where-to-start' });
    expect(row.taskId).toBeNull();
    expect(w.hq.tasks({ dept: 'marketing' }).filter((t) => t.meta.action === 'publish_article' || t.tags.includes('builder'))).toHaveLength(0);
    const api = blogApi(w.db, w.hq.now, () => w.hq.tz);
    const list = api.list();
    expect(list.articles.map((a) => a.slug)).toEqual([row.slug]);
    expect(list.articles[0]).toMatchObject({ published: true, date: '2026-11-18' });
    expect(api.get(row.slug)!.article.en.title).toBeTruthy();
    expect(api.get('no-such')).toBeNull();
    // the next weekly pack takes it
    w.hq.runRoutine('marketing-weekly-pack');
    await cycle(w);
    expect(store(w).itemsOfSlug(row.slug).map((i) => i.type).sort()).toEqual(['carousel', 'clip']);
    expect(store(w).queuedArticles()).toHaveLength(0);
  });

  it('/article ии writes the «ИИ для бизнеса» line; without an argument the weekday decides (Wednesday: AI)', async () => {
    const w = await proposed('ии');
    expect(store(w).articles()[0]).toMatchObject({ line: 'ai', niche: 'ai', status: 'proposed' });
    expect(w.messenger.sent.find((m) => m.buttons?.flat().some((b) => /^ap:\d+:a$/.test(b.data)))!.text).toContain('Статья дня, ИИ для бизнеса');
    const w2 = await proposed('');
    expect(store(w2).articles()[0]!.line).toBe('ai');
  });

  it('a rejected article closes its row and frees the niche', async () => {
    const w = await proposed('барбершоп');
    await w.decide('reject', w.queue.pending()[0]!.id);
    expect(store(w).articles()[0]!.status).toBe('rejected');
    expect(store(w).coveredNiches().has('barber')).toBe(false);
  });

  it('«Переписать» on an article takes a remark: the card closes, the same row is written again and comes back as a new card', async () => {
    const w = await proposed('барбершоп');
    const aid = w.queue.pending()[0]!.id;
    expect(await w.director.onEditPressed(aid)).toBe('Жду замечание');
    await w.director.onText('добавь про напоминания');
    expect(w.queue.get(aid)!.status).toBe('rejected');
    expect(store(w).articles()).toHaveLength(1);
    await cycle(w);
    expect(store(w).articles()[0]).toMatchObject({ status: 'proposed' });
    expect(w.hq.queuedApprovals().filter((a) => a.kind === 'article' && a.state === 'queued')).toHaveLength(1);
    expect(w.llm instanceof Object).toBe(true);
  });

  it('the daily routine runs at 07:30 on the owner clock (the card is ready for his 08:00 digest), the weekly one is off, the action makes one article', async () => {
    const w = world();
    expect(w.hq.routineByName('marketing-article-daily')).toMatchObject({ cron: '30 7 * * *', tz: 'owner', dept: 'marketing', meta: { action: 'article' }, enabled: true });
    expect(w.hq.routineByName('marketing-article-weekly')?.enabled ?? false).toBe(false);
    w.hq.runRoutine('marketing-article-daily');
    await cycle(w);
    expect(store(w).articles()).toHaveLength(1);
    expect(store(w).articles()[0]!.line).toBe('ai');
    expect(w.hq.queuedApprovals()[0]!.kind).toBe('article');
  });
});
