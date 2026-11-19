import type { ApprovalQueue } from '@fir/core';
import type { Hq } from '@fir/hq';
import type { BillingWorker } from '@fir/worker-billing';
import type { AdminReply } from './admin.js';
import type { createCrm } from './admin-crm.js';
import type { ClientChannel } from './client/channel.js';
import type { Director } from './director.js';
import type { OwnerChannel } from './presence.js';
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
}

export function createPult(d: PultDeps) {
  const hub = createHub(d.hq.db, d.now);
  const crm = createPultCrm(d);

  /** `seg`: the path after `/admin/`. null: not a «Пульт v3» route. */
  async function handle(method: string, seg: string[], query: URLSearchParams, body: unknown): Promise<AdminReply | null> {
    const [a] = seg;
    if (a === 'hub') return method === 'GET' && seg.length === 1 ? ok(hub.get()) : fail(404, 'not_found');
    if (a === 'crm') return crm.handle(method, seg.slice(1), query, body);
    return null;
  }
  return { handle, crm };
}
