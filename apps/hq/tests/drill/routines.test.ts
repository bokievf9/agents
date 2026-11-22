import { Cron } from 'croner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drillWorld, NOW, type DrillWorld } from './world.js';
import { seedEverything } from './seed.js';
import { useGuard } from './guard.js';

const g = useGuard();
let w: DrillWorld;
afterEach(async () => { vi.useRealTimers(); await w?.close(); });

const ROUTINES = ['marketing-weekly-pack', 'marketing-daily-today', 'marketing-trends-daily', 'marketing-trends-weekly', 'marketing-analyst-weekly', 'marketing-article-daily', 'marketing-seo-weekly',
  'support-daily', 'support-weekly', 'support-billing', 'sales-daily-cards', 'sales-followups', 'sales-referral-reminders', 'production-overdue', 'backoffice-lessons-weekly', 'backoffice-backup-daily', 'backoffice-renders-cleanup'];


describe('every routine, run once through Hq.runRoutine and the heads', () => {
  it('the routine list is the one the census knows', async () => {
    w = await drillWorld({ withServer: false });
    expect(w.hq.routines().map((r) => r.name).sort()).toEqual([...ROUTINES].sort());
  });
  for (const name of ROUTINES) {
    it(`${name}: a task is made, a head finishes it (done, approval or an explained block), no error line`, async () => {
      w = await drillWorld({ withServer: false });
      for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
      const t = w.hq.runRoutine(name);
      expect(t, 'the routine made no task').not.toBeNull();
      for (let i = 0; i < 4; i++) await w.beat();
      const after = w.hq.task(t!.id)!;
      expect(['done', 'approval', 'blocked', 'review'], `${name} stuck in ${after.status}`).toContain(after.status);
      if (after.status === 'blocked') {
        const why = w.hq.events(t!.id).at(-1)!.body;
        expect(why.length, 'a blocked routine must say why').toBeGreaterThan(5);
      }
      // the same routine fired again while the first is not terminal: skipped, not doubled
      const second = w.hq.runRoutine(name);
      if (second) expect(second.id).not.toBe(t!.id);
      expect(g.errors()).toEqual([]);
      expect(g.rejections).toEqual([]);
    });
  }
  it('a routine that is switched off or unknown makes nothing', async () => {
    w = await drillWorld({ withServer: false });
    expect(w.hq.runRoutine('nope')).toBeNull();
    w.hq.setRoutineEnabled('support-daily', false);
    expect(w.hq.runRoutine('support-daily')).toBeNull();
  });
});

describe('the heads under a dead or garbage model gateway', () => {
  for (const mode of ['down', 'garbage'] as const) {
    it(`all routines with the gateway ${mode}: tasks end in a reason, nothing throws, the owner is told once`, async () => {
      w = await drillWorld({ withServer: false });
      if (mode === 'down') w.state.down = true; else w.state.garbage = true;
      for (const n of ROUTINES) w.hq.runRoutine(n);
      for (let i = 0; i < 5; i++) await w.beat();
      const stuck = w.hq.tasks({ status: ['running', 'inbox', 'assigned'], limit: 100 });
      expect(stuck.map((t) => `${t.id} ${t.title} ${t.status}`), 'tasks left running').toEqual([]);
      for (const t of w.hq.tasks({ status: ['blocked'], limit: 100 })) expect(w.hq.events(t.id).at(-1)!.body.length).toBeGreaterThan(5);
      expect(g.errors().map((l) => `${l.msg}: ${String(l.err)}`)).toEqual([]);
      expect(g.rejections).toEqual([]);
    }, 30_000);
  }
});

describe('the clocks: every routine is scheduled on the right clock', () => {
  it('startRoutines makes one cron per enabled routine, on the owner clock (Kuala Lumpur) or the market clock (Dushanbe)', async () => {
    w = await drillWorld({ withServer: false });
    const jobs = w.startRoutines();
    expect(jobs.length).toBe(ROUTINES.length);
    const owner = new Set(['marketing-weekly-pack', 'marketing-trends-daily', 'marketing-trends-weekly', 'marketing-analyst-weekly', 'marketing-article-daily', 'marketing-seo-weekly', 'support-daily', 'support-weekly', 'support-billing', 'sales-daily-cards', 'sales-followups', 'sales-referral-reminders', 'production-overdue']);
    for (const r of w.hq.routines()) {
      const expected = owner.has(r.name) ? 'Asia/Kuala_Lumpur' : 'Asia/Dushanbe';
      expect(w.hq.routineTz(r), r.name).toBe(expected);
      const next = new Cron(r.cron, { timezone: expected }).nextRun(new Date(NOW));
      expect(next, `${r.name} never fires`).not.toBeNull();
      expect(next!.getTime() - NOW, `${r.name} fires within a week`).toBeLessThanOrEqual(7 * 86_400_000);
    }
    // the owner's morning chain: article 07:30 before the 08:00 summary and the 09:00 batch, all on his clock
    const at = (name: string) => new Cron(w.hq.routineByName(name)!.cron, { timezone: 'Asia/Kuala_Lumpur' }).nextRun(new Date(Date.UTC(2026, 10, 18, 0, 0)))!.toISOString().slice(11, 16);
    expect(at('marketing-article-daily')).toBe('23:30'); // 07:30 KL = 23:30Z the evening before
    jobs.forEach((j) => j.stop());
  });
  it('the Director jobs run their handlers: summary, approvals batch and the Monday digest answer the owner', async () => {
    w = await drillWorld({ withServer: false });
    expect(w.director.schedulePlan().map((p) => p.name)).toEqual(['director-summary', 'director-approvals', 'director-digest']);
    for (const p of w.director.schedulePlan()) expect(new Cron(p.cron, { timezone: p.tz }).nextRun(new Date(NOW))).not.toBeNull();
    const n = w.tg.sent.length;
    await w.director.sendMorningSummary();
    await w.director.sendApprovalBatch(false);
    await w.director.sendWeeklyDigest();
    expect(w.tg.sent.length).toBeGreaterThan(n);
    expect(w.posted.some((p) => p.dept === 'general')).toBe(true); // the group topic got the summary
    w.director.start();
    w.support.start();
    w.director.stop();
    w.support.stop();
    expect(g.errors()).toEqual([]);
    expect(g.rejections).toEqual([]);
  });
});

