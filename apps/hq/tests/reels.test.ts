import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { world } from './helpers.js';

/** An approved reel (item id returned) in a world with the render queue on and a temp renders dir. */
async function approvedReel() {
  const rendersDir = mkdtempSync(join(tmpdir(), 'fir-renders-'));
  const w = world({ renderReels: true, rendersDir });
  w.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner', meta: { action: 'topic', topic: 'приёмщик заявок', type: 'clip' } });
  await w.marketing.onHeartbeat();
  await w.director.sendApprovalBatch(false);
  const approval = w.queue.pending()[0]!;
  const itemId = Number(approval.payload.itemId);
  await w.decide('approve', approval.id);
  return { ...w, rendersDir, itemId };
}

const morning = async (w: Awaited<ReturnType<typeof approvedReel>>) => {
  w.clock.t += 2 * 86_400_000;
  w.hq.createTask({ title: 'что публикуем сегодня', dept: 'marketing', creator: 'owner', meta: { action: 'daily' } });
  await w.marketing.onHeartbeat();
};

const writeReel = (w: Awaited<ReturnType<typeof approvedReel>>, bytes = 1000) => {
  const dir = join(w.rendersDir, String(w.itemId));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'reel.mp4');
  writeFileSync(file, Buffer.alloc(bytes, 1));
  return file;
};

describe('reels: render queue on approval', () => {
  it('approving a reel queues one render job and creates no builder task', async () => {
    const w = await approvedReel();
    expect(w.marketing.renderQueue.latest(w.itemId)).toMatchObject({ status: 'queued', kind: 'reel', attempts: 0 });
    expect(w.hq.tasks({ status: 'blocked' }).some((t) => t.meta.action === 'build_clip')).toBe(false);
    expect(w.marketing.renderQueue.counts().queued).toBe(1);
  });

  it('without renderReels the old builder task is still created', async () => {
    const w = world();
    w.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner', meta: { action: 'topic', topic: 'приёмщик заявок', type: 'clip' } });
    await w.marketing.onHeartbeat();
    await w.director.sendApprovalBatch(false);
    await w.decide('approve', w.queue.pending()[0]!.id);
    expect(w.hq.tasks({ status: 'blocked' }).some((t) => t.meta.action === 'build_clip')).toBe(true);
  });
});

describe('reels: the morning message', () => {
  it('long captions: the video carries a short title, the full text with the buttons follows', async () => {
    const w = await approvedReel();
    writeReel(w);
    const store = (await import('@fir/worker-content-maker')).storeFor({ db: w.db, now: () => w.clock.t });
    for (const r of store.readyRows()) w.db.prepare('UPDATE cm_ready SET text = ? WHERE id = ?').run(`${'длинная подпись '.repeat(40)}\n#fir #боты`, r.id);
    await morning(w);
    expect(w.messenger.videos[0]!.caption).toBe('клип «Запись ночью»');
    expect(w.messenger.videos[0]!.buttons).toBeUndefined();
    const msg = w.messenger.sent.find((m) => m.text.includes('Публикуем: клип'))!;
    expect(msg.text).toContain('Видео собрано, оно пришло выше');
    expect(msg.buttons![0]).toHaveLength(3);
  });

  it('sends the MP4 with sendVideo when the file exists, and the buttons with the text', async () => {
    const w = await approvedReel();
    const file = writeReel(w);
    await morning(w);
    expect(w.messenger.videos).toHaveLength(1);
    expect(w.messenger.videos[0]).toMatchObject({ chatId: 100, file });
    expect(w.messenger.videos[0]!.caption).toContain('Запись ночью');
    // short captions: the whole message is the video's caption and the buttons sit on the video, no second message
    const v = w.messenger.videos[0]!;
    expect(v.caption).toContain('Публикуем: клип');
    expect(v.caption).toContain('Видео собрано, оно пришло выше');
    expect(v.caption).not.toContain('видео не собралось');
    expect(v.buttons![0]!.map((b) => b.text)).toContain('Опубликовано: Instagram');
    expect(w.messenger.sent.some((m) => m.text.includes('Публикуем: клип'))).toBe(false);
    expect(w.messenger.sent.some((m) => m.text.includes('Видео к отправке: 1'))).toBe(true);
    expect(w.marketing.renderQueue.counts().queued).toBe(1); // nothing is re-queued when the video exists
  });

  it('a failed job: the script text goes with «видео не собралось: <причина>» and the job is queued again', async () => {
    const w = await approvedReel();
    const q = w.marketing.renderQueue;
    q.claim();
    q.fail(q.latest(w.itemId)!.id, 'piper exited with 1: model missing');
    q.claim();
    q.fail(q.latest(w.itemId)!.id, 'piper exited with 1: model missing');
    expect(q.latest(w.itemId)!.status).toBe('failed');
    await morning(w);
    expect(w.messenger.videos).toHaveLength(0);
    const msg = w.messenger.sent.find((m) => m.text.includes('Публикуем: клип'))!;
    expect(msg.text).toContain('видео не собралось: piper exited with 1: model missing');
    expect(msg.text).toContain('== TikTok ==');
    expect(msg.buttons).toBeDefined();
    const next = q.latest(w.itemId)!;
    expect(next).toMatchObject({ status: 'queued', attempts: 0 }); // retried at the next run
  });

  it('a job still in the queue: «ещё собирается», no duplicate job', async () => {
    const w = await approvedReel();
    await morning(w);
    const msg = w.messenger.sent.find((m) => m.text.includes('Публикуем: клип'))!;
    expect(msg.text).toContain('видео ещё собирается');
    expect(w.marketing.renderQueue.counts().queued).toBe(1);
  });

  it('a file over 49 MB is not sent as video: the text carries the file name and a note', async () => {
    const w = await approvedReel();
    const file = writeReel(w, 0);
    truncateSync(file, 50 * 1024 * 1024);
    await morning(w);
    expect(w.messenger.videos).toHaveLength(0);
    const msg = w.messenger.sent.find((m) => m.text.includes('Публикуем: клип'))!;
    expect(msg.text).toContain('Видео не отправилось в Telegram');
    expect(msg.text).toContain(`Файл: ${file}`);
  });
});

describe('/render', () => {
  it('re-queues a finished or failed reel as a new job', async () => {
    const w = await approvedReel();
    const q = w.marketing.renderQueue;
    const first = q.claim()!;
    q.complete(first.id, '/x/reel.mp4');
    const reply = await w.marketing.command('render', String(w.itemId));
    expect(reply).toContain('Поставил в очередь рендера');
    expect(q.latest(w.itemId)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(q.latest(w.itemId)!.id).not.toBe(first.id);
    expect(await w.marketing.command('render', `#${w.itemId}`)).toContain('уже в очереди');
  });

  it('explains bad input', async () => {
    const w = await approvedReel();
    expect(await w.marketing.command('render', '')).toContain('Напишите номер');
    expect(await w.marketing.command('render', '9999')).toContain('не найден');
    const off = world();
    expect(await off.marketing.command('render', '1')).toContain('выключен');
  });
});
