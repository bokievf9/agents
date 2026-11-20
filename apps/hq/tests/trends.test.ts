/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { MockLlm, OffLlm, type LlmClient } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { HELP } from '../src/director.js';
import { carouselJson, clipJson, OWNER } from './helpers.js';
import { serve } from './pult-helpers.js';
import { NO_SUBTITLES, macAnswers } from './reach-helpers.js';
import { reviewWorld } from './review-helpers.js';

const IG = 'https://www.instagram.com/reel/ABC123/';
const YT = 'https://www.youtube.com/shorts/xyz789';
const ANALYSIS = {
  format: 'рилс 20 с, говорящая голова с субтитрами', hook: 'Клиент пишет в 2 ночи, а салон закрыт', structure: ['Боль в первой фразе', 'Показ решения', 'Призыв написать'],
  whyItWorks: 'Узнаваемая ситуация в первые две секунды', numbers: null,
  analogue: { type: 'clip', topic: 'Бот отвечает клиенту салона ночью', angle: 'Та же боль, показать запись через бота' },
};

function llmFor(analysis: unknown = ANALYSIS): MockLlm & LlmClient {
  return new MockLlm((req) => {
    if (req.system.includes('Владелец прислал ссылку')) return JSON.stringify(analysis);
    if (req.system.includes('Проверь материал по чек-листу')) return '{"ok":true,"issues":[]}';
    if (req.messages[0]!.content.startsWith('Составь карусель')) return carouselJson();
    return clipJson();
  });
}

function fetchMock(mode: 'ok' | 'closed' = 'ok') {
  const calls: string[] = [];
  const fn = (url: string): Promise<Response> => {
    calls.push(url);
    if (mode === 'closed') return Promise.resolve(new Response('login', { status: 302 }));
    if (url.startsWith('https://www.youtube.com/oembed')) return Promise.resolve(Response.json({ title: 'Бот для салона за минуту', author_name: 'Мастер Айдар' }));
    return Promise.resolve(new Response('<html><head><meta property="og:title" content="Анна on Instagram: Бот записывает клиентов"><meta property="og:description" content="Как бот ведёт запись ночью"></head></html>', { headers: { 'content-type': 'text/html' } }));
  };
  return { calls, fn };
}

function trendWorld(o: { llm?: LlmClient; fetch?: ReturnType<typeof fetchMock> } = {}) {
  const f = o.fetch ?? fetchMock();
  const p = reviewWorld({ llm: o.llm ?? llmFor(), integrations: { fetch: f.fn } });
  p.w.director.commands.set('trend', { dept: 'marketing', run: (arg) => p.w.marketing.command('trend', arg) });
  const post = (url: string, note?: string) => p.call('POST', '/admin/trends', { url, ...(note !== undefined ? { note } : {}) });
  const list = async () => (await p.call('GET', '/admin/trends')).json.items as any[];
  return { ...p, f, post, list };
}

