import { HostQueue, MockLlm, OffLlm, createTools, openDb, type LlmClient, type ToolFetch } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { LinkStore, analysisText, ogTags, parseLink } from '../src/link.js';
import { TrendScoutWorker } from '../src/worker.js';

const NOW = Date.UTC(2026, 10, 21, 3, 30);
const IG = 'https://www.instagram.com/reel/ABC123/';
const YT = 'https://www.youtube.com/shorts/xyz789';
const TT = 'https://www.tiktok.com/@salon/video/7300000000000000000';

const ANALYSIS = {
  format: 'рилс 20 с, говорящая голова с субтитрами', hook: 'Клиент пишет в 2 ночи, а салон закрыт', structure: ['Боль в первой фразе', 'Показ решения', 'Призыв написать'],
  whyItWorks: 'Узнаваемая ситуация в первые две секунды', numbers: null,
  analogue: { type: 'clip', topic: 'Бот отвечает клиенту салона ночью', angle: 'Та же боль, показать запись через бота' },
};

const page = (og: Record<string, string>) => `<html><head><title>x</title>${Object.entries(og).map(([k, v]) => `<meta property="${k}" content="${v}">`).join('')}</head><body>login</body></html>`;

function fakeFetch(mode: 'ok' | 'closed' | 'login' = 'ok') {
  const calls: string[] = [];
  const fn: ToolFetch = (url) => {
    calls.push(url);
    if (mode === 'closed') return Promise.resolve(new Response('forbidden', { status: 403 }));
    if (url.startsWith('https://www.youtube.com/oembed')) return Promise.resolve(Response.json({ title: 'Бот для салона за минуту', author_name: 'Мастер Айдар', thumbnail_url: 'https://i.ytimg.com/x.jpg' }));
    if (url.startsWith('https://www.tiktok.com/oembed')) return Promise.resolve(Response.json({ title: 'Салон и бот', author_name: 'salon' }));
    if (mode === 'login') return Promise.resolve(new Response('<html><body>Log in</body></html>', { headers: { 'content-type': 'text/html' } }));
    return Promise.resolve(new Response(page({ 'og:title': 'Анна on Instagram: &quot;Бот записывает клиентов&quot;', 'og:description': '1 200 лайков. Как бот ведёт запись ночью', 'og:image': 'https://cdn.example/i.jpg' }), { headers: { 'content-type': 'text/html' } }));
  };
  return { fn, calls };
}

function setup(llm: LlmClient, fetch: ToolFetch) {
  const db = openDb(':memory:');
  const tools = createTools({ agentId: 'trend-scout', dept: 'marketing', db, now: () => NOW, fetch, sleep: () => Promise.resolve(), queue: new HostQueue(() => NOW, () => Promise.resolve()) });
  const logs: string[] = [];
  const ctx: WorkerCtx = { llm, db, tz: 'Asia/Dushanbe', now: () => NOW, requestApproval: () => Promise.resolve(0), log: (a, d) => void logs.push(`${a}:${d ?? ''}`), tools };
  const links = new LinkStore(db, () => NOW);
  const run = (linkId: number) => new TrendScoutWorker().run({
    id: 1, title: 't', body: '', dept: 'marketing', assigneeId: null, creator: 'owner', parentId: null, status: 'running', priority: 0, dueAt: null, result: null, costUsd: 0,
    meta: { action: 'owner_link', linkId }, tags: [], routineId: null, createdAt: 0, updatedAt: 0,
  } as Task, ctx);
  return { ctx, links, run, logs };
}

describe('parseLink', () => {
  it('takes https links of Instagram, TikTok and YouTube and tells the platform', () => {
    expect(parseLink(IG)).toMatchObject({ ok: true, platform: 'instagram', host: 'www.instagram.com' });
    expect(parseLink(YT)).toMatchObject({ ok: true, platform: 'youtube' });
    expect(parseLink('https://youtu.be/abc')).toMatchObject({ ok: true, platform: 'youtube', host: 'youtu.be' });
    expect(parseLink(TT)).toMatchObject({ ok: true, platform: 'tiktok' });
    expect(parseLink(`  ${IG}#x `)).toMatchObject({ ok: true, url: IG });
  });
  it('refuses what is not a public post link: not a URL, http, a login in the URL, another host', () => {
    for (const bad of ['привет', 'www.instagram.com/reel/1', 'http://www.instagram.com/reel/1', 'https://me:pw@www.instagram.com/reel/1', 'https://example.com/reel/1', 'https://evil.test/https://www.instagram.com/']) {
      expect(parseLink(bad).ok, bad).toBe(false);
    }
  });
});

