/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signMedia } from '@fir/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drillWorld, MEDIA_SECRET, TOKENS, type DrillWorld } from './world.js';
import { seedEverything, LEAD } from './seed.js';
import { useGuard } from './guard.js';
import { ADMIN, BODIES } from './routes.js';

const g = useGuard();
let w: DrillWorld;
beforeAll(async () => {
  w = await drillWorld();
  for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
  await seedEverything(w);
}, 60_000);
afterAll(async () => { await w?.close(); });


describe('every /admin route: token, method, body', () => {
  it.each(ADMIN)('%s %s needs the token', async (method, path) => {
    for (const headers of [{}, { 'x-admin-token': 'wrong' }, { 'x-admin-token': '' }, { 'x-admin-token': TOKENS.admin + 'x' }, { 'x-chat-token': TOKENS.admin }]) {
      const r = await w.http(method, path, method === 'POST' ? {} : undefined, headers as Record<string, string>);
      expect(r.status, JSON.stringify(headers)).toBe(401);
      await r.text();
    }
  });
  it.each(ADMIN.filter(([m]) => m === 'GET'))('%s %s answers JSON without a 500', async (method, path) => {
    const r = await w.adm(method, path);
    expect(r.status, `${path}: ${r.text.slice(0, 200)}`).toBeLessThan(500);
    if (!path.startsWith('/admin/files/')) expect(r.json, `${path} is not JSON`).not.toBeNull();
    if (r.status === 200) expect(r.json.ok).toBe(true);
  });
  it.each(ADMIN.filter(([m]) => m === 'POST'))('%s %s survives every body', async (method, path) => {
    for (const body of BODIES) {
      const r = await w.adm(method, path, body);
      expect(r.status, `${path} ${JSON.stringify(body)?.slice(0, 80)}: ${r.text.slice(0, 200)}`).toBeLessThan(500);
      expect(r.json, `${path}: not JSON`).not.toBeNull();
    }
    expect(g.rejections).toEqual([]);
  });
  it('other methods are 405, broken or huge bodies 400/413', async () => {
    for (const m of ['PUT', 'DELETE', 'PATCH']) expect((await w.adm(m, '/admin/state', {})).status).toBe(405);
    expect((await w.adm('POST', '/admin/say', '{broken')).status).toBe(400);
    expect((await w.adm('POST', '/admin/say', { text: 'x'.repeat(40_000) })).status).toBe(413);
  });
  it('no 500 and no error line anywhere above', () => {
    expect(g.errors().filter((l) => l.msg !== 'webhook failed' || true)).toEqual([]);
  });
});

