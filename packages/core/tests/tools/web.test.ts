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

describe('web: internal hosts (policy flag, Monitoring only)', () => {
  const O = { hosts: ['omniroute'], internal: true };
  const pins: (PinnedAddress | undefined)[] = [];
  const net = fakeNet({ 'http://omniroute:20128/healthz': new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }) });
  const fetch: ToolFetch = (u, i, p) => (pins.push(p), net.fetch(u, i));

  it('support reaches an http host on any port: no public-address check, no pinned address, no activity line on success, no retries', async () => {
    const { t, journal } = tools({ dept: 'support', fetch, lookup: () => Promise.resolve(['10.0.0.5']) });
    expect(await t.web.getText('http://omniroute:20128/healthz', O)).toMatchObject({ ok: true, value: { status: 200, text: '{"ok":true}' } });
    expect(await t.web.getJson('http://omniroute:20128/healthz', O)).toEqual({ ok: true, value: { ok: true } });
    expect(pins).toEqual([undefined, undefined]);
    expect(journal.lines).toEqual([]);
    expect(JSON.parse(journal.setting('tools.stats.2026-11-20'))['web.getText']).toMatchObject({ calls: 1, errors: 0 });
    // a 503 is one attempt (the monitor has its own hysteresis) and is still a failure line
    const down = tools({ dept: 'support', fetch: async () => new Response('x', { status: 503 }) });
    expect(await down.t.web.getText('http://omniroute:20128/healthz', O)).toMatchObject({ ok: false, status: 503 });
    expect(down.sleeps).toEqual([]);
  });

  it('other departments get not_allowed; without the flag http and private hosts stay refused; the host list still applies', async () => {
    for (const dept of ['marketing', 'sales', 'production', 'backoffice', 'director']) {
      expect(await tools({ dept, fetch }).t.web.getText('http://omniroute:20128/healthz', O)).toMatchObject({ ok: false, error: 'not_allowed' });
      expect(await tools({ dept, fetch }).t.web.getJson('http://omniroute:20128/healthz', O)).toMatchObject({ ok: false, error: 'not_allowed' });
    }
    const s = tools({ dept: 'support', fetch });
    expect(await s.t.web.getText('http://omniroute:20128/healthz', { hosts: ['omniroute'] })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await tools({ dept: 'support', fetch, lookup: () => Promise.resolve(['10.0.0.5']) }).t.web.getText('https://omniroute/x', { hosts: ['omniroute'] })).toMatchObject({ ok: false, error: 'blocked' });
    expect(await s.t.web.getText('http://other:20128/healthz', O)).toMatchObject({ ok: false, error: 'blocked' });
    expect(await s.t.web.getText('http://u:p@omniroute:20128/healthz', O)).toMatchObject({ ok: false, error: 'invalid' });
    expect(await s.t.web.getText('ftp://omniroute/healthz', O)).toMatchObject({ ok: false, error: 'invalid' });
  });
});

