import { afterEach, describe, expect, it } from 'vitest';
import { COMMANDS } from '../../src/commands.js';
import { drillWorld, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

const g = useGuard();
let w: DrillWorld;
afterEach(async () => { await w?.close(); });

const ARGS = ['', 'abc', '99999', '-1', '<b>x</b> & y', 'x'.repeat(3000), '12 3 4'];

describe('every command of the Shell (POST /admin/command) answers something, with and without arguments', () => {
  for (const c of COMMANDS) {
    it(`/${c.name}`, async () => {
      w = await drillWorld({ withServer: false });
      for (const a of ARGS) {
        const before = w.tg.sent.length + w.tg.edits.length + w.channel.list({ limit: 500 }).length + w.pult.length;
        await w.cmd(c.name, a);
        const after = w.tg.sent.length + w.tg.edits.length + w.channel.list({ limit: 500 }).length + w.pult.length;
        expect(after, `/${c.name} ${a.slice(0, 20)} answered nothing`).toBeGreaterThan(before);
      }
      expect(g.rejections).toEqual([]);
      expect(g.errors()).toEqual([]);
    });
  }
});

describe('commands with an effect: the state really changes, repeats are safe', () => {
  it('/pause and /resume switch a department; /level changes a kind and an agent; /desk and /away switch the presence', async () => {
    w = await drillWorld({ withServer: false });
    await w.cmd('pause', 'sales');
    expect(w.hq.headOf('sales')!.status).toBe('paused');
    await w.cmd('pause', 'sales');
    expect(w.hq.headOf('sales')!.status).toBe('paused');
    await w.cmd('resume', 'sales');
    expect(w.hq.headOf('sales')!.status).not.toBe('paused');
    await w.cmd('level', 'lead_reply 0');
    expect(w.queue.level('lead_reply')).toBe(0);
    await w.cmd('level', 'lead_price 1'); // a locked kind moves only by the owner's own word
    expect(w.queue.level('lead_price')).toBe(1);
    await w.cmd('level', 'lead_price 0');
    await w.cmd('level', 'marketing-head 1');
    expect(w.hq.agent('marketing-head')!.trustLevel).toBe(1);
    await w.cmd('level', 'ghost 1');
    expect(w.ownerSaw()).toContain('Не знаю «ghost»');
    await w.cmd('desk');
    expect(w.channel.mode).toBe('desk');
    await w.cmd('away');
    expect(w.channel.mode).toBe('away');
    expect(g.errors()).toEqual([]);
  });
  it('/client, /ticket, /invoice, /sub, /onboard, /project, /pstatus, /target, /mdone, /doc, /lesson, /kb, /playbook run their flows', async () => {
    w = await drillWorld({ withServer: false });
    await w.cmd('client', 'Dilnoza | @dilnoza | бот записи | basic | 2026-11-01');
    await w.cmd('clients');
    expect(w.ownerSaw()).toContain('Dilnoza');
    await w.cmd('ticket', 'Dilnoza: бот не отвечает');
    await w.cmd('tickets');
    expect(w.ownerSaw()).toContain('Тикет #1');
    await w.cmd('invoice', 'Dilnoza 120 поддержка due=2026-11-25');
    await w.cmd('sub', 'Dilnoza 30 month usdt_trc20 2026-12-01 basic');
    await w.cmd('invoices');
    await w.cmd('onboard', 'Dilnoza: бот записи');
    await w.cmd('project', 'Dilnoza: бот записи в салон');
    for (let i = 0; i < 3; i++) await w.beat();
    await w.cmd('pstatus', '1');
    await w.cmd('target', '1 ours bot-dilnoza');
    await w.cmd('mdone', '1 brief');
    await w.cmd('mdone', '1 brief'); // a repeat
    await w.cmd('doc', 'договор Dilnoza');
    await w.cmd('lesson', '1: бриф лучше собирать голосом');
    await w.cmd('kb', 'бриф');
    for (const role of ['content-maker', 'publisher', 'trend-scout', 'seo', 'analyst', 'sales', 'контент-мейкер']) {
      expect((await w.cmd('playbook', role)).length, role).toBeGreaterThan(0);
    }
    for (let i = 0; i < 3; i++) await w.beat();
    expect(g.errors().map((l) => `${l.msg}: ${String(l.err)}`)).toEqual([]);
    expect(g.rejections).toEqual([]);
  });
  it('/retry: a blocked task goes back to its head, a done or unknown task and a builder task are explained', async () => {
    w = await drillWorld({ withServer: false });
    const t = w.hq.createTask({ title: 'Застряла', dept: 'sales', creator: 'owner' });
    w.hq.block(t.id, 'sales-head', 'модель недоступна');
    await w.cmd('retry', String(t.id));
    expect(w.hq.task(t.id)!.status).not.toBe('blocked');
    await w.cmd('retry', String(t.id)); // not blocked any more
    expect(w.ownerSaw()).toContain('не застряла');
    await w.cmd('retry', '99999');
    expect(w.ownerSaw()).toContain('Укажите номер задачи');
    const b = w.hq.createTask({ title: 'Для строителя', dept: 'hq', creator: 'owner', tags: ['builder'] });
    w.hq.block(b.id, 'director', 'нужен строитель', ['builder']);
    await w.cmd('retry', String(b.id));
    expect(w.ownerSaw()).toContain('у строителей');
    expect(g.errors()).toEqual([]);
  });
  it('/tasks pages and /approve with and without cards (the page buttons are the legacy Telegram cards)', async () => {
    w = await drillWorld({ withServer: false, tgCards: true });
    for (let i = 0; i < 25; i++) w.hq.createTask({ title: `Задача ${i}`, dept: 'support', creator: 'owner' });
    await w.channel.asReply(() => w.director.onCommand('tasks', 'support'));
    const first = w.tg.sent.at(-1)!;
    expect(first.buttons?.flat().some((b) => b.data?.startsWith('pg:support:1'))).toBe(true);
    for (const d of ['pg:support:1', 'pg:support:2', 'pg:support:3', 'pg:all:2']) expect((await w.press(d)).some((c) => c.method === 'answerCallbackQuery')).toBe(true);
    await w.cmd('approve');
    expect(w.ownerSaw()).toContain('Нечего одобрять');
    expect(g.errors()).toEqual([]);
  });
});
