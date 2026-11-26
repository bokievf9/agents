import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { MockLlm, type LlmRequest } from '@fir/core';
import { leadStoreFor } from '@fir/worker-lead-intake';
import { describe, expect, it } from 'vitest';
import { createAdmin } from '../src/admin.js';
import { Director } from '../src/director.js';
import { OwnerChannel } from '../src/presence.js';
import { createOwnerLead, OWNER_CONTACT, ownerLeadSchema } from '../src/owner-lead.js';
import { Reporter } from '../src/reporter.js';
import { createWebhook, webLeadSchema } from '../src/webhook.js';
import { chainWorld, type W } from './chain-helpers.js';
import { OWNER } from './helpers.js';

const TOKEN = 'adm-tok';
const J = JSON.stringify;

async function start(w: W) {
  const channel = new OwnerChannel({ hq: w.hq, inner: w.messenger, ownerId: OWNER, approvalPending: () => false, onCardSent: () => undefined });
  const admin = createAdmin({
    hq: w.hq, queue: w.queue, director: w.director, channel, ownerId: OWNER, now: () => w.clock.t, commandNames: [],
    ownerLead: (i) => createOwnerLead({ hq: w.hq, sales: w.sales }, i),
  });
  const server = createWebhook(() => Promise.resolve(0), undefined, Date.now, undefined, undefined, { token: TOKEN, handle: (r) => admin.handle(r) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (body: unknown, token: string | null = TOKEN) => {
    const r = await fetch(`${url}/admin/leads/owner`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-admin-token': token } : {}) }, body: J(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  return { call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('POST /admin/leads/owner', () => {
  it('401 without the admin token, 400 for a bad or unknown body', async () => {
    const w = chainWorld();
    const h = await start(w);
    expect((await h.call({ name: 'Ali', need: 'сайт' }, null)).status).toBe(401);
    expect((await h.call({ name: 'Ali', need: 'сайт' }, 'wrong')).status).toBe(401);
    for (const bad of [{}, { name: '', need: 'x' }, { name: 'Ali' }, { name: 'Ali', need: '' }, { name: 'Ali', need: 'x', extra: 1 }, { name: 'Ali', need: 'x', links: ['ftp://a.b'] },
      { name: 'Ali', need: 'x', links: ['javascript:alert(1)'] }, { name: 'Ali', need: 'x', links: Array.from({ length: 11 }, () => 'https://a.b') }, { name: 'Ali', need: 'x'.repeat(4001) }]) {
      expect((await h.call(bad)).status, J(bad).slice(0, 60)).toBe(400);
    }
    expect(w.hq.tasks({ dept: 'sales' })).toHaveLength(0);
    await h.close();
  });

  it('success: a Sales task with source owner, the lead row, {ok, id, leadId}', async () => {
    const w = chainWorld();
    const h = await start(w);
    const r = await h.call({ name: 'Cafe Navat', need: 'Нужен бот для приёма заказов', links: ['https://navat.example'] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, id: 1, leadId: 1 });
    const t = w.hq.task(1)!;
    expect(t).toMatchObject({ dept: 'sales', title: 'Клиент от владельца (unknown)', meta: { action: 'lead', lead: { source: 'owner', fromOwner: true } } });
    expect(leadStoreFor({ db: w.db, now: w.hq.now }).get(1)).toMatchObject({ origin: 'owner', name: 'Cafe Navat' });
    await h.close();
  });

  it('a public lead cannot claim the owner label through the site webhook schema', () => {
    expect(webLeadSchema.parse({ name: 'x', contact: 'abc', source: 'owner' }).source).toBe('');
    expect(webLeadSchema.parse({ name: 'x', contact: 'abc', source: 'ref:abc' }).source).toBe('ref:abc');
  });

  it('idempotent by clientRef: the same ref returns the same ids and creates nothing new', async () => {
    const w = chainWorld();
    const h = await start(w);
    const a = await h.call({ name: 'Ali', need: 'сайт', clientRef: 'chat-2026-11-26-ali' });
    const b = await h.call({ name: 'Ali', need: 'сайт (повтор)', clientRef: 'chat-2026-11-26-ali' });
    expect(b.json).toEqual(a.json);
    expect(w.hq.tasks({ dept: 'sales' })).toHaveLength(1);
    const c = await h.call({ name: 'Ali', need: 'сайт', clientRef: 'other' });
    expect(c.json.id).not.toBe(a.json.id);
    await h.close();
  });
});

describe('owner lead through the funnel', () => {
  it('no contact: delivery channel owner, Sales qualifies, the КП goes to approvals, the reply is handed to the owner to forward', async () => {
    const w = chainWorld();
    const r = createOwnerLead({ hq: w.hq, sales: w.sales }, ownerLeadSchema.parse({ name: 'Dilnoza', need: 'Нужен бот для записи в салон красоты' }));
    expect(r.deliveryChannel).toBe('owner');
    expect(w.hq.task(r.id)!.meta.lead).toMatchObject({ deliveryChannel: 'owner', contact: OWNER_CONTACT });
    await w.beat(); // lead intake: reply approval, afterLead qualifies and starts the КП
    const lead = leadStoreFor({ db: w.db, now: w.hq.now }).byTask(r.id)!;
    expect(lead).toMatchObject({ id: r.leadId, origin: 'owner', contact: OWNER_CONTACT });
    expect(w.hq.reports(0).some((x) => x.body.includes('квалифицирован'))).toBe(true);
    expect(w.hq.tasks({ dept: 'sales' }).some((t) => t.meta.action === 'kp' && t.meta.leadId === lead.id)).toBe(true);
    await w.beat(); // the КП task
    await w.director.sendApprovalBatch(false);
    // the price path: the locked КП pack waits for the owner, as for a site lead
    expect(w.queue.pending().some((p) => p.kind === 'presales_pack')).toBe(true);
    // the first reply was handed to the owner (level 1), told to forward it himself, no Telegram to a client
    const msg = w.messenger.sent.find((m) => m.text.includes('ответ утверждён'))!;
    expect(msg.chatId).toBe(OWNER);
    expect(msg.text).toContain('перешлите клиенту Dilnoza сами');
  });

  it('with a contact: normal handling, the owner gets the contact in the hand-off', async () => {
    const w = chainWorld();
    const r = createOwnerLead({ hq: w.hq, sales: w.sales }, ownerLeadSchema.parse({ name: 'Blanche', need: 'Сайт для кофейни', contact: '@blanche' }));
    expect(r.deliveryChannel).toBe('contact');
    expect(w.hq.task(r.id)!.meta.lead).not.toHaveProperty('deliveryChannel');
    await w.beat();
    const msg = w.messenger.sent.find((m) => m.text.includes('ответ утверждён'))!;
    expect(msg.text).toContain('@blanche');
    expect(leadStoreFor({ db: w.db, now: w.hq.now }).byTask(r.id)).toMatchObject({ contact: '@blanche', origin: 'owner' });
  });
});

describe('Director: «новый клиент от меня»', () => {
  const directorFor = (w: W, intent: (text: string) => string) => {
    const llm = new MockLlm((req: LlmRequest) => (req.system.includes('Разбери сообщение владельца') ? intent(req.messages[0]!.content as string) : 'not json'));
    const d = new Director({ hq: w.hq, llm, messenger: w.messenger, queue: w.queue, ownerId: OWNER, reporter: new Reporter(undefined, {}, new Map()) });
    d.onOwnerLead = (lead) => {
      const r = createOwnerLead({ hq: w.hq, sales: w.sales }, ownerLeadSchema.parse(lead));
      return Promise.resolve(`записан: лид #${r.leadId}`);
    };
    return d;
  };

  it('the phrase becomes a lead through the shared function and the owner sees the lead id', async () => {
    const w = chainWorld();
    const d = directorFor(w, () => J({ type: 'owner_lead', name: 'Кофейня Нават', need: 'бот для заказов', contact: '@navat', links: ['https://navat.example', 'javascript:x'] }));
    await d.onText('новый клиент от меня: Кофейня Нават, нужен бот для заказов, @navat, https://navat.example');
    const t = w.hq.tasks({ dept: 'sales' })[0]!;
    expect(t.meta.lead).toMatchObject({ source: 'owner', name: 'Кофейня Нават', contact: '@navat' });
    expect(w.messenger.last()!.text).toContain('лид #1');
  });

  it('a missing need asks one question and creates nothing', async () => {
    const w = chainWorld();
    const d = directorFor(w, () => J({ type: 'unknown', question: 'что нужно клиенту?' }));
    await d.onText('новый клиент от меня: Али');
    expect(w.hq.tasks({ dept: 'sales' })).toHaveLength(0);
    expect(w.messenger.last()!.text).toContain('что нужно клиенту?');
  });
});
