import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { articleSchema, storeFor } from '@fir/worker-content-maker';
import { issueBody } from '../src/bridge.js';
import { DIRECTOR_COMMANDS } from '../src/tg.js';
import { OWNER, world } from './helpers.js';

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
    const types = w.hq.queuedApprovals().map((a) => store(w).item(Number(a.payload.itemId))!.type);
    const n = (x: string) => types.filter((y) => y === x).length;
    expect([n('clip'), n('post'), n('carousel'), n('story')]).toEqual([7, 3, 2, 5]);
    expect(w.hq.queuedApprovals().every((a) => a.kind === 'content_item')).toBe(true);
    expect(w.hq.task(t.id)!.result).toContain('материалов 17, на одобрение 17');
  });

  it('the card of a post shows the whole text of the material; approval renders PNG files and stores the paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-renders-'));
    const w = world({ cadence: NEW_PACK, rendersDir: dir });
    w.hq.runRoutine('marketing-weekly-pack');
    await cycle(w);
    await w.director.sendApprovalBatch(false);
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
    expect(store(w).rowsOfItem(item)[0]!.files).toHaveLength(5);
  });

  it('the Director command table knows /profile and /article, the menu stays within 20 commands', () => {
    const names = DIRECTOR_COMMANDS.map((c) => c.command);
    expect(names).toEqual(expect.arrayContaining(['profile', 'article']));
    expect(names.length).toBeLessThanOrEqual(20);
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
    expect(card.text).toContain('Статья для блога, ниша «Барбершоп»');
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

  it('approval creates a builder task whose issue body holds the article JSON in a fenced block, the file path and the instruction', async () => {
    const w = await proposed('барбершоп');
    await w.decide('approve', w.queue.pending()[0]!.id);
    const row = store(w).articles()[0]!;
    expect(row.status).toBe('approved');
    const t = w.hq.task(row.taskId!)!;
    expect(t).toMatchObject({ status: 'blocked', tags: ['builder'], dept: 'marketing' });
    const body = issueBody(w.hq, t);
    expect(body).toContain('`src/content/blog/bot-dlya-barber.ts`');
    expect(body).toContain('```json');
    const json = /```json\n([\s\S]*?)\n```/.exec(body)![1]!;
    const article = articleSchema.parse(JSON.parse(json));
    expect(article.slug).toBe('bot-dlya-barber');
    expect(article.ru.title).toBeTruthy();
    expect(article.en.title).toBeTruthy();
    expect(body).toContain('src/content/blog/index.ts');
    expect(body).toContain('/ru/solutions/barber');
    expect(body).toContain(`HQ-TASK: ${t.id}`);
  });

  it('the issue number lands in cm_articles once the bridge made the issue; no second builder task for the same article', async () => {
    const w = await proposed('барбершоп');
    await w.decide('approve', w.queue.pending()[0]!.id);
    const row = store(w).articles()[0]!;
    w.hq.setMeta(row.taskId!, { issue: { number: 42, url: 'https://github.com/x/y/issues/42' } });
    w.marketing.syncArticles();
    expect(store(w).article(row.id)!.issueNumber).toBe(42);
    expect(w.hq.tasks({ dept: 'marketing', open: true }).filter((t) => t.meta.action === 'publish_article')).toHaveLength(1);
  });

  it('a rejected article closes its row and frees the niche', async () => {
    const w = await proposed('барбершоп');
    await w.decide('reject', w.queue.pending()[0]!.id);
    expect(store(w).articles()[0]!.status).toBe('rejected');
    expect(store(w).coveredNiches().has('barber')).toBe(false);
  });

  it('«Править» on an article takes a remark: the card closes, the same row is written again and comes back as a new card', async () => {
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

  it('the weekly routine exists on Tuesday 10:00 and runs the article action', async () => {
    const w = world();
    expect(w.hq.routineByName('marketing-article-weekly')).toMatchObject({ cron: '0 10 * * 2', dept: 'marketing', meta: { action: 'article' } });
    w.hq.runRoutine('marketing-article-weekly');
    await cycle(w);
    expect(store(w).articles()).toHaveLength(1);
    expect(w.hq.queuedApprovals()[0]!.kind).toBe('article');
  });
});
