import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryMessenger, USDT_TRC20_CONTRACT, macEnqueue, macQueued, macSettle, openDb, parseTrendsFeed } from '../../src/index.js';
import { fakeNet, tools } from './helpers.js';

const RSS = `<?xml version="1.0"?><rss xmlns:ht="https://trends.google.com/trending/rss"><channel>
<item><title>Курс доллара</title><ht:approx_traffic>200+</ht:approx_traffic><link>https://trends.google.com/x</link>
<ht:news_item><ht:news_item_title>Доллар &amp; тенге</ht:news_item_title><ht:news_item_url>https://news.example/usd</ht:news_item_url></ht:news_item></item>
<item><title>ChatGPT агент</title><ht:approx_traffic>1000+</ht:approx_traffic></item>
</channel></rss>`;

describe('google.trends', () => {
  it('parses the daily RSS, filters by q, caches an hour; geo must be a region code', async () => {
    expect(parseTrendsFeed(RSS, 'KZ')[0]).toEqual({ title: 'Курс доллара', traffic: '200+', newsTitle: 'Доллар & тенге', newsUrl: 'https://news.example/usd', link: 'https://trends.google.com/x', geo: 'KZ' });
    const net = fakeNet({ 'https://trends.google.com/trending/rss?geo=KZ': new Response(RSS, { headers: { 'content-type': 'application/rss+xml; charset=utf-8' } }) });
    const { t } = tools({ fetch: net.fetch });
    expect(await t.google.trends({ geo: 'kz', q: 'chatgpt' })).toMatchObject({ ok: true, value: [{ title: 'ChatGPT агент', traffic: '1000+' }] });
    expect(await t.google.trends({ geo: 'KZ' })).toMatchObject({ ok: true, value: [{}, {}] });
    expect(net.calls).toHaveLength(1);
    expect(await t.google.trends({ geo: 'Kazakhstan' })).toMatchObject({ error: 'invalid' });
    expect(await t.google.trends({ geo: 'UZ' })).toMatchObject({ error: 'not_found' });
  });
});

describe('google.searchConsole (service-account JWT with node:crypto)', () => {
  it('signs a JWT, reads top queries and pages, never shows the key; not configured without both settings', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const json = JSON.stringify({ client_email: 'seo@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    let assertion = '';
    const net = fakeNet({
      'https://oauth2.googleapis.com/token': (_u, i) => {
        assertion = new URLSearchParams(String(i.body)).get('assertion') ?? '';
        return Response.json({ access_token: 'AT' });
      },
      'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Afirtech.pro/searchAnalytics/query': (_u, i) => {
        const dim = (JSON.parse(String(i.body)) as { dimensions: string[] }).dimensions[0];
        return Response.json({ rows: [{ keys: [dim === 'query' ? 'бот для записи' : 'https://firtech.pro/'], clicks: 12, impressions: 300, position: 8.46 }] });
      },
    });
    const { t } = tools({ fetch: net.fetch, config: { gscServiceAccountJson: json, gscSiteUrl: 'sc-domain:firtech.pro' } });
    const r = await t.google.searchConsole();
    expect(r).toMatchObject({ ok: true, value: { queries: [{ key: 'бот для записи', clicks: 12, impressions: 300, position: 8.5 }], pages: [{ key: 'https://firtech.pro/' }], from: '2026-10-20', to: '2026-11-17' } });
    const [h, c, s] = assertion.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toMatchObject({ iss: 'seo@proj.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/webmasters.readonly' });
    const { createVerify } = await import('node:crypto');
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
    expect(JSON.stringify(r)).not.toContain('PRIVATE KEY');
    expect(await t.google.searchConsole()).toMatchObject({ ok: true }); // cached for the day
    expect(net.calls.filter((x) => x.url.includes('oauth2'))).toHaveLength(1);
    expect(await tools({ config: { gscSiteUrl: 'x' } }).t.google.searchConsole()).toMatchObject({ error: 'not_configured' });
    expect(await tools({ config: { gscServiceAccountJson: '{', gscSiteUrl: 'x' } }).t.google.searchConsole()).toMatchObject({ error: 'not_configured' });
  });
});

describe('google.youtube', () => {
  it('channel and videos by API key (key never in a message); upload needs OAuth and books the quota', async () => {
    const net = fakeNet({
      'https://www.googleapis.com/youtube/v3/channels': Response.json({ items: [{ statistics: { subscriberCount: '45', viewCount: '1200', videoCount: '3' } }] }),
      'https://www.googleapis.com/youtube/v3/videos': Response.json({ items: [{ id: 'abcdef1', snippet: { title: 'Shorts 1', publishedAt: '2026-11-18T10:00:00Z' }, statistics: { viewCount: '100', likeCount: '7' } }] }),
    });
    const { t } = tools({ fetch: net.fetch, config: { youtubeApiKey: 'YTKEY', youtubeChannelId: 'UC1' } });
    expect(await t.google.youtube.channel()).toEqual({ ok: true, value: { subscribers: 45, views: 1200, videos: 3 } });
    expect(await t.google.youtube.videos(['abcdef1'])).toEqual({ ok: true, value: [{ id: 'abcdef1', title: 'Shorts 1', publishedAt: '2026-11-18T10:00:00Z', views: 100, likes: 7, comments: 0 }] });
    expect(await t.google.youtube.videos(['../x'])).toMatchObject({ error: 'invalid' });
    expect(await t.google.youtube.upload({ title: 'x', bytes: new Uint8Array(100) })).toMatchObject({ error: 'not_configured' });
    const denied = tools({ fetch: fakeNet({ 'https://www.googleapis.com/': new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 }) }).fetch, config: { youtubeApiKey: 'YTKEY', youtubeChannelId: 'UC1' } });
    const f = await denied.t.google.youtube.channel();
    expect(f).toMatchObject({ ok: false, error: 'upstream', status: 403 });
    expect(JSON.stringify(f)).not.toContain('YTKEY');

    const used = new Map<string, number>();
    const quota = { used: (d: string) => used.get(d) ?? 0, add: (d: string, n: number) => void used.set(d, (used.get(d) ?? 0) + n) };
    const up = fakeNet({
      'https://oauth2.googleapis.com/token': Response.json({ access_token: 'AT', expires_in: 3600 }),
      'https://www.googleapis.com/upload/youtube/v3/videos': new Response(null, { status: 200, headers: { location: 'https://www.googleapis.com/upload/session/1' } }),
      'https://www.googleapis.com/upload/session/1': Response.json({ id: 'vid123456' }),
    });
    const o = tools({ fetch: up.fetch, youtubeQuota: quota, config: { ytOauthClientJson: '{"installed":{"client_id":"c","client_secret":"s"}}', ytRefreshToken: 'RT' } });
    expect(await o.t.google.youtube.upload({ title: 'Бот за 30 секунд', bytes: new Uint8Array(1000), privacy: 'unlisted' })).toEqual({ ok: true, value: { id: 'vid123456', url: 'https://youtube.com/shorts/vid123456' } });
    expect(used.get('2026-11-20')).toBe(1600);
    const meta = JSON.parse(String(up.calls.find((c) => c.url.includes('uploadType=resumable'))!.init.body)) as { status: { privacyStatus: string } };
    expect(meta.status.privacyStatus).toBe('unlisted');
    used.set('2026-11-20', 8000);
    expect(await o.t.google.youtube.upload({ title: 'x', bytes: new Uint8Array(1000) })).toMatchObject({ error: 'rate_limited', retryable: false });
    expect(await o.t.google.youtube.upload({ title: '', bytes: new Uint8Array(1000) })).toMatchObject({ error: 'invalid' });
  });
});

