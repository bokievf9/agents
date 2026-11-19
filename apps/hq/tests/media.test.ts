import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mediaUrl, resolveMedia } from '@fir/worker-publisher';
import { describe, expect, it } from 'vitest';
import { createWebhook } from '../src/webhook.js';

describe('GET /media/<signature>/<path>', () => {
  it('serves a signed render with its type and cache header; a tampered signature or path is 404', async () => {
    const root = mkdtempSync(join(tmpdir(), 'renders-'));
    mkdirSync(join(root, '7'));
    writeFileSync(join(root, '7', 'slide 1.png'), 'PNGDATA');
    const server = createWebhook(() => Promise.resolve(1), undefined, Date.now, undefined, undefined, undefined, { media: { resolve: (sig, rel) => resolveMedia(root, 'sec', sig, rel) } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const good = mediaUrl(`${host}/media`, 'sec', '7/slide 1.png');
      const r = await fetch(good);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/png');
      expect(r.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(await r.text()).toBe('PNGDATA');
      expect((await fetch(good, { method: 'HEAD' })).status).toBe(200);
      expect((await fetch(good.replace('7/slide', '7/slid'))).status).toBe(404);
      expect((await fetch(mediaUrl(`${host}/media`, 'other', '7/slide 1.png'))).status).toBe(404);
      expect((await fetch(good.replace(/\/media\/[0-9a-f]{32}\//, '/media/0123456789abcdef0123456789abcdef/'))).status).toBe(404);
      expect((await fetch(`${host}/media/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('without a secret the route does not exist', async () => {
    const server = createWebhook(() => Promise.resolve(1), 'lead');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      expect((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/media/${'a'.repeat(32)}/7/x.png`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
