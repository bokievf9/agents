import { describe, expect, it } from 'vitest';
import { ApprovalQueue, MemoryMessenger, openDb } from '../src/index.js';

describe('own card buttons', () => {
  it('a kind can replace the default button rows; the decision buttons keep the core data', async () => {
    const messenger = new MemoryMessenger();
    const queue = new ApprovalQueue(openDb(':memory:'), messenger, 1);
    queue.register('card', {
      initialLevel: 0,
      execute: () => Promise.resolve(),
      buttons: (id) => [[{ text: 'Скопировать', data: `pc:${id}:c` }, { text: 'Отправлено', data: `ap:${id}:a` }]],
    });
    const { id } = await queue.propose('card', { text: 'x' }, 's');
    expect(messenger.last()!.buttons).toEqual([[{ text: 'Скопировать', data: `pc:${id}:c` }, { text: 'Отправлено', data: `ap:${id}:a` }]]);
    expect(await queue.handle('approve', id, 1)).toBe('Одобрено');
  });
});
