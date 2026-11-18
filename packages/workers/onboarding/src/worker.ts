import type { KindSpec, Payload } from '@fir/core';
import { zonedParts, zonedToMs } from '@fir/core';
import type { WorkerCtx } from '@fir/hq';
import { accessItems, guessProduct, guideMarkdown, PRODUCT_RU } from './product.js';
import { ObStore, type Onboarding } from './store.js';

/** `onboarding_guide`: the client guide for the owner to send. Level 0 (not money: the trust counter may promote it). */
export const KIND_GUIDE = 'onboarding_guide';

/** Check-in days after the start and the local hour they are due (the daily 09:30 pass picks them up). */
export const CHECKIN_DAYS = [1, 3, 7] as const;
const CHECKIN_HOUR = 9;

const stores = new WeakMap<object, ObStore>();
export function obStoreFor(ctx: Pick<WorkerCtx, 'db' | 'now'>): ObStore {
  let s = stores.get(ctx.db);
  if (!s) {
    s = new ObStore(ctx.db, ctx.now);
    stores.set(ctx.db, s);
  }
  return s;
}

export interface GuideDelivery {
  text: string;
  onboardingId: number;
  name: string;
}

/** `/onboard <client> [product]`. */
export function parseOnboardArgs(args: string): { client: string; product: string } | null {
  const t = args.trim();
  if (!t) return null;
  const [client, ...rest] = t.split(/\s*[:|]\s*/);
  if (rest.length) return { client: client!.trim(), product: rest.join(' ').trim() };
  return { client: t, product: '' };
}

export const checklistText = (ob: Onboarding, items: { kind: string; title: string; dueAt: number | null }[], tz: string): string => {
  const fmt = (ms: number) => {
    const p = zonedParts(ms, tz);
    return `${String(p.d).padStart(2, '0')}.${String(p.mo).padStart(2, '0')}`;
  };
  const access = items.filter((i) => i.kind === 'access').map((i) => `- [ ] ${i.title}`);
  const checks = items.filter((i) => i.kind === 'checkin').map((i) => `- ${i.title}${i.dueAt ? ` (${fmt(i.dueAt)})` : ''}`);
  return [
    `Онбординг: ${ob.client} (${PRODUCT_RU[ob.productType]}${ob.product ? `: ${ob.product}` : ''})`,
    '',
    'Доступы:',
    ...access,
    '',
    `- [ ] Инструкция клиенту: черновик в очереди одобрений, отправьте клиенту сами`,
    '',
    'Первая неделя (напоминания придут сами):',
    ...checks,
  ].join('\n');
};

/**
 * Onboarding: when a new project is paid (or `/onboard <client>`), makes the checklist (accesses, guide, check-ins on
 * days 1, 3 and 7) and the guide draft. The head turns the checklist into a task for the owner. Check-ins are plain
 * info items: no approval, the owner is only reminded.
 */
export class OnboardingWorker {
  readonly id = 'onboarding';

  kindSpecs(deliver: (d: GuideDelivery) => Promise<void>): Record<string, KindSpec> {
    return {
      [KIND_GUIDE]: {
        initialLevel: 0,
        execute: async (p: Payload) => {
          if (typeof p.text !== 'string' || !p.text.trim()) throw new Error('nothing to deliver');
          await deliver({ text: p.text, onboardingId: Number(p.onboardingId), name: String(p.name ?? '') });
        },
      },
    };
  }

  /** Starts an onboarding (once per client while it is open) and stages the guide. `existing: true` when it was already running. */
  async start(ctx: WorkerCtx, a: { client: string; product: string; invoiceNumber?: string }): Promise<{ onboarding: Onboarding; checklist: string; existing: boolean }> {
    const store = obStoreFor(ctx);
    const open = store.openFor(a.client);
    if (open) return { onboarding: open, checklist: checklistText(open, store.items(open.id), ctx.tz), existing: true };
    const type = guessProduct(a.product);
    const p = zonedParts(ctx.now(), ctx.tz);
    const items = [
      ...accessItems(type).map((title) => ({ kind: 'access' as const, title })),
      { kind: 'guide' as const, title: 'Инструкция клиенту' },
      ...CHECKIN_DAYS.map((d) => ({
        kind: 'checkin' as const,
        title: `День ${d}: спросить клиента, как идёт`,
        dueAt: zonedToMs(p.y, p.mo, p.d + d, CHECKIN_HOUR, 0, ctx.tz),
      })),
    ];
    const onboarding = store.create({ client: a.client, product: a.product, productType: type, ...(a.invoiceNumber ? { invoiceNumber: a.invoiceNumber } : {}) }, items);
    await ctx.requestApproval(
      KIND_GUIDE,
      { text: guideMarkdown(onboarding.client, type), onboardingId: onboarding.id, name: onboarding.client },
      `Инструкция для клиента ${onboarding.client} (${PRODUCT_RU[type]}). Одобрение = «инструкция утверждена», отправьте её клиенту сами.`,
    );
    ctx.log('onboarding', `ob ${onboarding.id} ${type}`);
    return { onboarding, checklist: checklistText(onboarding, store.items(onboarding.id), ctx.tz), existing: false };
  }

  /** Check-ins that came due: marked sent, one info line each; `finished` are onboardings whose last check-in just went out. */
  checkins(ctx: Pick<WorkerCtx, 'db' | 'now'>): { lines: string[]; finished: Onboarding[] } {
    const store = obStoreFor(ctx);
    const lines: string[] = [];
    const finished: Onboarding[] = [];
    for (const { item, onboarding } of store.dueCheckins(ctx.now())) {
      store.markDone(item.id);
      lines.push(`Онбординг ${onboarding.client}: ${item.title}.`);
      const done = store.finishIfComplete(onboarding.id);
      if (done) finished.push(done);
    }
    return { lines, finished };
  }

  listText(ctx: Pick<WorkerCtx, 'db' | 'now'>): string {
    const list = obStoreFor(ctx).recent(10);
    return list.length ? list.map((o) => `#${o.id} ${o.client}: ${PRODUCT_RU[o.productType]}, ${o.finishedAt ? 'завершён' : 'идёт'}`).join('\n') : 'Онбордингов нет.';
  }
}
