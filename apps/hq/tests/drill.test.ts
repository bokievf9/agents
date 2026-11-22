import { ApprovalQueue, MemoryMessenger, MockLlm, openDb, type LlmRequest } from '@fir/core';
import { Hq } from '@fir/hq';
import { BillingWorker } from '@fir/worker-billing';
import { FinanceWorker } from '@fir/worker-finance';
import { MonitoringWorker, type CheckDeps } from '@fir/worker-monitoring';
import { ProspectorWorker, storeFor as prospectStoreFor } from '@fir/worker-prospector';
import { describe, expect, it } from 'vitest';
import { Director } from '../src/director.js';
import { DRILL_CLIENT, Drill } from '../src/drill.js';
import { BackofficeHead, seedBackoffice } from '../src/heads/backoffice.js';
import { MarketingHead } from '../src/heads/marketing.js';
import { ProductionHead, seedProduction } from '../src/heads/production.js';
import { SalesHead, seedSales } from '../src/heads/sales.js';
import { SupportHead, seedSupport } from '../src/heads/support.js';
import { seedOrg } from '../src/org.js';
import { Reporter, type TopicSender } from '../src/reporter.js';
import { CSV } from './sales-helpers.js';
import { NOW, OWNER, clipJson, instructionsDir } from './helpers.js';

const MIN = 60_000;
const read = (file: string) => `Инструкция ${file}`;

function drillWorld() {
  const clock = { t: NOW };
  const db = openDb(':memory:');
  const messenger = new MemoryMessenger();
  const hq = new Hq(db, { now: () => clock.t });
  const queue = new ApprovalQueue(db, messenger, OWNER, 20, () => clock.t);
  hq.attachQueue(queue);
  seedOrg(hq, { instructionsDir, marketingBudgetUsd: 0 });
  seedSupport(hq, { supportBudgetUsd: 0 }, read);
  seedSales(hq, { instructionsDir, salesBudgetUsd: 0 });
  seedProduction(hq, { productionBudgetUsd: 0 }, read);
  seedBackoffice(hq, { backofficeBudgetUsd: 0 }, read);
  const posted: { chatId: number; threadId: number; text: string }[] = [];
  const send: TopicSender = (chatId, threadId, text) => Promise.resolve(void posted.push({ chatId, threadId, text }));
  const reporter = new Reporter(-1001, { general: 2 }, new Map([['general', send]]));
  const llm = new MockLlm((req: LlmRequest) => {
    if (req.system.includes('Проверь')) return '{"ok":true,"issues":[]}';
    if (req.system.includes('Определи')) return '{"action":"none"}';
    return clipJson();
  });
  const offline = () => Promise.resolve(new Response('', { status: 500 }));
  const marketing = new MarketingHead({ hq, llm, queue, messenger, ownerId: OWNER, reporter, rng: () => 0.1, integrations: { fetch: offline } });
  const deps: CheckDeps = {
    now: () => clock.t, fetch: (() => Promise.resolve(new Response('{"ok":true}', { status: 200 }))) as unknown as typeof fetch,
    certValidTo: () => Promise.resolve(new Date(clock.t + 60 * 86_400_000).toUTCString()),
    statfs: () => Promise.resolve({ blocks: 100, bavail: 60 }), listContainers: () => Promise.resolve([]),
  };
  const support = new SupportHead({
    hq, llm, reporter, messenger, ownerId: OWNER, finance: new FinanceWorker({ fixedCosts: {} }), billing: new BillingWorker({ paymentDetails: { usdt_trc20: 'TXyz00' } }),
    monitor: new MonitoringWorker({ urls: ['https://firtech.pro/api/health'], omnirouteUrl: 'http://omniroute:20128/health', dataDir: '/d', docker: false, dockerSocket: '/s', diskMaxPct: 85, certMinDays: 14, timeoutMs: 1000 }, deps),
  });
  const sales = new SalesHead({ hq, llm, queue, messenger, ownerId: OWNER, reporter, prospector: new ProspectorWorker({ batchSize: 10 }) });
  prospectStoreFor({ db, now: hq.now }).importCsv(CSV);
  const production = new ProductionHead({ hq, llm, queue, messenger, ownerId: OWNER, reporter });
  const backoffice = new BackofficeHead({ hq, llm, queue, messenger, ownerId: OWNER, reporter });
  const director = new Director({ hq, llm, messenger, queue, ownerId: OWNER, reporter });
  const drill = new Drill({ hq, queue, messenger, ownerId: OWNER, reporter, monitor: async () => `проверки выполнены, событий: ${(await support.monitorTick()).length}`, kb: (q) => backoffice.command('kb', q) });
  director.onDrillCommand = (arg) => drill.command(arg);
  const beat = async () => {
    await marketing.onHeartbeat();
    await support.onHeartbeat();
    await sales.onHeartbeat();
    await production.onHeartbeat();
    await backoffice.onHeartbeat();
  };
  return { clock, db, hq, queue, messenger, posted, director, drill, beat };
}

