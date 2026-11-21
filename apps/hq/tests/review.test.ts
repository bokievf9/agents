/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostFn, SafePostResult } from '@fir/core';
import { storeFor } from '@fir/worker-content-maker';
import { PublishStore, PublisherWorker, YouTubePoster, isVideo, type PlatformPoster } from '@fir/worker-publisher';
import { describe, expect, it } from 'vitest';
import { OWNER } from './helpers.js';
import { reviewWorld, type ReviewWorld } from './review-helpers.js';
import { serve } from './pult-helpers.js';

const NEW_PACK = { postsPerWeek: 3, storiesPerWeek: 5, carouselsPerWeek: 2 };
const cstore = (p: ReviewWorld) => storeFor({ db: p.w.db, now: p.w.hq.now });

async function packed(opts: Parameters<typeof reviewWorld>[0] = {}) {
  const p = reviewWorld(opts);
  p.w.hq.runRoutine('marketing-weekly-pack');
  await p.w.marketing.onHeartbeat();
  return p;
}
const firstOf = (list: any[], format: string) => list.find((i) => i.kind === 'content_item' && i.meta.format === format);

describe('GET /admin/review: every approval kind is one item', () => {
  it('maps all kinds of the company to the contract shape (fixtures per kind)', async () => {
    const p = reviewWorld();
    const lead = p.lead('Анна', { contact: '@anna', service: 'Бот', budget: '$500', meta: { chatId: 777 } });
    const ticket = p.cs.addTicket({ clientName: 'Анна', text: 'Когда запуск?', money: false });
    const inv = p.seed.invoice(lead.id);
    const proj = p.seed.project();
    const doc = p.seed.doc();
    const ref = p.seed.referral(lead.id);
    const prospect = p.seed.prospect();
    const article = p.seed.article('Бот для салона');
    const fx = [
      { dept: 'sales', kind: 'lead_reply', payload: { text: 'Здравствуйте, Анна.', leadId: lead.id, contact: '@anna', name: 'Анна', chatId: 777 }, title: 'Ответ лиду: Анна', draft: 'Здравствуйте, Анна.', meta: ['lead', 'client', 'delivery'], actions: ['approve', 'edit', 'reject', 'send', 'call'] },
      { dept: 'sales', kind: 'lead_price', payload: { text: 'Цена [цена], срок [срок].', leadId: lead.id, contact: '@anna', name: 'Анна' }, title: 'Цена и сроки: Анна', draft: 'Цена [цена], срок [срок].', meta: ['lead', 'client'], actions: ['approve', 'edit', 'reject', 'send', 'call'] },
      { dept: 'sales', kind: 'presales_pack', payload: { packId: 1, leadId: lead.id, client: 'Анна', what: 'Бот', direction: 'admin', kp: 'КП текст', estimate: 'Смета текст', contract: 'Договор текст', totalUsd: 500, prepayUsd: 250, prepayPercent: 50, timeline: '2 недели' }, title: 'КП: Анна, Бот', draft: undefined, meta: ['lead', 'pack'], actions: ['approve', 'edit', 'reject', 'call'] },
      { dept: 'support', kind: 'support_answer', payload: { text: 'Запуск в пятницу.', ticketId: ticket.id, contact: '', name: 'Анна' }, title: `Ответ клиенту: тикет #${ticket.id}`, draft: 'Запуск в пятницу.', meta: ['ticket', 'client'], actions: ['approve', 'edit', 'reject', 'send'] },
      { dept: 'support', kind: 'support_money', payload: { text: 'Решение [решение владельца]', ticketId: ticket.id, contact: '', name: 'Анна' }, title: `Деньги: тикет #${ticket.id}`, draft: 'Решение [решение владельца]', meta: ['ticket'], actions: ['approve', 'edit', 'reject', 'send'] },
      { dept: 'backoffice', kind: 'bo_document', payload: { text: 'Договор', docId: doc.id }, title: 'Документ contract: Анна, версия 1', draft: 'Договор', meta: ['document'], actions: ['approve', 'edit', 'reject'] },
      { dept: 'support', kind: 'billing_invoice', payload: { text: 'Счёт на 250', invoiceId: inv.id, name: 'Анна' }, title: `Счёт ${inv.number}: Анна`, draft: 'Счёт на 250', meta: ['invoice', 'lead', 'client'], actions: ['approve', 'edit', 'reject', 'call'] },
      { dept: 'support', kind: 'billing_reminder', payload: { text: 'Напоминаем', invoiceId: inv.id, name: 'Анна' }, title: `Напоминание ${inv.number}: Анна`, draft: 'Напоминаем', meta: ['invoice'], actions: ['approve', 'edit', 'reject', 'call'] },
      { dept: 'sales', kind: 'referral_reward', payload: { referralId: ref.id }, title: 'Награда за рекомендацию: Иван', draft: undefined, meta: ['referral'], actions: ['approve', 'reject'] },
      { dept: 'sales', kind: 'referral_payout', payload: { referralId: ref.id }, title: 'Выплата рекомендателю: Иван', draft: undefined, meta: ['referral'], actions: ['approve', 'reject'] },
      { dept: 'production', kind: 'pm_spec', payload: { text: 'ТЗ: бот', projectId: proj.id }, title: `ТЗ проекта #${proj.id}: Анна`, draft: 'ТЗ: бот', meta: ['project'], actions: ['approve', 'edit', 'reject'] },
      { dept: 'production', kind: 'pm_client_status', payload: { text: 'Идём по плану', projectId: proj.id }, title: `Статус клиенту #${proj.id}: Анна`, draft: 'Идём по плану', meta: ['project'], actions: ['approve', 'edit', 'reject'] },
      { dept: 'support', kind: 'onboarding_guide', payload: { text: '# Инструкция', onboardingId: 1, name: 'Анна' }, title: 'Инструкция клиенту Анна', draft: '# Инструкция', meta: ['client', 'onboarding'], actions: ['approve', 'edit', 'reject'] },
      { dept: 'sales', kind: 'prospect_first', payload: { text: 'Добрый день, Роза', prospectId: prospect.id, draftKind: 'first' }, title: 'Разведчик, первое сообщение: Салон Роза', draft: 'Добрый день, Роза', meta: ['prospect', 'draftKind'], actions: ['approve', 'edit', 'reject'] },
      { dept: 'sales', kind: 'prospect_followup', payload: { text: 'Напомню о себе', prospectId: prospect.id, draftKind: 'followup' }, title: 'Разведчик, дожим: Салон Роза', draft: 'Напомню о себе', meta: ['prospect'], actions: ['approve', 'edit', 'reject'] },
      { dept: 'sales', kind: 'prospect_reply', payload: { text: 'Спасибо за ответ', prospectId: prospect.id, draftKind: 'reply' }, title: 'Разведчик, ответ: Салон Роза', draft: 'Спасибо за ответ', meta: ['prospect'], actions: ['approve', 'edit', 'reject'] },
      { dept: 'marketing', kind: 'seo_proposal', payload: { key: 'k1', page: '/ru', title: 'Короткий title', change: 'Сократить title до 60 знаков', needsBuilder: true }, title: 'SEO: Короткий title', draft: undefined, meta: ['seo'], actions: ['approve', 'reject'] },
      { dept: 'marketing', kind: 'audit', payload: { auditId: 1, host: 'salon.example', locale: 'ru', text: 'Находка 1' }, title: 'Аудит сайта: salon.example', draft: 'Находка 1', meta: ['audit', 'delivery'], actions: ['approve', 'edit', 'reject', 'send'] },
      { dept: 'marketing', kind: 'article', payload: { text: 'Статья: превью', articleId: article }, title: 'Бот для салона', draft: 'Статья: превью', meta: ['article', 'platform', 'url'], actions: ['approve', 'revise', 'reject', 'publish_now'] },
    ];
    const ids: Record<string, string> = {};
    for (const f of fx) ids[f.kind] = (await p.propose(f.dept, f.kind, f.payload, `Карточка ${f.kind}\nвторая строка`)).id;
    const list = await p.items();
    expect(list).toHaveLength(fx.length);
    for (const f of fx) {
      const it = list.find((i) => i.id === ids[f.kind])!;
      expect(it, f.kind).toBeDefined();
      // the common shape
      expect(Object.keys(it).sort(), f.kind).toEqual(['actions', 'createdAt', 'currentVersion', 'dept', 'error', 'id', 'kind', 'media', 'meta', 'parentId', 'status', 'summary', 'taskId', 'text', 'title', 'versions']);
      expect(it).toMatchObject({ kind: f.kind, dept: f.dept, status: 'pending', title: f.title, media: [], parentId: null, currentVersion: 1, error: null });
      expect(it.summary).toBe(`Карточка ${f.kind}`);
      expect(new Date(it.createdAt).toISOString()).toBe(it.createdAt);
      expect(it.versions).toHaveLength(1);
      expect(it.versions[0]).toMatchObject({ v: 1, note: '', author: 'worker' });
      if (f.draft !== undefined) expect(it.text.draft, f.kind).toBe(f.draft);
      for (const k of f.meta) expect(it.meta, `${f.kind}.meta.${k}`).toHaveProperty(k);
      expect(it.actions, f.kind).toEqual(f.actions);
    }
    // kind facts worth a look
    const byKind = (k: string) => list.find((i) => i.id === ids[k])!;
    expect(byKind('lead_reply').meta.lead).toMatchObject({ id: lead.id, name: 'Анна', contact: '@anna', service: 'Бот', budget: '$500' });
    expect(byKind('lead_reply').meta).toMatchObject({ client: { id: null, email: null, cabinet: false }, delivery: 'telegram' });
    expect(byKind('presales_pack').text.documents.map((x: any) => x.key)).toEqual(['kp', 'estimate', 'contract']);
    expect(byKind('presales_pack').meta.pack).toMatchObject({ id: 1, totalUsd: 500, prepayUsd: 250, direction: 'admin' });
    expect(byKind('support_answer').meta.ticket).toMatchObject({ id: ticket.id, clientName: 'Анна', status: 'open', question: 'Когда запуск?' });
    expect(byKind('billing_invoice').meta.invoice).toMatchObject({ number: inv.number, amountUsd: 250, dueDate: '2026-11-25', status: expect.any(String) });
    expect(byKind('referral_payout').meta.referral).toMatchObject({ referrer: 'Иван', referred: 'Анна' });
    expect(byKind('seo_proposal').text.body).toContain('Сократить title');
    expect(byKind('seo_proposal').meta.seo).toMatchObject({ page: '/ru', needsBuilder: true });
    expect(byKind('article').meta).toMatchObject({ platform: 'blog', url: null, article: { id: article, niche: 'barbershop' } });
    expect(byKind('article').text).toMatchObject({ subject: 'Бот для салона', body: 'Статья: превью' });
    // the counters: pending per department (the pack has no card here)
    const counts = (await p.call('GET', '/admin/review')).json.counts;
    expect(counts).toEqual({ marketing: 3, sales: 8, support: 5, production: 2, backoffice: 1, director: 0 });
  });

  it('filters: dept, status (pending, decided, all), limit and cursor; bad values are 400', async () => {
    const p = reviewWorld();
    const a = await p.propose('sales', 'lead_reply', { text: 'раз', leadId: 1 }, 'a');
    const b = await p.propose('sales', 'lead_reply', { text: 'два', leadId: 1 }, 'b');
    const c = await p.propose('production', 'pm_spec', { text: 'ТЗ', projectId: 1 }, 'c');
    expect((await p.items('dept=sales')).map((i) => i.id)).toEqual([b.id, a.id]);
    expect((await p.items('dept=production')).map((i) => i.id)).toEqual([c.id]);
    expect(await p.items('dept=marketing')).toEqual([]);
    const page1 = (await p.call('GET', '/admin/review?limit=2')).json;
    expect(page1.items.map((i: any) => i.id)).toEqual([c.id, b.id]);
    expect(page1.nextCursor).toBe(String(b.linkId));
    const page2 = (await p.call('GET', `/admin/review?limit=2&cursor=${page1.nextCursor}`)).json;
    expect(page2.items.map((i: any) => i.id)).toEqual([a.id]);
    expect(page2.nextCursor).toBeNull();
    await p.act(a.id, { action: 'reject' });
    expect((await p.items('status=pending')).map((i) => i.id)).toEqual([c.id, b.id]);
    expect((await p.items('status=decided')).map((i) => i.id)).toEqual([a.id]);
    expect((await p.items('status=all')).map((i) => i.id)).toEqual([c.id, b.id, a.id]);
    for (const bad of ['dept=hr', 'status=old', 'limit=0x', 'limit=abc', 'cursor=x']) expect((await p.call('GET', `/admin/review?${bad}`)).status, bad).toBe(400);
  });

  it('needs the admin token like the other admin routes', async () => {
    const p = reviewWorld();
    const s = await serve(p);
    expect((await s.http('GET', '/admin/review', undefined, {})).status).toBe(401);
    expect((await s.http('POST', '/admin/review/ap_1', { action: 'reject' }, {})).status).toBe(401);
    expect((await s.http('GET', '/admin/review')).status).toBe(200);
    await s.close();
  });
});

