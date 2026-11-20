import { describe, expect, it } from 'vitest';
import { ApprovalQueue, MemoryMessenger, openDb, placeholderHold, type Payload } from '../src/index.js';

const OWNER = 1;

/** Drill 2026-11-21: «Одобрить» on a card with `[цена]` used to run the kind, throw and leave the proposal `failed` for good ("Ошибка выполнения"). */
function setup() {
  const queue = new ApprovalQueue(openDb(':memory:'), new MemoryMessenger(), OWNER, 3);
  const executed: Payload[] = [];
  queue.register('price', {
    initialLevel: 0, locked: true,
    ready: (p) => placeholderHold(String(p.text).match(/\[[^\]]*\]/g) ?? []),
    execute: (p) => { executed.push(p); return Promise.resolve(); },
  });
  return { queue, executed };
}

describe('KindSpec.ready on a level 1 kind', () => {
  it('a draft with a template waits as a card instead of acting alone and failing; a clean draft acts at once', async () => {
    const queue = new ApprovalQueue(openDb(':memory:'), new MemoryMessenger(), OWNER, 3);
    const executed: Payload[] = [];
    queue.register('answer', {
      initialLevel: 1, ready: (p) => placeholderHold(String(p.text).match(/\[[^\]]*\]/g) ?? []),
      execute: (p) => { executed.push(p); return Promise.resolve(); },
    });
    const held = await queue.propose('answer', { text: 'Ответ: [решение владельца]' }, 's');
    expect(held.auto).toBe(false);
    expect(queue.get(held.id)!.status).toBe('pending');
    expect(executed).toHaveLength(0);
    const clean = await queue.propose('answer', { text: 'Всё работает, спасибо.' }, 's');
    expect(clean).toMatchObject({ auto: true, ok: true });
    expect(executed).toHaveLength(1);
  });
});

describe('KindSpec.ready: a template left in the text holds the approval open', () => {
  it('approve answers the reason, runs nothing and keeps the proposal pending; after the edit the same card approves', async () => {
    const { queue, executed } = setup();
    const { id } = await queue.propose('price', { text: 'Стоимость: [цена]' }, 'price question');
    const answer = await queue.handle('approve', id, OWNER);
    expect(answer).toContain('[цена]');
    expect(answer).toContain('Править');
    expect(queue.get(id)!.status).toBe('pending');
    expect(executed).toHaveLength(0);
    expect(queue.notReady(id)).toContain('[цена]');
    expect(await queue.applyEdit(id, 'Стоимость: 250 USD')).toBe(true);
    expect(queue.notReady(id)).toBeNull();
    expect(await queue.handle('approve', id, OWNER)).toBe('Одобрено');
    expect(executed).toEqual([{ text: 'Стоимость: 250 USD' }]);
  });

  it('reject still works on a card with a template, and «Одобрить все» leaves it for the owner', async () => {
    const { queue, executed } = setup();
    const a = await queue.propose('price', { text: 'Срок: [срок]' }, 'a');
    const r = await queue.approveAll(OWNER);
    expect(r).toEqual({ approved: 0, failed: 0, skipped: 1 });
    expect(queue.get(a.id)!.status).toBe('pending');
    expect(await queue.handle('reject', a.id, OWNER)).toBe('Отклонено');
    expect(executed).toHaveLength(0);
  });
});