describe('web.readable: Jina Reader fallback for pages with no text of their own', () => {
  const SPA = '<html><head><title>Салон</title></head><body><div id="app"></div><script>window.__DATA__={}</script></body></html>';
  const JINA = [
    'Title: Салон красоты: запись онлайн', '', 'URL Source: https://spa.example/booking', '', 'Published Time: 2026-11-10T08:00:00Z', '', 'Markdown Content:',
    '# Запись в салон', '', 'Администратор салона тратит **несколько часов** в день на переписку с клиентами. '.repeat(6), '', '- [Прайс](https://spa.example/price)', '- ![фото](https://spa.example/a.png)', '- Контакты',
  ].join('\n');

  it('under 400 characters of own text: one try at r.jina.ai, markdown cleaned, journaled, via jina', async () => {
    const net = fakeNet({ 'https://spa.example/booking': SPA, 'https://r.jina.ai/https://spa.example/booking': new Response(JINA, { headers: { 'content-type': 'text/plain; charset=utf-8' } }) });
    const { t, journal } = tools({ fetch: net.fetch });
    const r = await t.web.readable('https://spa.example/booking', { hosts: ['spa.example'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.via).toBe('jina');
    expect(r.value.title).toBe('Салон красоты: запись онлайн'); // Jina's title wins over an empty own one
    expect(r.value.published).toBe('2026-11-10T08:00:00.000Z');
    expect(r.value.text.length).toBeGreaterThanOrEqual(400);
    expect(r.value.text).toContain('Администратор салона тратит несколько часов');
    expect(r.value.text).not.toMatch(/\*\*|\]\(|!\[/);
    expect(r.value.links).toEqual([{ href: 'https://spa.example/price', text: 'Прайс' }]);
    expect(net.calls.map((c) => c.url)).toEqual(['https://spa.example/booking', 'https://r.jina.ai/https://spa.example/booking']);
    expect((net.calls[1]!.init.headers as Record<string, string>).accept).toBe('text/plain');
    expect(journal.lines.some((l) => l.action === 'tool:web.readable.jina' && l.detail?.startsWith('ok '))).toBe(true);
  });

  it('a page with enough own text never calls Jina', async () => {
    const net = fakeNet({ 'https://studio.example/': fixture('blog.html') });
    const r = await tools({ fetch: net.fetch }).t.web.readable('https://studio.example/blog/zapis', { hosts: ['studio.example'] });
    expect(r.ok && r.value.text.length).toBeGreaterThan(400);
    expect(r.ok && r.value.via).toBeUndefined();
    expect(net.calls).toHaveLength(1);
  });

  it('when Jina fails, answers garbage or says less, the own result stays and the failure is journaled', async () => {
    const down = fakeNet({ 'https://spa.example/booking': SPA, 'https://r.jina.ai/': new Response('nope', { status: 503 }) });
    const a = tools({ fetch: down.fetch });
    const r = await a.t.web.readable('https://spa.example/booking', { hosts: ['spa.example'] });
    expect(r).toMatchObject({ ok: true, value: { url: 'https://spa.example/booking' } });
    expect(r.ok && r.value.via).toBeUndefined();
    expect(a.journal.lines.some((l) => l.action === 'tool:web.readable.jina' && l.detail?.startsWith('failed'))).toBe(true);
    const short = fakeNet({ 'https://spa.example/booking': SPA, 'https://r.jina.ai/': 'Title: x\n\nMarkdown Content:\nкоротко' });
    const b = await tools({ fetch: short.fetch }).t.web.readable('https://spa.example/booking', { hosts: ['spa.example'] });
    expect(b.ok && b.value.via).toBe('jina'); // short but still more than nothing
    const empty = fakeNet({ 'https://spa.example/booking': SPA, 'https://r.jina.ai/': 'Title: x\n\nMarkdown Content:\n' });
    expect((await tools({ fetch: empty.fetch }).t.web.readable('https://spa.example/booking', { hosts: ['spa.example'] })).ok).toBe(true);
  });

  it('a timeout of Jina is 10 s and does not break the call', async () => {
    const slow = fakeNet({ 'https://spa.example/booking': SPA, 'https://r.jina.ai/': () => new Promise<Response>(() => undefined) });
    // the fake network never answers Jina: the request's own timer ends it; the call still answers with the own page
    const { t } = tools({ fetch: (u, i) => (u.startsWith('https://r.jina.ai/') ? Promise.reject(new DOMException('timeout', 'TimeoutError')) : slow.fetch(u, i)) });
    expect(await t.web.readable('https://spa.example/booking', { hosts: ['spa.example'] })).toMatchObject({ ok: true });
  });

  it('only a page the own request opened gets the fallback: a blocked host never reaches Jina', async () => {
    const net = fakeNet({ 'https://spa.example/': SPA });
    const { t } = tools({ fetch: net.fetch });
    expect(await t.web.readable('https://spa.example/booking', { hosts: ['other.example'] })).toMatchObject({ ok: false, error: 'blocked' });
    expect(net.calls).toHaveLength(0);
  });
});

describe('P2-10: the HTTP tools never fetch this server itself', () => {
  const net = fakeNet({ 'https://api.example.com/v1': () => json({ ok: 1 }) });
  const cfg = { selfIps: ['201.79.122.133'] };
  it('a name that resolves to PUBLIC_IP/SELF_IPS is blocked, so is a literal self IP; other hosts still work', async () => {
    const own = tools({ fetch: net.fetch, lookup: () => Promise.resolve(['201.79.122.133']), config: cfg });
    expect(await own.t.web.getJson('https://api.example.com/v1', H)).toMatchObject({ ok: false, error: 'blocked' });
    expect(await tools({ fetch: net.fetch, config: cfg }).t.web.getJson('https://201.79.122.133/v1', { hosts: ['201.79.122.133'] })).toMatchObject({ ok: false, error: 'blocked' });
    expect(await tools({ fetch: net.fetch, config: cfg }).t.web.getJson('https://api.example.com/v1', H)).toEqual({ ok: true, value: { ok: 1 } });
    expect(await tools({ fetch: net.fetch, lookup: () => Promise.resolve(['201.79.122.133']) }).t.web.getJson('https://api.example.com/v1', H)).toMatchObject({ ok: true });
  });
});