const ACTIONS: Record<string, string> = {
  'trend-scout': 'trends', 'content-maker': 'topic', seo: 'seo', analyst: 'report', 'lead-intake': 'lead', prospector: 'batch', presales: 'kp',
  referral: 'referral_reminders', 'customer-support': 'ticket', billing: 'invoice', onboarding: 'onboard', finance: 'weekly', 'project-manager': 'project', documents: 'doc',
};

describe('/drill', () => {
  it('creates one tagged task per worker (publisher waits for the clip) and wires the Director command and help', async () => {
    const w = drillWorld();
    await w.director.onCommand('drill');
    const tasks = w.hq.tasks({ tag: 'drill' });
    const byWorker = new Map(tasks.map((t) => [(t.meta.drill as { worker: string }).worker, t]));
    for (const [worker, action] of Object.entries(ACTIONS)) {
      const t = byWorker.get(worker)!;
      expect(t, worker).toBeDefined();
      expect(t.meta.action).toBe(action);
      expect(t.title.startsWith('Учения: ')).toBe(true);
      expect(t.tags).toContain('drill');
      expect((t.meta.drill as { startedAt: number }).startedAt).toBe(NOW);
    }
    expect(byWorker.get('monitoring')!.status).toBe('done');
    expect(byWorker.get('knowledge')!.status).toBe('done');
    expect(byWorker.has('publisher')).toBe(false);
    expect(tasks).toHaveLength(16);
    const lead = byWorker.get('lead-intake')!.meta.lead as { name: string; contact: string };
    expect(lead.name).toBe('Тест: нужен сайт');
    expect(lead.contact).toContain('invalid');
    await w.director.onCommand('drill', 'nope');
    expect(w.messenger.last()!.text).toContain('Формат: /drill');
  });

  it('/drill <dept> makes only that department; a second run while tasks are open is refused', async () => {
    const w = drillWorld();
    await w.director.onCommand('drill', 'backoffice');
    expect(w.hq.tasks({ tag: 'drill' }).map((t) => t.dept)).toEqual(['backoffice', 'backoffice']);
    await w.director.onCommand('drill', 'sales');
    expect(w.hq.tasks({ tag: 'drill', dept: 'sales' })).toHaveLength(4);
    await w.director.onCommand('drill', 'sales');
    expect(w.messenger.last()!.text).toContain('ещё идут');
    expect(w.hq.tasks({ tag: 'drill', dept: 'sales' })).toHaveLength(4);
  });

  it('report shows ⏳ at first, then ✅/⚠️/❌ as heads work, with the publisher chained after the clip', async () => {
    const w = drillWorld();
    await w.director.onCommand('drill');
    await w.director.onCommand('drill', 'report');
    const first = w.messenger.last()!.text;
    expect(first).toContain('⏳ Trend Scout');
    expect(first).toContain('✅ Monitoring');
    expect(first).toContain('⚠️ Reviewer and QA');
    await w.beat();
    w.clock.t += 40_000;
    await w.director.onCommand('drill', 'report');
    const report = w.messenger.last()!.text;
    expect(report).toMatch(/❌ Trend Scout, \d+с: Источники не дали данных/); // the stubbed network is down
    expect(report).toMatch(/✅ Analyst, \d+с/);
    expect(report).toMatch(/⚠️ Content Maker/);
    expect(report).toContain('ждёт вас');
    expect(report).toContain('⚠️ Publisher: ждёт одобрения клипа');
    expect(report).toContain('⚠️ Reviewer and QA: ждёт одобрения ТЗ / строителя');
    expect(report).toContain('⚠️ Deployer: ждёт одобрения ТЗ / строителя');
    expect(report.split('\n').filter((l) => l.startsWith('⏳'))).toHaveLength(0);
    expect(report).toContain('Отклоните их в /approve');
    expect(report).toMatch(/Итого: ✅ \d+, ⚠️ \d+, ❌ \d+, ⏳ 0\./);
    // the clip is approved: the publisher task appears and finishes
    await w.director.onCommand('approve');
    const clip = w.hq.tasks({ tag: 'drill', dept: 'marketing' }).find((t) => t.meta.action === 'topic')!;
    const link = w.db.prepare('SELECT approval_id FROM task_approvals WHERE task_id = ?').get(clip.id) as { approval_id: number };
    await w.queue.handle('approve', link.approval_id, OWNER);
    w.director.afterDecision();
    await w.director.onCommand('drill', 'report');
    await w.beat();
    await w.director.onCommand('drill', 'report');
    expect(w.messenger.last()!.text).toMatch(/✅ Publisher/);
  });

  it('the table always lists every scenario in order: 19 rows, a missing task is visible', async () => {
    const w = drillWorld();
    const rowLines = (text: string) => text.split('\n').filter((l) => /^(✅|⚠️|❌|⏳) /.test(l));
    await w.director.onCommand('drill', 'backoffice'); // only two tasks exist
    await w.director.onCommand('drill', 'report');
    const rows = rowLines(w.messenger.last()!.text);
    expect(rows).toHaveLength(19);
    expect(rows[0]).toBe('⏳ Trend Scout: задача не создана');
    expect(rows.filter((r) => r.endsWith('задача не создана'))).toHaveLength(17);
    expect(rows.findIndex((r) => r.includes('Project Manager'))).toBeGreaterThan(rows.findIndex((r) => r.includes('Lead Handler')));
    // a full drill: still 19
    await w.director.onCommand('drill', 'clear');
    await w.director.onCommand('drill');
    await w.beat();
    await w.director.onCommand('drill', 'report');
    expect(rowLines(w.messenger.last()!.text)).toHaveLength(19);
  });

  it('a failing head shows ❌ with the block reason', async () => {
    const w = drillWorld();
    await w.director.onCommand('drill', 'marketing');
    const seo = w.hq.tasks({ tag: 'drill' }).find((t) => t.meta.action === 'seo')!;
    w.hq.claim(seo.id, 'marketing-head');
    w.hq.block(seo.id, 'marketing-head', 'сайт не отвечает');
    await w.director.onCommand('drill', 'report');
    expect(w.messenger.last()!.text).toContain('❌ SEO');
    expect(w.messenger.last()!.text).toContain('сайт не отвечает');
  });

  it('/drill clear removes drill tasks and test data and leaves other tasks alone', async () => {
    const w = drillWorld();
    const real = w.hq.createTask({ title: 'Настоящая задача', dept: 'hq', creator: 'owner', tags: ['keep'] });
    const prospects = prospectStoreFor({ db: w.db, now: w.hq.now });
    const before = prospects.get(1)!.status;
    await w.director.onCommand('drill', 'sales');
    await w.director.onCommand('drill', 'support');
    await w.director.onCommand('drill', 'production');
    await w.director.onCommand('drill', 'backoffice');
    await w.beat();
    await w.director.onCommand('approve');
    expect(w.db.prepare('SELECT COUNT(*) c FROM bl_invoices').get()).toEqual({ c: 1 });
    await w.director.onCommand('drill', 'clear');
    expect(w.messenger.last()!.text).toContain('Учения очищены');
    expect(w.hq.tasks({ tag: 'drill' })).toHaveLength(0);
    for (const table of ['bl_invoices', 'cs_tickets', 'li_leads', 'pm_projects', 'bo_documents', 'task_approvals', 'ob_onboardings']) {
      expect(w.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get(), table).toEqual({ c: 0 });
    }
    expect(prospects.get(1)!.status).toBe(before);
    expect(w.queue.pending()).toHaveLength(0);
    expect(w.hq.tasks().filter((t) => t.id !== real.id)).toHaveLength(0);
    expect(w.hq.task(real.id)).toMatchObject({ title: 'Настоящая задача', status: 'inbox', tags: ['keep'] });
    await w.director.onCommand('drill', 'report');
    expect(w.messenger.last()!.text).toContain('Учений ещё не было');
  });

  it('drill tasks stay out of the morning summary', async () => {
    const w = drillWorld();
    await w.director.onCommand('drill');
    await w.beat();
    const text = w.director.morningSummary();
    expect(text).not.toContain('Учения:');
    expect(text).toContain('Отчётов отделов за сутки нет.');
  });
});

describe('/drill automatic report', () => {
  it('goes once to the owner and the group topic after 10 minutes, not before', async () => {
    const w = drillWorld();
    await w.director.onCommand('drill');
    expect(await w.drill.tick()).toBe(false); // heads have not worked yet
    w.clock.t += 9 * MIN;
    expect(await w.drill.tick()).toBe(false);
    w.clock.t += 2 * MIN;
    expect(await w.drill.tick()).toBe(true);
    expect(await w.drill.tick()).toBe(false);
    expect(w.messenger.sent.filter((m) => m.text.startsWith('Учения, идут'))).toHaveLength(1);
    expect(w.posted.filter((p) => p.threadId === 2 && p.text.startsWith('Учения'))).toHaveLength(1);
  });

  it('goes early when every task left the work stages, and re-arms on a new drill', async () => {
    const w = drillWorld();
    await w.director.onCommand('drill');
    await w.beat();
    w.clock.t += 30_000;
    expect(await w.drill.tick()).toBe(true);
    expect(await w.drill.tick()).toBe(false);
    await w.director.onCommand('drill', 'clear');
    await w.director.onCommand('drill', 'backoffice');
    expect(w.hq.setting('drill_reported')).toBe('');
  });
});

void DRILL_CLIENT;
