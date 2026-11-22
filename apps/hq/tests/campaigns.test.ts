/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import type { Tools } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { createAdmin } from '../src/admin.js';
import { Campaigns, CAMPAIGN_KIND } from '../src/campaigns.js';
import { ClientMail } from '../src/client-mail.js';
import { OWNER, world } from './helpers.js';

const SECRET = 'shared-unsubscribe-secret-0001';

function setup(max?: number) {
  const w = world({ presence: true });
  const sent: { to: string; subject: string; text: string; headers?: Record<string, string> }[] = [];
  const tools = { can: () => true, email: { send: (m: any) => { sent.push(m); return Promise.resolve({ ok: true, value: { id: 'x' } }); } } } as unknown as Tools;
  const mail = new ClientMail({ hq: w.hq, tools: () => tools, siteUrl: 'https://firtech.pro/', unsubscribeSecret: SECRET });
  const campaigns = new Campaigns({ hq: w.hq, mail, ...(max ? { maxRecipients: max } : {}) });
  const admin = createAdmin({ hq: w.hq, queue: w.queue, director: w.director, channel: w.channel!, ownerId: OWNER, now: () => w.clock.t, commandNames: [], campaigns });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await admin.handle({ method, path, query: new URLSearchParams(), body });
    return { status: r.status, json: r.body as Record<string, any> };
  };
  const client = async (n: number, consent: { marketingConsent?: boolean; recommendationsConsent?: boolean }) => {
    const r = await call('POST', '/admin/clients', { email: `c${n}@example.com`, name: `К${n}`, locale: 'ru', supabaseId: `uid-${n}`, ...consent });
    return r.json.client.id as number;
  };
  const approvalOf = (campaignId: number) => w.queue.pending().find((r) => r.kind === CAMPAIGN_KIND && r.payload.campaignId === campaignId)!.id;
  const draft = (over: Record<string, unknown> = {}) => call('POST', '/admin/campaigns', { kind: 'news', subject: 'Новости студии', text: 'Мы запустили новый продукт.', ...over });
  return { w, call, client, sent, draft, approvalOf, campaigns };
}

describe('a mailing stuck in sending after a restart', () => {
  it('is marked failed on start with the journal counts and the owner is told', async () => {
    const { client, draft, w, approvalOf, campaigns, call } = setup();
    const c1 = await client(1, { marketingConsent: true });
    const id = (await draft()).json.campaign.id as number;
    w.hq.db.prepare("UPDATE cab_campaigns SET status = 'sending' WHERE id = ?").run(id);
    w.hq.db.prepare("INSERT INTO cab_campaign_log (campaign_id, client_id, outcome, at) VALUES (?, ?, 'email', 1)").run(id, c1);
    void approvalOf;
    const again = new Campaigns({ hq: w.hq, mail: (campaigns as any).d.mail });
    expect(again.recoverStuck()).toBe(0); // the constructor already closed it
    const r = await call('GET', `/admin/campaigns/${id}`);
    expect(r.json.campaign).toMatchObject({ status: 'failed', counts: { email: 1 } });
  });
});