describe('content items, packs and media', () => {
  it('the weekly pack: one pack item stands for its held items, which are items of their own; the pack is not counted', async () => {
    const p = await packed({ cadence: NEW_PACK });
    const list = await p.items();
    const pack = list.find((i) => i.kind === 'content_pack')!;
    const items = list.filter((i) => i.kind === 'content_item');
    expect(items).toHaveLength(17);
    expect(pack).toMatchObject({ dept: 'marketing', status: 'pending', actions: ['approve', 'reject'] });
    expect(pack.meta.pack.count).toBe(17);
    expect(pack.meta.pack.itemIds.sort()).toEqual(items.map((i) => i.id).sort());
    expect(items.every((i) => i.meta.heldByPack === true && i.meta.pack === pack.id && i.status === 'pending')).toBe(true);
    expect((await p.call('GET', '/admin/review')).json.counts.marketing).toBe(17);
    const clip = firstOf(items, 'reel');
    expect(clip.meta).toMatchObject({ platform: 'instagram', platforms: ['instagram', 'tiktok', 'shorts'], format: 'reel', source: 'routine', render: { state: 'none' } });
    expect(clip.meta.slot).toMatch(/^2026-11-2\d$/);
    expect(clip.text.body).toContain('Хук');
    expect(clip.text.captions.tiktok).toContain('tt подпись');
    expect(clip.text.captions.shorts).toContain('Бот-администратор');
    expect(clip.summary).toContain('Клиент пишет в 2 ночи');
    expect(clip.actions).toEqual(['approve', 'edit', 'revise', 'reject', 'reschedule']);
    expect(firstOf(items, 'post').actions).toEqual(['approve', 'edit', 'revise', 'reject', 'publish_now', 'reschedule']);
  });

  it('approve of one held item decides only it (its core row is made, the pack stays); approving the pack approves the rest', async () => {
    const p = await packed({ cadence: NEW_PACK });
    const list = await p.items();
    const pack = list.find((i) => i.kind === 'content_pack')!;
    const clip = firstOf(list, 'reel');
    const r = await p.act(clip.id, { action: 'approve' });
    expect(r.status).toBe(200);
    expect(r.json.item.status).toBe('approved');
    expect(cstore(p).item(clip.meta.itemId)!.status).toBe('ready');
    expect((await p.item(pack.id)).status).toBe('pending');
    // again: nothing changes
    const n = (p.w.db.prepare("SELECT COUNT(*) n FROM decisions WHERE kind = 'content_item'").get() as any).n;
    expect((await p.act(clip.id, { action: 'approve' })).json.item.status).toBe('approved');
    expect((p.w.db.prepare("SELECT COUNT(*) n FROM decisions WHERE kind = 'content_item'").get() as any).n).toBe(n);
    // the opposite decision is refused
    const rej = await p.act(clip.id, { action: 'reject' });
    expect(rej.status).toBe(409);
    expect(rej.json.error).toBe('already_decided');
    // the pack: the other 16 are approved through it
    expect((await p.act(pack.id, { action: 'approve' })).json.item.status).toBe('approved');
    const after = (await p.items()).filter((i) => i.kind === 'content_item');
    expect(after.filter((i) => i.status === 'approved')).toHaveLength(17);
  });

  it('rejecting the pack rejects its items; a rejected item keeps the owner note', async () => {
    const p = await packed({ cadence: NEW_PACK });
    const list = await p.items();
    const one = list.find((i) => i.kind === 'content_item')!;
    expect((await p.act(one.id, { action: 'reject', note: 'не наш тон' })).json.item.status).toBe('rejected');
    expect(cstore(p).item(one.meta.itemId)).toMatchObject({ status: 'rejected', comment: 'не наш тон' });
    expect((await p.act(list.find((i) => i.kind === 'content_pack')!.id, { action: 'reject' })).json.item.status).toBe('rejected');
    const after = (await p.items()).filter((i) => i.kind === 'content_item');
    expect(after.every((i) => i.status === 'rejected')).toBe(true);
    expect(after.every((i) => i.actions.length === 0)).toBe(true);
  });

  it('an approved post has its pictures as site-proxied /admin/files paths with sizes; a failed render is told', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-renders-'));
    const p = await packed({ cadence: NEW_PACK, rendersDir: dir });
    const post = firstOf(await p.items(), 'post');
    const r = await p.act(post.id, { action: 'approve' });
    expect(r.json.item.status).toBe('approved');
    expect(r.json.item.media).toEqual([{ type: 'image', url: `/admin/files/${post.meta.itemId}/1.png`, poster: null, w: 1080, h: 1350, durationS: null }]);
    expect(r.json.item.meta.render.state).toBe('ready');
    expect(r.json.item.actions).toEqual(['publish_now', 'reschedule']);
  });
});

