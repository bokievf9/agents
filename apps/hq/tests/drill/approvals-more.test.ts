/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { afterEach, describe, expect, it } from 'vitest';
import { ProspectStore } from '@fir/worker-prospector';
import { CSV } from '../sales-helpers.js';
import { TOKENS, drillWorld, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

const g = useGuard();
let w: DrillWorld;
afterEach(async () => { await w?.close(); });
const DAY = 86_400_000;

/** With the legacy flag TG_APPROVAL_CARDS=on, so the same card can be decided from Telegram and from the review API. */
async function fresh(): Promise<DrillWorld> {
  const x = await drillWorld({ tgCards: true });
  for (const k of x.queue.trustTable()) x.queue.setLevel(k.kind, 0);
  return x;
}
const flush = async (x: DrillWorld) => { for (let i = 0; i < 3; i++) await x.beat(); await x.director.sendApprovalBatch(true); };
const waiting = (x: DrillWorld, kind: string) => x.queue.pending().filter((r) => r.kind === kind);

/** Each producer drives the real flow to the point where a card of the kind waits for the owner. */
const PRODUCERS: Record<string, (x: DrillWorld) => Promise<void>> = {
  prospect_followup: async (x) => {
    new ProspectStore(x.db, x.hq.now).importCsv(CSV);
    x.hq.runRoutine('sales-daily-cards');
    await flush(x);
    for (const p of waiting(x, 'prospect_first')) await x.decide('approve', p.id);
    x.clock.t += 5 * DAY;
    x.hq.runRoutine('sales-followups');
    await flush(x);
  },
  prospect_reply: async (x) => {
    new ProspectStore(x.db, x.hq.now).importCsv(CSV);
    x.hq.runRoutine('sales-daily-cards');
    await flush(x);
    for (const p of waiting(x, 'prospect_first')) await x.decide('approve', p.id);
    await x.cmd('reply', '3');
    await x.director.onText('Да, интересно, пришлите подробности и цену');
    await flush(x);
  },
  referral_reward: async (x) => {
    await x.cmd('referral', 'Cambridge -> Blanche');
    await x.cmd('paid', '1');
    await flush(x);
  },
  billing_reminder: async (x) => {
    await x.cmd('client', 'Dilnoza | @d | bot');
    await x.cmd('invoice', 'Dilnoza 120 поддержка due=2026-11-20');
    await flush(x);
    for (const p of waiting(x, 'billing_invoice')) await x.decide('approve', p.id);
    x.clock.t += DAY; // 19.11, one day before the due date
    x.hq.runRoutine('support-billing');
    await flush(x);
  },
  referral_payout: async (x) => {
    await x.cmd('client', 'cambridge | @cambridge_owner | бот');
    await x.http('POST', '/lead', { name: 'Blanche', contact: '@blanche', service: 'bots', budget: '$300-500', message: 'Нужен бот для записи', locale: 'ru', source: 'ref:cambridge' }, { 'x-lead-token': TOKENS.lead });
    await flush(x);
    for (const p of waiting(x, 'presales_pack')) await x.decide('approve', p.id);
    await flush(x);
    for (const p of waiting(x, 'billing_invoice')) await x.decide('approve', p.id);
    const inv = x.db.prepare("SELECT number FROM bl_invoices WHERE status = 'issued'").get() as { number: string };
    await x.cmd('paid', inv.number);
    await flush(x);
  },
};

describe('the kinds that need a longer story: every one is decided through Telegram and through the review API', () => {
  for (const [kind, produce] of Object.entries(PRODUCERS)) {
    describe(kind, () => {
      const prepared = async () => { w = await fresh(); await produce(w); const r = waiting(w, kind)[0]; expect(r, `no pending ${kind} card after its flow`).toBeDefined(); return r!; };
      it('Telegram approve with TG_APPROVAL_CARDS=on (a template is filled first), then a second press answers "already"', async () => {
        const r = await prepared();
        let calls = await w.press(`ap:${r.id}:a`);
        if (w.queue.get(r.id)!.status === 'pending') { // held: a template in the text
          await w.press(`ap:${r.id}:e`);
          await w.say('Готовый текст владельца.');
          calls = await w.press(`ap:${r.id}:a`);
        }
        await w.settle();
        expect(calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
        expect(w.queue.get(r.id)!.status).toBe('executed');
        await w.press(`ap:${r.id}:a`);
        expect(w.queue.get(r.id)!.status).toBe('executed');
        expect(g.rejections).toEqual([]);
        expect(g.errors().map((l) => `${l.msg}: ${String(l.err)}`)).toEqual([]);
      });
      it('Telegram reject with TG_APPROVAL_CARDS=on', async () => {
        const r = await prepared();
        await w.press(`ap:${r.id}:r`);
        expect(w.queue.get(r.id)!.status).toBe('rejected');
        await w.press(`ap:${r.id}:a`);
        expect(w.queue.get(r.id)!.status).toBe('rejected');
        expect(g.errors()).toEqual([]);
      });
      it('review API approve and reject, a repeat is a no-op, the opposite is refused', async () => {
        const r = await prepared();
        const link = w.hq.approvalByCoreId(r.id)!;
        const id = `ap_${link.id}`;
        let a = await w.adm('POST', `/admin/review/${id}`, { action: 'approve' });
        if (a.status === 409 && a.json.error === 'placeholder') {
          expect((await w.adm('POST', `/admin/review/${id}`, { action: 'edit', text: { draft: 'Готовый текст владельца.' } })).status).toBe(200);
          a = await w.adm('POST', `/admin/review/${id}`, { action: 'approve' });
        }
        expect(a.status, a.text).toBe(200);
        expect(a.json.ok, a.text).toBe(true);
        expect((await w.adm('POST', `/admin/review/${id}`, { action: 'approve' })).status).toBe(200);
        expect((await w.adm('POST', `/admin/review/${id}`, { action: 'reject' })).status).toBe(409);
        const item = ((await w.adm('GET', '/admin/review?status=all&limit=200')).json.items as any[]).find((i) => i.id === id);
        expect(item.kind).toBe(kind);
        expect(g.errors()).toEqual([]);
      });
      it('review API reject', async () => {
        const r = await prepared();
        const id = `ap_${w.hq.approvalByCoreId(r.id)!.id}`;
        expect((await w.adm('POST', `/admin/review/${id}`, { action: 'reject' })).status).toBe(200);
        expect(w.queue.get(r.id)!.status).toBe('rejected');
        expect(g.errors()).toEqual([]);
      });
      it('the card is listed with its actions and survives an edit through the API when the kind has text', async () => {
        const r = await prepared();
        const id = `ap_${w.hq.approvalByCoreId(r.id)!.id}`;
        const item = ((await w.adm('GET', '/admin/review?limit=200')).json.items as any[]).find((i) => i.id === id);
        expect(item.actions).toContain('approve');
        if (item.actions.includes('edit')) {
          const e = await w.adm('POST', `/admin/review/${id}`, { action: 'edit', text: { draft: 'Новый текст.' } });
          expect(e.status, e.text).toBe(200);
        }
        expect(g.errors()).toEqual([]);
      });
    });
  }
});
