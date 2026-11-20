import { stagesFor } from '@fir/core';
import { BillingStore } from '@fir/worker-billing';
import { PmStore } from '@fir/worker-project-manager';
import { describe, expect, it } from 'vitest';
import { reviewWorld } from './review-helpers.js';

describe('review center: a stage invoice card names its stage', () => {
  it('meta.stage carries the number, the count, the title and the amount; an invoice outside the plan has none; the КП card carries the stages', async () => {
    const w = reviewWorld();
    const pm = new PmStore(w.w.db, w.t);
    const project = pm.reserve({ client: 'Анна', what: 'сайт', product: 'site', leadId: null, packId: 1, stages: stagesFor(1000, ['site']) });
    const bs = new BillingStore(w.w.db, w.t);
    const mk = (stageNo: number | null) => bs.addInvoice({ client: 'Анна', amountUsd: 400, what: 'x', method: null, dueDate: '2026-12-01', projectId: project.id, stageNo, totalUsd: 1000 }, 2026);
    const staged = mk(2);
    const plain = mk(null);
    const a = await w.propose('support', 'billing_invoice', { text: 'Счёт', invoiceId: staged.id, name: 'Анна' }, 'Счёт этапа 2', { release: true });
    const b = await w.propose('support', 'billing_invoice', { text: 'Счёт', invoiceId: plain.id, name: 'Анна' }, 'Счёт', { release: true });
    expect((await w.item(a.id)).meta.stage).toEqual({ no: 2, of: 3, title: 'Все страницы и наполнение', amountUsd: 400 });
    expect((await w.item(b.id)).meta.stage).toBeUndefined();
    const kp = await w.propose('sales', 'presales_pack', { packId: 1, leadId: null, client: 'Анна', what: 'Сайт', direction: 'site', kp: 'КП', estimate: 'С', contract: 'Д', totalUsd: 1000, prepayUsd: 300, prepayPercent: 30, stages: stagesFor(1000, ['site']) }, 'КП', { release: true });
    expect((await w.item(kp.id)).meta.pack.stages).toHaveLength(3);
  });
});
