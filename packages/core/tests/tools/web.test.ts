import { describe, expect, it } from 'vitest';
import { openDb, ToolCache, extractReadable, parseBrave, parseDdg, type PinnedAddress, type ToolFetch } from '../../src/index.js';
import { fakeNet, fixture, tools } from './helpers.js';

const H = { hosts: ['api.example.com'] };
const json = (v: unknown, status = 200) => Response.json(v, { status });

describe('web.getJson', () => {
  it('success: parsed JSON, pinned public address, user agent, one journal line', async () => {
    const pins: (PinnedAddress | undefined)[] = [];
    const net = fakeNet({ 'https://api.example.com/v1': () => json({ items: [1, 2] }) });
    const { t, journal } = tools({ fetch: (u, i, p) => (pins.push(p), net.fetch(u, i)) });
    expect(await t.web.getJson('https://api.example.com/v1?x=1', H)).toEqual({ ok: true, value: { items: [1, 2] } });
    expect(pins).toEqual([{ address: '104.16.1.1', family: 4 }]);
    expect(new Headers(net.calls[0]!.init.headers).get('user-agent')).toContain('FirTechAgent');
    expect(journal.lines).toMatchObject([{ action: 'tool:web.getJson', objectId: '7', detail: expect.stringMatching(/^ok \d+ms$/) }]);
  });

  it('every error code it can give, never a throw', async () => {
    const run = async (fetch: ToolFetch, url = 'https://api.example.com/v1', o: object = H, lookup?: () => Promise<string[]>) =>
      tools({ fetch, ...(lookup ? { lookup } : {}) }).t.web.getJson(url, o as typeof H);
    const ok = fakeNet({ 'https://api.example.com/': json({}) }).fetch;
    expect(await run(ok, 'https://evil.example/v1')).toMatchObject({ error: 'blocked' });
    expect(await run(ok, 'http://api.example.com/v1')).toMatchObject({ error: 'invalid' });
    expect(await run(ok, 'https://api.example.com:8443/v1')).toMatchObject({ error: 'invalid' });
    expect(await run(ok, 'not a url')).toMatchObject({ error: 'invalid' });
    expect(await run(ok, 'https://api.example.com/v1', {})).toMatchObject({ error: 'invalid' });
    expect(await run(ok, 'https://api.example.com/v1', H, () => Promise.resolve(['10.0.0.1']))).toMatchObject({ error: 'blocked' });
    expect(await run(ok, 'https://api.example.com/v1', H, () => Promise.reject(new Error('ENOTFOUND')))).toMatchObject({ error: 'network', retryable: true });
    expect(await run(fakeNet({ 'https://api.example.com/': new Response('x', { status: 404 }) }).fetch)).toMatchObject({ error: 'not_found', status: 404 });
    expect(await run(fakeNet({ 'https://api.example.com/': new Response('x', { status: 429 }) }).fetch)).toMatchObject({ error: 'rate_limited' });
    expect(await run(fakeNet({ 'https://api.example.com/': new Response('x', { status: 503 }) }).fetch)).toMatchObject({ error: 'upstream', status: 503, retryable: true });
    expect(await run(fakeNet({ 'https://api.example.com/': new Response('<html>') }).fetch)).toMatchObject({ error: 'upstream', retryable: false });
    expect(await run(fakeNet({ 'https://api.example.com/': new Response('x'.repeat(2000)) }).fetch, 'https://api.example.com/v1', { ...H, maxBytes: 1000 })).toMatchObject({ error: 'too_large' });
    expect(await run(() => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })))).toMatchObject({ error: 'timeout' });
    expect(await run(() => Promise.reject(new TypeError('socket hang up')))).toMatchObject({ error: 'network' });
    expect(await run((() => { throw new Error('sync boom'); }) as never)).toMatchObject({ ok: false });
  });

  it('retries a 503 twice with backoff, not a 404', async () => {
    let n = 0;
    const { t, sleeps } = tools({ fetch: () => Promise.resolve((n++, new Response('x', { status: 503 }))) });
    expect(await t.web.getJson('https://api.example.com/v1', H)).toMatchObject({ error: 'upstream' });
    expect(n).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
    let m = 0;
    const b = tools({ fetch: () => Promise.resolve((m++, new Response('x', { status: 404 }))) });
    await b.t.web.getJson('https://api.example.com/v1', H);
    expect(m).toBe(1);
  });
});

