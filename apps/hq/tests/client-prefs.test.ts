/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { LeadStore, legalLabel, legalPartyOfLead } from '@fir/worker-lead-intake';
import type { Tools } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { createAdmin } from '../src/admin.js';
import { ClientMail } from '../src/client-mail.js';
import { channelsFor, unsubscribeToken, verifyUnsubscribeToken } from '../src/client-prefs.js';
import { OWNER, world } from './helpers.js';

const SECRET = 'shared-unsubscribe-secret-0001';
const UID = '3f2c1e0a-1111-4222-8333-444455556666';

function setup() {
  const w = world({ presence: true });
  const t = () => w.clock.t;
  const admin = createAdmin({ hq: w.hq, queue: w.queue, director: w.director, channel: w.channel!, ownerId: OWNER, now: t, commandNames: [] });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await admin.handle({ method, path, query: new URLSearchParams(), body });
    return { status: r.status, json: r.body as Record<string, any> };
  };
  const reg = (over: Record<string, unknown> = {}) => call('POST', '/admin/clients', { email: 'alice@example.com', name: 'Алиса', locale: 'ru', supabaseId: UID, ...over });
  const sent: { to: string; subject: string; text: string; headers?: Record<string, string> }[] = [];
  const tools = { can: () => true, email: { send: (m: any) => { sent.push(m); return Promise.resolve({ ok: true, value: { id: 'x' } }); } } } as unknown as Tools;
  const mail = (...args: [] | [string | undefined]) => new ClientMail({ hq: w.hq, tools: () => tools, siteUrl: 'https://firtech.pro/', unsubscribeSecret: args.length ? args[0] : SECRET });
  return { w, call, reg, sent, mail };
}

describe('profile v2: POST /admin/clients/:id takes the new fields', () => {
  it('saves consents, channel, niche, website, city, legal name and address, refund wallet; the answer carries them; empty clears', async () => {
    const { reg, call } = setup();
    const id = (await reg()).json.client.id;
    const r = await call('POST', `/admin/clients/${id}`, {
      marketingConsent: true, recommendationsConsent: true, notifyChannel: 'both', niche: 'salon', website: 'https://rose.example', city: 'Душанбе',
      legalName: 'ООО Ромашка', legalAddress: 'Душанбе, ул. Рудаки 1', refundWallet: 'TXyz123',
    });
    expect(r.status).toBe(200);
    expect(r.json.client).toMatchObject({
      marketingConsent: true, recommendationsConsent: true, notifyChannel: 'both', niche: 'salon', website: 'https://rose.example', city: 'Душанбе',
      legalName: 'ООО Ромашка', legalAddress: 'Душанбе, ул. Рудаки 1', refundWallet: 'TXyz123',
    });
    const off = await call('PATCH', `/admin/clients/${id}`, { marketingConsent: false, legalAddress: '', website: '' });
    expect(off.json.client).toMatchObject({ marketingConsent: false, recommendationsConsent: true, legalName: 'ООО Ромашка', legalAddress: '', website: '', notifyChannel: 'both' });
  });

  it('refuses a wrong channel, a non-URL website and over-long fields; nothing is written', async () => {
    const { reg, call } = setup();
    const id = (await reg()).json.client.id;
    for (const bad of [{ notifyChannel: 'sms' }, { website: 'ftp://x.y' }, { website: 'not a url' }, { niche: 'n'.repeat(41) }, { city: 'c'.repeat(81) }, { legalName: 'l'.repeat(161) }, { legalAddress: 'a'.repeat(301) }, { refundWallet: 'w'.repeat(121) }, { marketingConsent: 'yes' }]) {
      expect((await call('POST', `/admin/clients/${id}`, bad)).json).toMatchObject({ ok: false, error: 'invalid' });
    }
    expect((await call('POST', `/admin/clients/${id}`, {})).json.client).toMatchObject({ niche: '', legalName: '', notifyChannel: 'email', marketingConsent: false });
  });
});

describe('profile v2: registration', () => {
  it('takes recommendationsConsent, notifyChannel, phone and company; a repeated registration without them keeps what the client chose', async () => {
    const { reg, call, w } = setup();
    const a = await reg({ marketingConsent: true, recommendationsConsent: true, notifyChannel: 'telegram', phone: '+992900000000', company: 'Роза' });
    expect(a.json.client).toMatchObject({ marketingConsent: true, recommendationsConsent: true, notifyChannel: 'telegram', phone: '+992900000000', company: 'Роза' });
    await call('POST', `/admin/clients/${a.json.client.id}`, { marketingConsent: false });
    const again = await reg();
    expect(again.json.client).toMatchObject({ marketingConsent: false, recommendationsConsent: true, notifyChannel: 'telegram', phone: '+992900000000', company: 'Роза' });
    const row = w.hq.db.prepare('SELECT recommendations_consent r, notify_channel c FROM cab_clients').get() as any;
    expect(row).toEqual({ r: 1, c: 'telegram' });
    expect((await reg({ email: 'b@example.com', supabaseId: 'x2', notifyChannel: 'pigeon' })).json).toMatchObject({ ok: false, error: 'invalid' });
  });
});

