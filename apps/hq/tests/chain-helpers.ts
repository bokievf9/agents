import { ApprovalQueue, MemoryMessenger, MockLlm, openDb, type LlmRequest } from '@fir/core';
import { Hq } from '@fir/hq';
import { BillingWorker } from '@fir/worker-billing';
import { FinanceWorker } from '@fir/worker-finance';
import { MonitoringWorker } from '@fir/worker-monitoring';
import { Director } from '../src/director.js';
import { BackofficeHead, seedBackoffice } from '../src/heads/backoffice.js';
import { ProductionHead, seedProduction } from '../src/heads/production.js';
import { SalesHead, seedSales } from '../src/heads/sales.js';
import { SupportHead, seedSupport } from '../src/heads/support.js';
import { seedOrg } from '../src/org.js';
import { Reporter } from '../src/reporter.js';
import { NOW, OWNER, instructionsDir } from './helpers.js';

/** The chain of the sales tests: a world with every head wired like `index.ts`, and the lead that gets an approved КП. */
export const DAY = 86_400_000;
export const WORDING = {
  context: 'Dilnoza: салон красоты в Алматы.', problem: 'Заявки теряются вечером.', solution: 'Бот принимает запись круглосуточно. Стоимость: [цена].',
  scope: ['Диалоги', 'Запись', 'Напоминания', 'Уведомления', 'Админ-панель', 'Запуск'],
};

export function chainWorld() {
  const clock = { t: NOW };
  const db = openDb(':memory:');
  const messenger = new MemoryMessenger();
  const hq = new Hq(db, { now: () => clock.t });
  const queue = new ApprovalQueue(db, messenger, OWNER, 20, () => clock.t);
  hq.attachQueue(queue);
  seedOrg(hq, { instructionsDir, marketingBudgetUsd: 0 });
  const read = (file: string) => `Инструкция ${file}`;
  seedSupport(hq, { supportBudgetUsd: 0 }, read);
  seedSales(hq, { instructionsDir, salesBudgetUsd: 0 });
  seedProduction(hq, { productionBudgetUsd: 0 }, read);
  seedBackoffice(hq, { backofficeBudgetUsd: 0 }, read);
  const llm = new MockLlm((req: LlmRequest) => {
    if (req.system.includes('Проверь')) return '{"ok":true,"issues":[]}';
    if (req.system.includes('Ты пресейл')) return JSON.stringify(WORDING);
    if (req.system.includes('Разбери сообщение владельца')) return '{"type":"unknown"}';
    return 'not json';
  });
  const reporter = new Reporter(undefined, {}, new Map());
  const support = new SupportHead({
    hq, llm, reporter, messenger, ownerId: OWNER, finance: new FinanceWorker({ fixedCosts: {} }), billing: new BillingWorker({ paymentDetails: { usdt_trc20: 'TXyz00' } }),
    monitor: new MonitoringWorker({ urls: [], omnirouteUrl: 'http://omniroute:20128/health', dataDir: '/d', docker: false, dockerSocket: '/s', diskMaxPct: 85, certMinDays: 14, timeoutMs: 1000 }),
  });
  const sales = new SalesHead({ hq, llm, queue, messenger, ownerId: OWNER, reporter });
  const production = new ProductionHead({ hq, llm, queue, messenger, ownerId: OWNER, reporter });
  const backoffice = new BackofficeHead({ hq, llm, queue, messenger, ownerId: OWNER, reporter });
  support.onPaid = async (inv) => [...production.onInvoicePaid(inv), ...(await sales.onInvoicePaid(inv))];
  const director = new Director({ hq, llm, messenger, queue, ownerId: OWNER, reporter });
  director.onSalesCommand = (name, arg) => sales.salesCommand(name, arg);
  director.onSupportCommand = (name, args) => support.onCommand(name, args);
  for (const name of ['project', 'pstatus', 'target', 'mready', 'mdone']) director.commands.set(name, { dept: 'production', run: (arg) => production.command(name, arg) });
  for (const name of ['doc', 'lesson', 'kb']) director.commands.set(name, { dept: 'backoffice', run: (arg) => backoffice.command(name, arg) });
  const alerts: string[] = [];
  hq.onAlert((t) => void alerts.push(t));
  const beat = async () => {
    await sales.onHeartbeat();
    await support.onHeartbeat();
    await backoffice.onHeartbeat();
    await production.onHeartbeat();
  };
  const decide = async (action: 'approve' | 'reject', id: number) => {
    await queue.handle(action, id, OWNER);
    director.afterDecision();
  };
  const cmd = (name: string, arg = '') => director.onCommand(name, arg);
  const lastToOwner = () => messenger.to(OWNER).at(-1)!;
  const toOwner = () => messenger.to(OWNER);
  return { clock, db, hq, queue, messenger, director, sales, support, production, backoffice, alerts, beat, decide, cmd, lastToOwner, toOwner };
}
export type W = ReturnType<typeof chainWorld>;

export const QUALIFIED = { name: 'Dilnoza', contact: '@dilnoza', service: 'bots', budget: '$300-500', message: 'Нужен бот для записи в салон', locale: 'ru', source: '' };

/** A qualified lead goes to Sales and the chain up to the approved КП. Returns the КП approval id. */
export async function approvedKp(w: W, lead: Record<string, unknown> = QUALIFIED): Promise<number> {
  w.sales.createLeadTask(lead, String(lead.service));
  await w.beat(); // the lead: reply, review, afterLead starts the КП
  await w.beat(); // the КП task
  await w.director.sendApprovalBatch(false);
  const pack = w.queue.pending().find((p) => p.kind === 'presales_pack')!;
  await w.decide('approve', pack.id);
  return pack.id;
}