describe('Telegram stays in step with the center', () => {
  it('approve and reject from the center settle the Telegram card (edited in place, no decision buttons), through the same queue code', async () => {
    const p = reviewWorld();
    const lead = p.lead('Анна', { contact: '@anna' });
    const a = await p.propose('sales', 'lead_reply', { text: 'Привет', leadId: lead.id }, 'ответ', { release: true });
    const b = await p.propose('sales', 'prospect_first', { text: 'Добрый день', prospectId: 1, draftKind: 'first' }, 'холодное', { release: true });
    const coreA = p.w.hq.approvalLink(a.linkId)!.approvalId!;
    const coreB = p.w.hq.approvalLink(b.linkId)!.approvalId!;
    const cardA = p.w.queue.cardMessage(coreA)!;
    const cardB = p.w.queue.cardMessage(coreB)!;
    expect(cardA).toBeDefined();
    const journal = () => (p.w.db.prepare('SELECT COUNT(*) n FROM decisions').get() as any).n;
    const before = journal();
    expect((await p.act(a.id, { action: 'approve' })).json.item.status).toBe('approved');
    expect((await p.act(b.id, { action: 'reject' })).json.item.status).toBe('rejected');
    expect(journal()).toBe(before + 2);
    expect(p.executed.map((e) => e.kind)).toEqual(['lead_reply']);
    for (const [card, word] of [[cardA, /Одобрено/], [cardB, /Отклонено/]] as const) {
      const last = p.w.messenger.edits.filter((e) => e.messageId === card.messageId).at(-1);
      expect(last, 'the card was edited').toBeDefined();
      expect(last!.text).toMatch(word);
      expect(last!.buttons ?? []).toEqual([]);
    }
    // the same press in Telegram afterwards changes nothing
    expect(await p.w.queue.handle('approve', coreA, OWNER)).toBe('Уже обработано');
    expect(p.executed).toHaveLength(1);
  });

  it('a proposal that never went out as a card (still in the batch) is decided too: its row is made without a card and the task follows', async () => {
    const p = reviewWorld();
    const x = await p.propose('production', 'pm_spec', { text: 'ТЗ', projectId: p.seed.project().id }, 'ТЗ');
    expect(p.w.hq.approvalLink(x.linkId)!).toMatchObject({ state: 'queued', approvalId: null });
    const sent = p.w.messenger.sent.length;
    expect((await p.act(x.id, { action: 'approve' })).json.item.status).toBe('approved');
    expect(p.w.hq.approvalLink(x.linkId)!.state).toBe('executed');
    expect(p.w.messenger.sent.length).toBe(sent);
    expect(p.w.hq.task(x.taskId)!.status).toBe('done');
  });

  it('a failing execution is reported as ok:false failed and leaves the item failed', async () => {
    const p = reviewWorld();
    p.w.hq.registerKind('lead_reply', { initialLevel: 0, execute: () => Promise.reject(new Error('Telegram down')) });
    const x = await p.propose('sales', 'lead_reply', { text: 'Привет', leadId: 1 }, 's');
    const r = await p.act(x.id, { action: 'approve' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: false, error: 'failed', status: 'failed' });
    expect(r.json.item.status).toBe('failed');
    expect((await p.act(x.id, { action: 'approve' })).status).toBe(409);
  });
});