describe('public routes', () => {
  const lead = (over: Record<string, unknown> = {}) => w.http('POST', '/lead', { ...LEAD, name: 'Public Visitor', ...over }, { 'x-lead-token': TOKENS.lead, 'x-visitor-ip': '203.0.113.7' });
  it('/health and unknown paths', async () => {
    expect((await w.http('GET', '/health')).status).toBe(200);
    for (const [m, p] of [['GET', '/'], ['GET', '/nope'], ['POST', '/nope'], ['GET', '/lead'], ['DELETE', '/lead'], ['GET', '/chat'], ['GET', '/audit'], ['GET', '/events']] as const) expect((await w.http(m, p)).status, `${m} ${p}`).toBe(404);
  });
  it('POST /lead: valid, invalid, bad token, honeypot, cabinet client, huge body', async () => {
    const ok = await lead();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, id: expect.any(Number) });
    expect((await lead({ name: '' })).status).toBe(400);
    expect((await lead({ contact: 'ab' })).status).toBe(400);
    expect((await lead({ source: '' })).status).toBe(400);
    expect((await lead({ locale: 'de' })).status).toBe(400);
    expect((await lead({ budget: 'x'.repeat(50) })).status).toBe(400);
    const hp = await lead({ website: 'http://spam' });
    expect(hp.status).toBe(200);
    const before = w.hq.tasks({ dept: 'sales' }).length;
    await lead({ website: 'http://spam', name: 'Bot' });
    expect(w.hq.tasks({ dept: 'sales' }).length).toBe(before);
    expect((await w.http('POST', '/lead', LEAD, { 'x-lead-token': 'bad' })).status).toBe(401);
    expect((await w.http('POST', '/lead', LEAD)).status).toBe(401);
    expect((await w.http('POST', '/lead', '{nope', { 'x-lead-token': TOKENS.lead })).status).toBe(400);
    expect((await w.http('POST', '/lead', { ...LEAD, message: 'x'.repeat(20_000) }, { 'x-lead-token': TOKENS.lead })).status).toBe(413);
    const cab = await lead({ name: 'Anvar', contact: '', clientEmail: 'anvar2@example.com', cabinetId: 'sb-2' });
    expect(cab.status).toBe(200);
    expect(await cab.json()).toMatchObject({ ok: true, leadId: expect.any(Number) });
    const mal = await lead({ name: 'Anvar3', contact: '@anvar3', clientEmail: 'not-an-email' });
    expect(mal.status).toBe(200);
  });
  it('POST /chat: valid, invalid, bad token', async () => {
    const chat = (body: unknown, token: string | null = TOKENS.chat) => w.http('POST', '/chat', body, token ? { 'x-chat-token': token } : {});
    const ok = await chat({ sessionId: 'visitor-0001-abcd', locale: 'ru', message: 'Здравствуйте, делаете ботов?' });
    expect(ok.status).toBe(200);
    expect((await chat({ sessionId: 'v', locale: 'ru', message: 'x' })).status).toBe(400);
    expect((await chat({})).status).toBe(400);
    expect((await chat('{x', null)).status).toBe(401);
    expect((await chat({ sessionId: 'visitor-0001-abcd', locale: 'ru', message: 'hi' }, 'wrong')).status).toBe(401);
    expect((await chat({ sessionId: 'visitor-0001-abcd', locale: 'ru', message: 'x'.repeat(30_000) })).status).toBe(413);
  });
  it('POST /audit and POST /events', async () => {
    const audit = (b: unknown, t: string | null = TOKENS.lead) => w.http('POST', '/audit', b, t ? { 'x-lead-token': t } : {});
    expect((await audit({ url: 'https://other-site.example.org', contact: '@someone_x', locale: 'en' })).status).toBe(200);
    expect((await audit({ url: 'https://other-site.example.org', contact: '@someone_x', locale: 'en' })).status).toBe(200); // duplicate
    for (const b of [{}, { url: 'http://127.0.0.1', contact: '@abc', locale: 'ru' }, { url: 'https://a.example.org', contact: 'x', locale: 'ru' }, { url: 'ftp://a.b', contact: '@abc', locale: 'ru' }]) expect((await audit(b)).status, JSON.stringify(b)).toBe(400);
    expect((await audit({}, 'bad')).status).toBe(401);
    expect((await audit({}, null)).status).toBe(401);
    const ev = (b: unknown, t: string | null = TOKENS.events) => w.http('POST', '/events', b, t ? { 'x-site-token': t } : {});
    expect((await ev({ name: 'page_view', path: '/ru' })).status).toBeLessThan(500);
    expect((await ev({ name: 'nope' })).status).toBe(400);
    expect((await ev('{x')).status).toBe(400);
    expect((await ev({}, 'bad')).status).toBe(401);
  });
  it('GET /office, /status, /blog, /pay, /media', async () => {
    expect((await w.http('GET', '/office', undefined, { 'x-office-token': TOKENS.office })).status).toBe(200);
    expect((await w.http('GET', '/office', undefined, { 'x-office-token': 'bad' })).status).toBe(401);
    expect((await w.http('GET', '/office')).status).toBe(401);
    const st = await w.http('GET', '/status');
    expect(st.status).toBe(200);
    expect((await w.http('GET', '/status?x=1')).status).toBe(200);
    expect((await w.http('GET', '/blog')).status).toBe(200);
    expect((await w.http('GET', '/blog?lang=all')).status).toBe(200);
    expect((await w.http('GET', '/blog?lang=ru')).status).toBe(400);
    expect((await w.http('GET', '/blog/no-such-slug')).status).toBe(404);
    expect((await w.http('GET', '/blog/Bad_Slug!')).status).toBe(404);
    expect((await w.http('GET', '/pay/FT-2026-001')).status).toBe(404); // no key
    expect((await w.http('GET', '/pay/FT-2026-001?k=wrong')).status).toBe(404);
    expect((await w.http('GET', '/pay/%E0%A4?k=x')).status).toBe(404);
    expect((await w.http('GET', '/media/' + '0'.repeat(32) + '/a.png')).status).toBe(404);
    expect((await w.http('GET', '/media/%E0/a')).status).toBe(404);
    expect((await w.http('HEAD', '/media/' + '0'.repeat(32) + '/a.png')).status).toBe(404);
    expect(g.rejections).toEqual([]);
  });
  it('a GET /pay with the right key answers the invoice', async () => {
    const card = w.queue.pending().find((r) => r.kind === 'billing_invoice')!;
    await w.decide('approve', card.id);
    w.clock.t += 60_000; // the pay page keeps an unknown number for 10 s: the probes above asked for it
    const inv = w.db.prepare('SELECT number, pay_key k FROM bl_invoices WHERE pay_key IS NOT NULL LIMIT 1').get() as { number: string; k: string } | undefined;
    expect(inv, 'the seeded manual invoice has a pay key').toBeDefined();
    const r = await w.http('GET', `/pay/${inv!.number}?k=${inv!.k}`);
    expect(r.status).toBe(200);
    expect((await r.json() as any).invoice.number).toBe(inv!.number);
  });
  it('no error line, no unhandled rejection', () => {
    expect(g.errors()).toEqual([]);
    expect(g.rejections).toEqual([]);
  });
});

