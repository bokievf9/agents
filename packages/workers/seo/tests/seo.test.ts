import { generateKeyPairSync } from 'node:crypto';
import { HostQueue, MockLlm, createTools, openDb, type Payload, type ToolsConfig } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { LLMS_MAX_AGE_DAYS, MAX_PROPOSALS, SeoWorker, checkLlms, checkPage, checkServices, pageFacts, sitemapUrls, type FetchFn } from '../src/index.js';

const NOW = Date.UTC(2026, 10, 23, 6, 0); // Mon 11:00 Tashkent
const DAY = 86_400_000;

const GOOD = `<!doctype html><html lang="ru"><head>
<title>Fir Tech: боты и ИИ-агенты для бизнеса</title>
<meta name="description" content="Делаем Telegram-ботов и ИИ-агентов для малого бизнеса: запись клиентов, заявки, рутина. Цены от $150, ответ в день обращения.">
<link rel="canonical" href="https://firtech.pro/ru">
<link rel="alternate" hreflang="ru" href="https://firtech.pro/ru"><link rel="alternate" hreflang="en" href="https://firtech.pro/en">
<meta property="og:title" content="Fir Tech">
<script type="application/ld+json">{"@type":"Organization"}</script>
</head><body><h1>Боты и ИИ-агенты</h1><p>Бот-администратор от $290, приёмщик заявок от $220, автоматизация от $230, контент от $90, Mini App от $660, агент от $100, внедрение от $550, сайт от $150.</p></body></html>`;

const BAD = `<html><head><title>Hi</title></head><body><h1>A</h1><h1>B</h1><script>var price = "$999"</script></body></html>`;

describe('pageFacts and checkPage (fixture HTML)', () => {
  it('reads title, description, h1, canonical, hreflang, JSON-LD, Open Graph; script text is not page text', () => {
    const f = pageFacts('https://firtech.pro/ru', GOOD);
    expect(f).toMatchObject({ title: 'Fir Tech: боты и ИИ-агенты для бизнеса', h1: ['Боты и ИИ-агенты'], canonical: 'https://firtech.pro/ru', hreflang: ['ru', 'en'], jsonLd: 1, ogTitle: true });
    expect(f.description).toContain('Цены от $150');
    expect(pageFacts('https://firtech.pro/', BAD).text).not.toContain('999');
  });

  it('a complete home page has no findings', () => {
    expect(checkPage(pageFacts('https://firtech.pro/ru', GOOD), { home: true })).toEqual([]);
  });

  it('a bad home page: every missing piece is a keyed finding with a RU change', () => {
    const found = checkPage(pageFacts('https://firtech.pro/', BAD), { home: true });
    expect(found.map((f) => f.key).sort()).toEqual([
      'canonical_missing:/', 'description_missing:/', 'h1_many:/', 'hreflang_missing:/', 'jsonld_missing:/', 'og_missing:/', 'title_length:/',
    ]);
    expect(found.find((f) => f.key === 'jsonld_missing:/')).toMatchObject({ severity: 2, needsBuilder: true });
    expect(found.find((f) => f.key === 'jsonld_missing:/')!.change).toContain('JSON-LD');
  });

  it('inner pages are not required to carry hreflang or JSON-LD', () => {
    expect(checkPage(pageFacts('https://firtech.pro/bots', GOOD.replace(/<link rel="alternate"[^>]*>/g, '').replace(/<script[\s\S]*?<\/script>/, '')), { home: false })).toEqual([]);
  });
});

