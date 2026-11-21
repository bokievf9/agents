/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import type { Tools } from '@fir/core';
import { PresalesStore } from '@fir/worker-presales';
import { DocStore } from '@fir/worker-documents';
import { describe, expect, it } from 'vitest';
import { builderUrlOf } from '../src/admin-crm.js';
import { CabDocs } from '../src/cab-docs.js';
import { ensureCabinetTables } from '../src/cabinet.js';
import { reviewWorld } from './review-helpers.js';

const PACK = { packId: 1, direction: 'admin', client: 'Анна', what: 'Бот', kp: 'КП v1', estimate: 'Смета v1', contract: 'Договор v1', totalUsd: 500, prepayUsd: 250, prepayPercent: 50, timeline: '2 недели' };

/** A real CabDocs over the world's db (made after the world: the admin API gets a delegate) with a toolbox that «renders» PDFs into a list. */
function cabinetWorld() {
  const pdfs: string[] = [];
  const tools = {
    can: (n: string) => n.startsWith('media') || n.startsWith('files'),
    media: { pdf: (doc: unknown) => { pdfs.push(JSON.stringify(doc)); return Promise.resolve({ ok: true, value: { bytes: Buffer.from(`pdf${pdfs.length}`) } }); } },
    files: { put: (_d: string, name: string) => Promise.resolve({ ok: true, value: { path: `cabinet/${name}` } }), url: () => Promise.resolve({ ok: true, value: 'https://x/f' }) },
  } as unknown as Tools;
  const ref: { docs?: CabDocs } = {};
  const delegate = { revisable: (...a: Parameters<CabDocs['revisable']>) => ref.docs!.revisable(...a), reviseDelivered: (...a: Parameters<CabDocs['reviseDelivered']>) => ref.docs!.reviseDelivered(...a) };
  const p = reviewWorld({ admin: { cabinet: { docs: delegate, bind: () => undefined, route: () => null } as any } });
  ensureCabinetTables(p.w.db);
  const real = new CabDocs({ hq: p.w.hq, now: p.t, tools: () => tools, billing: undefined as never, siteUrl: 'https://firtech.pro', notifyOwner: () => undefined });
  ref.docs = real;
  p.w.db.prepare("INSERT INTO cab_clients (email, name, locale, created_at, updated_at) VALUES ('a@x.com', 'Анна', 'ru', 1, 1)").run();
  return { p, docs: real, pdfs };
}

describe('the pilot block of a flagship\'s КП: the owner\'s switch in the review center', () => {
  it('`pilot: true` puts the block into the КП, `false` takes it out; only for Персональный ИИ and ИИ-компании; the pack field follows; nothing automatic', async () => {
    const p = reviewWorld();
    const lead = p.lead('Анна');
    const kp = '# КП\n\n## Стоимость\nтаблица\n\n## Срок действия\n14 дней';
    const x = await p.propose('sales', 'presales_pack', { ...PACK, direction: 'company', kp, pilot: false, leadId: lead.id }, 'пакет', { release: true });
    new PresalesStore(p.w.db, p.t).createPack(lead.id, 'company', [{ kind: 'kp', title: 'КП', body: kp }]);
    const on = await p.act(x.id, { action: 'edit', pilot: true });
    expect(on.json.ok).toBe(true);
    expect(on.json.item.text.body).toContain('## Пилот');
    expect(on.json.item.text.body).toContain('Условия пилота');
    expect(on.json.item.text.body.indexOf('## Пилот')).toBeLessThan(on.json.item.text.body.indexOf('## Срок действия'));
    const core = p.w.hq.approvalLink(x.linkId)!.approvalId!;
    expect(p.w.queue.get(core)!.payload).toMatchObject({ pilot: true });
    expect((p.w.db.prepare("SELECT body FROM ps_documents WHERE kind = 'kp'").get() as any).body).toContain('## Пилот');
    expect((await p.act(x.id, { action: 'edit', pilot: true })).json.error).toBe('not_applied'); // already in
    const off = await p.act(x.id, { action: 'edit', pilot: false });
    expect(off.json.item.text.body).toBe(kp);
    expect(p.w.queue.get(core)!.payload).toMatchObject({ pilot: false });
    // an ordinary product has no pilot block
    const y = await p.propose('sales', 'presales_pack', { ...PACK, packId: 2, direction: 'admin', kp, leadId: lead.id }, 'пакет 2', { release: true });
    expect((await p.act(y.id, { action: 'edit', pilot: true })).json.error).toBe('not_applicable');
    // no `pilot` and no `text`: still invalid
    expect((await p.act(x.id, { action: 'edit', doc: 'kp' })).json.error).toBe('invalid');
  });
});