describe('rendered files: /admin/files (token) and /media (signature)', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000004380000056e08060000000000000000', 'hex');
  const video = Buffer.alloc(5000, 7);
  beforeAll(() => {
    mkdirSync(join(w.rendersDir, '41'), { recursive: true });
    writeFileSync(join(w.rendersDir, '41', '1.png'), png);
    writeFileSync(join(w.rendersDir, '41', 'reel.mp4'), video);
    writeFileSync(join(w.rendersDir, '41', 'notes.txt'), 'x');
    try { symlinkSync('/etc/hosts', join(w.rendersDir, '41', 'out.png')); } catch { /* exists */ }
  });
  const file = (path: string, headers: Record<string, string> = {}) => w.http('GET', `/admin/files/${path}`, undefined, { 'x-admin-token': TOKENS.admin, ...headers });
  it('serves a PNG and a ranged MP4, refuses traversal, odd types, symlinks out, no token', async () => {
    const r = await file('41/1.png');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await r.arrayBuffer()).length).toBe(png.length);
    const part = await file('41/reel.mp4', { range: 'bytes=0-99' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 0-99/5000');
    expect((await file('41/reel.mp4', { range: 'bytes=9999-' })).status).toBe(416);
    for (const bad of ['..%2F..%2Fetc%2Fpasswd', '41/%2e%2e/1.png', '41//1.png', '41/notes.txt', '41/nothing.png', '%E0%A4', '41%5C1.png']) expect([400, 404], bad).toContain((await file(bad)).status);
    expect((await file('41/out.png')).status).toBe(404);
    expect((await w.http('GET', '/admin/files/41/1.png')).status).toBe(401);
  });
  it('/media serves only with the right signature, HEAD included, never outside renders', async () => {
    const sig = signMedia(MEDIA_SECRET, '41/1.png');
    const ok = await w.http('GET', `/media/${sig}/41/1.png`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toContain('max-age');
    expect((await w.http('HEAD', `/media/${sig}/41/1.png`)).status).toBe(200);
    expect((await w.http('GET', `/media/${sig}/41/reel.mp4`)).status).toBe(404); // the signature covers one path
    expect((await w.http('GET', `/media/${signMedia(MEDIA_SECRET, '41/reel.mp4')}/41/reel.mp4`)).status).toBe(200);
    expect((await w.http('GET', `/media/${sig}/41/out.png`)).status).toBe(404);
    expect((await w.http('GET', `/media/${signMedia(MEDIA_SECRET, '../x.png')}/..%2Fx.png`)).status).toBe(404);
    expect((await w.http('GET', '/media/short/41/1.png')).status).toBe(404);
    expect(g.errors()).toEqual([]);
  });
});

describe('a brand new database: every route answers, no 500 "no such table"', () => {
  it('GET and POST on every /admin route, and the public ones, before anything was ever written', async () => {
    const fresh = await drillWorld();
    try {
      for (const [m, p] of ADMIN) {
        for (const body of m === 'POST' ? [{}, { action: 'approve' }, { text: 'x' }] : [undefined]) {
          const r = await fresh.adm(m, p, body);
          expect(r.status, `${m} ${p} ${JSON.stringify(body)}: ${r.text.slice(0, 160)}`).toBeLessThan(500);
        }
      }
      for (const p of ['/status', '/blog', '/blog/x', '/health']) expect((await fresh.http('GET', p)).status, p).toBeLessThan(500);
      expect((await fresh.http('GET', '/office', undefined, { 'x-office-token': TOKENS.office })).status).toBe(200);
      expect((await fresh.http('GET', '/pay/FT-2026-001?k=x')).status).toBe(404);
      expect((await fresh.http('POST', '/events', { name: 'page_view', path: '/' }, { 'x-site-token': TOKENS.events })).status).toBeLessThan(500);
      expect((await fresh.http('POST', '/chat', { sessionId: 'visitor-fresh-0001', locale: 'en', message: 'hello' }, { 'x-chat-token': TOKENS.chat })).status).toBe(200);
      expect(g.rejections).toEqual([]);
    } finally {
      await fresh.close();
    }
  });
});