describe('edit: the owner replaces the text, version v+1 appears', () => {
  it('a content item: parts are replaced, v1 keeps the worker text, v2 is the owner; a note rides on the next version', async () => {
    const p = await packed({ cadence: NEW_PACK });
    const clip = firstOf(await p.items(), 'reel');
    const sentBefore = p.w.messenger.sent.length;
    let r = await p.act(clip.id, { action: 'edit', text: { captions: { tiktok: 'Новая подпись TikTok #fir' } } });
    expect(r.status).toBe(200);
    const it = r.json.item;
    expect(it.status).toBe('pending');
    expect(it.text.captions.tiktok).toBe('Новая подпись TikTok #fir');
    expect(it.text.captions.shorts).toContain('Бот-администратор');
    expect(it.currentVersion).toBe(2);
    expect(it.versions.map((v: any) => [v.v, v.author, v.note])).toEqual([[1, 'worker', ''], [2, 'owner', 'владелец']]);
    expect(it.versions[0].text.captions.tiktok).toContain('tt подпись');
    expect(it.versions[1].text.captions.tiktok).toBe('Новая подпись TikTok #fir');
    // the item row and the approval follow; the owner did not get a second card for his own action
    expect(cstore(p).item(clip.meta.itemId)!.text).toContain('Новая подпись TikTok #fir');
    expect(p.w.messenger.sent.length).toBe(sentBefore);
    expect((p.w.db.prepare("SELECT COUNT(*) n FROM decisions WHERE decision = 'edit'").get() as any).n).toBe(1);
    // again, with a note: v3
    r = await p.act(clip.id, { action: 'edit', note: 'короче хук', text: { caption: 'Подпись Instagram', hashtags: ['#fir', '#бот'] } });
    expect(r.json.item.currentVersion).toBe(3);
    expect(r.json.item.versions[2].note).toBe('владелец: короче хук');
    expect(r.json.item.text).toMatchObject({ caption: 'Подпись Instagram', hashtags: ['#fir', '#бот'] });
    expect(r.json.item.text.captions.instagram).toBe('Подпись Instagram\n#fir #бот');
    // the whole text, and the script part
    r = await p.act(clip.id, { action: 'edit', text: { body: 'Клип, 25 с: Свой заголовок' } });
    expect(r.json.item.text.body).toBe('Клип, 25 с: Свой заголовок');
    expect(r.json.item.text.captions.instagram).toBe('Подпись Instagram\n#fir #бот');
    expect(r.json.item.currentVersion).toBe(4);
  });

  it('refusals: no text, an empty or unchanged text, a platform part the item does not have, a decided item', async () => {
    const p = await packed({ cadence: NEW_PACK });
    const items = await p.items();
    const post = firstOf(items, 'post');
    expect((await p.act(post.id, { action: 'edit' })).status).toBe(400);
    expect((await p.act(post.id, { action: 'edit', text: { unknown: 'x' } })).status).toBe(400);
    const same = await p.act(post.id, { action: 'edit', text: { draft: post.text.draft } });
    expect(same.status).toBe(409);
    expect(same.json.error).toBe('not_applied');
    const noPart = await p.act(post.id, { action: 'edit', text: { captions: { tiktok: 'x' } } });
    expect(noPart.status).toBe(409);
    expect(noPart.json.error).toBe('not_applied');
    expect((await p.act(post.id, { action: 'edit', text: { draft: '  ' } })).status).toBe(409);
    await p.act(post.id, { action: 'approve' });
    const late = await p.act(post.id, { action: 'edit', text: { draft: 'поздно' } });
    expect(late.status).toBe(409);
    expect(late.json.error).toBe('not_pending');
    expect((await p.item(post.id)).currentVersion).toBe(1);
  });

  it('other kinds: the draft is replaced through the queue (the Telegram card shows the edited text), v2 is recorded', async () => {
    const p = reviewWorld();
    const lead = p.lead('Анна', { contact: '@anna' });
    const x = await p.propose('sales', 'lead_reply', { text: 'Привет, Анна', leadId: lead.id }, 'ответ', { release: true });
    const core = p.w.hq.approvalLink(x.linkId)!.approvalId!;
    const sent = p.w.messenger.sent.length;
    const r = await p.act(x.id, { action: 'edit', text: { draft: 'Здравствуйте, Анна! Свободны в среду.' } });
    expect(r.json.item.text.draft).toBe('Здравствуйте, Анна! Свободны в среду.');
    expect(r.json.item.versions.map((v: any) => v.text.draft)).toEqual(['Привет, Анна', 'Здравствуйте, Анна! Свободны в среду.']);
    expect(p.w.queue.get(core)).toMatchObject({ status: 'pending', edited: true, payload: { text: 'Здравствуйте, Анна! Свободны в среду.' } });
    expect(p.w.messenger.sent.length).toBe(sent);
    // approving it sends the edited text
    await p.act(x.id, { action: 'approve' });
    expect(p.executed.at(-1)!.payload.text).toBe('Здравствуйте, Анна! Свободны в среду.');
    // kinds without an editable text do not offer edit
    const pack = await p.propose('sales', 'referral_payout', { referralId: 1 }, 'выплата');
    expect((await p.act(pack.id, { action: 'edit', text: { draft: 'x' } })).json.error).toBe('not_applicable');
  });
});