describe('ogTags', () => {
  it('reads og and twitter meta in either attribute order and decodes entities', () => {
    const tags = ogTags('<meta content="A &amp; B" property="og:title"><meta name="twitter:description" content=\'x y\'><meta property="og:image" content="">');
    expect(tags).toEqual({ 'og:title': 'A & B', 'twitter:description': 'x y' });
  });
});

describe('Trend scout: owner link', () => {
  it('reads oEmbed and og tags through the toolbox, stores the analysis with the analogue and never logs the text', async () => {
    const { fn, calls } = fakeFetch();
    const llm = new MockLlm(() => JSON.stringify(ANALYSIS));
    const t = setup(llm, fn);
    const id = t.links.add(YT, 'www.youtube.com', 'ценю хук');
    const res = await t.run(id);
    expect(res.error ?? '').toBe('');
    expect(res.ok).toBe(true);
    expect(calls[0]).toContain('https://www.youtube.com/oembed?url=');
    expect(calls).toContain(YT);
    const row = t.links.get(id)!;
    expect(row.status).toBe('analysed');
    expect(row.analysis).toMatchObject({ hook: ANALYSIS.hook, analogue: { type: 'clip' } });
    expect(res.result).toContain('Хук: Клиент пишет в 2 ночи');
    expect(res.result).toContain('Аналог для Fir Tech (рилс)');
    const prompt = llm.calls[0]!.messages[0]!.content;
    expect(prompt).toContain('Бот для салона за минуту');
    expect(prompt).toContain('Заметка владельца: ценю хук');
    expect(llm.calls[0]!.system).toContain('Видео ты не смотрел');
    expect(t.logs.join('\n')).not.toContain('Бот для салона');
  });

  it('Instagram has no oEmbed without an app token: only the page is read, its og tags carry the text', async () => {
    const { fn, calls } = fakeFetch();
    const llm = new MockLlm(() => JSON.stringify({ ...ANALYSIS, numbers: '1 200 лайков' }));
    const t = setup(llm, fn);
    const id = t.links.add(IG, 'www.instagram.com', '');
    expect((await t.run(id)).ok).toBe(true);
    expect(calls).toEqual([IG]);
    expect(llm.calls[0]!.messages[0]!.content).toContain('Бот записывает клиентов');
    expect(analysisText(t.links.get(id)!.analysis!, IG)).toContain('Цифры из данных страницы: 1 200 лайков');
  });

  it('a closed page or a login wall gives nothing: the link is failed with the reason, the model is not asked', async () => {
    for (const mode of ['closed', 'login'] as const) {
      const llm = new MockLlm(() => JSON.stringify(ANALYSIS));
      const t = setup(llm, fakeFetch(mode).fn);
      const id = t.links.add(IG, 'www.instagram.com', '');
      const res = await t.run(id);
      expect(res.ok).toBe(false);
      expect(res.error).toContain('без входа в аккаунт');
      expect(t.links.get(id)).toMatchObject({ status: 'failed', analysis: null });
      expect(llm.calls).toHaveLength(0);
    }
  });

  it('LLM off and a garbage answer both fail the link; a link that is not allowed any more fails before any request', async () => {
    const off = setup(new OffLlm(), fakeFetch().fn);
    const a = off.links.add(IG, 'www.instagram.com', '');
    expect((await off.run(a)).error).toContain('LLM off');
    expect(off.links.get(a)!.status).toBe('failed');
    const junk = setup(new MockLlm(() => 'не json'), fakeFetch().fn);
    const b = junk.links.add(IG, 'www.instagram.com', '');
    expect((await junk.run(b)).error).toContain('валидный разбор');
    const bad = fakeFetch();
    const c = setup(new MockLlm(() => JSON.stringify(ANALYSIS)), bad.fn);
    const id = c.links.add('https://example.com/x', 'example.com', '');
    expect((await c.run(id)).error).toContain('не подходит');
    expect(bad.calls).toHaveLength(0);
    expect((await c.run(999)).error).toContain('не найдена');
  });
});