describe('КП, смета and договор are editable before the approval', () => {
  it('doc + text replaces that document of the pack, the card stays pending, v2 is the owner, the stored draft follows', async () => {
    const p = reviewWorld();
    const lead = p.lead('Анна');
    const x = await p.propose('sales', 'presales_pack', { ...PACK, leadId: lead.id }, 'пакет', { release: true });
    new PresalesStore(p.w.db, p.t).createPack(lead.id, 'admin', [{ kind: 'kp', title: 'КП', body: 'КП v1' }]);
    expect((await p.item(x.id)).actions).toContain('edit');
    expect((await p.act(x.id, { action: 'edit', text: { draft: 'x' } })).json.error).toBe('invalid'); // doc is required
    const r = await p.act(x.id, { action: 'edit', doc: 'kp', text: { draft: 'КП v2, новая цена' } });
    expect(r.json.ok).toBe(true);
    const item = r.json.item;
    expect(item.status).toBe('pending');
    expect(item.text.body).toBe('КП v2, новая цена');
    expect(item.text.documents.map((d: any) => d.body)).toEqual(['КП v2, новая цена', 'Смета v1', 'Договор v1']);
    expect(item.versions.map((v: any) => v.v)).toEqual([1, 2]);
    expect(item.versions[0].text.body).toBe('КП v1');
    const core = p.w.hq.approvalLink(x.linkId)!.approvalId!;
    expect(p.w.queue.get(core)).toMatchObject({ status: 'pending', edited: true, payload: { kp: 'КП v2, новая цена', estimate: 'Смета v1', contract: 'Договор v1' } });
    expect((p.w.db.prepare("SELECT body FROM ps_documents WHERE kind = 'kp'").get() as any).body).toBe('КП v2, новая цена');
    // a plain string text works as draft; the contract and the estimate too; unchanged text is refused
    expect(p.w.queue.get(core)!.payload.contractEdited).toBeUndefined(); // a КП edit does not mark the contract as the owner's
    expect((await p.act(x.id, { action: 'edit', doc: 'contract', text: 'Договор v2' })).json.item.text.documents[2].body).toBe('Договор v2');
    expect(p.w.queue.get(core)!.payload.contractEdited).toBe(true);
    expect((await p.act(x.id, { action: 'edit', doc: 'estimate', text: { draft: 'Смета v2' } })).json.item.versions.length).toBe(4);
    expect((await p.act(x.id, { action: 'edit', doc: 'estimate', text: { draft: 'Смета v2' } })).json.error).toBe('not_applied');
    await p.act(x.id, { action: 'approve' });
    expect(p.executed.at(-1)!.payload).toMatchObject({ kp: 'КП v2, новая цена', estimate: 'Смета v2', contract: 'Договор v2' });
  });
});