describe('revise: the owner note goes to the worker, the answer is a new item with both versions', () => {
  it('creates a department task with the note and the original; the new card carries parentId and the combined versions; the original stays pending', async () => {
    const p = await packed({ cadence: NEW_PACK });
    const clip = firstOf(await p.items(), 'reel');
    expect((await p.act(clip.id, { action: 'revise' })).status).toBe(400);
    const r = await p.act(clip.id, { action: 'revise', note: 'короче хук, без слова «бот»' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, state: 'revising' });
    const task = p.w.hq.task(r.json.taskId)!;
    expect(task).toMatchObject({ dept: 'marketing', creator: 'owner', status: 'inbox' });
    expect(task.meta).toMatchObject({ action: 'revise_item', fromItemId: clip.meta.itemId, feedback: 'короче хук, без слова «бот»', reviseOf: clip.id });
    expect(task.meta.previous).toBe(cstore(p).item(clip.meta.itemId)!.text);
    expect(r.json.item.status).toBe('pending');
    expect(r.json.item.meta.revision).toEqual({ taskId: task.id, state: 'working', reviewId: null });
    // the department delivers
    await p.w.marketing.onHeartbeat();
    const all = await p.items();
    const child = all.find((i) => i.parentId === clip.id)!;
    expect(child).toBeDefined();
    expect(child).toMatchObject({ kind: 'content_item', status: 'pending', dept: 'marketing' });
    expect(child.meta.source).toBe('owner');
    expect(child.meta.itemId).not.toBe(clip.meta.itemId);
    expect(child.currentVersion).toBe(2);
    expect(child.versions.map((v: any) => [v.v, v.author])).toEqual([[1, 'worker'], [2, 'worker']]);
    expect(child.versions[0].note).toBe('');
    expect(child.versions[1].note).toBe('владелец: короче хук, без слова «бот»');
    expect(child.versions[0].text.body).toBe(clip.text.body);
    // the original is still with the owner and points to the new card; either can be decided
    const parent = all.find((i) => i.id === clip.id)!;
    expect(parent.status).toBe('pending');
    expect(parent.meta.revision).toMatchObject({ taskId: task.id, state: 'delivered', reviewId: child.id });
    expect(cstore(p).item(clip.meta.itemId)!.status).toBe('proposed');
    expect((await p.act(child.id, { action: 'approve' })).json.item.status).toBe('approved');
    expect((await p.act(clip.id, { action: 'reject' })).json.item.status).toBe('rejected');
  });

  it('is offered for reels, posts, carousels, stories and articles only while pending; an article is written again and the new card points back', async () => {
    const p = reviewWorld();
    const id = p.seed.article('Бот для салона');
    const x = await p.propose('marketing', 'article', { text: 'Превью статьи', articleId: id }, 'статья');
    const r = await p.act(x.id, { action: 'revise', note: 'добавь пример про барбершоп' });
    expect(r.json).toMatchObject({ ok: true, state: 'revising' });
    expect(r.json.item.status).toBe('rejected');
    const t = p.w.hq.tasks({ dept: 'marketing', limit: 20 }).find((x2) => x2.meta.action === 'article')!;
    expect(t.meta).toMatchObject({ articleId: id, feedback: 'добавь пример про барбершоп' });
    // the worker delivers a new card for the same article
    const y = await p.propose('marketing', 'article', { text: 'Превью статьи 2', articleId: id }, 'статья 2');
    const it = await p.item(y.id);
    expect(it.parentId).toBe(x.id);
    expect(it.versions.map((v: any) => v.v)).toEqual([1, 2]);
    expect(it.versions[0].text.draft).toBe('Превью статьи');
  });
});

