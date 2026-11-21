/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { MockLlm, openDb, tryComplete } from '@fir/core';
import { CsStore } from '@fir/worker-customer-support';
import { describe, expect, it } from 'vitest';
import { countCalls } from '../src/client/shared.js';
import { RateLimiter } from '../src/client/sanitize.js';
import { ensureCabinetTables } from '../src/cabinet.js';
import { Playground } from '../src/playground.js';
import { NOW } from './helpers.js';
import { pultWorld } from './pult-helpers.js';

describe('P-22: the client closes his own ticket in the cabinet', () => {
  it('POST /admin/clients/:id/tickets/:tid/close: only the own cabinet ticket, idempotent, the ticket leaves the SLA', async () => {
    const p = pultWorld();
    const reg = async (email: string) => {
      const r = await p.call('POST', '/admin/clients', { email, name: 'Клиент', supabaseId: `sb-${email.split('@')[0]}` });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json.client.id as number;
    };
    const a = await reg('a@example.com');
    const b = await reg('b@example.com');
    const made = await p.call('POST', `/admin/clients/${a}/tickets`, { text: 'Не приходит уведомление' });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const created = made.json.item;
    expect(created.status).toBe('open');
    expect((await p.call('POST', `/admin/clients/${b}/tickets/${created.id}/close`)).status).toBe(404);
    expect((await p.call('POST', `/admin/clients/${a}/tickets/9999/close`)).status).toBe(404);
    const r = await p.call('POST', `/admin/clients/${a}/tickets/${created.id}/close`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ already: false, item: { id: created.id, status: 'closed' } });
    expect((await p.call('POST', `/admin/clients/${a}/tickets/${created.id}/close`)).json.already).toBe(true);
    // no SLA alert for a closed ticket, even long after
    expect(new CsStore(p.w.hq.db, () => p.w.clock.t + 86_400_000).takeSlaBreaches(4 * 3_600_000)).toHaveLength(0);
  });

  it('the store: close() keeps the first time, a late approved answer does not reopen it, the list puts closed last', () => {
    const db = openDb(':memory:');
    let t = NOW;
    const cs = new CsStore(db, () => t);
    const x = cs.addTicket({ clientName: 'Лола', text: 'вопрос 1', money: false });
    const y = cs.addTicket({ clientName: 'Лола', text: 'вопрос 2', money: false });
    expect(cs.close(x.id)).toBe(true);
    const first = cs.ticket(x.id)!.answeredAt;
    t += 1000;
    cs.close(x.id);
    expect(cs.ticket(x.id)!.answeredAt).toBe(first);
    cs.markAnswered(x.id, 'поздний ответ');
    expect(cs.ticket(x.id)!.status).toBe('closed');
    expect(cs.close(999)).toBe(false);
    expect(cs.recent().map((r) => r.id)).toEqual([y.id, x.id]);
  });
});

describe('P-25: the daily cap counts model calls', () => {
  it('countCalls counts every request (complete, detailed, chat) through the gate', async () => {
    let n = 0;
    const llm = countCalls(new MockLlm(() => 'ok'), { llmUsed: () => void n++ });
    await llm.complete({ tier: 'haiku', system: '', messages: [{ role: 'user', content: 'a' }] });
    await llm.complete({ tier: 'haiku', system: '', messages: [{ role: 'user', content: 'b' }] });
    await tryComplete(llm, { tier: 'haiku', system: '', messages: [{ role: 'user', content: 'c' }] });
    expect(n).toBe(3);
  });

  it('a playground turn with a tool round costs several calls of the cap, not one', async () => {
    const db = openDb(':memory:');
    ensureCabinetTables(db);
    db.prepare("INSERT INTO cab_clients (id, email, name, created_at, updated_at) VALUES (1, 'liza@example.com', 'Лиза', 1, 1)").run();
    let used = 0;
    const pg = new Playground({
      db, now: () => NOW, tz: () => 'Asia/Dushanbe', secret: 's',
      llm: new MockLlm((_req, i) => (i === 1 ? JSON.stringify({ reply: 'Смотрю.', tool: { name: 'faq_search', args: { query: 'доставка' } } }) : JSON.stringify({ reply: 'Готово.' }))),
      gate: { llmAllowed: () => true, llmUsed: () => void used++ },
    });
    const a = pg.create(1, { company: 'Салон', niche: 'салон красоты', tools: ['faq_search'] });
    const id = (a.body.item as any).id as number;
    const r = await pg.chatAdmin(1, id, { text: 'Что у вас по доставке?' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain('Готово');
    expect(used).toBeGreaterThanOrEqual(2);
  });

  it('the owner hears at 80% and at 100% of the cap, once each, and the counter restarts the next day', () => {
    const clock = { t: NOW };
    const l = new RateLimiter(20, 10, () => clock.t, () => 'Asia/Tashkent');
    const seen: [number, number, number][] = [];
    l.onCap = (lvl, used, cap) => void seen.push([lvl, used, cap]);
    for (let i = 0; i < 12; i++) l.llmUsed();
    expect(seen).toEqual([[80, 8, 10], [100, 10, 10]]);
    clock.t += 86_400_000;
    for (let i = 0; i < 8; i++) l.llmUsed();
    expect(seen).toHaveLength(3);
    // a throwing notice never breaks counting
    l.onCap = () => { throw new Error('boom'); };
    expect(() => { for (let i = 0; i < 5; i++) l.llmUsed(); }).not.toThrow();
  });

  it('an agent that hits its daily limit tells the owner once a day (no visitor text) and the cabinet thread gets the agent line', async () => {
    const db = openDb(':memory:');
    ensureCabinetTables(db);
    db.prepare("INSERT INTO cab_clients (id, email, name, created_at, updated_at) VALUES (1, 'liza@example.com', 'Лиза', 1, 1)").run();
    const clock = { t: NOW };
    const owner: string[] = [];
    const pg = new Playground({ db, now: () => clock.t, tz: () => 'Asia/Dushanbe', secret: 's', llm: new MockLlm(() => JSON.stringify({ reply: 'Здравствуйте!' })), notifyOwner: (t) => void owner.push(t) });
    const a = pg.create(1, { company: 'Салон', niche: 'салон красоты' });
    const id = (a.body.item as any).id as number;
    pg.patch(1, id, { limits: { msgsPerDay: 1 } });
    await pg.chatAdmin(1, id, { text: 'первый' });
    expect((await pg.chatAdmin(1, id, { text: 'секретный текст посетителя' })).status).toBe(429);
    expect((await pg.chatAdmin(1, id, { text: 'ещё раз' })).status).toBe(429);
    expect(owner).toHaveLength(1);
    expect(owner[0]).toContain('исчерпал лимит 1');
    expect(owner[0]).not.toContain('секретный');
    clock.t += 86_400_000;
    await pg.chatAdmin(1, id, { text: 'новый день' });
    await pg.chatAdmin(1, id, { text: 'и снова' });
    expect(owner).toHaveLength(2);
  });
});