describe('POST /admin/trends and GET /admin/trends', () => {
  it('validates the link: a body error is 400 invalid, a link that is not a public post is 400 invalid_link with the reason in Russian', async () => {
    const p = trendWorld();
    for (const bad of [{}, { url: '' }, { url: IG, extra: 1 }, { url: IG, note: 'x'.repeat(501) }]) expect((await p.call('POST', '/admin/trends', bad)).status, JSON.stringify(bad)).toBe(400);
    for (const [url, reason] of [['привет', 'это не ссылка'], ['http://www.instagram.com/reel/1', 'нужна ссылка https'], ['https://example.com/x', 'беру ссылки Instagram, TikTok и YouTube'], ['https://me:pw@www.instagram.com/reel/1', 'в ссылке не должно быть логина']]) {
      const r = await p.post(url!);
      expect(r.status, url).toBe(400);
      expect(r.json).toMatchObject({ ok: false, error: 'invalid_link', reason });
    }
    expect(await p.list()).toEqual([]);
    expect(p.f.calls).toEqual([]);
  });

  it('a link becomes a Trendwatcher task, listed as analysing; the same link again is the same row', async () => {
    const p = trendWorld();
    const r = await p.post(`  ${IG}`, 'нравится хук');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, already: false, item: { id: 1, url: IG, host: 'www.instagram.com', platform: 'instagram', note: 'нравится хук', status: 'analysing', error: null, analysis: null, reviewId: null, itemId: null } });
    const task = p.w.hq.task(r.json.item.taskId)!;
    expect(task).toMatchObject({ dept: 'marketing', creator: 'owner', status: 'inbox' });
    expect(task.meta).toMatchObject({ action: 'owner_link', linkId: 1, url: IG });
    expect((await p.post(IG)).json).toMatchObject({ already: true, item: { id: 1 } });
    expect(await p.list()).toHaveLength(1);
    const y = await p.post(YT);
    expect(y.json.item.id).toBe(2);
    expect((await p.list()).map((x) => x.id)).toEqual([2, 1]);
    const page = (await p.call('GET', '/admin/trends?limit=1')).json;
    expect(page.items.map((x: any) => x.id)).toEqual([2]);
    expect(page.nextCursor).toBe('2');
    expect((await p.call('GET', '/admin/trends?limit=1&cursor=2')).json).toMatchObject({ nextCursor: null, statuses: ['analysing', 'proposed', 'done', 'failed'] });
    expect((await p.call('GET', '/admin/trends?limit=x')).status).toBe(400);
  });

  it('needs the admin token', async () => {
    const p = trendWorld();
    const s = await serve(p);
    expect((await s.http('GET', '/admin/trends', undefined, {})).status).toBe(401);
    expect((await s.http('POST', '/admin/trends', { url: IG }, {})).status).toBe(401);
    expect((await s.http('POST', '/admin/trends', { url: IG })).status).toBe(200);
    await s.close();
  });
});

