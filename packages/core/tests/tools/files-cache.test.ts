import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CACHE_MAX_BYTES, ToolCache, openDb, resolveMedia, safeRel } from '../../src/index.js';
import { NOW, tools } from './helpers.js';

describe('ToolCache', () => {
  it('TTL, sweep and the 64 KB cap, in SQLite and in memory', () => {
    for (const db of [openDb(':memory:'), undefined]) {
      const clock = { t: 1000 };
      const c = new ToolCache(db, () => clock.t);
      expect(c.set('a', 'x', 100)).toBe(true);
      expect(c.get('a')).toBe('x');
      clock.t += 100;
      expect(c.get('a')).toBeNull();
      expect(c.set('big', 'y'.repeat(CACHE_MAX_BYTES + 1), 1000)).toBe(false);
      expect(c.set('zero', 'z', 0)).toBe(false);
      c.set('b', '1', 10);
      c.set('c', '2', 1000);
      clock.t += 20;
      expect(c.sweep()).toBe(1);
      expect(c.get('c')).toBe('2');
      c.del('c');
      expect(c.get('c')).toBeNull();
      expect(c.getJson('nope')).toBeNull();
      c.set('bad', '{not json', 1000);
      expect(c.getJson('bad')).toBeNull();
    }
  });

  it('the cache tools: JSON values, key rules, TTL limits, own namespace', async () => {
    const db = openDb(':memory:');
    const { t, clock, journal } = tools({ db });
    expect(await t.cache.get('k')).toEqual({ ok: true, value: null });
    expect(await t.cache.set('k', { n: 1 }, 60_000)).toEqual({ ok: true, value: true });
    expect(await t.cache.get('k')).toEqual({ ok: true, value: { n: 1 } });
    expect(await t.cache.set('bad key!', 1, 1000)).toMatchObject({ error: 'invalid' });
    expect(await t.cache.set('k', 1, 0)).toMatchObject({ error: 'invalid' });
    expect(await t.cache.set('k', undefined, 1000)).toMatchObject({ error: 'invalid' });
    expect(await t.cache.set('k', 'x'.repeat(70_000), 1000)).toMatchObject({ error: 'too_large' });
    clock.t += 60_001;
    expect(await t.cache.get('k')).toEqual({ ok: true, value: null });
    expect(await t.cache.del('k')).toEqual({ ok: true, value: true });
    expect(journal.lines.filter((l) => l.detail?.startsWith('ok'))).toEqual([]); // quiet: only failures journaled
    expect(db.prepare("SELECT COUNT(*) n FROM tool_cache WHERE key NOT LIKE 'u:%'").get()).toEqual({ n: 0 });
  });
});

