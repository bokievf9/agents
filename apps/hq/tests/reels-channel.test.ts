import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { world } from './helpers.js';

/**
 * Regression (audit 2026-11-19): the head gets the OwnerChannel, not the bare messenger. The channel had no `sendVideo`, so the
 * MP4 of a reel never reached the owner. These tests go through the real channel in front of a recording Telegram stub.
 */
describe('the reel video reaches the owner through the OwnerChannel', () => {
  it('sendVideo is delegated to the Telegram messenger (and so are documents)', async () => {
    const w = world({ presence: true });
    expect(typeof w.channel!.sendVideo).toBe('function');
    await w.channel!.sendVideo(100, '/data/renders/1/reel.mp4', 'cap', [[{ text: 'ok', data: 'x' }]]);
    expect(w.messenger.videos).toEqual([{ chatId: 100, file: '/data/renders/1/reel.mp4', caption: 'cap', buttons: [[{ text: 'ok', data: 'x' }]] }]);
    await w.channel!.sendDocument(100, '/data/backups/a.tar', 'backup');
    expect(w.messenger.documents).toHaveLength(1);
  });

  it('the morning «что публикуем» sends the rendered MP4 with sendVideo, not the «видео не отправилось» text', async () => {
    const rendersDir = mkdtempSync(join(tmpdir(), 'fir-renders-'));
    const w = world({ presence: true, renderReels: true, rendersDir });
    w.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner', meta: { action: 'topic', topic: 'приёмщик заявок', type: 'clip' } });
    await w.marketing.onHeartbeat();
    await w.director.sendApprovalBatch(false);
    const approval = w.queue.pending()[0]!;
    const itemId = Number(approval.payload.itemId);
    await w.decide('approve', approval.id);
    const dir = join(rendersDir, String(itemId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'reel.mp4'), Buffer.alloc(1000, 1));
    w.clock.t += 2 * 86_400_000;
    w.hq.createTask({ title: 'что публикуем сегодня', dept: 'marketing', creator: 'owner', meta: { action: 'daily' } });
    await w.marketing.onHeartbeat();
    expect(w.messenger.videos).toHaveLength(1);
    expect(w.messenger.videos[0]!.file).toBe(join(dir, 'reel.mp4'));
    expect([...w.messenger.sent.map((m) => m.text), ...w.messenger.videos.map((v) => v.caption ?? '')].join('\n')).not.toContain('Видео не отправилось');
  });
});
