import { ProspectStore } from '@fir/worker-prospector';
import { CSV } from '../sales-helpers.js';
import { TOKENS, type DrillWorld } from './world.js';

export const LEAD = { name: 'Dilnoza Karimova', contact: '@dilnoza_k', service: 'bots', budget: '$300-500', message: 'Нужен бот для записи в салон красоты', locale: 'ru' };
export const CABINET_LEAD = { ...LEAD, name: 'Anvar', contact: 'anvar.k@example.com', clientEmail: 'anvar.k@example.com', cabinetId: 'sb-1', clientName: 'Anvar K' };

/** Runs every real flow that ends in an approval card and returns the kinds that are now waiting (queued or pending). */
export async function seedEverything(w: DrillWorld): Promise<void> {
  new ProspectStore(w.db, w.hq.now).importCsv(CSV);
  // marketing: week pack, article, SEO, free audit
  for (const r of ['marketing-weekly-pack', 'marketing-article-daily', 'marketing-seo-weekly']) w.hq.runRoutine(r);
  await w.http('POST', '/audit', { url: 'https://salon-roza.example.com', contact: '@roza_salon', locale: 'ru' }, { 'x-lead-token': TOKENS.lead });
  // sales: a qualified lead (reply + КП chain), a price question, prospects cards, a referral
  await w.http('POST', '/lead', LEAD, { 'x-lead-token': TOKENS.lead });
  await w.http('POST', '/lead', { name: 'Zarina', contact: '@zarina', service: 'website', budget: '', message: 'Сколько стоит сайт и за какой срок?', locale: 'ru' }, { 'x-lead-token': TOKENS.lead });
  w.hq.runRoutine('sales-daily-cards');
  await w.cmd('referral', 'Cambridge -> Blanche');
  // support: a ticket, a money ticket, a manual invoice, onboarding, billing routine
  await w.cmd('client', 'Dilnoza | @dilnoza_k | bot | basic | 2026-11-01');
  await w.cmd('ticket', 'Dilnoza: бот не отвечает с утра');
  await w.cmd('ticket', 'Dilnoza: верните деньги, я недоволен');
  await w.cmd('invoice', 'Dilnoza 120 поддержка бота');
  await w.cmd('onboard', 'Dilnoza: бот записи');
  w.hq.runRoutine('support-billing');
  // production and back office
  await w.cmd('project', 'Dilnoza: бот записи в салон');
  await w.cmd('doc', 'договор Dilnoza');
  for (let i = 0; i < 4; i++) await w.beat();
  await w.cmd('pstatus', '1');
  for (let i = 0; i < 2; i++) await w.beat();
  await w.director.sendApprovalBatch(true);
  await w.hq.releaseApprovals();
}

export const waitingKinds = (w: DrillWorld): string[] => [...new Set([...w.queue.pending().map((p) => p.kind), ...w.hq.queuedApprovals().map((a) => a.kind), ...w.hq.heldApprovals().map((a) => a.kind)])].sort();
