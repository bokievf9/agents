/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { once } from 'node:events';
import { Bot } from 'grammy';
import { installOwnerGlue } from '../../src/glue.js';
import { TopicManager } from '../../src/topics.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ApprovalQueue, MemoryMessenger, MockLlm, OutboxMessenger, openDb, type LlmRequest } from '@fir/core';
import { HeartbeatWorker, Hq, startRoutines } from '@fir/hq';
import { BillingWorker, PaymentWatcher } from '@fir/worker-billing';
import { CustomerSupportWorker } from '@fir/worker-customer-support';
import { FinanceWorker } from '@fir/worker-finance';
import { MonitoringWorker } from '@fir/worker-monitoring';
import { OnboardingWorker } from '@fir/worker-onboarding';
import { createAdmin } from '../../src/admin.js';
import { AuditGate, AuditStore, submitAudit } from '../../src/audit-shared.js';
import { blogApi } from '../../src/blog.js';
import { registerCabinetLead } from '../../src/cabinet.js';
import { WebChatEngine } from '../../src/client/web.js';
import { clientSinks } from '../../src/client/sinks.js';
import { gatewayGate } from '../../src/client/shared.js';
import { FALLBACK_INSTRUCTIONS } from '../../src/client/prompt.js';
import { Director } from '../../src/director.js';
import { Drill } from '../../src/drill.js';
import { BackofficeHead, seedBackoffice } from '../../src/heads/backoffice.js';
import { MarketingHead } from '../../src/heads/marketing.js';
import { ProductionHead, seedProduction } from '../../src/heads/production.js';
import { SalesHead, seedSales } from '../../src/heads/sales.js';
import { SupportHead, seedSupport } from '../../src/heads/support.js';
import { guardedLead, LostLeads } from '../../src/lost-leads.js';
import { cachedOffice } from '../../src/office.js';
import { seedOrg } from '../../src/org.js';
import { OwnerChannel } from '../../src/presence.js';
import { payApi } from '../../src/pay.js';
import { eventsApi } from '../../src/pult-events.js';
import { serveFile } from '../../src/pult-files.js';
import { Reporter, type TopicSender } from '../../src/reporter.js';
import { cachedStatus } from '../../src/status.js';
import { seedTiming } from '../../src/timing.js';
import { COMMAND_NAMES, routedTo } from '../../src/commands.js';
import { createWebhook } from '../../src/webhook.js';
import { resolveMedia } from '@fir/worker-publisher';
import { UPLOAD_TYPES } from '@fir/core';
import { buildCabinet } from '../../src/cabinet-api.js';
import { Calls } from '../../src/calls.js';
import type { SiteBooking, SiteBookingRequest } from '../../src/client/site-slots.js';
import { toolsFor, type AppTools } from '../../src/tools.js';
import { RateLimiter } from '../../src/client/sanitize.js';
import { instructionsDir, NOW, OWNER, routedLlm } from '../helpers.js';
import { WORDING } from '../chain-helpers.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

export { OWNER, NOW };
export const MEDIA_SECRET = 'media-secret-0123456789';
export const TOKENS = { admin: 'adm-tok', lead: 'lead-tok', chat: 'chat-tok', events: 'ev-tok', office: 'off-tok' };
export const SECRET_CLIENT = { name: 'Dilnoza Karimova', email: 'dilnoza.k@example.com', phone: '+992 90 123 45 67' };

/** The whole company as `index.ts` wires it, minus the Telegram network: every head, the Director, the Drill, the admin API and the real webhook server. */
export const MEDIA_BASE = 'https://hq.test/media';

/**
 * `flow: true` wires Cabinet v3 like `index.ts` does (documents to the client's cabinet, accept and sign, threads, uploads, the playground, the public agent route);
 * without it the world is the older one (a cabinet lead's КП makes the contract and the invoice at once), which the older drill tests still describe.
 */