describe('an approved КП, смета or contract is revised before the client acts', () => {
  it('a quote awaiting the client: text and PDF are renewed, the client gets a thread line; once accepted it is locked; the contract is edited as a document', async () => {
    const { p, docs, pdfs } = cabinetWorld();
    const lead = p.lead('Анна');
    const x = await p.propose('sales', 'presales_pack', { ...PACK, leadId: lead.id }, 'пакет', { release: true });
    await p.act(x.id, { action: 'approve' });
    docs.onQuoteApproved({ clientId: 1, leadId: lead.id, projectId: 1, packId: 1, client: 'Анна', totalUsd: 500, kpText: 'КП v1', estimateText: 'Смета v1', contractMeta: {}, invoiceMeta: {} });
    await docs.idle();
    const before = pdfs.length;
    expect((await p.item(x.id)).actions).toContain('edit');
    const r = await p.act(x.id, { action: 'edit', doc: 'kp', text: { draft: 'КП v2' } });
    expect(r.json.ok).toBe(true);
    expect(r.json.item.status).toBe('approved');
    expect(r.json.item.text.body).toBe('КП v2');
    expect(r.json.item.versions.map((v: any) => v.v)).toEqual([1, 2]);
    expect((p.w.db.prepare("SELECT body, pdf_rel FROM cab_documents WHERE src = 'ps_quote'").get() as any)).toMatchObject({ body: 'КП v2' });
    expect(pdfs.length).toBe(before + 1);
    expect((p.w.db.prepare("SELECT COUNT(*) n FROM cab_messages WHERE client_id = 1 AND text LIKE '%обновлён%'").get() as any).n).toBe(1);
    const e = await p.act(x.id, { action: 'edit', doc: 'estimate', text: { draft: 'Смета v2' } });
    expect(e.json.item.text.documents.find((d: any) => d.key === 'estimate').body).toBe('Смета v2');
    expect((await p.act(x.id, { action: 'edit', doc: 'contract', text: { draft: 'Д' } })).json.error).toBe('not_applicable');
    // the client accepted the КП: no more edits
    p.w.db.prepare("UPDATE cab_documents SET state = 'accepted' WHERE src = 'ps_quote'").run();
    expect((await p.item(x.id)).actions).not.toContain('edit');
    expect((await p.act(x.id, { action: 'edit', doc: 'kp', text: { draft: 'КП v3' } })).json.error).toBe('not_pending');
  });

  it('an approved bo_document: a new version row, the cabinet row follows the new id and is re-rendered; signed is locked', async () => {
    const { p, docs, pdfs } = cabinetWorld();
    const lead = p.lead('Анна');
    const task = p.w.hq.createTask({ title: 'Договор', dept: 'backoffice', creator: 'head', meta: { leadId: lead.id } });
    p.w.db.prepare('UPDATE li_leads SET client_id = 1 WHERE id = ?').run(lead.id);
    const doc = new DocStore(p.w.db, p.t).add({ type: 'contract', client: 'Анна', projectId: null, text: 'Договор № 5 v1', taskId: task.id });
    const x = await p.propose('backoffice', 'bo_document', { text: 'Договор № 5 v1', docId: doc.id }, 'договор', { release: true });
    await p.act(x.id, { action: 'approve' });
    new DocStore(p.w.db, p.t).setStatus(doc.id, 'approved');
    await docs.onDocApproved({ id: doc.id, type: 'contract', client: 'Анна', version: 1, text: 'Договор № 5 v1', taskId: task.id });
    const before = pdfs.length;
    const item = await p.item(x.id);
    expect(item.status).toBe('approved');
    expect(item.actions).toContain('edit');
    const r = await p.act(x.id, { action: 'edit', text: { draft: 'Договор № 5 v2' } });
    expect(r.json.ok).toBe(true);
    expect(r.json.item.text.draft).toBe('Договор № 5 v2');
    expect(r.json.item.meta.document).toMatchObject({ version: 2 });
    expect(r.json.item.versions.map((v: any) => v.v)).toEqual([1, 2]);
    const rows = p.w.db.prepare('SELECT id, version, status, text FROM bo_documents ORDER BY id').all() as any[];
    expect(rows.map((q) => [q.version, q.status, q.text])).toEqual([[1, 'approved', 'Договор № 5 v1'], [2, 'approved', 'Договор № 5 v2']]);
    expect(p.w.db.prepare("SELECT body, src_id FROM cab_documents WHERE src = 'bo'").get()).toMatchObject({ body: 'Договор № 5 v2', src_id: rows[1].id });
    expect(pdfs.length).toBe(before + 1);
    // signed: locked
    p.w.db.prepare("UPDATE cab_documents SET state = 'signed' WHERE src = 'bo'").run();
    expect((await p.item(x.id)).actions).not.toContain('edit');
    expect((await p.act(x.id, { action: 'edit', text: { draft: 'v3' } })).json.error).toBe('not_pending');
  });
});