describe('web.getText', () => {
  it('cuts at 300 KB, decodes the charset, follows redirects within the list only', async () => {
    const big = 'а'.repeat(200_000); // 400 KB in UTF-8
    const net = fakeNet({
      'https://site.example/big': new Response(big, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      'https://site.example/old': new Response(null, { status: 301, headers: { location: '/new' } }),
      'https://site.example/new': new Response('fresh', { headers: { 'content-type': 'text/plain', 'last-modified': 'Thu, 19 Nov 2026 10:00:00 GMT' } }),
      'https://site.example/away': new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
      'https://site.example/cp1251': new Response(new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), { headers: { 'content-type': 'text/html; charset=windows-1251' } }),
      'https://site.example/pic': new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    });
    const { t } = tools({ fetch: net.fetch });
    const o = { hosts: ['site.example'] };
    const r = await t.web.getText('https://site.example/big', o);
    expect(r.ok && r.value.truncated).toBe(true);
    expect(r.ok && Buffer.byteLength(r.value.text)).toBeLessThanOrEqual(300_000);
    expect(await t.web.getText('https://site.example/old', o)).toMatchObject({ ok: true, value: { text: 'fresh', url: 'https://site.example/new', lastModified: 'Thu, 19 Nov 2026 10:00:00 GMT' } });
    expect(await t.web.getText('https://site.example/away', o)).toMatchObject({ ok: false, error: 'blocked' });
    expect(await t.web.getText('https://site.example/cp1251', o)).toMatchObject({ ok: true, value: { text: 'Привет' } });
    expect(await t.web.getText('https://site.example/pic', o)).toMatchObject({ ok: false, error: 'invalid' });
    expect(await t.web.getText('https://site.example/missing', o)).toMatchObject({ ok: false, error: 'not_found', status: 404 });
    expect(await tools({ fetch: net.fetch, dept: 'production' }).t.web.getText('https://site.example/new', o)).toMatchObject({ error: 'not_allowed' });
  });
});

