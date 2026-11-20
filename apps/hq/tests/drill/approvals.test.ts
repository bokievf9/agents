/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drillWorld, type DrillWorld } from './world.js';
import { seedEverything } from './seed.js';
import { useGuard } from './guard.js';

const g = useGuard();

/** Kinds the real flows put in front of the owner at once; the rest (referral, reminders, follow-ups) are driven in chain.test.ts. */
const KINDS = ['article', 'seo_proposal', 'audit', 'support_answer', 'support_money', 'billing_invoice', 'onboarding_guide', 'presales_pack', 'prospect_first', 'lead_reply', 'lead_price', 'pm_spec', 'pm_client_status', 'bo_document'];

async function seeded(): Promise<DrillWorld> {
  const w = await drillWorld();
  for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
  await seedEverything(w);
  return w;
}
const rows = (w: DrillWorld, kind: string) => w.queue.pending().filter((r) => r.kind === kind);
const decisions = (w: DrillWorld, id: number) => (w.db.prepare("SELECT COUNT(*) n FROM decisions WHERE approval_id = ?").get(id) as { n: number } | undefined)?.n ?? -1;


const PLACEHOLDER_KINDS = new Set(['support_money', 'lead_price', 'bo_document']);
const NEW_TEXT = 'Готовый текст владельца, без заготовок: всё впишу сам.';

