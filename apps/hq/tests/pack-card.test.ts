import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeFor } from '@fir/worker-content-maker';
import { describe, expect, it } from 'vitest';
import { packButtons } from '../src/heads/marketing.js';
import { OWNER, routedLlm, world } from './helpers.js';

/** The weekly pack as ONE card (owner decision 2026-11-19): approve the pack, open the items one by one, or reject the pack. */
const NEW_PACK = { postsPerWeek: 3, storiesPerWeek: 5, carouselsPerWeek: 2 };
const store = (w: ReturnType<typeof world>) => storeFor({ db: w.db, now: w.hq.now });
const J = JSON.stringify;

async function packed(opts: Parameters<typeof world>[0] = {}) {
  const w = world(opts);
  const parent = w.hq.runRoutine('marketing-weekly-pack')!;
  await w.marketing.onHeartbeat();
  await w.director.sendApprovalBatch(false);
  const card = w.queue.pending().find((r) => r.kind === 'content_pack')!;
  return { w, parent, card };
}

describe('the pack card', () => {
  it('lists all 17 items (type, day, topic) and has three buttons; no per-item card is sent', async () => {
    const { w, card } = await packed({ cadence: NEW_PACK });
    const sent = w.messenger.sent.filter((m) => m.buttons?.flat().some((b) => b.data.startsWith('ap:')));
    expect(sent).toHaveLength(1); // 17 proposals, one card
    expect(sent[0]!.text).toContain('Пакет недели, материалов: 17');
    const lines = sent[0]!.text.split('\n').filter((l) => /^\d+\. /.test(l));
    expect(lines).toHaveLength(17);
    expect(lines.filter((l) => l.includes('клип,'))).toHaveLength(7);
    expect(lines.filter((l) => l.includes('пост,'))).toHaveLength(3);
    expect(lines.filter((l) => l.includes('карусель,'))).toHaveLength(2);
    expect(lines.filter((l) => l.includes('история,'))).toHaveLength(5);
    expect(lines[0]).toMatch(/^1\. клип, пн 23\.11: /);
    expect(sent[0]!.buttons!.flat().map((b) => [b.text, b.data])).toEqual([
      ['✅ Одобрить пакет', `ap:${card.id}:a`], ['👁 Посмотреть по одному', `pk:${card.id}:o`], ['❌ Отклонить пакет', `ap:${card.id}:r`],
    ]);
    expect(w.hq.heldApprovals()).toHaveLength(17);
    // the card is not cut at 600 characters: every line is visible
    expect(sent[0]!.text).not.toContain('…\n');
  });

  it('«Одобрить пакет»: every item is approved as for a button press; tasks close, the parent is done, the streak counts, no level promotion', async () => {
    const { w, parent, card } = await packed();
    await w.decide('approve', card.id);
    const kids = w.hq.tasks({ parentId: parent.id });
    expect(kids).toHaveLength(8);
    expect(kids.every((k) => k.status === 'done')).toBe(true);
    expect(w.hq.heldApprovals()).toHaveLength(0);
    expect(store(w).readyRows().length).toBeGreaterThanOrEqual(8); // one row per platform, 8 items
    expect(w.queue.pending()).toHaveLength(0);
    expect(w.queue.streak('content_item')).toBe(8);
    expect(w.queue.level('content_item')).toBe(0);
    expect(w.hq.task(parent.id)!.status).toBe('done');
    expect(store(w).counts()).toMatchObject({ ready: 8, rejected: 0 });
  });

  it('twenty clean approvals through packs never make content level 1 (content is not money, but every item still needs the owner)', async () => {
    const w = world({ cadence: NEW_PACK });
    w.hq.runRoutine('marketing-weekly-pack');
    await w.marketing.onHeartbeat();
    await w.director.sendApprovalBatch(false);
    await w.decide('approve', w.queue.pending().find((r) => r.kind === 'content_pack')!.id);
    expect(w.queue.streak('content_item')).toBe(17);
    expect(w.queue.trustTable().find((t) => t.kind === 'content_item')).toMatchObject({ locked: false, level: 0 });
    // a second week of clean approvals: 34 in a row, past the threshold of 20, and the level is still 0
    w.clock.t = Date.UTC(2026, 10, 25, 7, 0);
    const parent2 = w.hq.runRoutine('marketing-weekly-pack')!;
    await w.marketing.onHeartbeat();
    expect(w.hq.tasks({ parentId: parent2.id })).toHaveLength(17);
    await w.director.sendApprovalBatch(false);
    await w.decide('approve', w.queue.pending().find((r) => r.kind === 'content_pack')!.id);
    expect(w.queue.streak('content_item')).toBe(34);
    expect(w.queue.level('content_item')).toBe(0);
  });

  it('«Отклонить пакет»: all items rejected, their tasks rejected, nothing is rendered', async () => {
    const { w, parent, card } = await packed();
    await w.decide('reject', card.id);
    const kids = w.hq.tasks({ parentId: parent.id });
    expect(kids.every((k) => k.status === 'rejected')).toBe(true);
    expect(store(w).counts()).toMatchObject({ ready: 0, rejected: 8 });
    expect(w.hq.heldApprovals()).toHaveLength(0);
    expect(w.queue.pending()).toHaveLength(0);
  });

  it('«Посмотреть по одному»: the items go out as their own cards, in them one can be rejected and another approved', async () => {
    const { w, parent, card } = await packed();
    w.messenger.sent.length = 0;
    const toast = await w.marketing.onPackButton('o', card.id, { chatId: OWNER, messageId: 77 });
    expect(toast).toBe('Карточки ниже');
    const cards = w.messenger.sent.filter((m) => m.buttons?.flat().some((b) => /^ap:\d+:a$/.test(b.data)));
    expect(cards).toHaveLength(8);
    expect(w.messenger.edits.some((e) => e.messageId === 77 && e.text.includes('Пакет открыт по одному'))).toBe(true);
    // the pack's own row is settled (decided), the 8 items wait
    expect(w.queue.pending().filter((r) => r.kind === 'content_pack')).toHaveLength(0);
    expect(w.queue.pending()).toHaveLength(8);
    const [first, second] = w.queue.pending();
    await w.decide('reject', first!.id);
    await w.decide('approve', second!.id);
    expect(store(w).counts()).toMatchObject({ ready: 1, rejected: 1 });
    expect(w.hq.tasks({ parentId: parent.id, status: 'rejected' })).toHaveLength(1);
    expect(w.hq.tasks({ parentId: parent.id, status: 'done' })).toHaveLength(1);
    // pressing it again does nothing
    expect(await w.marketing.onPackButton('o', card.id, { chatId: OWNER, messageId: 77 })).toBe('Уже обработано');
  });

  it('«Одобрить все обычные» includes the pack and a single content item, and still leaves money for one by one', async () => {
    const w = world({ llm: routedLlm({ split: () => J({ action: 'topic', topic: 'бот для барбершопа', type: 'clip' }) }) });
    w.hq.registerKind('price', { initialLevel: 0, locked: true, execute: () => Promise.resolve() });
    w.hq.runRoutine('marketing-weekly-pack');
    const single = w.hq.createTask({ title: 'Сделай ролик про барбершоп', dept: 'marketing', creator: 'owner' });
    await w.marketing.onHeartbeat();
    const money = w.hq.createTask({ title: 'цена', dept: 'marketing', creator: 'owner' });
    w.hq.claim(money.id, 'marketing-head');
    await w.hq.requestApproval(money.id, 'marketing-head', 'price', { text: 'x' }, 'цена лиду');
    expect(w.hq.queuedApprovals().map((l) => l.kind).sort()).toEqual(['content_item', 'content_pack', 'price']);
    await w.director.sendApprovalBatch(false);
    expect(w.messenger.sent.some((m) => m.buttons?.flat().some((b) => b.data === 'ap:all'))).toBe(true);
    const r = await w.queue.approveAll(OWNER);
    w.director.afterDecision();
    expect(r).toEqual({ approved: 2, failed: 0, skipped: 1 }); // the pack and the single item; the price stays
    expect(w.queue.pending().map((p) => p.kind)).toEqual(['price']);
    expect(w.hq.task(single.id)!.status).toBe('done');
    expect(store(w).counts().ready).toBe(9); // 8 of the pack and the single one
  });

  it('an undecided pack card does not stop next week routine (the parent is done)', async () => {
    const { w } = await packed();
    expect(w.hq.runRoutine('marketing-weekly-pack')).not.toBeNull();
  });

  it('previews: an item with a picture or video is marked and the press sends the first PNG of each one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-pack-'));
    const { w, card } = await packed({ cadence: NEW_PACK });
    expect(packButtons(5, 0).flat().map((b) => b.data)).toEqual(['ap:5:a', 'pk:5:o', 'ap:5:r']);
    expect(packButtons(5, 3).flat().map((b) => b.data)).toEqual(['ap:5:a', 'pk:5:o', 'ap:5:r', 'pk:5:v']);
    // nothing rendered yet (pictures appear after approval): the press says so
    expect(await w.marketing.onPackButton('v', card.id, { chatId: OWNER, messageId: 1 })).toContain('Превью пока нет');
    // an item rendered earlier (e.g. a regenerated pack): its first PNG goes out as the preview
    const itemId = Number((card.payload.itemIds as number[])[0]);
    const file = join(dir, '1.png');
    writeFileSync(file, 'png');
    store(w).markReady(itemId, 'text', false, [{ platform: 'instagram', text: 't' }]);
    store(w).setFiles(itemId, [file]);
    expect(await w.marketing.onPackButton('v', card.id, { chatId: OWNER, messageId: 1 })).toBe('Превью ниже');
    expect(w.messenger.photos.at(-1)).toMatchObject({ chatId: OWNER, files: [file] });
  });
});
