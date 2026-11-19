import { EXCERPT_MAX, playbookExcerpt } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { json, rig } from './helpers.js';

describe('Prospector: the playbook is in the prompt', () => {
  it('the first-message prompt gets the capped sales excerpt after its own rules', async () => {
    const r = rig(() => json('Здравствуйте! Это Фирдавс из Fir Tech. У Cambridge запись идёт только по звонку, поэтому вечером заявки теряются. Настроим бота для записи, от $290. Как сейчас обрабатываете вечерние заявки?'), 1);
    await r.run({ action: 'batch' });
    expect(r.llm.calls.length).toBeGreaterThan(0);
    const system = r.llm.calls[0]!.system;
    const excerpt = playbookExcerpt('sales');
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(system.endsWith(excerpt)).toBe(true);
    expect(system.length).toBeGreaterThan(excerpt.length + 100);
  });
});