export async function drillWorld(o: { gatewayDown?: boolean; withServer?: boolean; flow?: boolean } = {}) {
  const clock = { t: NOW };
  const t = () => clock.t;
  const db = openDb(':memory:');
  const tg = new MemoryMessenger();
  const sleeps: number[] = [];
  const outbox = new OutboxMessenger(tg, { minGapMs: 0, backoffMs: 1, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, now: t });
  const hq = new Hq(db, { now: t });
  const lost = new LostLeads(hq);
  const channel: OwnerChannel = new OwnerChannel({ hq, inner: outbox, ownerId: OWNER, approvalPending: (id) => queue.get(id)?.status === 'pending', onCardSent: (id, m) => queue.noteCard(id, OWNER, m) });
  const queue: ApprovalQueue = new ApprovalQueue(db, channel, OWNER, 20, t);
  hq.attachQueue(queue);
  const cfg = { instructionsDir, marketingBudgetUsd: 0, salesBudgetUsd: 0, supportBudgetUsd: 0, productionBudgetUsd: 0, backofficeBudgetUsd: 0 };
  const read = (f: string) => `Инструкция ${f}`;
  seedTiming(hq, { tz: 'Asia/Dushanbe', ownerTz: 'Asia/Kuala_Lumpur' } as any);
  seedOrg(hq, cfg);
  seedSupport(hq, cfg, read);
  seedSales(hq, cfg);
  seedProduction(hq, cfg, read);
  seedBackoffice(hq, cfg, read);

  const calls: LlmRequest[] = [];
  const heads = routedLlm();
  const state: { down: boolean; garbage: boolean; delayMs: number; intent: ((text: string) => string) | null } = { down: o.gatewayDown ?? false, garbage: false, delayMs: 0, intent: null };
  const llm = new MockLlm(async (req: LlmRequest) => {
    calls.push(req);
    if (state.delayMs) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * state.delayMs)));
    if (state.down) throw new Error('gateway down 502');
    if (state.garbage) return 'not json at all';
    if (state.intent && req.system.includes('Разбери сообщение владельца')) return state.intent(req.messages[0]!.content);
    if (req.system.includes('Ты пресейл')) return JSON.stringify(WORDING);
    if (req.system.includes('Проверь')) return '{"ok":true,"issues":[]}';
    if (req.system.includes('Разбери сообщение владельца') || req.system.includes('Определи, что нужно сделать') || req.system.includes('Определи, какому исполнителю')) return heads.complete(req) as unknown as string;
    const base = JSON.parse(String(await heads.complete(req))) as Record<string, unknown>;
    // one answer that satisfies the strict schemas of the scout drafts, support answers and the free audit
    return JSON.stringify({ message: 'Здравствуйте! Это Fir Tech. Уточните, пожалуйста, детали, подготовим решение для вашего салона.', answer: 'Здравствуйте! Проверим и вернёмся с ответом сегодня.', reply: 'Здравствуйте! Проверим и вернёмся с ответом сегодня.', ...base });
  });
  const alerts: string[] = [];
  hq.onAlert((x) => void alerts.push(x));
  const posted: { dept: string; text: string }[] = [];
  const mk = (dept: string): TopicSender => (_c, _th, text) => Promise.resolve(void posted.push({ dept, text }));
  const reporter = new Reporter(-1001, { marketing: 1, sales: 2, support: 3, production: 4, backoffice: 5, general: 6 }, new Map(['marketing', 'sales', 'support', 'production', 'backoffice', 'general'].map((d) => [d, mk(d)])));
  const director = new Director({ hq, llm: llm as any, messenger: channel, queue, ownerId: OWNER, reporter });
  const fetched: string[] = [];
  // Resend, as the heads see it: every email goes into `emails` (the cabinet documents and the clarifying questions of the Sales head)
  const emails: { to: string; subject: string; text: string }[] = [];
  const emailFail = { on: false };
  const resend = (init: RequestInit): Promise<Response> => {
    if (emailFail.on) return Promise.resolve(new Response('boom', { status: 500 }));
    const b = JSON.parse(String(init.body)) as { to: string[]; subject: string; text: string };
    emails.push({ to: b.to[0]!, subject: b.subject, text: b.text });
    return Promise.resolve(Response.json({ id: `em_${emails.length}` }));
  };
  const tools = {
    config: { resendApiKey: 'RSKEY', emailFrom: 'Fir Tech <hello@firtech.pro>' },
    fetch: ((url: string, init: RequestInit) => {
      if (url.startsWith('https://api.resend.com/emails')) return resend(init);
      fetched.push(url);
      return Promise.resolve(new Response('<html><head><title>t</title></head><body>ok</body></html>', { headers: { 'content-type': 'text/html' } }));
    }) as any,
    lookup: () => Promise.resolve(['93.184.216.34']), sleep: () => Promise.resolve(),
  };
  const rendersDir = mkdtempSync(join(tmpdir(), 'drill-renders-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'drill-data-'));
  const marketing = new MarketingHead({
    hq, tools, llm: llm as any, queue, messenger: channel, ownerId: OWNER, reporter, rng: () => 0.1, postsPerWeek: 3, storiesPerWeek: 5, carouselsPerWeek: 2, rendersDir, lost,
    integrations: { fetch: tools.fetch } as any,
  } as any);
  director.editors.set('content_item', marketing);
  director.editors.set('article', marketing);
  director.onPackButton = (op, id, at) => marketing.onPackButton(op, id, at);
  for (const name of routedTo('marketing')) director.commands.set(name, { dept: 'marketing', run: (arg) => marketing.command(name, arg) });
  const monitor = new MonitoringWorker({ urls: [], omnirouteUrl: 'http://omniroute:20128/health', dataDir: '/d', docker: false, dockerSocket: '/s', diskMaxPct: 85, certMinDays: 14, timeoutMs: 1000 }, {
    now: t, fetch: (() => Promise.resolve(new Response('{"ok":true}'))) as any, certValidTo: () => Promise.resolve(new Date(t() + 60 * 86_400_000).toUTCString()), statfs: () => Promise.resolve({ blocks: 100, bavail: 60 }), listContainers: () => Promise.resolve([]),
  } as any);
  const billing = new BillingWorker({ prefix: 'FT', paymentDetails: { usdt_trc20: 'TXyz00' }, siteUrl: 'https://firtech.pro' });
  const chainGets: string[] = [];
  const chain = { fail: false };
  const payWatch = new PaymentWatcher({ addresses: billing.chainAddresses(), get: (url: string) => { chainGets.push(url); return chain.fail ? Promise.reject(new Error('indexer 503')) : Promise.resolve({ data: [] }); }, keys: {}, tolerancePct: 1 } as any);
  const support = new SupportHead({ hq, tools, llm: llm as any, reporter, monitor, finance: new FinanceWorker({ fixedCosts: { droplet: 30 } }), cs: new CustomerSupportWorker({ slaHours: 4 }), billing, payWatch, onboarding: new OnboardingWorker(), messenger: channel, ownerId: OWNER } as any);
  director.onSupportCommand = (name, args) => support.onCommand(name, args);
  // the site's call windows (`GET /api/slots`) and its booking route (`POST /api/slots`) as HQ sees them: tests put free windows (UTC ms) and the answer here
  const site = { slots: [] as number[], bookings: [] as SiteBookingRequest[], answer: 'booked' as SiteBooking };
  const callsRef: { current: Calls | null } = { current: null };
  const freeSlots = () => Promise.resolve((callsRef.current ? callsRef.current.freeOf(site.slots) : site.slots).filter((x) => x > t()));
  const sales = new SalesHead({ hq, tools, llm: llm as any, queue, messenger: channel, ownerId: OWNER, reporter, batchSize: 3, slotHours: ['10:00', '14:00'], replyLevel: 1, referralReward: '10%', kpValidDays: 14, lost, freeSlots } as any);
  const auditGate = new AuditGate(t);
  director.onSalesReply = (id, text) => sales.startReply(id, text);
  director.onSalesCommand = (name, arg) => sales.salesCommand(name, arg);
  director.editors.set('sales:reply', sales);
  const production = new ProductionHead({ hq, tools, llm: llm as any, queue, messenger: channel, ownerId: OWNER, reporter } as any);
  support.onPaid = async (inv) => [...production.onInvoicePaid(inv), ...(await sales.onInvoicePaid(inv))];
  const backoffice = new BackofficeHead({ hq, tools, llm: llm as any, queue, messenger: channel, ownerId: OWNER, reporter, knowledgeDir: join(process.cwd(), '..', '..', 'knowledge'), ops: { dataDir, rendersDir, ageRecipient: undefined } } as any);
  // Cabinet v3 (opt-in): the same wiring as index.ts
  const cabTools: AppTools = {
    config: { dataDir, rendersDir, mediaSecret: MEDIA_SECRET, mediaBase: MEDIA_BASE, resendApiKey: 'RSKEY', emailFrom: 'Fir Tech <hello@firtech.pro>' },
    fetch: ((url: string, init: RequestInit) => (url.startsWith('https://api.resend.com/emails') ? resend(init) : Promise.resolve(new Response('nf', { status: 404 })))) as any,
    sleep: () => Promise.resolve(),
  };
  const cabinet = o.flow
    ? buildCabinet({
        hq, llm: llm as any, billing, siteUrl: 'https://firtech.pro', dataDir, mediaSecret: MEDIA_SECRET, mediaBase: MEDIA_BASE, secret: 'pg-test-secret',
        tools: () => toolsFor(hq, cabTools, { agentId: 'documents', dept: 'backoffice', messenger: channel, ownerId: OWNER }),
      })
    : undefined;
  const callBook = new Calls({
    hq, mail: cabinet?.mail, notifyOwner: (text) => void channel.notify('message', text),
    siteBook: (b) => { site.bookings.push(b); return Promise.resolve(site.answer); },
  });
  callsRef.current = callBook;
  sales.calls = callBook;
  if (cabinet) {
    sales.cabinet = cabinet.docs;
    backoffice.cabinet = cabinet.docs;
    support.cabinet = cabinet.docs;
    production.cabinet = cabinet.docs;
    support.onPaid = async (inv) => {
      cabinet.docs.onPaid(inv);
      return [...production.onInvoicePaid(inv), ...(await sales.onInvoicePaid(inv))];
    };
  }
  for (const name of routedTo('production')) director.commands.set(name, { dept: 'production', run: (arg) => production.command(name, arg) });
  for (const name of routedTo('backoffice')) director.commands.set(name, { dept: 'backoffice', run: (arg) => backoffice.command(name, arg) });
  const drill = new Drill({
    hq, queue, messenger: channel, ownerId: OWNER, reporter,
    monitor: async () => { const e = await support.monitorTick(); return e.length ? `событий: ${e.length}` : 'всё в норме'; },
    kb: (q) => backoffice.command('kb', q),
  });
  director.onDrillCommand = (arg) => drill.command(arg);
  director.onTopicsCommand = () => Promise.resolve('Группа HQ не подключена.');
  director.summaryLines.push(() => production.overdueLine(), () => backoffice.pendingLine(), () => lost.summaryLine());

  // The real glue of the owner's bot on a grammy Bot whose network is a recorder: updates go in through `handleUpdate`.
  const api: { method: string; payload: any }[] = [];
  const bot = new Bot('123456:TEST', { botInfo: { id: 123456, is_bot: true, first_name: 'hq', username: 'hq_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false } as any });
  bot.api.config.use((_prev, method, payload) => { api.push({ method, payload }); return Promise.resolve({ ok: true, result: true } as any); });
  const topicManager = new TopicManager(hq, undefined, {}, bot.api);
  installOwnerGlue(bot, { ownerId: OWNER, channel, queue, director, marketing, sales, topicManager });
  let upd = 1;
  const user = (id: number) => ({ id, is_bot: false, first_name: 'u' });
  const msgOf = (from: number, chat: number, type: 'private' | 'supergroup') => ({ message_id: ++upd, date: 0, chat: { id: chat, type, first_name: 'u' }, from: user(from) });
  /** The owner (or someone else) presses an inline button of the message `messageId`. */
  const press = async (data: string, o: { from?: number; messageId?: number; noMessage?: boolean } = {}) => {
    const n = api.length;
    await bot.handleUpdate({ update_id: ++upd, callback_query: { id: String(upd), from: user(o.from ?? OWNER), chat_instance: 'x', data, ...(o.noMessage ? {} : { message: msgOf(100, o.from ?? OWNER, 'private') }) } } as any);
    if (o.messageId !== undefined) void o.messageId;
    return api.slice(n);
  };
  /** The owner (or someone else) writes a text; commands are `/name args`. Background work is awaited by the caller (`settle`). */
  const say = async (text: string, o: { from?: number; chat?: number; type?: 'private' | 'supergroup' } = {}) => {
    const n = api.length;
    const entities = text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0]!.length }] : undefined;
    await bot.handleUpdate({ update_id: ++upd, message: { ...msgOf(o.from ?? OWNER, o.chat ?? o.from ?? OWNER, o.type ?? 'private'), text, ...(entities ? { entities } : {}) } } as any);
    return api.slice(n);
  };
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

  const counter = { get: (k: string) => hq.setting(k) || undefined, set: (k: string, v: string) => hq.setSetting(k, v) };
  const gatewayDown = gatewayGate(() => state.down, t);
  const chatGate = new RateLimiter(1, 300, t, () => hq.tz, counter);
  const webChat = new WebChatEngine({
    db, now: t, tz: () => hq.tz, llm: llm as any, instructions: FALLBACK_INSTRUCTIONS, quietHours: '22:00-08:00', gate: chatGate,
    onLost: (s: any, r: any, i: any) => lost.record(s, r, i), gatewayDown, slots: freeSlots,
  } as any);
  webChat.connect(clientSinks({ hq, sales, support, invoicePrefix: 'FT', calls: callBook }));
  callBook.webReply = (sessionId: string, text: string) => webChat.store.queueOwnerReply(sessionId, text);
  const reloads = { n: 0, fail: false };
  const toWeb: { sessionId: string; text: string }[] = [];
  const toClient: { chatId: number; text: string }[] = [];
  callBook.client = { send: (chatId: number, text: string) => { toClient.push({ chatId, text }); return Promise.resolve(); } };
  const commandNames = COMMAND_NAMES;
  const admin = createAdmin({
    hq, queue, director, channel, ownerId: OWNER, now: t, commandNames, drill: (a) => drill.command(a),
    cabinetTicket: (x: any) => support.cabinetTicket(x.id, x.name, x.text, x.telegram, x.leadId),
    reloadPrices: () => { reloads.n++; return reloads.fail ? Promise.reject(new Error('site down')) : Promise.resolve({ source: 'fetched' as const, updatedAt: '2026-11-21' }); },
    acceptStage: (pid, no) => Promise.resolve(production.acceptStage(pid, no, 'client')),
    billing, marketing, tools: tools as any, rendersDir, onRoutinesChange: () => undefined, ...(cabinet ? { cabinet } : {}),
    client: { send: (chatId: number, text: string) => { toClient.push({ chatId, text }); return Promise.resolve(); } } as any,
    webReply: (sessionId: string, text: string) => { toWeb.push({ sessionId, text }); return webChat.store.queueOwnerReply(sessionId, text); },
  });
  const cfgLead = guardedLead(lost, (l: any) => {
    const id = sales.createLeadTask({ ...l, ...(l.telegramSent ? { telegramSent: true } : {}) }, l.service);
    if (!l.clientEmail) return id;
    try {
      const r = registerCabinetLead(db, t, id, { ...l, source: l.source });
      return { id, leadId: r.leadId };
    } catch {
      return id;
    }
  });
  const webhook = createWebhook(
    cfgLead as any, TOKENS.lead, t, { token: TOKENS.office, get: cachedOffice(hq) },
    { token: TOKENS.chat, handle: (r, ip) => webChat.handle(r, ip) },
    { token: TOKENS.admin, handle: (r) => admin.handle(r), file: (p, range) => serveFile(rendersDir, p, range) },
    {
      audit: { token: TOKENS.lead, handle: (a) => Promise.resolve(submitAudit({ store: new AuditStore(db, t), gate: auditGate, create: (x: any) => marketing.requestAudit(x) } as any, a)) },
      status: { get: cachedStatus(db) },
      blog: blogApi(db, t, () => hq.tz),
      pay: payApi(db, billing, t, () => hq.tz),
      events: { token: TOKENS.events, handle: eventsApi(db, t, () => hq.tz).handle },
      media: {
        resolve: (sig: string, rel: string, exp?: number | null) => rel.startsWith('uploads/')
          ? resolveMedia(dataDir, MEDIA_SECRET, sig, rel, { exp: exp ?? null, now: t(), types: UPLOAD_TYPES })
          : resolveMedia(rendersDir, MEDIA_SECRET, sig, rel, { exp: exp ?? null, now: t() }),
      },
      ...(cabinet ? { agent: { handle: (id: string, r: any) => cabinet.playground.handlePublic(id, r) } } : {}),
    },
  );
  // P-29: the test client (undici) keeps idle sockets about 4 s against the server's 5 s; under the load of the whole suite a request could go out on a
  // socket the server was closing (ECONNRESET, «fetch failed»). A long server keep-alive takes the race away; `close()` still ends idle sockets.
  webhook.keepAliveTimeout = 60_000;
  let url = '';
  if (o.withServer !== false) {
    webhook.listen(0, '127.0.0.1');
    await once(webhook, 'listening');
    url = `http://127.0.0.1:${(webhook.address() as AddressInfo).port}`;
  }
  const http = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
  const adm = async (method: string, path: string, body?: unknown) => {
    const r = await http(method, path, body, { 'x-admin-token': TOKENS.admin });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json: json as Record<string, any>, text };
  };
  /** The index.ts heartbeat handler: each head runs its queue when woken. */
  const heartbeat = new HeartbeatWorker(hq, async (agent) => {
    if (agent.id === 'marketing-head') await marketing.onHeartbeat();
    if (agent.id === 'support-head') await support.onHeartbeat();
    if (agent.id === 'sales-head') await sales.onHeartbeat();
    if (agent.id === 'production-head') await production.onHeartbeat();
    if (agent.id === 'backoffice-head') await backoffice.onHeartbeat();
  }, 5);
  const beat = async () => {
    await sales.onHeartbeat();
    await support.onHeartbeat();
    await backoffice.onHeartbeat();
    await production.onHeartbeat();
    await marketing.onHeartbeat();
  };
  const decide = async (action: 'approve' | 'reject', id: number) => { const r = await queue.handle(action, id, OWNER); director.afterDecision(); return r; };
  const cmd = (name: string, arg = '') => director.onCommand(name, arg);
  const ownerSaw = () => tg.to(OWNER).join('\n');
  const close = () => new Promise<void>((res) => (url ? webhook.close(() => res()) : res()));
  return {
    bot, api, press, say, settle, clock, db, tg, hq, queue, channel, llm, calls, state, director, marketing, support, sales, production, backoffice, drill, billing, payWatch, chain, chainGets, admin, webhook, url, http, adm,
    cabinet, callBook, emails, emailFail, site, heartbeat, beat, decide, cmd, alerts, posted, lost, webChat, reloads, toWeb, toClient, tools, fetched, rendersDir, dataDir, sleeps, outbox, ownerSaw, close, startRoutines: () => startRoutines(hq),
  };
}
export type DrillWorld = Awaited<ReturnType<typeof drillWorld>>;
void readFileSync;