describe('llms.txt and the services table', () => {
  it('missing, thin and stale llms.txt', () => {
    expect(checkLlms({ status: 404, text: '', lastModified: null }, 'https://firtech.pro', NOW)[0]).toMatchObject({ key: 'llms_missing:/llms.txt', severity: 3 });
    expect(checkLlms({ status: 200, text: 'коротко', lastModified: null }, 'https://firtech.pro', NOW)[0]!.key).toBe('llms_thin:/llms.txt');
    const long = 'Fir Tech. '.repeat(40);
    const old = new Date(NOW - (LLMS_MAX_AGE_DAYS + 10) * DAY).toUTCString();
    expect(checkLlms({ status: 200, text: long, lastModified: old }, 'https://firtech.pro', NOW)[0]!.key).toBe('llms_stale:/llms.txt');
    expect(checkLlms({ status: 200, text: long, lastModified: new Date(NOW - DAY).toUTCString() }, 'https://firtech.pro', NOW)).toEqual([]);
    expect(checkLlms(null, 'https://firtech.pro', NOW)[0]!.key).toBe('llms_missing:/llms.txt');
  });

  it('every direction price from the table must appear in the site text', () => {
    expect(checkServices('от $290 от $220 от $230 от $90 от $660 от $100 от $550 от $150')).toEqual([]);
    const missing = checkServices('от $290 от $220 от $230 от $90 от $660 от $150');
    expect(missing.map((f) => f.key)).toEqual(['service_missing:agent', 'service_missing:implementation']);
    expect(missing[0]!.problem).toContain('от $100');
    expect(checkServices('290 USD 220$ 230 $ 90 $ 660 $ 100 $ 550 $ 150')).toEqual([]);
  });

  it('sitemap: same host only, no nested sitemaps, capped', () => {
    const xml = '<urlset><url><loc>https://firtech.pro/</loc></url><url><loc>https://firtech.pro/ru</loc></url><url><loc>https://evil.example/x</loc></url><url><loc>https://firtech.pro/sitemap-2.xml</loc></url></urlset>';
    expect(sitemapUrls(xml, 'firtech.pro')).toEqual(['https://firtech.pro/', 'https://firtech.pro/ru']);
  });
});

function site(pages: Record<string, { status?: number; body?: string; headers?: Record<string, string> }>): { fn: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const fn: FetchFn = (url) => {
    calls.push(url);
    const p = pages[new URL(url).pathname] ?? pages[url];
    if (!p) return Promise.resolve(new Response('nf', { status: 404 }));
    return Promise.resolve(new Response(p.body ?? '', { status: p.status ?? 200, headers: p.headers ?? {} }));
  };
  return { fn, calls };
}

function setup(worker: SeoWorker, fetch: FetchFn = site({}).fn, config: ToolsConfig = {}) {
  const db = openDb(':memory:');
  const clock = { t: NOW };
  const staged: { kind: string; payload: Payload; summary: string }[] = [];
  // the site check goes through the toolbox: the fake site is its network (no DNS, no waits)
  const tools = createTools({ agentId: 'seo', dept: 'marketing', db, now: () => clock.t, fetch: (u, i) => fetch(u, i), config, sleep: () => Promise.resolve(), queue: new HostQueue(() => clock.t, () => Promise.resolve()) });
  const ctx: WorkerCtx = {
    llm: new MockLlm(() => ''), db, tz: 'Asia/Tashkent', now: () => clock.t,
    requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1), log: () => undefined, tools,
  };
  const task = { id: 1, title: 't', body: '', dept: 'marketing', assigneeId: null, creator: 'routine', parentId: null, status: 'running', priority: 0, dueAt: null, result: null, costUsd: 0, meta: { action: 'seo' }, tags: [], routineId: null, createdAt: 0, updatedAt: 0 } as Task;
  return { ctx, clock, staged, run: () => worker.run(task, ctx) };
}