describe('telegram, email, mac queue, chain', () => {
  it('telegram writes only to the owner through the head messenger; documents from stored files', async () => {
    const m = new MemoryMessenger();
    const dataDir = mkdtempSync(join(tmpdir(), 'fir-tg-'));
    const { t } = tools({ messenger: m, ownerId: 42, dept: 'backoffice', config: { dataDir } });
    expect(await t.telegram.send('Готово')).toEqual({ ok: true, value: { sent: true } });
    expect(m.sent).toEqual([{ chatId: 42, text: 'Готово' }]);
    await t.files.put('docs', 'kp.pdf', '%PDF-1.3');
    expect(await t.telegram.sendDocument('docs/kp.pdf', 'КП')).toEqual({ ok: true, value: { sent: true } });
    expect(await t.telegram.sendDocument('docs/none.pdf')).toMatchObject({ error: 'not_found' });
    expect(await t.telegram.send('')).toMatchObject({ error: 'invalid' });
    expect(await tools().t.telegram.send('x')).toMatchObject({ error: 'not_configured' });
  });

  it('email through Resend: not configured without a key, validation, daily cap, key never in a message', async () => {
    expect(await tools({ dept: 'support' }).t.email.send({ to: 'a@b.co', subject: 's', text: 't' })).toMatchObject({ error: 'not_configured' });
    const net = fakeNet({ 'https://api.resend.com/emails': (_u, i) => (new Headers(i.headers).get('authorization') === 'Bearer RSKEY' ? Response.json({ id: 'em_1' }) : new Response('no', { status: 401 })) });
    const { t, journal } = tools({ dept: 'support', fetch: net.fetch, config: { resendApiKey: 'RSKEY', emailFrom: 'Fir Tech <hello@firtech.pro>' } });
    expect(await t.email.send({ to: 'client@example.com', subject: 'Счёт', text: 'Ссылка на оплату' })).toEqual({ ok: true, value: { id: 'em_1' } });
    expect(JSON.parse(String(net.calls[0]!.init.body))).toMatchObject({ from: 'Fir Tech <hello@firtech.pro>', to: ['client@example.com'], subject: 'Счёт' });
    expect(await t.email.send({ to: 'not an email', subject: 's', text: 't' })).toMatchObject({ error: 'invalid' });
    expect(await t.email.send({ to: 'a@b.co', subject: 'two\nlines', text: 't' })).toMatchObject({ error: 'invalid' });
    journal.settings.set('tools.email.2026-11-20', '100');
    expect(await t.email.send({ to: 'a@b.co', subject: 's', text: 't' })).toMatchObject({ error: 'rate_limited' });
    const bad = tools({ dept: 'sales', fetch: net.fetch, config: { resendApiKey: 'WRONGKEY', emailFrom: 'x@y.co' } });
    const f = await bad.t.email.send({ to: 'a@b.co', subject: 's', text: 't' });
    expect(f).toMatchObject({ error: 'upstream', status: 401, retryable: false });
    expect(JSON.stringify(f)).not.toContain('WRONGKEY');
    expect(await tools({ dept: 'marketing', config: { resendApiKey: 'k', emailFrom: 'x@y.co' } }).t.email.send({ to: 'a@b.co', subject: 's', text: 't' })).toMatchObject({ error: 'not_allowed' });
  });

  it('mac queue: enqueue once per item and platform, the helper settles it', async () => {
    const db = openDb(':memory:');
    db.exec("CREATE TABLE cm_items (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO cm_items (id, status) VALUES (5, 'ready')");
    const { t } = tools({ db });
    expect(await t.mac.poster.enqueue(5, 'instagram')).toEqual({ ok: true, value: { id: 1, already: false } });
    expect(await t.mac.poster.enqueue(5, 'instagram')).toEqual({ ok: true, value: { id: 1, already: true } });
    expect(await t.mac.poster.enqueue(5, 'tiktok')).toMatchObject({ ok: true, value: { already: false } });
    expect(await t.mac.poster.enqueue(6, 'instagram')).toMatchObject({ error: 'not_found' });
    expect(await t.mac.poster.enqueue(5, 'facebook' as never)).toMatchObject({ error: 'invalid' });
    expect(macQueued(db)).toEqual(new Map([[5, ['instagram', 'tiktok']]]));
    expect(macSettle(db, 5, 'instagram', 'done', 1)).toBe(1);
    expect(macQueued(db)).toEqual(new Map([[5, ['tiktok']]]));
    expect(await t.mac.poster.enqueue(5, 'instagram')).toMatchObject({ ok: true, value: { already: false } }); // a new run after the last one closed
    expect(await tools({ db, dept: 'sales' }).t.mac.poster.enqueue(5, 'instagram')).toMatchObject({ error: 'not_allowed' });
    // the plain function behind it (the owner's «Выложить сейчас» in the review center uses it too): same open row, null for an unknown item
    expect(macEnqueue(db, 5, 'tiktok', 'owner', 9)).toMatchObject({ already: true });
    expect(macEnqueue(db, 5, 'instagram', 'owner', 9)).toMatchObject({ already: true });
    expect(macEnqueue(db, 77, 'instagram', 'owner', 9)).toBeNull();
  });

  it('chain.transfers: TRC20 through TronGrid with the key header, validation, statuses', async () => {
    const addr = `T${'A'.repeat(33)}`;
    const tx = { token_info: { address: USDT_TRC20_CONTRACT, decimals: 6 }, to: addr, type: 'Transfer', transaction_id: 'ab'.repeat(32), value: '150000000', block_timestamp: 1_700_000_000_000 };
    const net = fakeNet({ 'https://api.trongrid.io/v1/accounts/': (_u, i) => Response.json({ success: true, data: [tx, { ...tx, to: 'Tother' }], key: new Headers(i.headers).get('tron-pro-api-key') }) });
    const { t } = tools({ dept: 'support', fetch: net.fetch, config: { trongridApiKey: 'TGKEY' } });
    const r = await t.chain.transfers('usdt_trc20', addr, 0);
    expect(r).toMatchObject({ ok: true, value: [{ method: 'usdt_trc20', txId: 'ab'.repeat(32), amountMicro: 150000000n, cents: 15000 }] });
    expect(new Headers(net.calls[0]!.init.headers).get('tron-pro-api-key')).toBe('TGKEY');
    expect(await t.chain.transfers('usdt_trc20', 'nope', 0)).toMatchObject({ error: 'invalid' });
    expect(await t.chain.transfers('btc' as never, addr, 0)).toMatchObject({ error: 'invalid' });
    const busy = tools({ dept: 'support', fetch: fakeNet({ 'https://api.trongrid.io/': new Response('x', { status: 429 }) }).fetch });
    expect(await busy.t.chain.transfers('usdt_trc20', addr, 0)).toMatchObject({ error: 'rate_limited', retryable: true });
    expect(await tools({ dept: 'marketing' }).t.chain.transfers('usdt_trc20', addr, 0)).toMatchObject({ error: 'not_allowed' });
  });
});
