import { openDb } from '@fir/core';
import { Hq } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { COMMANDS, COMMAND_NAMES, DIRECTOR_MENU, MENU_LIMIT, routedTo, type CommandRoute } from '../src/commands.js';
import { seedBackoffice } from '../src/heads/backoffice.js';
import { seedProduction } from '../src/heads/production.js';
import { seedSales } from '../src/heads/sales.js';
import { SUPPORT_COMMANDS, seedSupport } from '../src/heads/support.js';
import { seedOrg } from '../src/org.js';
import { DIRECTOR_COMMANDS } from '../src/tg.js';
import { WORKER_TRIGGERS, cronWords, workersText } from '../src/workers.js';
import { OWNER, instructionsDir, world } from './helpers.js';

/** One list of commands feeds /help, the bot menu, the handlers and the Director's passthrough routes: nothing dead, nothing missing. */
describe('the command list, the menu and /help agree', () => {
  it('names are unique Telegram commands; the menu is at most 20, every menu command is in the list, described in Russian', () => {
    expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length);
    expect(COMMAND_NAMES.every((n) => /^[a-z][a-z0-9_]{0,31}$/.test(n))).toBe(true);
    expect(DIRECTOR_COMMANDS).toBe(DIRECTOR_MENU);
    expect(DIRECTOR_MENU.length).toBeLessThanOrEqual(MENU_LIMIT);
    expect(DIRECTOR_MENU.length).toBe(MENU_LIMIT);
    for (const c of DIRECTOR_MENU) {
      expect(COMMAND_NAMES).toContain(c.command);
      expect(c.description.length).toBeGreaterThan(3);
      expect(c.description.length).toBeLessThanOrEqual(256);
      expect(c.description).toMatch(/[а-яё]/i);
    }
    for (const c of COMMANDS) expect(c.help).toMatch(/[а-яё]/i);
  });

  it('the routes match the code: the support commands are the head list, and every route has a handler', () => {
    expect([...routedTo('support')].sort()).toEqual([...SUPPORT_COMMANDS].sort());
    const routes: CommandRoute[] = ['director', 'sales', 'support', 'production', 'backoffice', 'marketing'];
    expect(routes.flatMap((r) => routedTo(r)).sort()).toEqual([...COMMAND_NAMES].sort());
  });

  it('every command in /help works: none answers «Не знаю команды»', async () => {
    const w = world({ presence: false });
    // the heads' handlers, registered from the same list the app registers them from
    for (const route of ['production', 'backoffice', 'marketing'] as const) for (const name of routedTo(route)) w.director.commands.set(name, { dept: route, run: () => Promise.resolve(`ok ${name}`) });
    w.director.onSalesCommand = (name) => Promise.resolve(`ok ${name}`);
    w.director.onSupportCommand = (name) => Promise.resolve(`ok ${name}`);
    w.director.onSalesReply = () => Promise.resolve('ok reply');
    w.director.onDrillCommand = () => Promise.resolve('ok drill');
    w.director.onTopicsCommand = () => Promise.resolve('ok topics');
    for (const name of COMMAND_NAMES) {
      w.messenger.sent.length = 0;
      await w.director.onCommand(name, '');
      expect(w.messenger.to(OWNER).join('\n'), `/${name}`).not.toMatch(/Не знаю команды/);
      expect(w.messenger.sent.length, `/${name} answered nothing`).toBeGreaterThan(0);
    }
    // and an unknown one still gets the hint
    w.messenger.sent.length = 0;
    await w.director.onCommand('nonsense', '');
    expect(w.messenger.to(OWNER).join('\n')).toContain('Не знаю команды /nonsense');
  });
});

describe('/workers: the table of the executors and what wakes them', () => {
  function fullHq() {
    const hq = new Hq(openDb(':memory:'));
    const read = (f: string) => `Инструкция ${f}`;
    seedOrg(hq, { instructionsDir, marketingBudgetUsd: 0 });
    seedSupport(hq, { supportBudgetUsd: 0 }, read);
    seedSales(hq, { instructionsDir, salesBudgetUsd: 0 });
    seedProduction(hq, { productionBudgetUsd: 0 }, read);
    seedBackoffice(hq, { backofficeBudgetUsd: 0 }, read);
    return hq;
  }

  it('19 executors (and the client bot that only meters the model): each has a trigger, every named routine and command exists', () => {
    const hq = fullHq();
    const workers = hq.agents().filter((a) => a.role === 'worker');
    expect(workers.filter((a) => a.id !== 'client-bot')).toHaveLength(19);
    expect(workers.map((a) => a.id).sort()).toEqual([...Object.keys(WORKER_TRIGGERS)].sort());
    const routineNames = new Set(hq.routines().map((r) => r.name));
    for (const [id, t] of Object.entries(WORKER_TRIGGERS)) {
      expect((t.routines?.length ?? 0) + (t.commands?.length ?? 0) + (t.events?.length ?? 0), `${id} has no trigger`).toBeGreaterThan(0);
      for (const r of t.routines ?? []) expect(routineNames, `${id}: routine ${r}`).toContain(r);
      for (const c of t.commands ?? []) expect(COMMAND_NAMES, `${id}: /${c}`).toContain(c);
    }
    // every routine of the code wakes somebody listed in the table
    const used = new Set(Object.values(WORKER_TRIGGERS).flatMap((t) => t.routines ?? []));
    for (const r of hq.routines()) if (!r.name.startsWith('backoffice-backup') && !r.name.startsWith('backoffice-renders') && !r.name.startsWith('production-')) expect(used, `routine ${r.name} wakes nobody in the table`).toContain(r.name);
  });

  it('prints from code: every executor with its real routine times on the right clock, and the Director answers /workers', async () => {
    const hq = fullHq();
    const text = workersText(hq);
    expect(text).toContain('Исполнители (20)');
    expect(text).toContain('Content Maker (content-maker)');
    expect(text).toContain('рутина marketing-weekly-pack (пн 06:00 Куала-Лумпур)');
    expect(text).toContain('рутина marketing-daily-today (каждый день 09:00 Душанбе)');
    expect(text).toContain('Presales (presales): /kp; лид стал квалифицированным');
    expect(text).toContain('Monitoring (monitoring): каждые 5 минут');
    expect(text).toContain('Referral Manager (referral)');
    expect(cronWords({ cron: '30 8 * * 1', tz: 'owner' })).toBe('пн 08:30 Куала-Лумпур');
    expect(cronWords({ cron: '*/5 * * * *', tz: 'company' })).toBe('*/5 * * * * Душанбе');
    const w = world();
    for (const a of hq.agents()) w.hq.upsertAgent({ ...a });
    await w.director.onCommand('workers', '');
    expect(w.messenger.to(OWNER).at(-1)).toContain('Исполнители (');
  });
});
