import type { ApprovalQueue } from '@fir/core';
import type { Hq } from '@fir/hq';
import type { BillingWorker } from '@fir/worker-billing';
import type { AdminReply } from './admin.js';
import type { createCrm } from './admin-crm.js';
import type { ClientChannel } from './client/channel.js';
import type { Director } from './director.js';
import type { OwnerChannel } from './presence.js';
import type { MarketingHead } from './heads/marketing.js';
import { createCompany } from './pult-company.js';
import type { AppTools } from './tools.js';
import { createPultContent } from './pult-content.js';
import { createMetrics, SiteEvents } from './pult-events.js';
import { createHub } from './pult-hub.js';
import { createPultCrm, fail, ok } from './pult-crm.js';

/**
 * «Пульт v3»: the owner workplace routes added on top of `/admin/*` (hub, CRM writes, content, metrics, company).
 * Each handler reuses the code the Telegram side already runs (approval queue, `/paid`, `/mdone`, `/level`, routines), never a copy.
 * Contract: `docs/admin-crm-api.md`, section «Пульт v3».
 */
export interface PultDeps {
  hq: Hq;
  queue: ApprovalQueue;
  director: Director;
  channel: OwnerChannel;
  ownerId: number;
  now: () => number;
  crm: ReturnType<typeof createCrm>;
  billing?: BillingWorker | undefined;
  client?: Pick<ClientChannel, 'send'> | undefined;
  webReply?: ((sessionId: string, text: string) => boolean) | undefined;
  marketing?: MarketingHead | undefined;
  rendersDir?: string | undefined;
  /** The owner's decision on one open approval, as the Telegram buttons run it (`admin.ts`). */
  decide: (approvalId: number, action: 'approve' | 'reject') => Promise<unknown>;
  /** The routines changed (switch): the app restarts its cron jobs. */
  onRoutinesChange?: (() => void) | undefined;
  /** The agents' toolbox adapters and keys (the `tools` list of `GET /admin/company`). */
  tools?: AppTools | undefined;
}

export function createPult(d: PultDeps) {
  const hub = createHub(d.hq.db, d.now);
  const crm = createPultCrm(d);
  const content = createPultContent(d);
  const metrics = createMetrics(d.hq.db, d.now, () => d.hq.tz, new SiteEvents(d.hq.db, d.now, () => d.hq.tz));
  const company = createCompany(d);

  /** `seg`: the path after `/admin/`. null: not a «Пульт v3» route. */
  async function handle(method: string, seg: string[], query: URLSearchParams, body: unknown): Promise<AdminReply | null> {
    const [a] = seg;
    if (a === 'hub') return method === 'GET' && seg.length === 1 ? ok(hub.get()) : fail(404, 'not_found');
    if (a === 'content') {
      if (method === 'GET' && seg.length === 1) return content.list(query);
      if (method === 'POST' && seg.length === 2) return content.post(seg[1]!, body);
      return fail(404, 'not_found');
    }
    if (a === 'metrics') return method === 'GET' && seg.length === 2 && seg[1] === 'week' ? metrics.week(query) : fail(404, 'not_found');
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
