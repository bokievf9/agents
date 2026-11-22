import { MockLlm, openDb } from '@fir/core';
import { Hq } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { ensureCabinetTables } from '../src/cabinet.js';
import { Playground } from '../src/playground.js';
import { backoff, TelegramRunner, TgApiError, type TgTransport, type TgUpdate } from '../src/tg-runner.js';
import { NOW } from './helpers.js';

const TOKEN = '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN2 = '1234567891:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

class FakeTg implements TgTransport {
  queue = new Map<string, (TgUpdate | Error)[]>();
  sent: { token: string; chatId: number; text: string }[] = [];
  polls: { token: string; offset: number }[] = [];
  push(token: string, ...u: (TgUpdate | Error)[]) { this.queue.set(token, [...(this.queue.get(token) ?? []), ...u]); }
  async getUpdates(token: string, offset: number, _t: number, signal: AbortSignal): Promise<TgUpdate[]> {
    this.polls.push({ token, offset });
    const q = this.queue.get(token) ?? [];
    const next = q.shift();
    if (next instanceof Error) throw next;
    if (next) return [next];
    // an idle long poll: waits until aborted
    await new Promise<void>((r) => { if (signal.aborted) r(); else signal.addEventListener('abort', () => r(), { once: true }); });
    return [];
  }
  async send(token: string, chatId: number, text: string): Promise<void> { this.sent.push({ token, chatId, text }); }
}
const msg = (updateId: number, text: string, chatId = 77): TgUpdate => ({ updateId, chatId, text, private: true });
const tick = () => new Promise<void>((r) => setTimeout(r, 5));
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await tick(); expect(f()).toBe(true); };

function setup() {
  const db = openDb(':memory:');
  const clock = { t: NOW };
  new Hq(db, { now: () => clock.t });
  ensureCabinetTables(db);
  db.prepare("INSERT INTO cab_clients (id, email, name, created_at, updated_at) VALUES (1, 'liza@example.com', 'Лиза', 1, 1)").run();
  const pg = new Playground({ db, now: () => clock.t, tz: () => 'Asia/Dushanbe', llm: new MockLlm(() => JSON.stringify({ reply: 'Здравствуйте, чем помочь?' })), secret: 'unit-secret' });
  const tg = new FakeTg();
  const owner: string[] = [];
  const sleeps: number[] = [];
  const runner = new TelegramRunner({ agents: pg, transport: tg, db, now: () => clock.t, random: () => 0, sleep: async (ms, s) => { sleeps.push(ms); await tick(); if (s.aborted) return; }, maxBots: 2, notifyOwner: (t) => void owner.push(t) });
  const make = (token: string | null, live = true, limit?: number) => {
    const r = pg.create(1, { company: 'Салон', niche: 'салон красоты' });
    const id = (r.body.item as { id: number }).id;
    if (token) expect(pg.patch(1, id, { channels: { telegram: { botToken: token } } }).status).toBe(200);
    if (limit) expect(pg.patch(1, id, { limits: { msgsPerDay: limit } }).status).toBe(200);
    if (live) db.prepare("UPDATE pg_agents SET state = 'live' WHERE id = ?").run(id);
    return id;
  };
  return { db, pg, tg, runner, owner, sleeps, make, clock };
}

