import { describe, expect, it } from 'vitest';
import { creditLine, licenceLabel } from '../../src/index.js';
import { FakeJournal, fakeNet, tools } from './helpers.js';

const IMG = {
  id: 'abc-123', title: 'Barber shop chair', creator: 'Jane Doe', url: 'https://live.staticflickr.com/1/a.jpg', thumbnail: 'https://api.openverse.org/v1/images/abc-123/thumb/',
  license: 'by', license_version: '2.0', foreign_landing_url: 'https://www.flickr.com/photos/jane/1', attribution: '"Barber shop chair" by Jane Doe is licensed under CC BY 2.0.',
};
const answer = (results: unknown[]) => Response.json({ result_count: results.length, results });

describe('media.openverse.search', () => {
  it('asks the images endpoint with the licence params and returns a credit line ready for a caption', async () => {
    const net = fakeNet({ 'https://api.openverse.org/v1/images/': answer([IMG, { ...IMG, id: 'x', license: 'cc0', license_version: '1.0', creator: '' }, { ...IMG, id: 'bad', url: 'http://insecure.example/a.jpg' }]) });
    const { t } = tools({ fetch: net.fetch });
    const r = await t.media.openverse.search({ q: 'barbershop', kind: 'image', licence: 'by', pageSize: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = new URL(net.calls[0]!.url);
    expect(u.pathname).toBe('/v1/images/');
    expect(u.searchParams.get('q')).toBe('barbershop');
    expect(u.searchParams.get('license')).toBe('by');
    expect(u.searchParams.get('license_type')).toBe('commercial');
    expect(u.searchParams.get('page_size')).toBe('3');
    expect(r.value).toHaveLength(2); // the http:// result is dropped
    expect(r.value[0]).toMatchObject({ url: IMG.url, thumbnail: IMG.thumbnail, licence: 'by', licenceVersion: '2.0', creator: 'Jane Doe', landingUrl: IMG.foreign_landing_url });
    expect(r.value[0]!.attribution).toBe('Фото: «Barber shop chair», Jane Doe, CC BY 2.0, https://www.flickr.com/photos/jane/1');
    expect(r.value[0]!.attributionFull).toContain('CC BY 2.0');
    expect(r.value[1]!.attribution).toContain('CC0 1.0');
    expect(r.value[1]!.attribution).toContain('автор не указан');
  });

  it('commercial leaves the license parameter out; audio uses its own endpoint; English credit', async () => {
    const net = fakeNet({ 'https://api.openverse.org/v1/audio/': answer([{ ...IMG, thumbnail: '' }]) });
    const { t } = tools({ fetch: net.fetch });
    const r = await t.media.openverse.search({ q: 'whoosh', kind: 'audio', lang: 'en' });
    const u = new URL(net.calls[0]!.url);
    expect(u.pathname).toBe('/v1/audio/');
    expect(u.searchParams.has('license')).toBe(false);
    expect(u.searchParams.get('license_type')).toBe('commercial');
    expect(r.ok && r.value[0]!.attribution.startsWith('Audio: ')).toBe(true);
  });

  it('keeps to 15 calls a minute and 150 a day, counted in the journal', async () => {
    const net = fakeNet({ 'https://api.openverse.org/v1/images/': answer([IMG]) });
    const { t, journal, clock } = tools({ fetch: net.fetch });
    for (let i = 0; i < 15; i++) expect((await t.media.openverse.search({ q: `q${i}`, kind: 'image' })).ok).toBe(true);
    expect(net.calls).toHaveLength(15);
    const blocked = await t.media.openverse.search({ q: 'one more', kind: 'image' });
    expect(blocked).toMatchObject({ ok: false, error: 'rate_limited', retryable: true });
    expect(net.calls).toHaveLength(15); // nothing was sent
    clock.t += 61_000;
    expect((await t.media.openverse.search({ q: 'later', kind: 'image' })).ok).toBe(true);
    // the day counter
    const day = [...journal.settings.keys()].find((x) => x.startsWith('tools.openverse.2'))!;
    expect(journal.settings.get(day)).toBe('16');
    journal.settings.set(day, '150');
    clock.t += 61_000;
    expect(await t.media.openverse.search({ q: 'over the day', kind: 'image' })).toMatchObject({ ok: false, error: 'rate_limited', retryable: false });
  });

  it('a repeated query is answered from the cache and costs nothing', async () => {
    const net = fakeNet({ 'https://api.openverse.org/v1/images/': answer([IMG]) });
    const { t, journal } = tools({ fetch: net.fetch });
    await t.media.openverse.search({ q: 'Salon', kind: 'image' });
    await t.media.openverse.search({ q: 'salon', kind: 'image' });
    expect(net.calls).toHaveLength(1);
    expect([...journal.settings.entries()].find(([k]) => k.startsWith('tools.openverse.2'))![1]).toBe('1');
  });

  it('a 429 is rate_limited without a repeat; garbage is upstream; empty results are an empty list', async () => {
    const limited = fakeNet({ 'https://api.openverse.org/': new Response('slow down', { status: 429 }) });
    expect(await tools({ fetch: limited.fetch }).t.media.openverse.search({ q: 'a', kind: 'image' })).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(limited.calls).toHaveLength(1);
    const junk = fakeNet({ 'https://api.openverse.org/': Response.json({ nope: true }) });
    expect(await tools({ fetch: junk.fetch }).t.media.openverse.search({ q: 'a', kind: 'image' })).toMatchObject({ ok: false, error: 'upstream' });
    const empty = fakeNet({ 'https://api.openverse.org/': answer([]) });
    expect(await tools({ fetch: empty.fetch }).t.media.openverse.search({ q: 'a', kind: 'image' })).toEqual({ ok: true, value: [] });
  });

  it('validates arguments and rights; never throws', async () => {
    const { t } = tools({ fetch: fakeNet({}).fetch });
    expect(await t.media.openverse.search({ q: '', kind: 'image' })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await t.media.openverse.search({ q: 'x'.repeat(201), kind: 'image' })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await t.media.openverse.search({ q: 'x', kind: 'video' as never })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await t.media.openverse.search({ q: 'x', kind: 'image', licence: 'gpl' as never })).toMatchObject({ ok: false, error: 'invalid' });
    const support = tools({ dept: 'support', agentId: 'support' }).t;
    expect(await support.media.openverse.search({ q: 'x', kind: 'image' })).toMatchObject({ ok: false, error: 'not_allowed' });
  });

  it('with OAuth keys it asks for a token once (form post), caches it and sends it as a bearer; a failed token falls back to anonymous', async () => {
    let tokenCalls = 0;
    const net = fakeNet({
      'https://api.openverse.org/v1/auth_tokens/token/': (_u, init) => {
        tokenCalls++;
        expect(String(init.body)).toContain('grant_type=client_credentials');
        expect(String(init.body)).toContain('client_id=cid');
        return Response.json({ access_token: 'tok-1', expires_in: 36_000 });
      },
      'https://api.openverse.org/v1/images/': (_u, init) => {
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
        return answer([IMG]);
      },
    });
    const { t } = tools({ fetch: net.fetch, config: { openverseClientId: 'cid', openverseClientSecret: 'sec' } });
    expect((await t.media.openverse.search({ q: 'a', kind: 'image' })).ok).toBe(true);
    expect((await t.media.openverse.search({ q: 'b', kind: 'image' })).ok).toBe(true);
    expect(tokenCalls).toBe(1);

    const anon = fakeNet({ 'https://api.openverse.org/v1/auth_tokens/token/': new Response('no', { status: 401 }), 'https://api.openverse.org/v1/images/': (_u, init) => {
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
      return answer([IMG]);
    } });
    const r = await tools({ fetch: anon.fetch, config: { openverseClientId: 'cid', openverseClientSecret: 'sec' } }).t.media.openverse.search({ q: 'a', kind: 'image' });
    expect(r.ok).toBe(true);
  });

  it('the registry lists it for marketing and the journal has a line per call, without the secret', async () => {
    const net = fakeNet({ 'https://api.openverse.org/v1/images/': answer([IMG]) });
    const { t, journal } = tools({ fetch: net.fetch, config: { openverseClientSecret: 'SECRET-123' } });
    expect(t.list()).toContain('media.openverse.search');
    await t.media.openverse.search({ q: 'a', kind: 'image' });
    expect(journal.lines.some((l) => l.action === 'tool:media.openverse.search')).toBe(true);
    expect(JSON.stringify(journal.lines)).not.toContain('SECRET-123');
    expect(journal).toBeInstanceOf(FakeJournal);
  });
});

describe('credit lines', () => {
  it('names the licence the way people write it', () => {
    expect(licenceLabel('by', '2.0')).toBe('CC BY 2.0');
    expect(licenceLabel('by-sa', '4.0')).toBe('CC BY-SA 4.0');
    expect(licenceLabel('cc0', '1.0')).toBe('CC0 1.0');
    expect(licenceLabel('pdm', '')).toBe('Public Domain Mark');
    expect(creditLine({ kind: 'image', title: '', creator: 'A', licence: 'by', licenceVersion: '4.0', landingUrl: 'https://x.example/1' })).toBe('Фото: «без названия», A, CC BY 4.0, https://x.example/1');
  });
});

describe('web.getBytes', () => {
  it('returns the bytes as they are, only from listed hosts, up to the size cap', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const net = fakeNet({ 'https://api.openverse.org/v1/images/abc/thumb/': new Response(png, { headers: { 'content-type': 'image/jpeg' } }) });
    const { t } = tools({ fetch: net.fetch });
    const r = await t.web.getBytes('https://api.openverse.org/v1/images/abc/thumb/', { hosts: ['api.openverse.org'] });
    expect(r.ok && r.value.bytes.equals(png)).toBe(true);
    expect(r.ok && r.value.contentType).toBe('image/jpeg');
    expect(await t.web.getBytes('https://evil.example/a.jpg', { hosts: ['api.openverse.org'] })).toMatchObject({ ok: false, error: 'blocked' });
    expect(await t.web.getBytes('https://api.openverse.org/x', { hosts: [] })).toMatchObject({ ok: false, error: 'invalid' });
    const big = fakeNet({ 'https://api.openverse.org/': new Response(Buffer.alloc(3_100_000)) });
    expect(await tools({ fetch: big.fetch }).t.web.getBytes('https://api.openverse.org/big', { hosts: ['api.openverse.org'] })).toMatchObject({ ok: false, error: 'too_large' });
    expect(await tools({ dept: 'sales', agentId: 's' }).t.web.getBytes('https://api.openverse.org/x', { hosts: ['api.openverse.org'] })).toMatchObject({ ok: false, error: 'not_allowed' });
  });
});
