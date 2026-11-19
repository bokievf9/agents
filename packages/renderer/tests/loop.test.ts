import { openDb } from '@fir/core';
import { RenderQueue, storeFor } from '@fir/worker-content-maker';
import { describe, expect, it, vi } from 'vitest';
import { tick, type LoopDeps } from '../src/loop.js';

const TEXT = 'Клип, 28 с: Тест\nХук (первая секунда): Привет\n\n1. Голос: Первая сцена.\n   Субтитр: Раз\n2. Голос: Вторая сцена.\n   Субтитр: Два\n\nCTA: firtech.pro';

function setup(render: LoopDeps['render'], timeoutMs = 5000) {
  const db = openDb(':memory:');
  const now = () => 1_000_000;
  const store = storeFor({ db, now });
  const queue = new RenderQueue(db, now);
  const id = store.insertItem({ packId: null, seq: 1, total: 1, type: 'clip', topicKey: 't', topicText: 't', plannedDate: '2026-11-20' });
  store.setProposed(id, TEXT, 'Тест');
  const logs: string[] = [];
  const deps: LoopDeps = { db, queue, now, render, timeoutMs, log: (_l, msg) => logs.push(msg) };
  return { deps, queue, id, logs };
}

describe('renderer loop', () => {
  it('returns null when the queue is empty', async () => {
    const w = setup(() => Promise.resolve('x'));
    expect(await tick(w.deps)).toBeNull();
  });
  it('renders the claimed job and stores the output path', async () => {
    const render = vi.fn((job: { itemId: number }, script: { scenes: unknown[] }) => Promise.resolve(`/d/renders/${job.itemId}/reel.mp4#${script.scenes.length}`));
    const w = setup(render);
    w.queue.enqueue(w.id);
    const done = await tick(w.deps);
    expect(done).toMatchObject({ status: 'done', outputPath: `/d/renders/${w.id}/reel.mp4#2`, attempts: 1 });
  });
  it('retries once, then fails with the reason', async () => {
    const w = setup(() => Promise.reject(new Error('chrome crashed')));
    w.queue.enqueue(w.id);
    expect(await tick(w.deps)).toMatchObject({ status: 'queued', attempts: 1, error: 'chrome crashed' });
    expect(await tick(w.deps)).toMatchObject({ status: 'failed', attempts: 2 });
    expect(await tick(w.deps)).toBeNull();
  });
  it('fails a job at once when the script cannot be read', async () => {
    const render = vi.fn();
    const w = setup(render);
    storeFor({ db: w.deps.db, now: w.deps.now }).setText(w.id, 'сломанный текст', 'x');
    w.queue.enqueue(w.id);
    expect(await tick(w.deps)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(render).not.toHaveBeenCalled();
  });
  it('times out a hung render', async () => {
    const w = setup(() => new Promise(() => {}), 20);
    w.queue.enqueue(w.id);
    const r = await tick(w.deps);
    expect(r).toMatchObject({ status: 'queued', attempts: 1 });
    expect(r!.error).toContain('timed out');
  });
});
