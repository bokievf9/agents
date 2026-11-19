import { describe, expect, it } from 'vitest';
import { world } from './helpers.js';

describe('/level', () => {
  it('lists the levels, sets a kind, refuses a bad level or an unknown name', async () => {
    const w = world();
    w.queue.register('lead_reply', { initialLevel: 1, execute: async () => undefined });
    w.queue.register('price', { initialLevel: 0, locked: true, execute: async () => undefined });
    expect(w.director.levelCommand('')).toContain('lead_reply: уровень 1');
    expect(w.director.levelCommand('lead_reply 0')).toContain('уровне 0');
    expect(w.queue.level('lead_reply')).toBe(0);
    expect(w.director.levelCommand('lead_reply 1')).toContain('/level lead_reply 0');
    expect(w.queue.level('lead_reply')).toBe(1);
    expect(w.director.levelCommand('lead_reply 2')).toContain('0 или 1');
    expect(w.director.levelCommand('nothing 1')).toContain('Не знаю');
    // a locked kind is changed only when named: the owner's own decision
    w.director.levelCommand('price 1');
    expect(w.queue.level('price')).toBe(1);
  });

  it('an agent id moves the unlocked kinds its department proposed, not the locked ones', async () => {
    const w = world();
    w.queue.register('a_kind', { initialLevel: 0, execute: async () => undefined });
    w.queue.register('b_lock', { initialLevel: 0, locked: true, execute: async () => undefined });
    w.hq.registerKind('a_kind', { initialLevel: 0, execute: async () => undefined });
    w.hq.registerKind('b_lock', { initialLevel: 0, locked: true, execute: async () => undefined });
    const t = w.hq.createTask({ title: 'x', dept: 'marketing', creator: 'owner' });
    w.hq.claim(t.id, 'marketing-head');
    await w.hq.requestApproval(t.id, 'marketing-head', 'a_kind', { text: 'a' }, 'a');
    await w.hq.requestApproval(t.id, 'marketing-head', 'b_lock', { text: 'b' }, 'b');
    expect(w.director.levelCommand('marketing-head 1')).toContain('a_kind');
    expect(w.queue.level('a_kind')).toBe(1);
    expect(w.queue.level('b_lock')).toBe(0);
    expect(w.hq.agent('marketing-head')!.trustLevel).toBe(1);
  });

  it('REPLY_LEVEL only seeds: a level the owner set survives a second registration', () => {
    const w = world();
    w.queue.register('lead_reply', { initialLevel: 1, execute: async () => undefined });
    w.director.levelCommand('lead_reply 0');
    w.queue.register('lead_reply', { initialLevel: 1, execute: async () => undefined });
    expect(w.queue.level('lead_reply')).toBe(0);
  });
});