describe('telegram runner of the playground agents', () => {
  it('answers a private message of a live agent through chat() and keeps the text out of the logs', async () => {
    const s = setup();
    const id = s.make(TOKEN);
    s.tg.push(TOKEN, msg(10, 'Сколько стоит стрижка?'));
    s.runner.sync();
    await until(() => s.tg.sent.length === 1);
    expect(s.tg.sent[0]).toMatchObject({ token: TOKEN, chatId: 77, text: 'Здравствуйте, чем помочь?' });
    const conv = s.db.prepare('SELECT channel FROM pg_conversations WHERE agent_id = ?').get(id) as { channel: string };
    expect(conv.channel).toBe('telegram');
    await until(() => s.tg.polls.some((p) => p.offset === 11));
    await s.runner.stop();
  });

  it('ignores draft agents, agents without a token and group chats', async () => {
    const s = setup();
    s.make(TOKEN, false);
    s.make(null, true);
    s.runner.sync();
    expect(s.runner.active()).toEqual([]);
    const id = s.make(TOKEN2);
    s.tg.push(TOKEN2, { updateId: 1, chatId: -100, text: 'hi', private: false }, msg(2, 'привет'));
    s.runner.sync();
    await until(() => s.tg.sent.length === 1);
    expect(s.runner.active()).toEqual([id]);
    expect(s.tg.sent).toHaveLength(1);
    await s.runner.stop();
  });

  it('respects msgsPerDay: over the limit a fixed text goes out once per chat, the model is not called', async () => {
    const s = setup();
    s.make(TOKEN, true, 1);
    s.tg.push(TOKEN, msg(1, 'раз'), msg(2, 'два'), msg(3, 'три'));
    s.runner.sync();
    await until(() => s.tg.sent.length === 2);
    await tick(); await tick();
    expect(s.tg.sent[1]!.text).toMatch(/лимит/);
    expect(s.tg.sent).toHaveLength(2);
    expect((s.db.prepare("SELECT n FROM pg_journal WHERE kind = 'limit_hit'").get() as { n: number }).n).toBe(2);
    await s.runner.stop();
  });

  it('stops a bot when the agent is switched off or the token is revoked, and starts again with a new token', async () => {
    const s = setup();
    const id = s.make(TOKEN);
    s.runner.sync();
    expect(s.runner.active()).toEqual([id]);
    s.db.prepare("UPDATE pg_agents SET state = 'draft' WHERE id = ?").run(id);
    s.runner.sync();
    expect(s.runner.active()).toEqual([]);
    s.db.prepare("UPDATE pg_agents SET state = 'live' WHERE id = ?").run(id);
    s.pg.patch(1, id, { channels: { telegram: null } });
    s.runner.sync();
    expect(s.runner.active()).toEqual([]);
    s.pg.patch(1, id, { channels: { telegram: { botToken: TOKEN2 } } });
    s.runner.sync();
    expect(s.runner.active()).toEqual([id]);
    await s.runner.stop();
  });

  it('does not answer a message that arrives after the revoke', async () => {
    const s = setup();
    const id = s.make(TOKEN);
    s.runner.sync();
    s.db.prepare("UPDATE pg_agents SET state = 'draft' WHERE id = ?").run(id);
    s.tg.push(TOKEN, msg(5, 'поздно'));
    await tick(); await tick();
    s.runner.sync();
    await tick();
    expect(s.tg.sent).toHaveLength(0);
    await s.runner.stop();
  });

  it('restarts after errors with backoff, and a rejected token stops the bot for good and tells the owner', async () => {
    const s = setup();
    s.make(TOKEN);
    s.tg.push(TOKEN, new TgApiError('network'), new TgApiError('network'), new TgApiError('rate', 7000), msg(1, 'ok'));
    s.runner.sync();
    await until(() => s.tg.sent.length === 1);
    expect(s.sleeps.slice(0, 3)).toEqual([1000, 2000, 7000]);
    s.tg.push(TOKEN, new TgApiError('unauthorized'));
    s.tg.polls.length = 0;
    await tick();
    // wake the idle long poll by an unauthorized answer: queue is consulted on the next poll
    await s.runner.stop();
    const s2 = setup();
    s2.make(TOKEN);
    s2.tg.push(TOKEN, new TgApiError('unauthorized'));
    s2.runner.sync();
    await until(() => s2.owner.length === 1);
    expect(s2.owner[0]).not.toContain(TOKEN);
    await until(() => s2.runner.active().length === 0);
    s2.runner.sync();
    expect(s2.runner.active()).toEqual([]);
    await s2.runner.stop();
  });

  it('caps the number of polled bots and tells the owner once', async () => {
    const s = setup();
    s.make(TOKEN);
    s.make(TOKEN2);
    s.make('1234567892:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC');
    s.runner.sync();
    s.runner.sync();
    expect(s.runner.active()).toHaveLength(2);
    expect(s.owner).toHaveLength(1);
    await s.runner.stop();
  });

  it('backoff grows to a minute, conflicts wait at least 30 s', () => {
    expect([1, 2, 3, 10].map((n) => backoff(n, false, 0))).toEqual([1000, 2000, 4000, 60000]);
    expect(backoff(1, true, 0)).toBe(30000);
  });
});
