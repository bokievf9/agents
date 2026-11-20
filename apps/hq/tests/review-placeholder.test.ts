import { placeholderHold } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { OWNER } from './helpers.js';
import { reviewWorld } from './review-helpers.js';

/** Drill 2026-11-21: approving a card with `[цена]` from the site used to fail the approval for good; now it is a 409 and the card stays open. */
describe('POST /admin/review/:id and /admin/approvals/:id: a template left in the text', () => {
  it('approve is 409 placeholder and the proposal stays pending; the edit then the approve go through', async () => {
    const p = reviewWorld();
    p.w.hq.registerKind('lead_price', {
      initialLevel: 0, locked: true, ready: (x) => placeholderHold(String(x.text).match(/\[[^\]]*\]/g) ?? []),
      execute: (payload) => { p.executed.push({ kind: 'lead_price', payload }); return Promise.resolve(); },
    });
    const { id, linkId } = await p.propose('sales', 'lead_price', { text: 'Стоимость: [цена]', leadId: 1, contact: '@a', name: 'A' }, 'price', { release: true });
    const r = await p.act(id, { action: 'approve' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ ok: false, error: 'placeholder', placeholders: ['[цена]'] });
    expect((await p.item(id)).status).toBe('pending');
    expect(p.executed).toHaveLength(0);
    // the same through the older approvals route
    const core = p.w.hq.approvalLink(linkId)!.approvalId!;
    const old = await p.call('POST', `/admin/approvals/${core}`, { action: 'approve' });
    expect(old.status).toBe(409);
    expect(old.json.error).toBe('placeholder');
    expect((await p.act(id, { action: 'edit', text: { draft: 'Стоимость: 250 USD' } })).status).toBe(200);
    expect((await p.act(id, { action: 'approve' })).status).toBe(200);
    expect(p.executed).toHaveLength(1);
    void OWNER;
  });
});
