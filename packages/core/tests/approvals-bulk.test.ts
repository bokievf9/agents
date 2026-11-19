import { describe, expect, it } from 'vitest';
import { ApprovalQueue, MemoryMessenger, openDb, type Payload } from '../src/index.js';

const OWNER = 1;

function setup(threshold = 3) {
  const messenger = new MemoryMessenger();
  const queue = new ApprovalQueue(openDb(':memory:'), messenger, OWNER, threshold);
  const executed: string[] = [];
  const run = (name: string) => (p: Payload) => {
    executed.push(`${name}:${String(p.text)}`);
    return Promise.resolve();
  };
  queue.register('reply', { initialLevel: 0, execute: run('reply') });
  queue.register('price', { initialLevel: 0, locked: true, execute: run('price') });
  // content is not money: ordinary for bulk approval, but never promoted to level 1 by the counter
  queue.register('content', { initialLevel: 0, keepManual: true, execute: run('content') });
  // a pack's card has its own buttons and still stands for ordinary items
  queue.register('pack', { initialLevel: 0, keepManual: true, bulk: true, buttons: (id) => [[{ text: 'Пакет', data: `ap:${id}:a` }]], execute: run('pack') });
  // own buttons without `bulk` (a Scout card): the owner's own action, never in bulk
  queue.register('card', { initialLevel: 0, buttons: (id) => [[{ text: 'Карточка', data: `ap:${id}:a` }]], execute: run('card') });
  return { messenger, queue, executed };
}

describe('ordinary kinds, content and weekly packs', () => {
  it('isBulk: not locked, and no own buttons unless the kind says bulk', () => {
    const { queue } = setup();
    expect(['reply', 'content', 'pack'].every((k) => queue.isBulk(k))).toBe(true);
    expect(['price', 'card', 'unknown'].some((k) => queue.isBulk(k))).toBe(false);
  });

  it('«Одобрить все обычные» takes content items and packs, and leaves money and own-button cards for one by one', async () => {
    const { queue, executed } = setup();
    await queue.propose('reply', { text: 'r' }, 's');
    await queue.propose('content', { text: 'c' }, 's');
    await queue.propose('pack', { text: 'p' }, 's');
    await queue.propose('price', { text: 'm' }, 's');
    await queue.propose('card', { text: 'k' }, 's');
    const r = await queue.approveAll(OWNER);
    expect(r).toEqual({ approved: 3, failed: 0, skipped: 2 });
    expect(executed.sort()).toEqual(['content:c', 'pack:p', 'reply:r']);
    expect(queue.pending().map((p) => p.kind).sort()).toEqual(['card', 'price']);
  });

  it('keepManual: twenty clean approvals never promote content to level 1; an ordinary kind is promoted as before', async () => {
    const { queue } = setup(3);
    for (let i = 0; i < 5; i++) {
      const c = await queue.propose('content', { text: `c${i}` }, 's');
      await queue.handle('approve', c.id, OWNER);
      const r = await queue.propose('reply', { text: `r${i}` }, 's');
      if (r.auto) continue;
      await queue.handle('approve', r.id, OWNER);
    }
    expect(queue.level('content')).toBe(0);
    expect(queue.streak('content')).toBe(5);
    expect(queue.level('reply')).toBe(1);
    // the owner can still decide it himself
    queue.setLevel('content', 1);
    expect(queue.level('content')).toBe(1);
  });

  it('open: a proposal without a card, decided through another card; the counter and the journal work as for a button', async () => {
    const { queue, messenger, executed } = setup();
    const id = queue.open('content', { text: 'silent' }, 'in a pack');
    expect(messenger.sent).toHaveLength(0);
    expect(queue.get(id)!.status).toBe('pending');
    expect(await queue.handle('approve', id, OWNER)).toBe('Одобрено');
    expect(executed).toEqual(['content:silent']);
    expect(queue.streak('content')).toBe(1);
    expect(queue.journalRows(1)[0]).toMatchObject({ approvalId: id, kind: 'content', decision: 'approve' });
    expect(() => queue.open('nope', {}, 's')).toThrow(/Unknown approval kind/);
  });
});