/** A scripted Google (init gives a session URL, PUT gives the video id): the YouTube poster under the Publisher of the head. */
function googleMock() {
  const calls: { url: string; method?: string }[] = [];
  const mode = { putStatus: 200 };
  const post: PostFn = (url, o) => {
    calls.push({ url, ...(o.method ? { method: o.method } : {}) });
    const res = (r: SafePostResult) => Promise.resolve(r);
    if (url.includes('uploadType=resumable')) return res({ ok: true, status: 200, body: null, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=S1' } });
    return res(mode.putStatus !== 200 ? { ok: true, status: mode.putStatus, body: { error: { status: 'INTERNAL' } }, headers: {} } : { ok: true, status: 200, body: { id: 'vid123' }, headers: {} });
  };
  return { calls, post, mode };
}

/** A world whose Publisher has a YouTube poster on the scripted Google; reels are rendered to `dir` by the test. */
async function reelWorld(o: { youtube?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'review-reel-'));
  const g = googleMock();
  const ref: { w?: ReviewWorld['w'] } = {};
  const yt: PlatformPoster = {
    platform: 'shorts', canPost: (pack) => pack.files.some(isVideo),
    post: (pack) => new YouTubePoster({ auth: { accessToken: () => Promise.resolve('AT') }, store: new PublishStore(ref.w!.db), day: () => '2026-11-18', now: () => ref.w!.clock.t, post: g.post, readFile: () => new Uint8Array(10) }).post(pack),
  };
  const publisher = new PublisherWorker({ render: (itemId) => join(dir, String(itemId), 'reel.mp4'), ...(o.youtube === false ? {} : { posters: [yt] }) });
  const p = reviewWorld({ publisher, renderReels: true, rendersDir: dir, cadence: NEW_PACK });
  ref.w = p.w;
  p.w.hq.runRoutine('marketing-weekly-pack');
  await p.w.marketing.onHeartbeat();
  const clip = firstOf(await p.items(), 'reel');
  const approve = async () => {
    await p.act(clip.id, { action: 'approve' });
    mkdirSync(join(dir, String(clip.meta.itemId)), { recursive: true });
    writeFileSync(join(dir, String(clip.meta.itemId), 'reel.mp4'), 'mp4');
  };
  return { ...p, dir, g, clip, approve, store: () => new PublishStore(p.w.db) };
}

describe('publish_now', () => {
  it('a reel: Shorts through the YouTube poster, Instagram and TikTok into the Mac queue (queued=1), the answer says queued with the Shorts url', async () => {
    const r = await reelWorld();
    expect(r.clip.actions).not.toContain('publish_now'); // pending reel: its video does not exist yet
    await r.approve();
    const approved = await r.item(r.clip.id);
    expect(approved.status).toBe('approved');
    expect(approved.media).toEqual([{ type: 'video', url: `/admin/files/${r.clip.meta.itemId}/reel.mp4`, poster: null, w: 1080, h: 1920, durationS: 28 }]);
    expect(approved.meta.render.state).toBe('ready');
    expect(approved.actions).toEqual(['publish_now', 'reschedule']);
    const out = await r.act(r.clip.id, { action: 'publish_now' });
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({ ok: true, state: 'queued', url: 'https://youtube.com/shorts/vid123' });
    expect(out.json.results).toEqual([
      { platform: 'instagram', state: 'queued' }, { platform: 'tiktok', state: 'queued' }, { platform: 'shorts', state: 'published', url: 'https://youtube.com/shorts/vid123' },
    ]);
    // YouTube: the resumable upload ran once, the quota was booked, the row is published exactly as the morning run would mark it
    expect(r.g.calls.map((c) => c.method ?? 'POST')).toEqual(['POST', 'PUT']);
    expect(r.store().quotaUsed('2026-11-18')).toBe(1600);
    expect(out.json.item.meta.publishedOn).toEqual(['shorts']);
    expect(out.json.item.meta.publishedUrl).toBe('https://youtube.com/shorts/vid123');
    // the Mac helper reads them from the queue the owner's morning flow uses
    expect(out.json.item.meta.macQueued).toEqual(['instagram', 'tiktok']);
    const q = await r.call('GET', '/admin/content?queued=1&week=2026-W48');
    const queued = [...q.json.queuedItems, ...q.json.days.flatMap((d: any) => d.items)].find((i: any) => i.id === r.clip.meta.itemId);
    expect(queued.macQueued).toEqual(['instagram', 'tiktok']);
    // asking again publishes nothing twice: YouTube is skipped, the Mac rows are the same open rows
    const again = await r.act(r.clip.id, { action: 'publish_now' });
    expect(again.json.results.find((x: any) => x.platform === 'shorts')).toMatchObject({ state: 'skipped' });
    expect(r.g.calls).toHaveLength(2);
    expect((r.w.db.prepare("SELECT COUNT(*) n FROM mac_queue WHERE status = 'queued'").get() as any).n).toBe(2);
  });

  it('pending post: approved first (same queue path), then queued for the Mac; the answer carries the updated item', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-post-'));
    const p = await packed({ cadence: NEW_PACK, rendersDir: dir });
    const post = firstOf(await p.items(), 'post');
    const r = await p.act(post.id, { action: 'publish_now' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, state: 'queued', results: [{ platform: 'instagram', state: 'queued' }] });
    expect(r.json.item.status).toBe('approved');
    expect(r.json.item.meta.macQueued).toEqual(['instagram']);
    expect(p.w.queue.get(p.w.hq.approvalLink(Number(post.id.slice(3)))!.approvalId!)!.status).toBe('executed');
    expect((p.w.db.prepare("SELECT platform, agent_id FROM mac_queue WHERE item_id = ? AND status = 'queued'").all(post.meta.itemId) as any[])).toEqual([{ platform: 'instagram', agent_id: 'owner' }]);
  });

  it('a failed upload leaves the item failed with the reason, the error is in the answer; the retry works and clears it', async () => {
    const r = await reelWorld();
    await r.approve();
    r.g.mode.putStatus = 500;
    const out = await r.act(r.clip.id, { action: 'publish_now', platform: 'shorts' });
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({ ok: false, error: 'publish_failed', state: 'failed', results: [{ platform: 'shorts', state: 'failed', quota: false }] });
    expect(out.json.message).toContain('YouTube: загрузка не удалась');
    expect(out.json.item).toMatchObject({ status: 'failed' });
    expect(out.json.item.error).toContain('YouTube: загрузка не удалась');
    expect(out.json.item.actions).toContain('publish_now');
    expect(out.json.item.meta.publishedOn).toEqual([]);
    // the morning routine would try again as today; so does the owner
    r.g.mode.putStatus = 200;
    const retry = await r.act(r.clip.id, { action: 'publish_now', platform: 'shorts' });
    expect(retry.json).toMatchObject({ ok: true, state: 'published', url: 'https://youtube.com/shorts/vid123' });
    expect(retry.json.item.error).toBeNull();
    expect(retry.json.item.status).toBe('approved');
  });

  it('the YouTube quota is checked like in the morning run: a spent day fails without a request', async () => {
    const r = await reelWorld();
    await r.approve();
    r.store().addQuota('2026-11-18', 8000);
    const out = await r.act(r.clip.id, { action: 'publish_now', platform: 'youtube' });
    expect(out.json).toMatchObject({ ok: false, error: 'publish_failed', results: [{ platform: 'shorts', state: 'failed', quota: true }] });
    expect(out.json.message).toContain('квота YouTube');
    expect(r.g.calls).toHaveLength(0);
  });

  it('without a YouTube poster: an explicit Shorts request is 409 not_configured, «all platforms» still queues the Mac ones and says manual for Shorts', async () => {
    const r = await reelWorld({ youtube: false });
    await r.approve();
    const one = await r.act(r.clip.id, { action: 'publish_now', platform: 'shorts' });
    expect(one.status).toBe(409);
    expect(one.json.error).toBe('not_configured');
    const all = await r.act(r.clip.id, { action: 'publish_now' });
    expect(all.json).toMatchObject({ ok: true, state: 'queued' });
    expect(all.json.results.find((x: any) => x.platform === 'shorts').state).toBe('manual');
    expect(all.json.results.filter((x: any) => x.state === 'queued').map((x: any) => x.platform)).toEqual(['instagram', 'tiktok']);
  });

  it('an article is published by its approval: the answer has its /blog url; a failed publication is told', async () => {
    const p = reviewWorld();
    const id = p.seed.article('Бот для салона');
    p.w.hq.registerKind('article', { initialLevel: 0, locked: true, execute: () => { cstore(p).publishArticle(id, { slug: 'bot-dlya-salona', json: '{}', date: '2026-11-18' }); return Promise.resolve(); } });
    const x = await p.propose('marketing', 'article', { text: 'Превью', articleId: id }, 'статья');
    expect((await p.item(x.id)).actions).toEqual(['approve', 'revise', 'reject', 'publish_now']);
    const r = await p.act(x.id, { action: 'publish_now' });
    expect(r.json).toMatchObject({ ok: true, state: 'published', url: '/blog/bot-dlya-salona' });
    expect(r.json.item).toMatchObject({ status: 'published', actions: [] });
    expect(r.json.item.meta.url).toBe('/blog/bot-dlya-salona');
    // a publication that did not happen (the approval ran but the article is not live) is a failure, not a success
    const id2 = p.seed.article('Другая');
    p.w.hq.registerKind('article', { initialLevel: 0, locked: true, execute: () => Promise.resolve() });
    const y = await p.propose('marketing', 'article', { text: 'Превью 2', articleId: id2 }, 'статья 2');
    const bad = await p.act(y.id, { action: 'publish_now' });
    expect(bad.json).toMatchObject({ ok: false, error: 'publish_failed', state: 'failed' });
  });

  it('a profile kit is not published from here; neither is anything that is rejected or published', async () => {
    const p = await packed({ cadence: NEW_PACK });
    p.w.hq.createTask({ title: 'kit', dept: 'marketing', creator: 'owner', meta: { action: 'profile', platform: 'instagram' } });
    await p.w.marketing.onHeartbeat();
    const kit = (await p.items()).find((i) => i.kind === 'content_item' && i.meta.format === 'profile')!;
    expect(kit).toBeDefined();
    expect(kit.actions).toEqual(['approve', 'edit', 'reject', 'reschedule']);
    expect(kit.text.kit).toEqual({ instagram: expect.any(String), youtube: '', tiktok: '' });
    expect((await p.act(kit.id, { action: 'publish_now' })).json.error).toBe('not_applicable');
  });
});