describe('lead breakdown data', () => {
  it('builderUrlOf: the enrichment link wins, else the first firtech.pro builder link of the texts', () => {
    expect(builderUrlOf({ builderLink: 'https://firtech.pro/ru/builder?b=AAA' }, 'x')).toBe('https://firtech.pro/ru/builder?b=AAA');
    expect(builderUrlOf(null, 'Мой проект: https://firtech.pro/en/builder?b=Zm9v_-1, спасибо', 'other')).toBe('https://firtech.pro/en/builder?b=Zm9v_-1');
    expect(builderUrlOf(null, 'https://example.com/builder?b=1', 'нет ссылки')).toBeNull();
    expect(builderUrlOf(null, null, undefined)).toBeNull();
  });

  it('meta.lead of a review card and the CRM lead carry message, estimate and builderUrl', async () => {
    const p = reviewWorld();
    const lead = p.lead('Анна', { contact: '@anna' });
    p.w.db.prepare('UPDATE li_leads SET task = ?, estimate = ? WHERE id = ?').run('Хочу бота. https://firtech.pro/ru/builder?b=QUJD', 'Итого $500', lead.id);
    const x = await p.propose('sales', 'lead_reply', { text: 'Привет', leadId: lead.id }, 'ответ', { release: true });
    const meta = (await p.item(x.id)).meta.lead;
    expect(meta).toMatchObject({ message: 'Хочу бота. https://firtech.pro/ru/builder?b=QUJD', estimate: 'Итого $500', builderUrl: 'https://firtech.pro/ru/builder?b=QUJD' });
    const crm = (await p.call('GET', '/admin/crm/leads')).json.items.find((i: any) => i.id === lead.id);
    expect(crm).toMatchObject({ message: meta.message, estimate: 'Итого $500', builderUrl: meta.builderUrl });
    // the enrichment of the receptionist beats the text
    p.w.db.prepare('UPDATE li_leads SET enrichment = ? WHERE id = ?').run(JSON.stringify({ summary: [], productFamily: 'adminbot', niche: 'salon', intentScore: 50, builderLink: 'https://firtech.pro/ru/builder?b=ENR' }), lead.id);
    expect((await p.item(x.id)).meta.lead.builderUrl).toBe('https://firtech.pro/ru/builder?b=ENR');
  });
});

describe('presales_pack: the ids of the document rows', () => {
  it('documents[].id and meta.pack.documentIds are the ps_documents rows of the pack (null / skipped when no row exists)', async () => {
    const p = reviewWorld();
    const lead = p.lead('Анна');
    const rows = new PresalesStore(p.w.db, p.t).createPack(lead.id, 'admin', [{ kind: 'kp', title: 'КП', body: 'КП v1' }, { kind: 'estimate', title: 'Смета', body: 'Смета v1' }, { kind: 'contract', title: 'Договор', body: 'Договор v1' }]);
    const x = await p.propose('sales', 'presales_pack', { ...PACK, packId: rows[0]!.packId, leadId: lead.id }, 'пакет', { release: true });
    const item = await p.item(x.id);
    expect(item.text.documents.map((d: any) => [d.key, d.id])).toEqual([['kp', rows[0]!.id], ['estimate', rows[1]!.id], ['contract', rows[2]!.id]]);
    expect(item.meta.pack.documentIds).toEqual(rows.map((r) => r.id));
    // a pack without rows (a stub proposal): ids are null and the list is empty, the card still works
    const y = await p.propose('sales', 'presales_pack', { ...PACK, packId: 99, leadId: lead.id }, 'пакет без строк', { release: true });
    const bare = await p.item(y.id);
    expect(bare.text.documents.map((d: any) => d.id)).toEqual([null, null, null]);
    expect(bare.meta.pack.documentIds).toEqual([]);
  });
});