describe('files', () => {
  const setup = (over: Parameters<typeof tools>[0] = {}) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'fir-files-'));
    return { dataDir, ...tools({ dept: 'marketing', config: { dataDir, mediaSecret: 'mediasecret', mediaBase: 'https://hq.example/media' }, ...over }) };
  };

  it('put, get, list, url under DATA_DIR/renders; the URL passes the /media/ route check', async () => {
    const { t, dataDir } = setup();
    expect(await t.files.put('kits/42', 'cover.png', new Uint8Array([0x89, 0x50, 1, 2]))).toEqual({ ok: true, value: { path: 'kits/42/cover.png', size: 4 } });
    expect(await t.files.put('kits/42', 'notes.txt', 'привет')).toMatchObject({ ok: true, value: { size: 12 } });
    const g = await t.files.get('kits/42/cover.png');
    expect(g.ok && [...g.value.bytes]).toEqual([0x89, 0x50, 1, 2]);
    expect(await t.files.list('kits/42')).toMatchObject({ ok: true, value: [{ name: 'cover.png', path: 'kits/42/cover.png', size: 4 }, { name: 'notes.txt' }] });
    expect(await t.files.list('kits/none')).toEqual({ ok: true, value: [] });
    const u = await t.files.url('kits/42/cover.png');
    expect(u.ok).toBe(true);
    const m = /^https:\/\/hq\.example\/media\/([0-9a-f]{32})\/(.+)$/.exec(u.ok ? u.value : '')!;
    expect(resolveMedia(join(dataDir, 'renders'), 'mediasecret', m[1]!, m[2]!)).toMatchObject({ type: 'image/png', size: 4 });
    expect(await t.files.url('kits/42/notes.txt')).toMatchObject({ error: 'invalid' });
    expect(await t.files.url('kits/42/gone.png')).toMatchObject({ error: 'not_found' });
    expect(await t.files.get('kits/42/gone.png')).toMatchObject({ error: 'not_found' });
  });

  it('an expiring link: the signature covers the expiry, so it cannot be moved or cut off; PDF is served, a txt is not', async () => {
    const { t, dataDir } = setup();
    await t.files.put('cabinet/c1', 'quote-3.pdf', '%PDF-1.4 test');
    const root = join(dataDir, 'renders');
    const u = await t.files.url('cabinet/c1/quote-3.pdf', { ttlMs: 7 * 86_400_000 });
    expect(u.ok).toBe(true);
    const m = /^https:\/\/hq\.example\/media\/([0-9a-f]{32})\/(.+)\?e=(\d+)$/.exec(u.ok ? u.value : '')!;
    expect(m, u.ok ? u.value : '').not.toBeNull();
    const exp = Number(m[3]);
    const rel = decodeURIComponent(m[2]!);
    expect(resolveMedia(root, 'mediasecret', m[1]!, rel, { exp, now: NOW })).toMatchObject({ type: 'application/pdf' });
    // the link is about 7 days long
    expect(exp * 1000 - NOW).toBeGreaterThan(6.9 * 86_400_000);
    expect(exp * 1000 - NOW).toBeLessThan(7.1 * 86_400_000);
    // expired, moved expiry, expiry cut off, another secret: all the same refusal
    expect(resolveMedia(root, 'mediasecret', m[1]!, rel, { exp, now: exp * 1000 + 1 })).toBeNull();
    expect(resolveMedia(root, 'mediasecret', m[1]!, rel, { exp: exp + 86_400, now: NOW })).toBeNull();
    expect(resolveMedia(root, 'mediasecret', m[1]!, rel)).toBeNull();
    expect(resolveMedia(root, 'other', m[1]!, rel, { exp, now: NOW })).toBeNull();
    // a permanent link does not pass as an expiring one and the other way round
    const forever = await t.files.url('cabinet/c1/quote-3.pdf');
    const f = /\/media\/([0-9a-f]{32})\/(.+)$/.exec(forever.ok ? forever.value : '')!;
    expect(resolveMedia(root, 'mediasecret', f[1]!, rel, { exp, now: NOW })).toBeNull();
    expect(await t.files.url('cabinet/c1/quote-3.pdf', { ttlMs: 99 * 86_400_000 })).toMatchObject({ error: 'invalid' });
  });

  it('path safety: no .., no absolute paths, no odd names or types, no symlink out of the folder', async () => {
    const { t, dataDir } = setup();
    for (const [dir, name] of [['..', 'x.png'], ['a/..', 'x.png'], ['/etc', 'x.png'], ['a', '../x.png'], ['a', 'x.exe'], ['a', '.hidden.png'], ['a b', 'x.png'], ['a', 'x..png'], ['', 'x.png'], ['a/b/c/d/e', 'x.png']]) {
      expect(await t.files.put(dir!, name!, 'x'), `${dir}/${name}`).toMatchObject({ ok: false, error: 'invalid' });
    }
    expect(await t.files.get('../hq.db')).toMatchObject({ error: 'invalid' });
    expect(await t.files.list('..')).toMatchObject({ error: 'invalid' });
    expect(safeRel('a/b.png', true)).toBe('a/b.png');
    // P2-2: a lone `.` or `..` (or only dots) is never a segment
    for (const bad of ['.', '..', '...', 'a/./b.png', 'a/../b.png', './b.png', '../b.png', 'a/..']) expect(safeRel(bad, false), bad).toBeNull();
    const outside = mkdtempSync(join(tmpdir(), 'fir-out-'));
    writeFileSync(join(outside, 'secret.txt'), 'nope');
    mkdirSync(join(dataDir, 'renders'), { recursive: true });
    symlinkSync(outside, join(dataDir, 'renders', 'link'));
    expect(await t.files.get('link/secret.txt')).toMatchObject({ error: 'blocked' });
    expect(await t.files.put('link', 'x.txt', 'x')).toMatchObject({ error: 'blocked' });
  });

  it('50 MB cap; not configured without DATA_DIR or the media secret; rights by department', async () => {
    const { t } = setup();
    expect(await t.files.put('big', 'v.mp4', new Uint8Array(50 * 1024 * 1024 + 1))).toMatchObject({ error: 'too_large' });
    const none = tools({ dept: 'marketing' }).t;
    expect(await none.files.put('a', 'b.png', 'x')).toMatchObject({ error: 'not_configured' });
    const dataDir = mkdtempSync(join(tmpdir(), 'fir-files-'));
    const noSecret = tools({ dept: 'marketing', config: { dataDir } }).t;
    await noSecret.files.put('a', 'b.png', 'x');
    expect(await noSecret.files.url('a/b.png')).toMatchObject({ error: 'not_configured' });
    expect(await tools({ dept: 'production', config: { dataDir } }).t.files.put('a', 'b.png', 'x')).toMatchObject({ error: 'not_allowed' });
  });
});