describe('letters respect the client\'s settings', () => {
  it('news only with marketingConsent, recommendations only with recommendationsConsent; no consent, no letter', async () => {
    const { reg, call, mail, sent } = setup();
    const id = (await reg()).json.client.id;
    const n = { subject: { ru: 'Новости', en: 'News' }, text: { ru: 'Привет', en: 'Hi' } };
    expect(await mail().sendCampaign(id, 'news', n, 'n1')).toBe('no_consent');
    expect(await mail().sendCampaign(id, 'recommendation', n, 'r1')).toBe('no_consent');
    await call('POST', `/admin/clients/${id}`, { marketingConsent: true });
    expect(await mail().sendCampaign(id, 'recommendation', n, 'r1')).toBe('no_consent');
    expect(await mail().sendCampaign(id, 'news', n, 'n1')).toBe('email');
    await call('POST', `/admin/clients/${id}`, { marketingConsent: false, recommendationsConsent: true });
    expect(await mail().sendCampaign(id, 'news', n, 'n2')).toBe('no_consent');
    expect(await mail().sendCampaign(id, 'recommendation', n, 'r2')).toBe('email');
    expect(sent).toHaveLength(2);
  });

  it('every campaign letter has the unsubscribe link in the text and List-Unsubscribe plus One-Click headers, signed like the site', async () => {
    const { reg, call, mail, sent } = setup();
    const id = (await reg()).json.client.id;
    await call('POST', `/admin/clients/${id}`, { marketingConsent: true, recommendationsConsent: true });
    const n = { subject: { ru: 'Новости', en: 'News' }, text: { ru: 'Привет', en: 'Hi' } };
    await mail().sendCampaign(id, 'news', n, 'n1');
    await mail().sendCampaign(id, 'recommendation', n, 'r1');
    const [news, rec] = sent;
    const tokenOf = (m: typeof news) => decodeURIComponent(/token=([^>\s]+)/.exec(m!.headers!['List-Unsubscribe']!)![1]!);
    expect(news!.headers!['List-Unsubscribe']).toMatch(/^<https:\/\/firtech\.pro\/api\/cabinet\/unsubscribe\?token=/);
    expect(news!.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(news!.text).toContain(`Отписаться: https://firtech.pro/ru/cabinet/unsubscribe?token=${encodeURIComponent(tokenOf(news))}`);
    expect(verifyUnsubscribeToken(tokenOf(news), SECRET)).toEqual({ userId: UID, field: 'marketing' });
    expect(verifyUnsubscribeToken(tokenOf(rec), SECRET)).toEqual({ userId: UID, field: 'recommendations' });
    expect(verifyUnsubscribeToken(tokenOf(rec), 'another-secret-another-secret')).toBeNull();
    // the same formula the site uses (`firtech/src/lib/unsubscribe.ts`): a token made by hand matches
    expect(tokenOf(news)).toBe(unsubscribeToken(UID, 'marketing', SECRET));
  });

  it('without the shared secret (or too short) no news letter goes at all', async () => {
    const { reg, call, mail, sent } = setup();
    const id = (await reg()).json.client.id;
    await call('POST', `/admin/clients/${id}`, { marketingConsent: true });
    const n = { subject: { ru: 'a', en: 'a' }, text: { ru: 'b', en: 'b' } };
    expect(await mail(undefined).sendCampaign(id, 'news', n, 'n')).toBe('no_unsubscribe');
    expect(await mail('short').sendCampaign(id, 'news', n, 'n')).toBe('no_unsubscribe');
    expect(sent).toHaveLength(0);
  });

  it('letters about the project always go by email, unless the client chose Telegram and is linked to the bot', async () => {
    const { reg, call, w, mail, sent } = setup();
    const id = (await reg()).json.client.id;
    await call('POST', `/admin/clients/${id}`, { notifyChannel: 'telegram' });
    // not linked to the bot: the letter goes by email, never silence
    expect(channelsFor(w.hq.db, id, 'project')).toEqual({ email: true, telegram: false });
    expect(await mail().send(id, { subject: { ru: 'Этап готов', en: 'Stage ready' }, text: { ru: 'x', en: 'x' } }, 'stage', 'p1')).toBe('email');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers).toBeUndefined();
    w.hq.db.prepare('UPDATE cab_clients SET tg_chat_id = 777 WHERE id = ?').run(id);
    expect(channelsFor(w.hq.db, id, 'project')).toEqual({ email: false, telegram: true });
    await call('POST', `/admin/clients/${id}`, { notifyChannel: 'both' });
    expect(channelsFor(w.hq.db, id, 'project')).toEqual({ email: true, telegram: true });
    // news never go to Telegram
    expect(channelsFor(w.hq.db, id, 'news')).toEqual({ email: true, telegram: false });
  });
});

describe('legal name and address reach the papers', () => {
  it('the lead of a cabinet client gives its legal party; without a legal name there is none', async () => {
    const { reg, call, w } = setup();
    const id = (await reg()).json.client.id;
    new LeadStore(w.hq.db, () => w.clock.t);
    const task = w.hq.createTask({ title: 'Лид', dept: 'sales', creator: 'routine' });
    w.hq.db.prepare("INSERT INTO li_leads (task_id, name, contact, origin, created_at, client_id) VALUES (?, 'Алиса', 'alice@example.com', 'site', ?, ?)").run(task.id, w.clock.t, id);
    const leadId = (w.hq.db.prepare('SELECT MAX(id) m FROM li_leads').get() as { m: number }).m;
    expect(legalPartyOfLead(w.hq.db, leadId)).toBeNull();
    await call('POST', `/admin/clients/${id}`, { legalName: 'ООО Ромашка', legalAddress: 'Душанбе, ул. Рудаки 1' });
    const party = legalPartyOfLead(w.hq.db, leadId)!;
    expect(party).toEqual({ name: 'ООО Ромашка', address: 'Душанбе, ул. Рудаки 1' });
    expect(legalLabel(party)).toBe('ООО Ромашка, адрес: Душанбе, ул. Рудаки 1');
    await call('POST', `/admin/clients/${id}`, { legalAddress: '' });
    expect(legalLabel(legalPartyOfLead(w.hq.db, leadId)!)).toBe('ООО Ромашка');
  });
});
