import { describe, expect, it } from 'vitest';
import { OWNER, world } from './helpers.js';

/** Drill 2026-11-21: a card whose Telegram send failed stayed in the inbox as undelivered; the retry added a second row and /approve then sent the card a third time. */
describe('an approval card whose Telegram send failed and was retried', () => {
  it('is one inbox row, one Telegram card, and /approve resends nothing', async () => {
    const w = world({ presence: true });
    w.queue.register('probe', { initialLevel: 0, execute: () => Promise.resolve() });
    const task = w.hq.createTask({ title: 'проба', dept: 'marketing', creator: 'head' });
    w.hq.registerKind('probe', { initialLevel: 0, execute: () => Promise.resolve() });
    await w.hq.requestApproval(task.id, 'marketing-head', 'probe', { text: 'проба' }, 'проба');
    const real = w.messenger.sendMessage.bind(w.messenger);
    let down = true;
    w.messenger.sendMessage = (...a: Parameters<typeof real>) => (down ? Promise.reject(new Error('502 Bad Gateway')) : real(...a));
    await w.director.sendApprovalBatch(false);
    const rows = () => w.channel!.list({ limit: 50 }).filter((i) => i.kind === 'approval');
    expect(rows().length).toBe(1);
    expect(rows()[0]!.deliveredTg).toBe(false);
    down = false;
    await w.director.sendApprovalBatch(true); // /approve: the stale inbox row and the queued card must give ONE card
    expect(rows().filter((r) => !r.deliveredTg)).toHaveLength(0);
    expect(rows(), 'one copy on the site').toHaveLength(1);
    const cards = () => w.messenger.sent.filter((m) => m.buttons?.some((r) => r.some((b) => /^ap:\d+:a$/.test(b.data))));
    expect(cards()).toHaveLength(1);
    await w.director.sendApprovalBatch(true); // /approve
    expect(cards(), '/approve does not send the same card again').toHaveLength(1);
    void OWNER;
  });
});
