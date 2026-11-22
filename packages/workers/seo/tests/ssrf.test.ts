import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { collectFacts, isPrivateAddress, pinnedFetch, resolvePublic, type PinnedAddress } from '../src/index.js';

const PAGE = '<html><head><title>Лайм</title></head><body><h1>Салон</h1></body></html>';
const clock = { t: 1_000 };
const html = (body = PAGE): Response => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

describe('which addresses are private', () => {
  it('IPv4: private, loopback, link-local, metadata, CGNAT 100.64/10, 198.18/15, documentation, multicast, reserved', () => {
    for (const ip of [
      '0.0.0.0', '10.1.2.3', '127.0.0.1', '127.9.9.9', '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '100.64.0.1',
      '100.100.100.200', '100.127.255.255', '198.18.0.1', '198.19.255.255', '192.0.0.8', '192.0.2.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250',
      '240.0.0.1', '255.255.255.255',
    ]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '198.17.255.255', '198.20.0.1', '11.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('IPv6: loopback, unspecified, unique-local, link-local, multicast, NAT64 64:ff9b::/96, 6to4, Teredo, documentation', () => {
    for (const ip of [
      '::', '::1', '0:0:0:0:0:0:0:1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', 'ff00::', '64:ff9b::1', '64:ff9b::808:808',
      '64:ff9b::7f00:1', '64:ff9b:1::1', '2002:7f00:1::', '2002:a00:1::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1', '100::1',
    ]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e', '2002:5db8:d822::1']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('IPv4 hidden in IPv6: the whole mapped range ::ffff:0:0/96 is refused (a resolver never answers with it), compatible forms follow the IPv4 rules', () => {
    for (const ip of ['::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:c0a8:1', '::7f00:1', '::10.0.0.1', '::ffff:100.64.0.1', '::ffff:198.18.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['::ffff:93.184.216.34', '::ffff:5db8:d822', '::ffff:0:0']) expect(isPrivateAddress(ip), ip).toBe(true);
    expect(isPrivateAddress('192.88.99.1')).toBe(true);
  });

  it('what is not an address is never fetched', () => {
    for (const x of ['', 'not-an-ip', '1.2.3', '1.2.3.256', 'gggg::1']) expect(isPrivateAddress(x), x).toBe(true);
  });
});

describe('resolve once, connect to the checked address', () => {
  it('one DNS answer per hop; the fetcher is handed exactly the checked address (a rebinding second answer is never asked)', async () => {
    let asked = 0;
    // DNS rebinding: the first answer is public, any later answer would be the metadata address
    const lookup = (): Promise<string[]> => Promise.resolve(++asked === 1 ? ['93.184.216.34'] : ['169.254.169.254']);
    const pins: (PinnedAddress | undefined)[] = [];
    const f = await collectFacts('https://rebind.example/', {
      fetch: (_u, _i, pin) => (pins.push(pin), Promise.resolve(html())), lookup, now: () => (clock.t += 100),
    });
    expect(f.reachable).toBe(true);
    expect(asked).toBe(1);
    expect(pins).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('a host with any private answer among public ones is blocked (no picking the public one)', async () => {
    const lookup = () => Promise.resolve(['93.184.216.34', '10.0.0.7']);
    let fetched = 0;
    const f = await collectFacts('https://mixed.example/', { fetch: () => (fetched++, Promise.resolve(html())), lookup, now: () => 1 });
    expect(f).toMatchObject({ reachable: false, reason: 'blocked' });
    expect(fetched).toBe(0);
  });

  it('every redirect hop is resolved and checked again, and gets its own pin', async () => {
    const table: Record<string, string[]> = { 'a.example': ['93.184.216.34'], 'b.example': ['203.0.114.5'], 'c.example': ['198.18.0.9'] };
    const asked: string[] = [];
    const pins: string[] = [];
    const f = await collectFacts('https://a.example/', {
      lookup: (h) => (asked.push(h), Promise.resolve(table[h]!)),
      fetch: (u, _i, pin) => {
        pins.push(`${new URL(u).hostname}->${pin?.address}`);
        const next = u.includes('a.example') ? 'https://b.example/' : u.includes('b.example') ? 'https://c.example/' : null;
        return Promise.resolve(next ? new Response(null, { status: 301, headers: { location: next } }) : html());
      },
      now: () => (clock.t += 100),
    });
    expect(f).toMatchObject({ reachable: false, reason: 'blocked' }); // c.example is 198.18/15
    expect(asked).toEqual(['a.example', 'b.example', 'c.example']);
    expect(pins).toEqual(['a.example->93.184.216.34', 'b.example->203.0.114.5']); // never connected to c
  });

  it('a redirect to an IP literal or to an IPv6 form of a private address is blocked without a DNS query', async () => {
    for (const target of ['http://127.0.0.1/admin', 'http://[::1]/x', 'http://[::ffff:7f00:1]/x', 'http://[64:ff9b::7f00:1]/x', 'http://2130706433/x', 'http://0x7f.0.0.1/x']) {
      let dnsCalls = 0;
      const f = await collectFacts('https://a.example/', {
        lookup: (h) => (h === 'a.example' ? Promise.resolve(['93.184.216.34']) : (dnsCalls++, Promise.resolve(['93.184.216.34']))),
        fetch: (u) => Promise.resolve(u.includes('a.example') ? new Response(null, { status: 302, headers: { location: target } }) : html()),
        now: () => 1,
      });
      expect(f, target).toMatchObject({ reachable: false, reason: 'blocked' });
      expect(dnsCalls, target).toBe(0);
    }
  });

  it('resolvePublic returns the first public answer, dns when nothing resolves', async () => {
    expect(await resolvePublic('x.example', () => Promise.resolve(['2606:4700:4700::1111']))).toEqual({ ok: { address: '2606:4700:4700::1111', family: 6 } });
    expect(await resolvePublic('x.example', () => Promise.resolve([]))).toBe('dns');
    expect(await resolvePublic('x.example', () => Promise.reject(new Error('ENOTFOUND')))).toBe('dns');
  });
});

describe('pinnedFetch really connects to the pinned address', () => {
  it('a hostname that resolves nowhere is reached through the pin (so the system resolver is never used), Host stays the hostname', async () => {
    const seen: { host?: string | undefined }[] = [];
    const server = createServer((req, res) => {
      seen.push({ host: req.headers.host });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://elsewhere.invalid/' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await pinnedFetch(`http://rebind-target.invalid:${port}/`, { headers: { 'user-agent': 't' } }, { address: '127.0.0.1', family: 4 });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Лайм');
      expect(seen[0]!.host).toBe(`rebind-target.invalid:${port}`);
      const red = await pinnedFetch(`http://rebind-target.invalid:${port}/redirect`, {}, { address: '127.0.0.1', family: 4 });
      expect(red.status).toBe(302);
      expect(red.headers.get('location')).toBe('http://elsewhere.invalid/');
      // without a pin the unresolvable name fails: the pin is what made the first call work
      await expect(pinnedFetch(`http://rebind-target.invalid:${port}/`, {})).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  it('the timeout signal aborts a slow server', async () => {
    const server = createServer(() => undefined); // never answers
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(pinnedFetch(`http://slow.invalid:${port}/`, { signal: AbortSignal.timeout(150) }, { address: '127.0.0.1', family: 4 })).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
