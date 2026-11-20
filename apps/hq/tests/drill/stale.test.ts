import { afterEach, describe, expect, it } from 'vitest';
import { drillWorld, type DrillWorld } from './world.js';
import { seedEverything } from './seed.js';
import { useGuard } from './guard.js';

const g = useGuard();
let w: DrillWorld;
afterEach(async () => { await w?.close(); });

async function seeded() {
  w = await drillWorld();
  for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
  await seedEverything(w);
  return w;
}
const card = (kind: string) => w.queue.pending().find((r) => r.kind === kind)!;
const text = (id: number) => 'Готовый текст владельца, без заготовок.' + id;
async function approveFilled(id: number) {
  if (w.queue.notReady(id)) await w.queue.applyEdit(id, text(id));
  return w.queue.handle('approve', id, 100);
}

describe('stale cards: the object behind the card changed before the owner decided', () => {
  it('an invoice voided on the site, then its card approved: no crash, the card ends decided', async () => {
    await seeded();
    const c = card('billing_invoice');
    const invId = Number(c.payload.invoiceId);
    expect((await w.adm('POST', `/admin/crm/invoices/${invId}`, { action: 'void' })).status).toBe(200);
    const n = w.tg.sent.length;
    const answer = await approveFilled(c.id);
    // the card is stale: it answers why, stays open for a rejection, and sends nothing about a void invoice
    expect(answer).toContain('аннулирован');
    expect(w.queue.get(c.id)!.status).toBe('pending');
    expect(w.tg.sent.slice(n).map((m) => m.text).join(' ')).not.toContain('Оплата USDT');
    const link = w.hq.approvalByCoreId(c.id)!;
    const api = await w.adm('POST', `/admin/review/ap_${link.id}`, { action: 'approve' });
    expect(api.status).toBe(409);
    expect(api.json.error).toBe('not_ready');
    expect(await w.queue.handle('reject', c.id, 100)).toBe('Отклонено');
    // a voided invoice must not become payable through the old card
    const row = w.db.prepare('SELECT status FROM bl_invoices WHERE id = ?').get(invId) as { status: string };
    expect(row.status).not.toBe('issued');
    expect(g.rejections).toEqual([]);
    g.expectErrors();
  });
  it('a content item rejected from the calendar, then its pack item card approved from Telegram', async () => {
    await seeded();
    const pack = card('content_pack');
    await w.press(`pk:${pack.id}:o`);
    const item = card('content_item');
    const itemId = Number(item.payload.itemId);
    expect((await w.adm('POST', `/admin/content/${itemId}`, { action: 'reject' })).status).toBeLessThan(500);
    await w.press(`ap:${item.id}:a`);
    expect(['executed', 'failed', 'rejected']).toContain(w.queue.get(item.id)!.status);
    expect(g.rejections).toEqual([]);
    g.expectErrors();
  });
  it('a lead marked lost, then the reply card approved; a project set to done, then the spec approved', async () => {
    await seeded();
    const reply = card('lead_reply');
    const lead = w.db.prepare('SELECT id FROM li_leads ORDER BY id LIMIT 1').get() as { id: number };
    expect((await w.adm('POST', `/admin/crm/leads/${lead.id}`, { stage: 'lost', lost_reason: 'передумал' })).status).toBe(200);
    await approveFilled(reply.id);
    expect(['executed', 'failed']).toContain(w.queue.get(reply.id)!.status);
    const spec = card('pm_spec');
    const pid = Number(spec.payload.projectId);
    await w.adm('POST', `/admin/crm/projects/${pid}`, { action: 'set_status', status: 'done' });
    await approveFilled(spec.id);
    expect(['executed', 'failed']).toContain(w.queue.get(spec.id)!.status);
    expect(g.rejections).toEqual([]);
    g.expectErrors();
  });
  it('two decisions at once on the same card (Telegram and the site) run it once', async () => {
    await seeded();
    const c = card('support_answer');
    const before = w.db.prepare("SELECT COUNT(*) n FROM decisions WHERE approval_id = ?").get(c.id) as { n: number };
    if (w.queue.notReady(c.id)) await w.queue.applyEdit(c.id, text(c.id));
    const link = w.hq.approvalByCoreId(c.id)!;
    const [a, b, d] = await Promise.all([w.press(`ap:${c.id}:a`), w.adm('POST', `/admin/review/ap_${link.id}`, { action: 'approve' }), w.adm('POST', `/admin/approvals/${c.id}`, { action: 'approve' })]);
    void a; void b; void d;
    const after = w.db.prepare("SELECT COUNT(*) n FROM decisions WHERE approval_id = ? AND decision = 'approve'").get(c.id) as { n: number };
    expect(after.n - (before.n ?? 0)).toBe(1);
    expect(w.queue.get(c.id)!.status).toBe('executed');
    expect(g.errors()).toEqual([]);
    expect(g.rejections).toEqual([]);
  });
  it('the same approval pressed from five places at once, approve and reject mixed, ends in exactly one outcome', async () => {
    await seeded();
    const c = card('onboarding_guide');
    if (w.queue.notReady(c.id)) await w.queue.applyEdit(c.id, text(c.id));
    await Promise.all([w.press(`ap:${c.id}:a`), w.press(`ap:${c.id}:r`), w.queue.handle('approve', c.id, 100), w.queue.handle('reject', c.id, 100), w.press(`ap:${c.id}:a`)]);
    const rows = w.db.prepare("SELECT decision FROM decisions WHERE approval_id = ? AND decision IN ('approve','reject')").all(c.id) as { decision: string }[];
    expect(rows).toHaveLength(1);
    expect(['executed', 'rejected']).toContain(w.queue.get(c.id)!.status);
    expect(g.rejections).toEqual([]);
  });
});