describe('web.readable: the extractor on three fixture pages', () => {
  it('a blog post: title, date, article text without nav, cookie banner, sidebar, ads, share and footer; article links', () => {
    const r = extractReadable(fixture('blog.html'), 'https://studio.example/blog/zapis');
    expect(r.title).toBe('Как салону красоты автоматизировать запись');
    expect(r.published).toBe('2026-11-12T04:30:00.000Z');
    expect(r.lang).toBe('ru');
    expect(r.text).toContain('Администратор салона тратит до трёх часов');
    expect(r.text).toContain('С чего начать');
    for (const junk of ['cookie', 'Популярное', 'Реклама', 'Поделиться', 'Все права', 'Контакты', 'tracking-123', 'color: red']) expect(r.text).not.toContain(junk);
    expect(r.links).toEqual([{ href: 'https://example.org/case', text: 'Разбор кейса' }]);
  });

  it('a news page: JSON-LD date, entities decoded, related and comments dropped', () => {
    const r = extractReadable(fixture('news.html'), 'https://news.example/tech/1');
    expect(r.title).toBe('AI agents reach small business - Daily Tech News');
    expect(r.published).toBe('2026-11-18T06:00:00.000Z');
    expect(r.text).toContain('invoicing & payments');
    expect(r.text).toContain('“The bot paid for itself in a month,”');
    for (const junk of ['Accept all cookies', 'Related', 'Great article', 'World', 'Daily Tech News, 2026']) expect(r.text).not.toContain(junk);
  });

  it('an old table layout with unclosed <p>: the content cell, the <time> date', () => {
    const r = extractReadable(fixture('table-layout.html'), 'https://host.example/');
    expect(r.title).toBe('Тарифы на хостинг');
    expect(r.published).toBe('2026-10-01T00:00:00.000Z');
    expect(r.text).toContain('Тариф «Старт» подходит для лендинга');
    expect(r.text).toContain('- Тестовый период 14 дней');
    expect(r.text).not.toContain('О нас');
    expect(r.text).not.toContain('+992');
  });

  it('through the tool: hosts from a search are readable, others need a list or "public"', async () => {
    const net = fakeNet({
      'https://html.duckduckgo.com/html/': new Response(fixture('ddg.html'), { headers: { 'content-type': 'text/html' } }),
      'https://example.org/salon-bot': new Response(fixture('blog.html'), { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      'https://other.example/': new Response(fixture('news.html'), { headers: { 'content-type': 'text/html' } }),
    });
    const { t } = tools({ fetch: net.fetch });
    expect(await t.web.readable('https://example.org/salon-bot')).toMatchObject({ ok: false, error: 'blocked' });
    await t.web.search('боты для салонов');
    expect(await t.web.readable('https://example.org/salon-bot')).toMatchObject({ ok: true, value: { title: 'Как салону красоты автоматизировать запись', url: 'https://example.org/salon-bot' } });
    expect(await t.web.readable('https://other.example/a')).toMatchObject({ ok: false, error: 'blocked' });
    expect(await t.web.readable('https://other.example/a', { hosts: 'public' })).toMatchObject({ ok: true, value: { published: '2026-11-18T06:00:00.000Z' } });
    expect(await t.web.readable('https://other.example/a', { hosts: 'public' as never, maxChars: 50 })).toMatchObject({ ok: true });
    expect(await tools({ fetch: net.fetch, lookup: () => Promise.resolve(['127.0.0.1']) }).t.web.readable('https://other.example/a', { hosts: 'public' })).toMatchObject({ error: 'blocked' });
  });
});

describe('web.search', () => {
  it('parses both providers from fixtures', () => {
    expect(parseBrave(JSON.parse(fixture('brave.json')))).toEqual([
      { title: 'Бот для записи в салон красоты', url: 'https://example.org/salon-bot', snippet: 'Как бот снижает неявки клиентов', age: '2026-11-10T00:00:00' },
      { title: 'Чат-боты для бизнеса & CRM', url: 'https://blog.example.com/bots', snippet: 'Обзор сервисов' },
    ]);
    expect(parseBrave({ nope: 1 })).toEqual([]);
    expect(parseBrave({ web: { results: 5 } })).toBeNull();
    expect(parseDdg(fixture('ddg.html'))).toEqual([
      { title: 'Бот для записи в салон красоты', url: 'https://example.org/salon-bot?a=1&b=2', snippet: 'Как бот снижает неявки & переносы' },
      { title: 'Чат-боты для бизнеса', url: 'https://blog.example.com/bots', snippet: 'Обзор сервисов' },
    ]);
  });

  it('Brave with the key (token in a header, never in a message), DuckDuckGo without; one hour cache in SQLite', async () => {
    const net = fakeNet({
      'https://api.search.brave.com/res/v1/web/search': (u, i) => (new Headers(i.headers).get('x-subscription-token') === 'BRAVEKEY' ? new Response(fixture('brave.json')) : new Response('no', { status: 401 })),
      'https://html.duckduckgo.com/html/': new Response(fixture('ddg.html')),
    });
    const db = openDb(':memory:');
    const a = tools({ fetch: net.fetch, db, config: { braveSearchKey: 'BRAVEKEY' } });
    const r = await a.t.web.search('боты для салонов', { limit: 1, lang: 'ru' });
    expect(r).toEqual({ ok: true, value: [expect.objectContaining({ url: 'https://example.org/salon-bot' })] });
    expect(net.calls[0]!.url).toContain('count=1');
    expect(net.calls[0]!.url).toContain('search_lang=ru');
    expect(net.calls[0]!.url).not.toContain('BRAVEKEY');
    await a.t.web.search('боты  для салонов', { limit: 1, lang: 'ru' }); // same query: cached
    expect(net.calls).toHaveLength(1);
    a.clock.t += 3_600_001;
    await a.t.web.search('боты для салонов', { limit: 1, lang: 'ru' });
    expect(net.calls).toHaveLength(2);

    const b = tools({ fetch: net.fetch, db: openDb(':memory:') });
    expect(await b.t.web.search('боты для салонов')).toMatchObject({ ok: true, value: [{ url: 'https://example.org/salon-bot?a=1&b=2' }, { url: 'https://blog.example.com/bots' }] });
    expect(net.calls[2]!.url).toContain('html.duckduckgo.com/html/?q=');

    const bad = tools({ fetch: fakeNet({ 'https://api.search.brave.com/': new Response('no', { status: 401 }) }).fetch, config: { braveSearchKey: 'BRAVEKEY' } });
    const fail = await bad.t.web.search('x y z');
    expect(fail).toMatchObject({ ok: false, error: 'upstream', status: 401 });
    expect(JSON.stringify(fail)).not.toContain('BRAVEKEY');
  });

  it('invalid query, the DuckDuckGo challenge, one request a second per provider', async () => {
    const { t } = tools({ fetch: fakeNet({ 'https://html.duckduckgo.com/': new Response('<div class="anomaly-modal">bots</div>') }).fetch });
    expect(await t.web.search('  ')).toMatchObject({ error: 'invalid' });
    expect(await t.web.search('x'.repeat(401))).toMatchObject({ error: 'invalid' });
    expect(await t.web.search('боты')).toMatchObject({ error: 'rate_limited', retryable: false });

    const waits: number[] = [];
    const clock = { t: 1_000_000 };
    const { HostQueue } = await import('../../src/index.js');
    const q = new HostQueue(() => clock.t, (ms) => (waits.push(ms), (clock.t += ms), Promise.resolve()));
    const s = tools({ fetch: fakeNet({ 'https://html.duckduckgo.com/': new Response(fixture('ddg.html')) }).fetch, queue: q, cache: new ToolCache(undefined, () => clock.t) });
    await s.t.web.search('один');
    await s.t.web.search('два');
    await s.t.web.search('три');
    expect(waits).toEqual([1000, 1000]);
  });
});

describe('web.post', () => {
  it('JSON and form bodies, no retry on failure, statuses as codes', async () => {
    let n = 0;
    const net = fakeNet({
      'https://api.example.com/ok': (_u, i) => json({ got: String(i.body), ct: new Headers(i.headers).get('content-type') }, 201),
      'https://api.example.com/down': () => (n++, new Response('x', { status: 503 })),
    });
    const { t } = tools({ fetch: net.fetch });
    expect(await t.web.post('https://api.example.com/ok', { a: 1 }, H)).toMatchObject({ ok: true, value: { status: 201, body: { got: '{"a":1}', ct: 'application/json' } } });
    expect(await t.web.post('https://api.example.com/ok', { a: 'b c' }, { ...H, as: 'form' })).toMatchObject({ ok: true, value: { body: { got: 'a=b+c' } } });
    expect(await t.web.post('https://api.example.com/down', {}, H)).toMatchObject({ ok: false, error: 'upstream', retryable: false });
    expect(n).toBe(1);
    expect(await t.web.post('https://api.example.com/ok', 5, { ...H, as: 'raw' })).toMatchObject({ error: 'invalid' });
    expect(await t.web.post('https://evil.example/ok', {}, H)).toMatchObject({ error: 'blocked' });
  });
});
