import { describe, expect, it } from 'vitest';
import { safeGetJson, type PinnedAddress } from '../src/net.js';

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