describe('reschedule, send, call and the error answers', () => {
  it('reschedule moves the planned day of an item (text of the slot, the day is used); bad slots are 400, published items cannot move', async () => {
    const p = await packed({ cadence: NEW_PACK });
    const post = firstOf(await p.items(), 'post');
    expect((await p.act(post.id, { action: 'reschedule' })).status).toBe(400);
    for (const bad of ['завтра', '2026-13-40', '2026-02-30']) expect((await p.act(post.id, { action: 'reschedule', slot: bad })).status, bad).toBe(400);
    const r = await p.act(post.id, { action: 'reschedule', slot: '2026-11-27T09:00+05:00' });
    expect(r.json.item.meta).toMatchObject({ slot: '2026-11-27', plannedDate: '2026-11-27' });
    expect(cstore(p).item(post.meta.itemId)!.plannedDate).toBe('2026-11-27');
    // after approval the ready rows move with it
    await p.act(post.id, { action: 'approve' });
    await p.act(post.id, { action: 'reschedule', slot: '2026-11-28' });
    expect(cstore(p).rowsOfItem(post.meta.itemId).every((row) => row.plannedDate === '2026-11-28')).toBe(true);
    // a lead reply has no slot
    const x = await p.propose('sales', 'lead_reply', { text: 'Привет', leadId: 1 }, 'ответ');
    expect((await p.act(x.id, { action: 'reschedule', slot: '2026-11-27' })).json.error).toBe('not_applicable');
  });

  it('send: the draft (or the owner text) goes out through the approval path; telegram leads get it from the bot, the answer says how', async () => {
    const p = reviewWorld();
    p.w.hq.registerKind('lead_reply', { initialLevel: 0, execute: (payload) => (payload.chatId !== undefined ? p.toClient.push({ chatId: Number(payload.chatId), text: String(payload.text) }) : 0, Promise.resolve()) });
    const lead = p.lead('Анна', { contact: '@anna', meta: { chatId: 777 } });
    const tg = await p.propose('sales', 'lead_reply', { text: 'Привет, Анна', leadId: lead.id, chatId: 777 }, 'ответ', { release: true });
    const r = await p.act(tg.id, { action: 'send', text: { draft: 'Привет, Анна! Записал вас на среду.' } });
    expect(r.json).toMatchObject({ ok: true, state: 'sent', via: 'telegram' });
    expect(r.json.item.status).toBe('approved');
    expect(p.toClient).toEqual([{ chatId: 777, text: 'Привет, Анна! Записал вас на среду.' }]);
    expect(r.json.item.versions.map((v: any) => v.author)).toEqual(['worker', 'owner']);
    // a lead without a chat: handed to the owner to forward
    const web = await p.propose('sales', 'lead_reply', { text: 'Добрый день', leadId: lead.id }, 'ответ 2');
    expect((await p.act(web.id, { action: 'send' })).json).toMatchObject({ ok: true, state: 'handed_off', via: 'owner' });
    // sending twice is refused: not pending any more
    expect((await p.act(web.id, { action: 'send' })).status).toBe(409);
  });

  it('send refuses a draft with an unfilled placeholder (price, money, support answer)', async () => {
    const p = reviewWorld();
    const price = await p.propose('sales', 'lead_price', { text: 'Стоимость [цена] за [срок].', leadId: 1 }, 'цена');
    const r = await p.act(price.id, { action: 'send' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'placeholder', placeholders: ['[цена]', '[срок]'] });
    expect(p.executed).toHaveLength(0);
    const ok2 = await p.act(price.id, { action: 'send', text: { draft: 'Стоимость 500 долларов за 2 недели.' } });
    expect(ok2.json).toMatchObject({ ok: true });
    expect(p.executed).toHaveLength(1);
    expect(p.executed[0]!.payload.text).toBe('Стоимость 500 долларов за 2 недели.');
  });

  it('call sets the call slot of the lead through the existing call path, on a lead card in any state', async () => {
    const p = reviewWorld();
    const lead = p.lead('Анна', { contact: '@anna' });
    const x = await p.propose('sales', 'lead_reply', { text: 'Привет', leadId: lead.id }, 'ответ');
    expect((await p.act(x.id, { action: 'call' })).status).toBe(400);
    expect((await p.act(x.id, { action: 'call', slot: 'завтра в 10' })).status).toBe(400);
    const r = await p.act(x.id, { action: 'call', slot: '2026-11-24T10:00:00Z' });
    expect(r.json).toMatchObject({ ok: true, callAt: '2026-11-24T10:00:00.000Z' });
    expect((p.w.db.prepare('SELECT chosen_slot FROM li_leads WHERE id = ?').get(lead.id) as any).chosen_slot).toBe(Date.parse('2026-11-24T10:00:00Z'));
    expect(r.json.item.meta.lead.callAt).toBe('2026-11-24T10:00:00.000Z');
    await p.act(x.id, { action: 'reject' });
    expect((await p.act(x.id, { action: 'call', slot: '2026-11-25T10:00:00Z' })).json.ok).toBe(true);
    const doc = await p.propose('backoffice', 'bo_document', { text: 'Договор', docId: p.seed.doc().id }, 'док');
    expect((await p.act(doc.id, { action: 'call', slot: '2026-11-25T10:00:00Z' })).json.error).toBe('not_applicable');
  });

  it('errors: unknown id 404, bad body 400, an action the item does not offer 409 with the list, a decided item 409', async () => {
    const p = reviewWorld();
    expect((await p.act('ap_999', { action: 'approve' })).status).toBe(404);
    expect((await p.act('x1', { action: 'approve' })).status).toBe(404);
    const x = await p.propose('production', 'pm_spec', { text: 'ТЗ', projectId: p.seed.project().id }, 'ТЗ');
    for (const bad of [{}, { action: 'burn' }, { action: 'approve', extra: 1 }, { action: 'approve', note: '' }]) expect((await p.act(x.id, bad)).status, JSON.stringify(bad)).toBe(400);
    const na = await p.act(x.id, { action: 'publish_now' });
    expect(na.status).toBe(409);
    expect(na.json).toMatchObject({ error: 'not_applicable', status: 'pending', actions: ['approve', 'edit', 'reject'] });
    await p.act(x.id, { action: 'approve' });
    expect((await p.act(x.id, { action: 'reject' })).json).toMatchObject({ error: 'already_decided', status: 'approved' });
    expect((await p.act(x.id, { action: 'revise', note: 'x' })).json.error).toBe('not_pending');
    expect((await p.item(x.id)).actions).toEqual([]);
  });
});

describe('auto-executed kinds (level 1) are history, not work', () => {
  it('shows an approved item with no actions; the counters ignore it', async () => {
    const p = reviewWorld({}, { keepLevels: true });
    const t = p.w.hq.createTask({ title: 't', dept: 'support', creator: 'head' });
    await p.w.hq.requestApproval(t.id, 'support-head', 'support_answer', { text: 'Ответ', ticketId: 1, contact: '', name: 'Анна' }, 'ответ');
    const list = await p.items();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'approved', actions: [] });
    expect((await p.call('GET', '/admin/review')).json.items).toEqual([]);
    expect((await p.call('GET', '/admin/review')).json.counts.support).toBe(0);
  });
});
