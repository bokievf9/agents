import { openDb } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { clipSchema, renderClip } from '../src/format.js';
import { parseReel } from '../src/reel.js';
import { MAX_RENDER_ATTEMPTS, RenderQueue, shortReason } from '../src/render-queue.js';
import { clipJson } from './helpers.js';

describe('parseReel', () => {
  it('reads hook, scenes, cta and duration from the rendered clip text', () => {
    const text = renderClip(clipSchema.parse(JSON.parse(clipJson())));
    const r = parseReel(text)!;
    expect(r.durationSec).toBe(28);
    expect(r.hook).toBe('Клиент пишет в 2 ночи, а бот отвечает');
    expect(r.scenes).toHaveLength(4);
    expect(r.scenes[1]).toEqual({ voice: 'Бот-администратор предлагает свободные окна.', subtitle: 'Свободные окна' });
    expect(r.cta).toContain('firtech.pro');
    expect(r.lang).toBe('ru');
  });
  it('detects English and returns null for a broken text', () => {
    const en = 'Клип, 25 с: T\nХук (первая секунда): Hello there\n\n1. Голос: Your clients write at night.\n   Субтитр: Night\n\nCTA: firtech.pro';
    expect(parseReel(en)!.lang).toBe('en');
    expect(parseReel('просто текст')).toBeNull();
  });
});

describe('render queue', () => {
  const mk = () => {
    let t = 1000;
    return new RenderQueue(openDb(':memory:'), () => (t += 10));
  };
  it('enqueues once per item while a job is active', () => {
    const q = mk();
    const a = q.enqueue(7);
    expect(q.enqueue(7).id).toBe(a.id);
    expect(a).toMatchObject({ itemId: 7, kind: 'reel', status: 'queued', attempts: 0 });
  });
  it('claims one job at a time, oldest first', () => {
    const q = mk();
    q.enqueue(1);
    q.enqueue(2);
    const first = q.claim()!;
    expect(first).toMatchObject({ itemId: 1, status: 'running', attempts: 1 });
    expect(q.claim()).toBeNull(); // one is running
    q.complete(first.id, '/d/renders/1/reel.mp4');
    expect(q.get(first.id)).toMatchObject({ status: 'done', outputPath: '/d/renders/1/reel.mp4' });
    expect(q.claim()!.itemId).toBe(2);
  });
  it('retries a failed attempt, then fails for good at the cap', () => {
    const q = mk();
    q.enqueue(3);
    const a = q.claim()!;
    expect(q.fail(a.id, 'chrome crashed')).toMatchObject({ status: 'queued', attempts: 1, error: 'chrome crashed' });
    const b = q.claim()!;
    expect(b.attempts).toBe(MAX_RENDER_ATTEMPTS);
    expect(q.fail(b.id, 'chrome crashed again')).toMatchObject({ status: 'failed', finishedAt: expect.any(Number) });
    expect(q.claim()).toBeNull();
  });
  it('requeues a failed or done item as a new job', () => {
    const q = mk();
    const a = q.enqueue(4);
    q.claim();
    q.fail(a.id, 'x');
    q.claim();
    q.fail(a.id, 'x');
    const again = q.requeue(4);
    expect(again.id).not.toBe(a.id);
    expect(again).toMatchObject({ status: 'queued', attempts: 0 });
    expect(q.latest(4)!.id).toBe(again.id);
  });
  it('recovers a job left running by a crash as a failed attempt', () => {
    const q = mk();
    q.enqueue(5);
    q.claim();
    expect(q.recoverStale()).toBe(1);
    expect(q.latest(5)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(q.counts()).toMatchObject({ queued: 1, running: 0 });
  });
  it('shortReason keeps one line without paths', () => {
    expect(shortReason('Error: ENOENT /opt/x/y.wav\n   at foo')).toBe('Error: ENOENT …');
    expect(shortReason(null)).toBe('неизвестная ошибка');
  });
});
