import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { storeFor } from '@fir/worker-content-maker';
import { blogApi } from '../src/blog.js';
import { createWebhook } from '../src/webhook.js';
import { world } from './helpers.js';

async function start() {
  const w = world();
  await w.marketing.command('article', 'барбершоп');
  await w.marketing.onHeartbeat();
  await w.director.sendApprovalBatch(false);
  await w.decide('approve', w.queue.pending()[0]!.id);
  const server = createWebhook(() => Promise.resolve(0), undefined, Date.now, undefined, undefined, undefined, { blog: blogApi(w.db, w.hq.now, () => w.hq.tz) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { ...w, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('GET /blog (public, no token)', () => {
  it('lists approved articles newest first in the site format, with a 60 s cache header', async () => {
    const { server, url } = await start();
    try {
      const res = await fetch(`${url}/blog?lang=all`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=60');
      const body = (await res.json()) as { ok: boolean; articles: { slug: string; published: boolean; date: string; ru: { title: string; description: string; blocks: unknown[] }; en: { title: string } }[] };
      expect(body.ok).toBe(true);
      expect(body.articles).toHaveLength(1);
      const a = body.articles[0]!;
      expect(Object.keys(a).sort()).toEqual(['date', 'en', 'published', 'ru', 'slug']);
      expect(a).toMatchObject({ published: true, date: '2026-11-18', slug: 'a-booking-bot-for-your-business-where-to-start' });
      expect(a.ru.blocks.length).toBeGreaterThan(7);
      expect((await fetch(`${url}/blog`)).status).toBe(200);
      expect((await fetch(`${url}/blog?lang=ru`)).status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('GET /blog/:slug returns one article or 404 not_found', async () => {
    const { server, url, db, hq } = await start();
    try {
      const slug = storeFor({ db, now: hq.now }).articles()[0]!.slug;
      const ok = await fetch(`${url}/blog/${slug}`);
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { ok: boolean; article: { slug: string } }).article.slug).toBe(slug);
      const miss = await fetch(`${url}/blog/no-such-article`);
      expect(miss.status).toBe(404);
      expect(await miss.json()).toEqual({ ok: false, error: 'not_found' });
      expect((await fetch(`${url}/blog/Bad..Slug`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('counts the requests per day for the analyst and limits one IP to 60 a minute', async () => {
    const { server, url, db } = await start();
    try {
      for (let i = 0; i < 3; i++) await fetch(`${url}/blog`);
      expect((db.prepare("SELECT value FROM cm_kv WHERE key = 'blog_hits:2026-11-18'").get() as { value: string }).value).toBe('3');
      let last = 200;
      for (let i = 0; i < 60; i++) last = (await fetch(`${url}/blog`)).status;
      expect(last).toBe(429);
    } finally {
      server.close();
    }
  });
});