describe('mailings go only through the owner\'s approval', () => {
  it('a draft sends nothing; the card waits as a locked approval', async () => {
    const { client, draft, sent, w } = setup();
    await client(1, { marketingConsent: true });
    const r = await draft();
    expect(r.status).toBe(200);
    expect(r.json.campaign).toMatchObject({ kind: 'news', status: 'pending', counts: {} });
    expect(r.json.audience).toBe(1);
    expect(sent).toHaveLength(0);
    expect(w.queue.pending().filter((x) => x.kind === CAMPAIGN_KIND)).toHaveLength(1);
    expect(w.queue.isLocked(CAMPAIGN_KIND)).toBe(true);
  });

  it('after approval the letter goes with List-Unsubscribe; a rejected mailing sends nothing', async () => {
    const { client, draft, sent, w, approvalOf } = setup();
    await client(1, { marketingConsent: true });
    const a = (await draft()).json.campaign.id;
    await w.decide('approve', approvalOf(a));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers!['List-Unsubscribe']).toMatch(/unsubscribe\?token=/);
    expect(sent[0]!.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const b = (await draft({ subject: 'Другое' })).json.campaign.id;
    await w.decide('reject', approvalOf(b));
    expect(sent).toHaveLength(1);
  });

  it('no consent, no letter: only clients with the matching consent are written to', async () => {
    const { client, draft, sent, w, approvalOf, call } = setup();
    const news = await client(1, { marketingConsent: true });
    await client(2, { recommendationsConsent: true });
    await client(3, {});
    const id = (await draft()).json.campaign.id;
    await w.decide('approve', approvalOf(id));
    expect(sent.map((m) => m.to)).toEqual(['c1@example.com']);
    const d = (await call('GET', `/admin/campaigns/${id}`)).json;
    expect(d.campaign).toMatchObject({ status: 'sent', counts: { email: 1 } });
    expect(d.log).toEqual([expect.objectContaining({ clientId: news, outcome: 'email' })]);
    expect(JSON.stringify(d.log)).not.toMatch(/example\.com|Мы запустили/);
    // recommendations go to the other client only
    const rid = (await draft({ kind: 'recommendation' })).json.campaign.id;
    await w.decide('approve', approvalOf(rid));
    expect(sent.map((m) => m.to)).toEqual(['c1@example.com', 'c2@example.com']);
  });

  it('a consent withdrawn between the draft and the approval is respected', async () => {
    const { client, draft, sent, w, approvalOf, call } = setup();
    const c = await client(1, { marketingConsent: true });
    await client(2, { marketingConsent: true });
    const id = (await draft()).json.campaign.id;
    await call('POST', `/admin/clients/${c}`, { marketingConsent: false });
    await w.decide('approve', approvalOf(id));
    expect(sent.map((m) => m.to)).toEqual(['c2@example.com']);
  });

  it('no recipients with consent: the draft is refused', async () => {
    const { client, draft } = setup();
    await client(1, {});
    expect((await draft()).json).toMatchObject({ ok: false, error: 'no_recipients' });
  });

  it('a second approval of the same mailing sends nothing again', async () => {
    const { client, draft, sent, w, approvalOf, campaigns } = setup();
    await client(1, { marketingConsent: true });
    const id = (await draft()).json.campaign.id;
    const ap = approvalOf(id);
    await w.decide('approve', ap);
    await w.decide('approve', ap);
    expect(sent).toHaveLength(1);
    // even a direct second run of the action (a retry, a second card) does nothing
    await campaigns.execute({ campaignId: id, text: 'x' });
    expect(sent).toHaveLength(1);
  });

  it('the recipient cap per mailing: the rest are counted, not written to', async () => {
    const { client, draft, sent, w, approvalOf, call } = setup(2);
    for (let i = 1; i <= 5; i++) await client(i, { marketingConsent: true });
    const id = (await draft()).json.campaign.id;
    await w.decide('approve', approvalOf(id));
    expect(sent).toHaveLength(2);
    expect((await call('GET', '/admin/campaigns')).json.items[0].counts).toEqual({ email: 2, capped: 3 });
  });

  it('the owner\'s edit of the text is what goes out', async () => {
    const { client, draft, sent, w, approvalOf } = setup();
    await client(1, { marketingConsent: true });
    const id = (await draft()).json.campaign.id;
    const ap = approvalOf(id);
    await w.queue.applyEdit(ap, 'Исправленный текст');
    await w.decide('approve', ap);
    expect(sent[0]!.text).toContain('Исправленный текст');
    expect(sent[0]!.text).not.toContain('Мы запустили');
  });

  it('locked: twenty-one approvals in a row never make the kind automatic or bulk', async () => {
    const { client, draft, sent, w, approvalOf } = setup();
    await client(1, { marketingConsent: true });
    for (let i = 0; i < 21; i++) {
      const id = (await draft({ subject: `Новости ${i}` })).json.campaign.id;
      await w.decide('approve', approvalOf(id));
    }
    expect(sent).toHaveLength(21);
    expect(w.queue.level(CAMPAIGN_KIND)).toBe(0);
    const next = (await draft()).json.campaign.id;
    expect(w.queue.isBulk(CAMPAIGN_KIND)).toBe(false);
    await w.queue.approveAll(OWNER);
    expect(sent).toHaveLength(21);
    expect(w.queue.get(approvalOf(next))!.status).toBe('pending');
  });

  it('validates the body', async () => {
    const { client, call } = setup();
    await client(1, { marketingConsent: true });
    for (const bad of [{}, { kind: 'project', subject: 'a', text: 'b' }, { kind: 'news', subject: '', text: 'b' }, { kind: 'news', subject: 'a', text: 'b', x: 1 }]) {
      expect((await call('POST', '/admin/campaigns', bad)).json).toMatchObject({ ok: false, error: 'invalid' });
    }
  });
});
