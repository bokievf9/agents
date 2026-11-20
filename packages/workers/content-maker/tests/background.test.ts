import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTools, HostQueue, type ToolFetch } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { BACKGROUND_TYPES, backgroundOf, backgroundQuery, ContentMakerWorker, findBackground, framesOf, onApproved, pngSize, renderFrame, renderItem, storeFor, withCredit } from '../src/index.js';
import { promptsDir, setup } from './helpers.js';

const IMG = { id: 'a1', title: 'Barber chair', creator: 'Jane Doe', url: 'https://live.staticflickr.com/1/a.jpg', thumbnail: 'https://api.openverse.org/v1/images/a1/thumb/', license: 'by', license_version: '2.0', foreign_landing_url: 'https://www.flickr.com/photos/jane/1', attribution: 'x' };

/** A fake Openverse: a search answer and a real PNG as the thumbnail (rendered by our own frame renderer). */
async function openverse(png: Buffer) {
  const seen: string[] = [];
  const fetch: ToolFetch = async (url) => {
    seen.push(url);
    if (url.startsWith('https://api.openverse.org/v1/images/?')) return Response.json({ results: [IMG] });
    if (url.startsWith('https://api.openverse.org/v1/images/a1/thumb/')) return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
    return new Response('nf', { status: 404 });
  };
  return { fetch, seen };
}

const photo = () => renderFrame({ kind: 'slide', title: 'Фон', lines: [] }); // any PNG will do as the "photo"

function toolbox(dir: string, fetch: ToolFetch) {
  return createTools({ agentId: 'content-maker', dept: 'marketing', fetch, lookup: () => Promise.resolve(['104.16.1.1']), queue: new HostQueue(() => 0, () => Promise.resolve()), config: { rendersDir: dir } });
}

describe('Openverse backgrounds of the content maker', () => {
  it('builds an English query from the topic words or the direction', () => {
    expect(backgroundQuery(null, 'Бот для барбершопа ночью')).toBe('barbershop');
    expect(backgroundQuery('site', 'Сайт под ключ')).toBe('laptop web design');
    expect(backgroundQuery(null, 'что-то общее')).toBe('small business');
    expect([...BACKGROUND_TYPES]).toEqual(['carousel', 'post']);
  });

  it('findBackground stores the thumbnail as <itemId>/bg.png and returns the credit; any failure is null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-'));
    const net = await openverse(await photo());
    const bg = await findBackground(toolbox(dir, net.fetch), 7, 'barbershop');
    expect(bg).toMatchObject({ file: '7/bg.png', licence: 'by' });
    expect(bg!.credit).toBe('Фото: «Barber chair», Jane Doe, CC BY 2.0, https://www.flickr.com/photos/jane/1');
    expect(existsSync(join(dir, '7', 'bg.png'))).toBe(true);
    expect(backgroundOf(dir, 7)).toMatch(/^data:image\/png;base64,/);
    expect(backgroundOf(dir, 8)).toBeUndefined();
    // not a picture, no keys needed but no network, no toolbox: nothing is stored, nothing throws
    const junk = await findBackground(toolbox(dir, async (u) => (u.includes('/thumb/') ? new Response('<html>') : Response.json({ results: [IMG] }))), 9, 'x');
    expect(junk).toBeNull();
    expect(await findBackground(toolbox(dir, async () => new Response('no', { status: 500 })), 10, 'x')).toBeNull();
    expect(await findBackground(undefined, 11, 'x')).toBeNull();
  });

  it('the credit goes before the hashtags of the Instagram caption, once', () => {
    const text = 'Карусель, 6 слайдов: Тест\n\n1. Один\n\nCTA: firtech.pro\n\n== Instagram ==\nПодпись.\n#боты #салон';
    const credited = withCredit(text, 'Фото: «A», B, CC0 1.0, https://x.example/1');
    expect(credited).toContain('== Instagram ==\nПодпись.\n\nФото: «A», B, CC0 1.0, https://x.example/1\n\n#боты #салон');
    expect(withCredit(credited, 'Фото: «A», B, CC0 1.0, https://x.example/1')).toBe(credited);
    expect(withCredit('Просто текст', 'Фото: «A»')).toBe('Просто текст\n\nФото: «A»');
  });

  it('a carousel is drafted with a background: stored file, credit in the caption and on the card; the render uses it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-'));
    const net = await openverse(await photo());
    const s = setup({ rendersDir: dir });
    const worker = new ContentMakerWorker({ promptsDir, rng: () => 0.1, rendersDir: dir, backgrounds: true, carouselsPerWeek: 0.5 });
    const ctx = { ...s.ctx, tools: toolbox(dir, net.fetch) };
    const res = await worker.run(s.task({ action: 'topic', topic: 'карусель про бота для барбершопа' }), ctx);
    expect(res.ok).toBe(true);
    const staged = s.staged[0]!;
    const credit = 'Фото: «Barber chair», Jane Doe, CC BY 2.0, https://www.flickr.com/photos/jane/1';
    expect(staged.payload.credit).toBe(credit);
    expect(String(staged.payload.text)).toContain(credit);
    expect(staged.summary).toContain('Фон: Openverse');
    expect(net.seen.some((u) => u.includes('q=barbershop'))).toBe(true);
    const itemId = Number(staged.payload.itemId);
    expect(existsSync(join(dir, String(itemId), 'bg.png'))).toBe(true);

    // the owner edits the caption and drops the credit: approval puts it back
    const store = storeFor({ db: s.db, now: () => s.clock.t });
    const edited = String(staged.payload.text).replace(credit, '');
    onApproved(store, { ...staged.payload, text: edited }, true);
    expect(store.readyRows()[0]!.text).toContain(credit);

    // the slides are rendered with the picture under the frame: same size, different pixels from the plain frame
    const files = await renderItem(dir, itemId, 'carousel', String(staged.payload.text));
    expect(files.length).toBeGreaterThanOrEqual(6);
    const withBg = readFileSync(files[0]!);
    expect(pngSize(withBg)).toEqual({ width: 1080, height: 1350 });
    const plainDir = mkdtempSync(join(tmpdir(), 'plain-'));
    const plain = readFileSync((await renderItem(plainDir, itemId, 'carousel', String(staged.payload.text)))[0]!);
    expect(withBg.equals(plain)).toBe(false);
  });

  it('without the option, or without a toolbox, the item has no picture and no credit (the default)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bg-'));
    const net = await openverse(await photo());
    const s = setup({ rendersDir: dir });
    const ctx = { ...s.ctx, tools: toolbox(dir, net.fetch) };
    const res = await s.worker.run(s.task({ action: 'topic', topic: 'карусель про бота' }), ctx);
    expect(res.ok).toBe(true);
    expect(net.seen).toHaveLength(0);
    expect(s.staged[0]!.payload.credit).toBeUndefined();
    const on = new ContentMakerWorker({ promptsDir, rng: () => 0.1, rendersDir: dir, backgrounds: true });
    const s2 = setup({ rendersDir: dir });
    const r2 = await on.run(s2.task({ action: 'topic', topic: 'карусель про бота' }), s2.ctx); // no ctx.tools
    expect(r2.ok).toBe(true);
    expect(s2.staged[0]!.payload.credit).toBeUndefined();
    expect(framesOf('carousel', String(s2.staged[0]!.payload.text)).length).toBeGreaterThan(0);
  });
});
