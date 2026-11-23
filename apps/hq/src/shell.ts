import type { ApprovalQueue, LlmClient } from '@fir/core';
import type { Hq } from '@fir/hq';
import type { BillingWorker } from '@fir/worker-billing';
import type { AdminReply } from './admin.js';
import type { createCrm } from './admin-crm.js';
import type { Director } from './director.js';
import type { OwnerChannel } from './presence.js';
import type { MarketingHead } from './heads/marketing.js';
import { createAgents } from './shell-agents.js';
import { createCompany } from './shell-company.js';
import type { AppTools } from './tools.js';
import type { CabDocs } from './cab-docs.js';
import { createShellContent } from './shell-content.js';
import { createShellContentPurge } from './shell-content-purge.js';
import { createMetrics, SiteEvents } from './shell-events.js';
import { createHub } from './shell-hub.js';
import { createShellCrm, fail, ok } from './shell-crm.js';
import type { Calls } from './calls.js';
import { createChats, type ChatsClient } from './chats.js';
import { createReview } from './review.js';
import { createShellTrends } from './shell-trends.js';
import { createReach } from './reach.js';
import type { DrillStatus } from './drill.js';
import { createProcesses } from './shell-processes.js';
import { createCalendar } from './shell-calendar.js';
import { createAudit } from './shell-audit.js';
import { createAnalytics } from './shell-analytics.js';
import type { SettingsApi } from './settings.js';
import { createKnowledgeApi, type ShellKnowledgeDeps } from './shell-knowledge.js';
import { createQualityApi } from './shell-quality.js';
import { createDashboard } from './shell-dashboard.js';
import type { Campaigns } from './campaigns.js';
import { createMarketingChat } from './marketing-chat.js';
import { MarketingPlans } from './marketing-plans.js';
import { createMarketingRules, handleMarketing } from './shell-marketing.js';

/**
 * «Shell v3»: the owner workplace routes added on top of `/admin/*` (hub, CRM writes, content, metrics, company).
 * Each handler reuses the code the Telegram side already runs (approval queue, `/paid`, `/mdone`, `/level`, routines), never a copy.
 * Contract: `docs/admin-crm-api.md`, section «Shell v3».
 */
export interface ShellDeps {
  hq: Hq;
  queue: ApprovalQueue;
  director: Director;
  channel: OwnerChannel;
  ownerId: number;
  now: () => number;
  crm: ReturnType<typeof createCrm>;
  billing?: BillingWorker | undefined;
  client?: ChatsClient | undefined;
  webReply?: ((sessionId: string, text: string) => boolean) | undefined;
  marketing?: MarketingHead | undefined;
  rendersDir?: string | undefined;
  /** The owner's decision on one open approval, as the Telegram buttons run it (`admin.ts`). */
  decide: (approvalId: number, action: 'approve' | 'reject') => Promise<unknown>;
  /** The routines changed (switch): the app restarts its cron jobs. */
  onRoutinesChange?: (() => void) | undefined;
  /** The agents' toolbox adapters and keys (the `tools` list of `GET /admin/company`). */
  tools?: AppTools | undefined;
  /** The cabinet's documents: a КП, a смета or a contract already sent to the client is revised in place (`review.ts`). */
  cabinet?: Pick<CabDocs, 'reviseDelivered' | 'revisable'> & Partial<Pick<CabDocs, 'resend' | 'ownerList'>> | undefined;
  /** P-18/P-19: the call bookings behind the lead's «Созвон» (`calls.ts`). */
  calls?: Calls | undefined;
  /** `GET` and `PATCH /admin/settings` (`settings.ts`). */
  settings?: SettingsApi | undefined;
  /** The Drill behind `/admin/processes/drill` (`drill.ts`). */
  drill?: { command(arg: string): Promise<string>; status(): DrillStatus } | undefined;
  /** The lead manager on Fira (when `FIRA_LEAD_MANAGER=on`): owner notes of `/admin/knowledge` go into its search. */
  fira?: ShellKnowledgeDeps['fira'];
  /** The company's model client: Fira as Head of Marketing in `/admin/marketing/chat` (absent: the chat answers from the data by code). */
  llm?: LlmClient | undefined;
  /** The mailings (`campaigns.ts`): read by the marketing chat. */
  campaigns?: Campaigns | undefined;
}