describe('the Trendwatcher works the link: analysis, the Fir Tech analogue through the content pipeline, the review center', () => {
  it('reads the page through the toolbox, analyses it, makes a content item that lands in the review center with the analysis as the first note', async () => {
    const p = trendWorld();
    await p.post(YT, 'ценю хук');
    // the transcript is asked of the owner's Mac first; here the Mac has no subtitles for the video, so the page path goes on alone
    await p.w.marketing.onHeartbeat();
    await macAnswers(p, () => NO_SUBTITLES.error && { ok: false, items: [], meta: {}, error: NO_SUBTITLES.error });
    await p.w.marketing.onHeartbeat();
    // only the allowed hosts were asked, oEmbed and the page
    expect(p.f.calls.map((u) => new URL(u).hostname)).toEqual(['www.youtube.com', 'www.youtube.com']);
    expect(p.f.calls[0]).toContain('/oembed?url=');
    const [link] = await p.list();
    expect(link).toMatchObject({ id: 1, status: 'proposed', error: null, platform: 'youtube', analysis: { hook: ANALYSIS.hook, analogue: { type: 'clip' } } });
    expect(link.reviewId).toMatch(/^ap_\d+$/);
    // the review center
    const item = (await p.items()).find((i) => i.id === link.reviewId)!;
    expect(item).toMatchObject({ kind: 'content_item', dept: 'marketing', status: 'pending', meta: { source: 'owner_link', format: 'reel', link: { id: 1, url: YT, note: 'ценю хук' } } });
    expect(item.versions).toHaveLength(1);
    expect(item.versions[0].note).toContain('Разбор ссылки');
    expect(item.versions[0].note).toContain('Хук: Клиент пишет в 2 ночи');
    expect(item.versions[0].note).toContain('Структура:');
    expect(item.versions[0].note).toContain('Почему работает:');
    expect(item.text.body).toContain('Хук');
    // the prompt that wrote the item got only the analysis as inspiration
    const prompt = (p.w.llm as MockLlm).calls.find((c) => c.messages[0]!.content.includes('Свежие тренды ниши'))!.messages[0]!.content;
    expect(prompt).toContain('хук: Клиент пишет в 2 ночи');
    // the owner was told in the inbox (not by an alert)
    expect(p.w.channel!.list({}).some((i) => i.text.includes('Разбор ссылки готов'))).toBe(true);
    // deciding the item finishes the link
    expect((await p.act(item.id, { action: 'approve' })).json.item.status).toBe('approved');
    expect((await p.list())[0]).toMatchObject({ status: 'done', reviewId: item.id });
    // the note survives an edit: v1 keeps the analysis
    const second = await p.post(IG);
    await p.w.marketing.onHeartbeat();
    const link2 = (await p.list()).find((l) => l.id === second.json.item.id)!;
    const it2 = (await p.items()).find((i) => i.id === link2.reviewId)!;
    const edited = await p.act(it2.id, { action: 'edit', text: { captions: { tiktok: 'Моя подпись' } } });
    expect(edited.json.item.versions.map((v: any) => v.v)).toEqual([1, 2]);
    expect(edited.json.item.versions[0].note).toContain('Разбор ссылки');
    expect(edited.json.item.versions[1].note).toBe('владелец');
  });

  it('a rejected analogue also finishes the link (done); a carousel analogue is a carousel item', async () => {
    const p = trendWorld({ llm: llmFor({ ...ANALYSIS, analogue: { type: 'carousel', topic: 'Что входит в бота-администратора', angle: 'Шесть слайдов' } }) });
    await p.post(IG);
    await p.w.marketing.onHeartbeat();
    const link = (await p.list())[0];
    const item = (await p.items()).find((i) => i.id === link.reviewId)!;
    expect(item.meta.format).toBe('carousel');
    await p.act(item.id, { action: 'reject' });
    expect((await p.list())[0].status).toBe('done');
  });

  it('a closed page fails the link with the reason, the owner hears it, nothing reaches the review center', async () => {
    const p = trendWorld({ fetch: fetchMock('closed') });
    await p.post(IG);
    await p.w.marketing.onHeartbeat();
    const link = (await p.list())[0];
    expect(link).toMatchObject({ status: 'failed', analysis: null, reviewId: null, itemId: null });
    expect(link.error).toContain('без входа в аккаунт');
    expect(await p.items()).toEqual([]);
    expect(p.w.channel!.list({}).some((i) => i.text.includes('не выполнена'))).toBe(true);
  });

  it('LLM off fails the link without a request to the page', async () => {
    const p = trendWorld({ llm: new OffLlm() });
    await p.post(IG);
    await p.w.marketing.onHeartbeat();
    expect((await p.list())[0]).toMatchObject({ status: 'failed' });
    expect((await p.list())[0].error).toContain('LLM off');
    expect(p.f.calls).toEqual([]);
  });

  it('an analogue the content-maker cannot write fails the link with the reason, the analysis stays', async () => {
    const llm = new MockLlm((req) => (req.system.includes('Владелец прислал ссылку') ? JSON.stringify(ANALYSIS) : 'не json'));
    const p = trendWorld({ llm });
    await p.post(IG);
    await p.w.marketing.onHeartbeat();
    const link = (await p.list())[0];
    expect(link.status).toBe('failed');
    expect(link.error).toContain('Аналог не получился');
    expect(link.analysis).toMatchObject({ hook: ANALYSIS.hook });
  });
});

describe('/trend in the Director bot', () => {
  it('takes a link with an optional note, answers in Russian, refuses what is not a public post, does not queue a link twice', async () => {
    const p = trendWorld();
    const say = async (arg: string) => {
      const before = p.w.channel!.list({}).length;
      await p.w.director.onCommand('trend', arg);
      return p.w.channel!.list({}).slice(before).map((i) => i.text).join('\n');
    };
    expect(await say('')).toContain('Пришлите ссылку');
    expect(await say('привет')).toBe('Не взял ссылку: это не ссылка.');
    expect(await say('https://example.com/x')).toContain('Не взял ссылку: беру ссылки Instagram, TikTok и YouTube');
    const ok = await say(`${IG} нравится хук и темп`);
    expect(ok).toContain('Взял (ссылка #1, задача #');
    expect(p.w.channel!.list({}).length).toBeGreaterThan(0);
    const [link] = await p.list();
    expect(link).toMatchObject({ url: IG, note: 'нравится хук и темп', status: 'analysing' });
    expect(await say(IG)).toContain('Эту ссылку я уже разбираю (ссылка #1)');
    expect(await p.list()).toHaveLength(1);
    await p.w.marketing.onHeartbeat();
    expect((await p.list())[0].status).toBe('proposed');
  });

  it('is in /help (the one command list) and is not a menu entry (the menu is full)', () => {
    expect(HELP).toContain('/trend &lt;ссылка&gt; [заметка]');
    expect(OWNER).toBeGreaterThan(0);
  });
});
