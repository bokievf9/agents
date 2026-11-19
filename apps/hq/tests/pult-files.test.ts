import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRange, serveFile } from '../src/pult-files.js';
import { pultWorld, serve } from './pult-helpers.js';

const VIDEO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'pult-files-'));
  const renders = join(base, 'renders');
  mkdirSync(join(renders, '7'), { recursive: true });
  writeFileSync(join(renders, '7', '1.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  writeFileSync(join(renders, '7', 'reel.mp4'), VIDEO);
  writeFileSync(join(renders, '7', 'meta.json'), '{"a":1}');
  writeFileSync(join(renders, '7', 'notes.txt'), 'x');
  writeFileSync(join(base, 'secret.png'), 'SECRET');
  mkdirSync(join(base, 'outside'));
  writeFileSync(join(base, 'outside', 'leak.png'), 'LEAK');
  symlinkSync(join(base, 'outside'), join(renders, 'link'));
  symlinkSync(join(base, 'secret.png'), join(renders, '7', 'evil.png'));
  return { base, renders };
}

describe('GET /admin/files/<path>', () => {
  it('serves the files under renders with the right type and a private cache header; 401 without the token', async () => {
    const { renders } = fixture();
    const s = await serve(pultWorld(), {}, renders);
    expect((await s.http('GET', '/admin/files/7/1.png', undefined, {})).status).toBe(401);
    const png = await s.http('GET', '/admin/files/7/1.png');
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('cache-control')).toBe('private, max-age=300');
    expect(Buffer.from(await png.arrayBuffer()).toString('hex')).toBe('89504e470d0a1a0a');
    const mp4 = await s.http('GET', '/admin/files/7/reel.mp4');
    expect(mp4.headers.get('content-type')).toBe('video/mp4');
    expect(mp4.headers.get('accept-ranges')).toBe('bytes');
    expect(mp4.headers.get('content-length')).toBe('1000');
    expect((await s.http('GET', '/admin/files/7/meta.json')).headers.get('content-type')).toBe('application/json');
    await s.close();
  });

  it('Range on video: 206 with Content-Range, open-ended and suffix ranges, 416 when outside', async () => {
    const { renders } = fixture();
    const s = await serve(pultWorld(), {}, renders);
    const get = (range: string) => s.http('GET', '/admin/files/7/reel.mp4', undefined, { 'x-admin-token': 'admin-secret', range });
    let r = await get('bytes=0-99');
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect(r.headers.get('content-length')).toBe('100');
    expect(Buffer.from(await r.arrayBuffer()).equals(VIDEO.subarray(0, 100))).toBe(true);
    r = await get('bytes=900-');
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 900-999/1000');
    expect(Buffer.from(await r.arrayBuffer()).equals(VIDEO.subarray(900))).toBe(true);
    r = await get('bytes=-10');
    expect(r.headers.get('content-range')).toBe('bytes 990-999/1000');
    r = await get('bytes=500-5000'); // the end is clamped to the file
    expect(r.headers.get('content-range')).toBe('bytes 500-999/1000');
    r = await get('bytes=1000-');
    expect(r.status).toBe(416);
    expect(r.headers.get('content-range')).toBe('bytes */1000');
    // a Range header nobody can read is ignored: the whole file
    r = await get('items=0-5');
    expect(r.status).toBe(200);
    expect((await r.arrayBuffer()).byteLength).toBe(1000);
    await s.close();
  });

  it('rejects path escapes: .., encoded .., absolute paths, backslashes, NUL, symlinks that leave the folder', async () => {
    const { renders } = fixture();
    const s = await serve(pultWorld(), {}, renders);
    const paths = [
      '../secret.png', '7/../../secret.png', '%2e%2e/secret.png', '7/%2e%2e/%2e%2e/secret.png', '..%2fsecret.png', '%2Fetc%2Fpasswd.png', '/etc/passwd',
      '7%5C..%5C..%5Csecret.png', '7/1.png%00.txt', '7/%00.png', '7//1.png', '%252e%252e/secret.png',
    ];
    for (const path of paths) {
      const r = await s.http('GET', `/admin/files/${path}`);
      expect([400, 404], path).toContain(r.status);
      expect(await r.text(), path).not.toContain('SECRET');
    }
    // a symlinked folder and a symlinked file that point outside are not served (realpath check)
    for (const path of ['link/leak.png', '7/evil.png']) {
      const r = await s.http('GET', `/admin/files/${path}`);
      expect(r.status, path).toBe(404);
      expect(await r.text(), path).not.toMatch(/LEAK|SECRET/);
    }
    await s.close();
  });

  it('only known extensions; missing files and folders are 404; without a renders folder everything is 404', async () => {
    const { renders } = fixture();
    const s = await serve(pultWorld(), {}, renders);
    expect((await s.http('GET', '/admin/files/7/notes.txt')).status).toBe(400);
    expect((await s.http('GET', '/admin/files/7/none.png')).status).toBe(404);
    expect((await s.http('GET', '/admin/files/7')).status).toBe(400);
    expect((await s.http('GET', '/admin/files/')).status).toBe(400);
    await s.close();
    expect(serveFile(undefined, '7/1.png').status).toBe(404);
    expect(serveFile(join(renders, 'nope'), '7/1.png').status).toBe(404);
  });

  it('is GET only; the JSON API rate limit does not count file requests', async () => {
    const { renders } = fixture();
    const p = pultWorld();
    const s = await serve(p, {}, renders);
    expect((await s.http('POST', '/admin/files/7/1.png', {})).status).toBe(404);
    for (let i = 0; i < 610; i++) expect((await s.http('GET', '/admin/files/7/1.png')).status).toBe(200);
    expect((await s.http('GET', '/admin/hub')).status).toBe(200);
    await s.close();
  });
});

describe('parseRange', () => {
  it('reads single byte ranges only', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-5', 100)).toEqual({ start: 95, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=5-2', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    for (const bad of ['bytes=0-1,5-6', 'bytes=-', 'bytes=a-b', 'lines=0-1', '']) expect(parseRange(bad, 100)).toBeNull();
  });
});
