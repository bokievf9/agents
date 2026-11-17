import { describe, expect, it } from 'vitest';
import { ApprovalQueue, MemoryMessenger, openDb, type Payload } from '../src/index.js';

const OWNER = 1;

function setup(threshold = 3) {
  const messenger = new MemoryMessenger();
  const queue = new ApprovalQueue(openDb(':memory:'), messenger, OWNER, threshold);
  const executed: Payload[] = [];
  queue.register('reply', { initialLevel: 0, execute: (p) => { executed.push(p); return Promise.resolve(); } });
  queue.register('price', { initialLevel: 0, locked: true, execute: (p) => { executed.push(p); return Promise.resolve(); } });
  queue.register('duty', { initialLevel: 1, execute: (p) => { executed.push(p); return Promise.resolve(); } });
  return { messenger, queue, executed };
}

describe('approval queue', () => {
  it('does nothing until approved, then runs once', async () => {
    const { queue, executed, messenger } = setup();
    const { id, auto } = await queue.propose('reply', { text: 'hi' }, 'client asks');
    expect(auto).toBe(false);
    expect(executed).toHaveLength(0);
    expect(messenger.last()?.buttons?.[0]?.map((b) => b.data)).toEqual([`ap:${id}:a`, `ap:${id}:e`, `ap:${id}:r`]);
    expect(await queue.handle('approve', id, OWNER)).toBe('Одобрено');
    expect(executed).toEqual([{ text: 'hi' }]);
    expect(await queue.handle('approve', id, OWNER)).toBe('Уже обработано');
    expect(executed).toHaveLength(1);
  });

  it('refuses anyone but the owner', async () => {
    const { queue, executed } = setup();
    const { id } = await queue.propose('reply', { text: 'x' }, 's');
    expect(await queue.handle('approve', id, 999)).toBe('Нет доступа');
    expect(executed).toHaveLength(0);
  });

  it('reject never executes and resets the streak', async () => {
    const { queue, executed } = setup();
    const a = await queue.propose('reply', { text: 'a' }, 's');
    await queue.handle('approve', a.id, OWNER);
    expect(queue.streak('reply')).toBe(1);
    const b = await queue.propose('reply', { text: 'b' }, 's');
    await queue.handle('reject', b.id, OWNER);
    expect(executed).toHaveLength(1);
    expect(queue.streak('reply')).toBe(0);
  });

  it('edit replaces the text, resets the streak and the edited approval is not a clean one', async () => {
    const { queue, executed } = setup();
    const a = await queue.propose('reply', { text: 'a' }, 's');
    await queue.handle('approve', a.id, OWNER);
    const b = await queue.propose('reply', { text: 'draft' }, 's');
    await queue.handle('edit', b.id, OWNER);
    expect(queue.awaitingEdit).toBe(true);
    expect(await queue.submitEdit(OWNER, 'better')).toBe(true);
    expect(queue.awaitingEdit).toBe(false);
    expect(executed).toHaveLength(1);
    await queue.handle('approve', b.id, OWNER);
    expect(executed.at(-1)).toEqual({ text: 'better' });
    expect(queue.streak('reply')).toBe(0);
  });

  it('only the owner can submit an edit', async () => {
    const { queue } = setup();
    const a = await queue.propose('reply', { text: 'a' }, 's');
    await queue.handle('edit', a.id, OWNER);
    expect(await queue.submitEdit(2, 'hack')).toBe(false);
    expect(queue.awaitingEdit).toBe(true);
  });

  it('moves a kind to level 1 after the threshold of clean approvals, then acts by itself', async () => {
    const { queue, executed, messenger } = setup(3);
    for (let i = 0; i < 3; i++) {
      const { id } = await queue.propose('reply', { text: String(i) }, 's');
      await queue.handle('approve', id, OWNER);
    }
    expect(queue.level('reply')).toBe(1);
    expect(messenger.to(OWNER).some((t) => t.includes('уровень 1'))).toBe(true);
    const r = await queue.propose('reply', { text: 'auto' }, 's');
    expect(r.auto).toBe(true);
    expect(executed.at(-1)).toEqual({ text: 'auto' });
    expect(queue.journalRows(1)[0]?.decision).toBe('auto');
  });

  it('a locked kind (prices) is never promoted by the counter', async () => {
    const { queue } = setup(2);
    for (let i = 0; i < 5; i++) {
      const { id } = await queue.propose('price', { text: 'p' }, 's');
      await queue.handle('approve', id, OWNER);
    }
    expect(queue.level('price')).toBe(0);
    expect((await queue.propose('price', { text: 'p' }, 's')).auto).toBe(false);
  });

  it('a kind registered at level 1 acts at once', async () => {
    const { queue, executed } = setup();
    expect((await queue.propose('duty', { text: 'q' }, 's')).auto).toBe(true);
    expect(executed).toHaveLength(1);
  });

  it('a failing action is marked failed and does not count', async () => {
    const messenger = new MemoryMessenger();
    const queue = new ApprovalQueue(openDb(':memory:'), messenger, OWNER, 2);
    queue.register('bad', { initialLevel: 0, execute: () => Promise.reject(new Error('boom')) });
    const { id } = await queue.propose('bad', { text: 'x' }, 's');
    expect(await queue.handle('approve', id, OWNER)).toBe('Ошибка выполнения');
    expect(queue.get(id)?.status).toBe('failed');
    expect(queue.streak('bad')).toBe(0);
  });

  it('journals every decision without texts', async () => {
    const { queue } = setup();
    const a = await queue.propose('reply', { text: 'secret client text' }, 's');
    await queue.handle('approve', a.id, OWNER);
    const rows = queue.journalRows();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('secret');
  });
});