describe('Telegram buttons through the bot glue', () => {
  describe('approve every kind', () => {
    let w: DrillWorld;
    beforeAll(async () => { w = await seeded(); }, 60_000);
    afterAll(async () => { await w?.close(); });
    it.each(KINDS)('approve %s', async (kind) => {
      const r = rows(w, kind)[0];
      expect(r, `no pending ${kind} card to press`).toBeDefined();
      const calls = await w.press(`ap:${r!.id}:a`);
      await w.settle();
      expect(calls.some((c) => c.method === 'answerCallbackQuery'), 'the button spun: no answer').toBe(true);
      if (PLACEHOLDER_KINDS.has(kind)) {
        // a template (`[цена]`) is left in the text: the card stays open with a hint, it is not failed; the owner edits, then approves
        expect(w.queue.get(r!.id)!.status, `${kind} #${r!.id} killed by a placeholder`).toBe('pending');
        expect(JSON.stringify(calls.find((c) => c.method === 'answerCallbackQuery')!.payload)).toContain('Править');
        await w.press(`ap:${r!.id}:e`);
        await w.say(NEW_TEXT);
        await w.settle();
        expect(w.queue.get(r!.id)!.status).toBe('pending');
        expect(w.queue.get(r!.id)!.payload.text).toBe(NEW_TEXT);
        await w.press(`ap:${r!.id}:a`);
        await w.settle();
      }
      expect(w.queue.get(r!.id)!.status, `${kind} #${r!.id}`).toBe('executed');
      // a second press (stale card, double tap) must not run anything again and must still be answered
      const again = await w.press(`ap:${r!.id}:a`);
      expect(again.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
      expect(w.queue.get(r!.id)!.status).toBe('executed');
      expect(decisions(w, r!.id)).toBe(PLACEHOLDER_KINDS.has(kind) ? 2 : 1); // edit + approve, or approve
      expect(g.rejections).toEqual([]);
      expect(g.errors()).toEqual([]);
    });
  });

  describe('reject every kind', () => {
    let w: DrillWorld;
    beforeAll(async () => { w = await seeded(); }, 60_000);
    afterAll(async () => { await w?.close(); });
    it.each(KINDS)('reject %s', async (kind) => {
      const r = rows(w, kind)[0];
      expect(r, `no pending ${kind} card to press`).toBeDefined();
      const calls = await w.press(`ap:${r!.id}:r`);
      await w.settle();
      expect(calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
      expect(w.queue.get(r!.id)!.status).toBe('rejected');
      const again = await w.press(`ap:${r!.id}:a`); // approve after reject: nothing runs
      expect(again.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
      expect(w.queue.get(r!.id)!.status).toBe('rejected');
      expect(decisions(w, r!.id)).toBe(1);
      expect(g.rejections).toEqual([]);
      expect(g.errors()).toEqual([]);
    });
  });
});

describe('the weekly pack and its items', () => {
  const pack = (w: DrillWorld) => w.queue.pending().find((r) => r.kind === 'content_pack')!;
  it('«Одобрить» on the pack card approves every held item, once', async () => {
    const w = await seeded();
    const p = pack(w);
    const calls = await w.press(`ap:${p.id}:a`);
    await w.settle();
    expect(calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
    expect(w.queue.get(p.id)!.status).toBe('executed');
    const items = w.hq.db.prepare("SELECT state FROM task_approvals WHERE kind = 'content_item'").all() as { status?: string; state?: string }[];
    expect(items.length).toBeGreaterThan(10);
    expect(items.filter((i) => i.state !== 'approved' && i.state !== 'executed').map((i) => i.state)).toEqual([]);
    await w.press(`ap:${p.id}:a`); // second tap
    expect(w.queue.get(p.id)!.status).toBe('executed');
    expect(g.rejections).toEqual([]);
    expect(g.errors()).toEqual([]);
    await w.close();
  }, 30_000);
  it('«Отклонить» on the pack card rejects the held items', async () => {
    const w = await seeded();
    const p = pack(w);
    await w.press(`ap:${p.id}:r`);
    await w.settle();
    expect(w.queue.get(p.id)!.status).toBe('rejected');
    expect(w.queue.pending().filter((r) => r.kind === 'content_item')).toHaveLength(0);
    expect(g.errors()).toEqual([]);
    await w.close();
  }, 30_000);
  it('«Посмотреть по одному» opens the items as their own cards; approve, reject, edit one of them; old pack buttons answer', async () => {
    const w = await seeded();
    const p = pack(w);
    await w.press(`pk:${p.id}:o`);
    await w.settle();
    const items = w.queue.pending().filter((r) => r.kind === 'content_item');
    expect(items.length).toBeGreaterThan(5);
    const [a, b, c] = items;
    await w.press(`ap:${a!.id}:a`);
    expect(w.queue.get(a!.id)!.status).toBe('executed');
    await w.press(`ap:${b!.id}:r`);
    expect(w.queue.get(b!.id)!.status).toBe('rejected');
    // «Править» on a content item asks which part, the part button then the new text
    const edit = await w.press(`ap:${c!.id}:e`);
    expect(edit.some((x) => x.method === 'answerCallbackQuery')).toBe(true);
    await w.press(`pk:${p.id}:o`); // the open button pressed again
    await w.press(`pk:${p.id}:v`); // the preview button
    await w.settle();
    expect(g.rejections).toEqual([]);
    expect(g.errors()).toEqual([]);
    await w.close();
  }, 30_000);
});

describe('«Править» on content and articles through the bot glue', () => {
  it('a content item: the part picker, a part chosen, the new text replaces only that part; /skip cancels a pending edit', async () => {
    const w = await seeded();
    const p = w.queue.pending().find((r) => r.kind === 'content_pack')!;
    await w.press(`pk:${p.id}:o`);
    await w.settle();
    const item = w.queue.pending().find((r) => r.kind === 'content_item')!;
    const parts = (w.director.editors.get('content_item') as any).parts(item.id) as { id: string; label: string }[];
    expect(parts.length).toBeGreaterThan(0);
    const before = String(w.queue.get(item.id)!.payload.text);
    await w.press(`ap:${item.id}:e`);
    await w.press(`ce:${item.id}:${parts[0]!.id}`);
    await w.say('Новый текст этой части, сделанный владельцем.');
    await w.settle();
    const after = w.queue.get(item.id)!;
    expect(after.status).toBe('pending');
    expect(String(after.payload.text)).not.toBe(before);
    expect(String(after.payload.text)).toContain('Новый текст этой части');
    // a second item: start the edit, then /skip, then free text is a task again, not an edit
    const other = w.queue.pending().find((r) => r.kind === 'content_item' && r.id !== item.id)!;
    await w.press(`ap:${other.id}:e`);
    await w.press(`ce:${other.id}:${parts[0]!.id}`);
    await w.say('/skip');
    await w.settle();
    const t = String(w.queue.get(other.id)!.payload.text);
    await w.say('Это уже не правка');
    await w.settle();
    expect(String(w.queue.get(other.id)!.payload.text)).toBe(t);
    expect(g.rejections).toEqual([]);
    expect(g.errors()).toEqual([]);
    await w.close();
  }, 30_000);
  it('an article: «Править» is a remark and the article is written again; a repeat press and a stale part button answer', async () => {
    const w = await seeded();
    const art = w.queue.pending().find((r) => r.kind === 'article')!;
    await w.press(`ap:${art.id}:e`);
    await w.say('Сократи вдвое и убери пример про барбершоп.');
    for (let i = 0; i < 3; i++) await w.beat();
    await w.settle();
    const status = w.queue.get(art.id)!.status;
    expect(['rejected', 'pending', 'editing']).toContain(status);
    const calls = await w.press(`ce:${art.id}:body`);
    expect(calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
    expect(g.rejections).toEqual([]);
    expect(g.errors()).toEqual([]);
    await w.close();
  }, 30_000);
});