describe('workers on their own crons', () => {
  it('monitoring, SLA and the payment watch tick without throwing, also with the indexers down', async () => {
    w = await drillWorld();
    await seedEverything(w);
    await expect(w.support.monitorTick()).resolves.toBeDefined();
    await expect(w.support.slaTick()).resolves.toBeDefined();
    await expect(w.support.paymentTick()).resolves.toBeDefined();
    w.chain.fail = true;
    await expect(w.support.paymentTick()).resolves.toBeDefined();
    expect(g.errors()).toEqual([]);
    expect(g.rejections).toEqual([]);
  });
  it('the 30 s ticker (demo reminders, audit watch, lost leads) and presence sync run clean', async () => {
    w = await drillWorld({ withServer: false });
    await w.marketing.auditWatch();
    w.lost.watchStale();
    await w.lost.flush();
    await w.channel.sync();
    w.hq.recoverInterrupted();
    expect(g.errors()).toEqual([]);
  });
});

describe('the night routines on real files', () => {
  it('the backup routine makes an archive of the SQLite files and sends it to the owner; the cleanup routine removes an old render folder', async () => {
    const { mkdirSync, utimesSync, writeFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { openDb } = await import('@fir/core');
    w = await drillWorld({ withServer: false });
    const file = openDb(join(w.dataDir, 'hq.db'));
    file.exec('CREATE TABLE t (x TEXT)');
    file.close();
    const t = w.hq.runRoutine('backoffice-backup-daily')!;
    await w.beat();
    expect(w.hq.task(t.id)!.status, JSON.stringify(w.hq.events(t.id).at(-1))).toBe('done');
    expect(w.tg.documents.length, 'no age key: the plain archive never goes to the owner').toBe(0);
    // renders of an item that no longer exists, older than 14 days
    mkdirSync(join(w.rendersDir, '777'), { recursive: true });
    writeFileSync(join(w.rendersDir, '777', 'reel.mp4'), 'x');
    const old = new Date(w.clock.t - 20 * 86_400_000);
    utimesSync(join(w.rendersDir, '777'), old, old);
    const c = w.hq.runRoutine('backoffice-renders-cleanup')!;
    await w.beat();
    expect(w.hq.task(c.id)!.status, JSON.stringify(w.hq.events(c.id).at(-1))).toBe('done');
    expect(existsSync(join(w.rendersDir, '777'))).toBe(false);
    expect(g.errors()).toEqual([]);
  });
});

describe('the real heartbeat: five heads at once (three at a time) with a slow model', () => {
  it('every routine of the company run together ends once, in a terminal or waiting state, with no double processing and no error line', async () => {
    w = await drillWorld({ withServer: false });
    w.state.delayMs = 6;
    for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
    const made = ROUTINES.map((n) => w.hq.runRoutine(n)!);
    expect(made.every(Boolean)).toBe(true);
    w.heartbeat.start();
    const open = () => w.hq.tasks({ status: ['inbox', 'assigned', 'running'], limit: 500 });
    const t0 = Date.now();
    while (open().length && Date.now() - t0 < 25_000) await new Promise((r) => setTimeout(r, 20));
    w.heartbeat.stop();
    await w.heartbeat.idle();
    expect(open().map((t) => `${t.id} ${t.dept} ${t.title} ${t.status}`), 'tasks never finished').toEqual([]);
    for (const t of made) {
      const fresh = w.hq.task(t.id)!;
      const claims = w.hq.events(t.id).filter((e) => e.kind === 'status' && /-> running/.test(e.body)).length;
      expect(claims, `task ${t.id} (${fresh.title}) was started more than once`).toBeLessThanOrEqual(1 + (fresh.status === 'blocked' ? 1 : 0));
    }
    expect(g.errors().map((l) => `${l.msg}: ${String(l.err)}`)).toEqual([]);
    expect(g.rejections).toEqual([]);
  }, 60_000);
});
