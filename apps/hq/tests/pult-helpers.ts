/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { MockLlm } from '@fir/core';
import { BillingWorker } from '@fir/worker-billing';
import { FinanceWorker } from '@fir/worker-finance';
import { LeadStore } from '@fir/worker-lead-intake';
import { DAY_MS, MonitoringWorker, type CheckDeps, type MonitorConfig } from '@fir/worker-monitoring';
import { CsStore } from '@fir/worker-customer-support';
import { createAdmin, type AdminDeps } from '../src/admin.js';
import { PRODUCTION_HEAD_ID, ProductionHead, seedProduction } from '../src/heads/production.js';
import { SupportHead, seedSupport } from '../src/heads/support.js';
import { createWebhook } from '../src/webhook.js';
import { OWNER, world } from './helpers.js';

export const TOKEN = 'admin-secret';
const mcfg: MonitorConfig = {
  urls: [], omnirouteUrl: 'http://omniroute:20128/health', dataDir: '/d', docker: false, dockerSocket: '/s', diskMaxPct: 85, certMinDays: 14, timeoutMs: 1000,
};
const mdeps = (t: () => number): CheckDeps => ({
  now: t, fetch: (() => Promise.resolve(new Response('{"ok":true}', { status: 200 }))) as unknown as typeof fetch,
  certValidTo: () => Promise.resolve(new Date(t() + 60 * DAY_MS).toUTCString()), statfs: () => Promise.resolve({ blocks: 100, bavail: 60 }), listContainers: () => Promise.resolve([]),
});

/** The company world of the marketing tests plus Support (for `/paid`), Production (for `/mdone`), a client-bot spy and the admin API. */
export function pultWorld(opts: Partial<Parameters<typeof world>[0]> & { admin?: Partial<AdminDeps> } = {}) {
  const w = world({ presence: true, ...opts });
  const t = () => w.clock.t;
  seedSupport(w.hq, { supportBudgetUsd: 0 }, () => 'Инструкция');
  seedProduction(w.hq, { productionBudgetUsd: 0 }, () => 'Инструкция');
  const llm = new MockLlm(() => '');
  const billing = new BillingWorker({ paymentDetails: { usdt_trc20: 'TXyz00' }, siteUrl: 'https://firtech.pro' });
  const support = new SupportHead({
    hq: w.hq, llm, reporter: w.reporter, monitor: new MonitoringWorker(mcfg, mdeps(t)), finance: new FinanceWorker({ fixedCosts: { droplet: 30 } }),
    billing, messenger: w.channel!, ownerId: OWNER,
  });
  w.director.onSupportCommand = (name, args) => support.onCommand(name, args);
  const production = new ProductionHead({ hq: w.hq, llm, queue: w.queue, messenger: w.channel!, ownerId: OWNER, reporter: w.reporter });
  w.director.commands.set('mdone', { dept: 'production', run: (a) => production.command('mdone', a) });
  const toClient: { chatId: number; text: string }[] = [];
  const client = { send: (chatId: number, text: string) => { toClient.push({ chatId, text }); return Promise.resolve(); } };
  const toWeb: { sessionId: string; text: string }[] = [];
  const webReply = (sessionId: string, text: string) => { if (sessionId === 'gone') return false; toWeb.push({ sessionId, text }); return true; };
  const admin = createAdmin({
    hq: w.hq, queue: w.queue, director: w.director, channel: w.channel!, ownerId: OWNER, now: t, commandNames: ['paid', 'mdone'],
    billing, client, webReply, marketing: w.marketing, ...(opts.rendersDir ? { rendersDir: opts.rendersDir } : {}), ...opts.admin,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const [p, qs] = path.split('?');
    const r = await admin.handle({ method, path: p!, query: new URLSearchParams(qs ?? ''), body });
    return { status: r.status, json: r.body as Record<string, any> };
  };
  const leads = new LeadStore(w.hq.db, t);
  /** A lead with its Sales task (`meta.lead` carries what the site/bot gave: chat id, session id, estimate). */
  const lead = (name: string, over: { contact?: string; service?: string; budget?: string; meta?: Record<string, unknown>; at?: number } = {}) => {
    const task = w.hq.createTask({ title: `Лид ${name}`, dept: 'sales', creator: 'routine', meta: { action: 'lead', lead: { name, ...over.meta } } });
    w.hq.db.prepare('INSERT INTO li_leads (task_id, name, contact, service, budget, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(task.id, name, over.contact ?? '', over.service ?? '', over.budget ?? '', 'site', over.at ?? t());
    return { id: (w.hq.db.prepare('SELECT MAX(id) m FROM li_leads').get() as { m: number }).m, taskId: task.id };
  };
  const cs = new CsStore(w.hq.db, t);
  return { w, call, admin, lead, leads, cs, toClient, toWeb, billing, support, production, PRODUCTION_HEAD_ID, t };
}
export type PultWorld = ReturnType<typeof pultWorld>;

/** The admin API behind the real webhook server (token, 401, rate-limit behaviour). */
export async function serve(p: PultWorld, extra: Parameters<typeof createWebhook>[6] = {}) {
  const server = createWebhook(() => Promise.resolve(0), undefined, Date.now, undefined, undefined, { token: TOKEN, handle: (r) => p.admin.handle(r) }, extra);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const http = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-admin-token': TOKEN }) => {
    const r = await fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return r;
  };
  return { server, url, http, close: () => new Promise<void>((res) => server.close(() => res())) };
}