export function createShell(d: ShellDeps) {
  const hub = createHub(d.hq.db, d.now);
  const crm = createShellCrm(d);
  const content = createShellContent(d);
  const contentPurge = createShellContentPurge({ hq: d.hq, now: d.now, rendersDir: d.rendersDir });
  const metrics = createMetrics(d.hq.db, d.now, () => d.hq.tz, new SiteEvents(d.hq.db, d.now, () => d.hq.tz));
  const company = createCompany(d);
  const agents = createAgents(d);
  const review = createReview({
    hq: d.hq, queue: d.queue, director: d.director, channel: d.channel, now: d.now, crm: d.crm, marketing: d.marketing, rendersDir: d.rendersDir, decide: d.decide, ...(d.cabinet ? { cabinet: d.cabinet } : {}),
    callLead: (leadId, at) => crm.handle('POST', ['leads', String(leadId), 'call'], new URLSearchParams(), { at }),
  });
  const chats = createChats({ hq: d.hq, now: d.now, client: d.client, webReply: d.webReply });
  const trends = createShellTrends({ hq: d.hq, now: d.now, marketing: d.marketing });
  const reach = createReach({ hq: d.hq, now: d.now });
  const processes = createProcesses({ db: d.hq.db, now: d.now, drill: d.drill });
  const plans = new MarketingPlans(d.hq);
  const calendar = createCalendar({ hq: d.hq, db: d.hq.db, now: d.now, plans });
  const audit = createAudit({ hq: d.hq, db: d.hq.db });
  const knowledge = createKnowledgeApi({ db: d.hq.db, now: d.now, fira: d.fira });
  const quality = createQualityApi({ db: d.hq.db, now: d.now, setting: (k) => d.hq.setting(k) });
  const dashboard = createDashboard({ hq: d.hq, now: d.now });
  const analytics = createAnalytics({ db: d.hq.db, now: d.now, tz: () => d.hq.tz, numbers: metrics.numbers });
  const marketingRules = createMarketingRules(d.hq);
  const marketingChat = createMarketingChat({
    hq: d.hq, llm: d.llm, plans, rules: marketingRules, content, calendar, analytics, numbers: metrics.numbers, settings: d.settings,
    campaigns: d.campaigns ? () => d.campaigns!.handle('GET', [], undefined) : undefined,
    order: d.marketing ? (o) => d.marketing!.requestStudioOrder({ ...o, via: 'plan' }) : undefined,
  });

  /** `seg`: the path after `/admin/`. null: not a «Shell v3» route. */
  async function handle(method: string, seg: string[], query: URLSearchParams, body: unknown): Promise<AdminReply | null> {
    const [a] = seg;
    if (a === 'hub') return method === 'GET' && seg.length === 1 ? ok(hub.get()) : fail(404, 'not_found');
    if (a === 'content') {
      if (method === 'GET' && seg.length === 1) return content.list(query);
      if (seg[1] === 'feed' && seg.length === 2) return method === 'GET' ? content.feed(query) : fail(404, 'not_found');
      if (seg[1] === 'purge' && seg.length === 2) return method === 'POST' ? contentPurge.run(body) : fail(404, 'not_found');
      if (seg[1] === 'orders' && seg.length === 2) return method === 'GET' ? content.orders(query) : method === 'POST' ? content.createOrder(body) : fail(404, 'not_found');
      if (method === 'POST' && seg.length === 2) return content.post(seg[1]!, body);
      return fail(404, 'not_found');
    }
    if (a === 'review') {
      if (method === 'GET' && seg.length === 1) return review.list(query);
      if (method === 'POST' && seg.length === 2) return review.post(seg[1]!, body);
      return fail(404, 'not_found');
    }
    if (a === 'chats') {
      let id: string | null;
      try {
        id = seg[1] ? decodeURIComponent(seg[1]) : null;
      } catch {
        return fail(404, 'not_found');
      }
      if (method === 'GET' && seg.length === 1) return chats.list(query);
      if (method === 'GET' && seg.length === 2 && id) return chats.get(id);
      if (method === 'POST' && seg.length === 3 && id && seg[2] === 'reply') return chats.reply(id, body);
      if (method === 'POST' && seg.length === 3 && id && seg[2] === 'unread') return chats.markUnread(id);
      if (method === 'POST' && seg.length === 3 && id && seg[2] === 'resume') return chats.resume(id);
      return fail(404, 'not_found');
    }
    if (a === 'trends') {
      if (method === 'GET' && seg.length === 1) return trends.list(query);
      if (method === 'POST' && seg.length === 1) return trends.post(body);
      return fail(404, 'not_found');
    }
    if (a === 'settings' && seg.length === 2 && seg[1] === 'log') {
      if (!d.settings) return fail(503, 'unavailable');
      return method === 'GET' ? d.settings.logView(query) : fail(405, 'method_not_allowed');
    }
    if (a === 'settings' && seg.length === 1) {
      if (!d.settings) return fail(503, 'unavailable');
      if (method === 'GET') return d.settings.get();
      if (method === 'PATCH') return d.settings.patch(body);
      return fail(405, 'method_not_allowed');
    }
    if (a === 'processes') {
      if (method === 'GET' && seg.length === 1) return processes.get();
      if (method === 'POST' && seg.length === 2 && seg[1] === 'drill') return processes.drill(body);
      return fail(404, 'not_found');
    }
    if (a === 'calendar') return method === 'GET' && seg.length === 1 ? calendar.get(query) : fail(404, 'not_found');
    if (a === 'audit') return method === 'GET' && seg.length === 1 ? audit.get(query) : fail(404, 'not_found');
    if (a === 'analytics') return method === 'GET' && seg.length === 1 ? analytics.get(query) : fail(404, 'not_found');
    if (a === 'dashboard') return method === 'GET' && seg.length === 1 ? dashboard.get(query) : fail(404, 'not_found');
    if (a === 'knowledge') return knowledge.handle(method, seg.slice(1), query, body);
    if (a === 'quality') return quality.handle(method, seg.slice(1), query, body);
    if (a === 'reach') return reach.handle(method, seg, query, body);
    if (a === 'metrics') return method === 'GET' && seg.length === 2 && seg[1] === 'week' ? metrics.week(query) : fail(404, 'not_found');
    if (a === 'agents') return agents.handle(method, seg.slice(1), body);
    if (a === 'marketing') return handleMarketing(marketingRules, marketingChat, method, seg.slice(1), query, body);
    if (a === 'company') {
      const [, kind, rawName, act] = seg;
      if (method === 'GET' && seg.length === 1) return company.get();
      let name: string | null;
      try {
        name = rawName ? decodeURIComponent(rawName) : null;
      } catch {
        return fail(404, 'not_found');
      }
      if (method === 'GET' && kind === 'playbooks' && name && seg.length === 3) return company.playbook(name);
      if (method === 'POST' && kind === 'routines' && name) {
        if (seg.length === 3) return company.toggle(name, body);
        if (seg.length === 4 && act === 'run') return company.run(name);
      }
      if (method === 'POST' && kind === 'trust' && name && seg.length === 3) return company.trust(name, body);
      return fail(404, 'not_found');
    }
    if (a === 'crm') return crm.handle(method, seg.slice(1), query, body);
    return null;
  }
  return { handle, crm };
}
