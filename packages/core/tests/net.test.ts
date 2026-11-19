import { describe, expect, it } from 'vitest';
import { safeGetJson, safePost, type PinnedAddress } from '../src/net.js';

const HOSTS = ['api.trongrid.io', 'toncenter.com'];
const publicDns = () => Promise.resolve(['104.16.1.1']);

describe('safeGetJson (allow-listed hosts, pinned public address)', () => {
  it('refuses other hosts, http, ports and credentials before any network work', async () => {
    let calls = 0;
    const fetch = () => {
      calls++;
      return Promise.resolve(new Response('{}'));
    };
    for (const u of ['https://evil.example/x', 'http://api.trongrid.io/x', 'https://api.trongrid.io:8443/x', 'https://u:p@api.trongrid.io/x', 'https://api.trongrid.io.evil.example/x', 'nonsense']) {
      expect(await safeGetJson(u, { allowHosts: HOSTS, lookup: publicDns, fetch }), u).toEqual({ ok: false, status: 0, error: 'not_allowed' });
    }
    expect(calls).toBe(0);
  });

  it('a host that resolves to a private address is blocked; the checked address is the one connected to', async () => {
    const pins: (PinnedAddress | undefined)[] = [];
    const fetch = (_u: string, _i: RequestInit, pin?: PinnedAddress) => {
      pins.push(pin);
      return Promise.resolve(new Response('{"a":1}', { status: 200 }));
    };
    expect(await safeGetJson('https://toncenter.com/api', { allowHosts: HOSTS, lookup: () => Promise.resolve(['10.0.0.5']), fetch })).toEqual({ ok: false, status: 0, error: 'blocked' });
    expect(await safeGetJson('https://toncenter.com/api', { allowHosts: HOSTS, lookup: () => Promise.reject(new Error('ENOTFOUND')), fetch })).toEqual({ ok: false, status: 0, error: 'dns' });
    expect(await safeGetJson('https://toncenter.com/api', { allowHosts: HOSTS, lookup: publicDns, fetch, headers: { 'X-API-Key': 'k' } })).toEqual({ ok: true, status: 200, body: { a: 1 } });
    expect(pins).toEqual([{ address: '104.16.1.1', family: 4 }]);
  });

  it('passes statuses through, caps the size, reports bad JSON and timeouts', async () => {
    const answer = (body: string, status = 200) => () => Promise.resolve(new Response(body, { status }));
    const base = { allowHosts: HOSTS, lookup: publicDns };
    expect(await safeGetJson('https://api.trongrid.io/v1', { ...base, fetch: answer('slow down', 429) })).toEqual({ ok: true, status: 429, body: null });
    expect(await safeGetJson('https://api.trongrid.io/v1', { ...base, fetch: answer('x'.repeat(2000)), maxBytes: 1000 })).toEqual({ ok: false, status: 200, error: 'too_large' });
    expect(await safeGetJson('https://api.trongrid.io/v1', { ...base, fetch: answer('<html>') })).toEqual({ ok: false, status: 200, error: 'invalid_json' });
    const timeout = () => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    expect(await safeGetJson('https://api.trongrid.io/v1', { ...base, fetch: timeout })).toEqual({ ok: false, status: 0, error: 'timeout' });
  });
});

describe('safePost (uploads and token calls)', () => {
  const H = ['oauth2.googleapis.com', 'www.googleapis.com', 'youtube.googleapis.com'];
  it('refuses other hosts, http, ports and credentials before any network work', async () => {
    let calls = 0;
    const fetch = () => {
      calls++;
      return Promise.resolve(new Response('{}'));
    };
    for (const u of ['https://evil.example/x', 'http://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com:8443/t', 'https://u:p@www.googleapis.com/x', 'https://www.googleapis.com.evil.example/x', 'nonsense']) {
      expect(await safePost(u, { allowHosts: H, lookup: publicDns, fetch }), u).toEqual({ ok: false, status: 0, error: 'not_allowed' });
    }
    expect(calls).toBe(0);
  });

  it('blocks private addresses, sends method, body and a 60 s timeout, returns lower-case headers and parsed JSON', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetch = (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Promise.resolve(new Response('{"id":"abc"}', { status: 200, headers: { Location: 'https://www.googleapis.com/up?id=1' } }));
    };
    expect(await safePost('https://www.googleapis.com/x', { allowHosts: H, lookup: () => Promise.resolve(['10.0.0.1']), fetch })).toEqual({ ok: false, status: 0, error: 'blocked' });
    const r = await safePost('https://www.googleapis.com/x', { allowHosts: H, lookup: publicDns, fetch, method: 'PUT', body: new Uint8Array([1, 2]) });
    expect(r).toEqual({ ok: true, status: 200, body: { id: 'abc' }, headers: expect.objectContaining({ location: 'https://www.googleapis.com/up?id=1' }) });
    expect(seen[0]!.init.method).toBe('PUT');
    expect(seen[0]!.init.redirect).toBe('manual');
    expect(seen[0]!.init.body).toEqual(new Uint8Array([1, 2]));
  });

  it('a non-JSON or empty answer is body null, a transport failure is status 0', async () => {
    expect(await safePost('https://www.googleapis.com/x', { allowHosts: H, lookup: publicDns, fetch: () => Promise.resolve(new Response('', { status: 308 })) })).toMatchObject({ ok: true, status: 308, body: null });
    expect(await safePost('https://www.googleapis.com/x', { allowHosts: H, lookup: publicDns, fetch: () => Promise.reject(new Error('boom')) })).toEqual({ ok: false, status: 0, error: 'network' });
  });
});