describe('SEO worker', () => {
  it('without a sitemap checks /, /ru, /en and llms.txt; proposes at most five, worst first, through the approval kind', async () => {
    const s = site({ '/': { body: BAD }, '/ru': { body: BAD }, '/en': { body: BAD } });
    const t = setup(new SeoWorker(), s.fn);
    const res = await t.run();
    expect(res.ok).toBe(true);
    expect(s.calls).toContain('https://firtech.pro/llms.txt');
    expect(s.calls).toContain('https://firtech.pro/en');
    expect(res.result).toContain('sitemap нет, проверены /, /ru, /en');
    expect(t.staged).toHaveLength(MAX_PROPOSALS);
    expect(t.staged[0]!.kind).toBe('seo_proposal');
    expect(t.staged[0]!.payload).toMatchObject({ needsBuilder: true });
    expect(t.staged[0]!.summary).toContain('SEO (нужен строитель)');
    expect(t.staged[0]!.payload.key).toBe('llms_missing:/llms.txt'); // severity 3 first
  });

  it('a good site with a fresh llms.txt and all prices: nothing to propose', async () => {
    const s = site({
      '/sitemap.xml': { body: '<urlset><url><loc>https://firtech.pro/ru</loc></url></urlset>' },
      '/ru': { body: GOOD }, '/llms.txt': { body: `Fir Tech. ${'Услуги. '.repeat(40)}`, headers: { 'last-modified': new Date(NOW - 5 * DAY).toUTCString() } },
    });
    const t = setup(new SeoWorker(), s.fn);
    const res = await t.run();
    expect(res.ok).toBe(true);
    expect(t.staged).toEqual([]);
    expect(res.result).toContain('sitemap: 1 страниц');
    expect(res.result).toContain('Новых предложений нет');
  });

  it('the same problems are not proposed again for four weeks, then they are', async () => {
    const s = site({ '/': { body: BAD }, '/ru': { body: BAD }, '/en': { body: BAD } });
    const t = setup(new SeoWorker(), s.fn);
    await t.run();
    const first = t.staged.map((x) => x.payload.key);
    await t.run();
    const second = t.staged.slice(first.length).map((x) => x.payload.key);
    expect(second.every((k) => !first.includes(k))).toBe(true); // next five, not the same five
    t.clock.t = NOW + 30 * DAY;
    const before = t.staged.length;
    await t.run();
    expect(t.staged.slice(before).map((x) => x.payload.key)).toEqual(first);
  });

  it('a down site is reported as an error; a broken inner page is a severity 3 finding', async () => {
    expect((await setup(new SeoWorker(), site({}).fn).run()).error).toContain('не отдал ни одной страницы');
    const s = site({ '/': { body: GOOD }, '/ru': { status: 500 }, '/en': { body: GOOD } });
    const t = setup(new SeoWorker(), s.fn);
    await t.run();
    expect(t.staged.some((x) => x.payload.key === 'page_down:/ru')).toBe(true);
  });

  it('Search Console is off by default and read only with both settings; the key signs a JWT, no secret in the result', async () => {
    const off = await setup(new SeoWorker(), site({ '/': { body: GOOD } }).fn).run();
    expect(off.result).not.toContain('Search Console');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const json = JSON.stringify({ client_email: 'seo@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    const calls: { url: string; body?: string }[] = [];
    const fn: FetchFn = (url, init) => {
      calls.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : init?.body ? { body: String(init.body) } : {}) });
      if (url.startsWith('https://oauth2.googleapis.com/token')) return Promise.resolve(Response.json({ access_token: 'TOKEN' }));
      if (url.includes('searchAnalytics/query')) {
        const dim = JSON.parse(String(init!.body)).dimensions[0] as string;
        return Promise.resolve(Response.json({ rows: [{ keys: [dim === 'query' ? 'бот для записи' : 'https://firtech.pro/'], clicks: 12, impressions: 300, position: 8.46 }] }));
      }
      return site({ '/': { body: GOOD } }).fn(url);
    };
    const res = await setup(new SeoWorker(), fn, { gscServiceAccountJson: json, gscSiteUrl: 'sc-domain:firtech.pro' }).run();
    expect(res.result).toContain('бот для записи: 12 кликов, 300 показов, позиция 8.5');
    const tokenCall = calls.find((c) => c.url.startsWith('https://oauth2'))!;
    expect(tokenCall.body).toContain('grant_type=urn');
    expect(JSON.stringify(res)).not.toContain('PRIVATE KEY');
    expect(calls.find((c) => c.url.includes('searchAnalytics'))!.url).toContain('sc-domain%3Afirtech.pro');
  });
});
