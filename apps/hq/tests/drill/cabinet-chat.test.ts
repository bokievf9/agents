/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { readdirSync } from 'node:fs';
import { PmStore } from '@fir/worker-project-manager';
import { afterEach, describe, expect, it } from 'vitest';
import { addCabMessage } from '../../src/cabinet.js';
import { makePng } from '../png.js';
import { TOKENS, drillWorld, MEDIA_BASE, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

/** Cabinet v3: the threads of the cabinet chat, files, the profile, the agent of the playground; everything through the real webhook. */
const g = useGuard();
let w: DrillWorld;
afterEach(async () => { await w?.close(); });

const EMAIL = 'dilya.chat@example.com';
const LEAD = {
  name: 'Dilya Chat', contact: '@dilya_chat', service: 'bots', budget: '$300-500', message: 'Нужен бот для салона', locale: 'ru', source: 'miniapp', clientEmail: EMAIL, cabinetId: 'sb-chat', clientName: 'Dilya',
  estimate: 'Пакет: Бот-администратор\nНиша: салон красоты\nЦели: запись клиентов; ответы на вопросы\nТон: тёплый\nКомпания: Салон Диля',
};
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');
const PNG_BYTES = makePng({ stroke: true });

async function start() {
  w = await drillWorld({ flow: true });
  for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
  const lead = await w.http('POST', '/lead', LEAD, { 'x-lead-token': TOKENS.lead });
  const { leadId } = (await lead.json()) as any;
  await w.beat();
  const cab = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json;
  const cid = cab.client.id as number;
  const project = new PmStore(w.db, w.hq.now).createProject({ client: 'Dilya Chat', what: 'Бот для салона', product: 'bot', source: 'sales', taskId: null, leadId, packId: null });
  return { cid, leadId: leadId as number, projectId: project.id };
}
const threads = async (cid: number) => (await w.adm('GET', `/admin/clients/${cid}/threads`)).json.items as any[];
const messages = async (cid: number, tid: string, after = 0) => (await w.adm('GET', `/admin/clients/${cid}/threads/${tid}/messages?after=${after}`)).json.items as any[];
const say = (cid: number, tid: string, body: unknown) => w.adm('POST', `/admin/clients/${cid}/threads/${tid}/messages`, body);

describe('the profile persists', () => {
  it('POST /admin/clients/:id patches name, telegram, phone, company, locale; only the sent fields change; by-email shows them', async () => {
    const { cid } = await start();
    const r = await w.adm('POST', `/admin/clients/${cid}`, { name: 'Дилярам Каримова', telegram: '@dilya_new', phone: '+992 90 111 22 33', company: 'Салон Диля', locale: 'en' });
    expect(r.status, r.text).toBe(200);
    expect(r.json.client).toEqual({ id: cid, email: EMAIL, name: 'Дилярам Каримова', telegram: '@dilya_new', phone: '+992 90 111 22 33', company: 'Салон Диля', locale: 'en' });
    const by = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json.client;
    expect(by).toMatchObject({ name: 'Дилярам Каримова', telegram: '@dilya_new', phone: '+992 90 111 22 33', company: 'Салон Диля', locale: 'en' });
    // a partial patch keeps the rest; a field sent empty clears it; PATCH is the same as POST
    const p = await w.adm('PATCH', `/admin/clients/${cid}`, { company: '' });
    expect(p.status).toBe(405); // PATCH is for the agent's settings only; the profile is POST
    const partial = await w.adm('POST', `/admin/clients/${cid}`, { company: '' });
    expect(partial.json.client).toMatchObject({ name: 'Дилярам Каримова', telegram: '@dilya_new', company: '' });
    expect((await w.adm('POST', `/admin/clients/${cid}`, {})).json.client.name).toBe('Дилярам Каримова');
    expect((await w.adm('POST', `/admin/clients/${cid}`, { locale: 'de' })).status).toBe(400);
    expect((await w.adm('POST', `/admin/clients/${cid}`, { name: 'x'.repeat(121) })).status).toBe(400);
    expect((await w.adm('POST', '/admin/clients/9999', { name: 'x' })).status).toBe(404);
    // the registration upsert of the site does not wipe what the profile form saved (it is the same row, the same id)
    const reg = await w.adm('POST', '/admin/clients', { email: EMAIL, name: 'Dilya', telegram: '', locale: 'ru', supabaseId: 'sb-chat' });
    expect(reg.json.client.id).toBe(cid);
    expect(g.errors()).toEqual([]);
  });
});

describe('threads: lead, project, support', () => {
  it('lists a thread per lead and project plus support; messages, read marks, routing to the owner\'s chats and to Support, the answer back in the same thread', async () => {
    const { cid, leadId, projectId } = await start();
    // the message the client wrote before Cabinet v3 is in the lead thread as it was
    addCabMessage(w.db, w.hq.now(), { clientId: cid, leadId, from: 'client', text: 'Старое сообщение до обновления' });
    addCabMessage(w.db, w.hq.now(), { clientId: cid, leadId, from: 'manager', text: 'Старый ответ менеджера' });
    let list = await threads(cid);
    expect(list.map((t) => t.id).sort()).toEqual([`lead-${leadId}`, `project-${projectId}`, 'support'].sort());
    const old = await messages(cid, `lead-${leadId}`);
    expect(list.find((t) => t.id === `lead-${leadId}`)).toMatchObject({ kind: 'lead', refId: leadId, unread: old.filter((m) => m.from === 'firtech').length, title: expect.stringContaining('Нужен бот') });
    expect(list.find((t) => t.id === `project-${projectId}`)).toMatchObject({ kind: 'project', refId: projectId, unread: 0 });
    expect(list.find((t) => t.id === 'support')).toMatchObject({ kind: 'support', refId: null });
    expect(old.map((m) => [m.from, m.text])).toEqual(expect.arrayContaining([['client', 'Старое сообщение до обновления'], ['firtech', 'Старый ответ менеджера']]));
    expect(old.find((m) => m.text === 'Старый ответ менеджера')).toMatchObject({ attachments: [], readAt: null });
    // read mark
    expect((await w.adm('POST', `/admin/clients/${cid}/threads/lead-${leadId}/read`)).json).toEqual({ ok: true, unread: 0 });
    expect((await threads(cid)).find((t) => t.id === `lead-${leadId}`).unread).toBe(0);
    expect((await messages(cid, `lead-${leadId}`)).find((m) => m.text === 'Старый ответ менеджера').readAt).toEqual(expect.any(String));

    w.clock.t += 60_000;
    // the client writes in the project thread: stored, a Support ticket in that thread, the owner's chats list it, the inbox line has no text
    const sent = await say(cid, `project-${projectId}`, { text: 'Когда будет макет бота?' });
    expect(sent.status, sent.text).toBe(200);
    expect(sent.json.item).toMatchObject({ from: 'client', text: 'Когда будет макет бота?', attachments: [], readAt: null });
    expect(sent.json.ticketId).toBeGreaterThan(0);
    expect((await messages(cid, `project-${projectId}`)).map((m) => m.text)).toEqual(['Когда будет макет бота?']);
    expect((await w.adm('GET', '/admin/inbox?limit=100')).text).toContain(`Сообщение по проекту #${projectId}`);
    expect((await w.adm('GET', '/admin/inbox?limit=100')).text).not.toContain('Когда будет макет');
    const chats = (await w.adm('GET', '/admin/chats?status=all')).json.items as any[];
    const mine = chats.find((c) => c.client.id === cid);
    expect(mine, 'the thread of the client is in /admin/chats').toBeDefined();
    const chat = (await w.adm('GET', `/admin/chats/${mine.id}`)).json;
    expect(chat.messages.map((m: any) => m.text)).toContain('Когда будет макет бота?');
    expect(mine.unread).toBeGreaterThanOrEqual(1);
    // the Support head drafts an answer (a card); the approved answer lands in the SAME thread, once
    await w.beat();
    await w.director.sendApprovalBatch(false);
    const card = ((await w.adm('GET', '/admin/review?status=pending&limit=200')).json.items as any[]).find((i) => i.kind === 'support_answer');
    expect(card, 'the Support head made a draft').toBeDefined();
    let ok = await w.adm('POST', `/admin/review/${card.id}`, { action: 'approve' });
    if (ok.status === 409) {
      expect((await w.adm('POST', `/admin/review/${card.id}`, { action: 'edit', text: { draft: 'Макет будет готов в пятницу, пришлём в кабинет.' } })).status).toBe(200);
      ok = await w.adm('POST', `/admin/review/${card.id}`, { action: 'approve' });
    }
    expect(ok.status, ok.text).toBe(200);
    const proj = await messages(cid, `project-${projectId}`);
    expect(proj.map((m) => m.from)).toEqual(['client', 'firtech']);
    expect(proj[1].text.length).toBeGreaterThan(20);
    expect((await threads(cid)).find((t) => t.id === `project-${projectId}`).unread).toBe(1);
    // the owner answers in the thread the client wrote in (without an approval), it is his own channel
    const reply = await w.adm('POST', `/admin/chats/${mine.id}/reply`, { text: 'Дилярам, макет покажу завтра.', thread: `project-${projectId}` });
    expect(reply.status, reply.text).toBe(200);
    expect(reply.json).toMatchObject({ sent: true, via: 'cabinet' });
    expect((await messages(cid, `project-${projectId}`)).map((m) => m.text).at(-1)).toBe('Дилярам, макет покажу завтра.');
    expect((await messages(cid, `lead-${leadId}`)).map((m) => m.text)).not.toContain('Дилярам, макет покажу завтра.');
    // `after` returns only the newer ones
    const first = (await messages(cid, `project-${projectId}`))[0];
    expect((await messages(cid, `project-${projectId}`, first.id)).map((m) => m.id)).not.toContain(first.id);

    // the support thread and the lead thread route the same way (the lead thread keeps the lead's task journal)
    expect((await say(cid, 'support', { text: 'Как оплатить в тенге?' })).status).toBe(200);
    expect((await say(cid, `lead-${leadId}`, { text: 'Уточните срок, пожалуйста' })).status).toBe(200);
    expect(w.db.prepare("SELECT COUNT(*) n FROM cs_tickets WHERE source = 'cabinet'").get()).toEqual({ n: 3 });
    expect((w.db.prepare("SELECT thread FROM cs_tickets WHERE thread IS NOT NULL ORDER BY id").all() as any[]).map((r) => r.thread)).toEqual([`project-${projectId}`, 'support']);
    expect((await messages(cid, 'support')).map((m) => m.text)).toEqual(['Как оплатить в тенге?']);
    expect((await messages(cid, `lead-${leadId}`)).map((m) => m.text)).toContain('Уточните срок, пожалуйста');
    list = await threads(cid);
    expect(list[0].lastAt >= list.at(-1).lastAt).toBe(true); // the newest activity first
    expect(g.errors()).toEqual([]);
  }, 90_000);

  it('somebody else\'s thread, an unknown thread, an empty message, too many messages', async () => {
    const { cid, leadId } = await start();
    const other = await w.adm('POST', '/admin/clients', { email: 'someone.else@example.com', name: 'Else', telegram: '', locale: 'ru', supabaseId: 'sb-else' });
    const oid = other.json.client.id as number;
    expect((await w.adm('GET', `/admin/clients/${oid}/threads/lead-${leadId}/messages`)).status).toBe(404);
    expect((await say(oid, `lead-${leadId}`, { text: 'чужая заявка' })).status).toBe(404);
    expect((await w.adm('POST', `/admin/clients/${oid}/threads/lead-${leadId}/read`)).status).toBe(404);
    for (const tid of ['nope', 'lead-99999', 'project-999', 'agent-1', 'lead-abc', '../support']) expect((await w.adm('GET', `/admin/clients/${cid}/threads/${encodeURIComponent(tid)}/messages`)).status, tid).toBe(404);
    expect((await w.adm('GET', '/admin/clients/9999/threads')).status).toBe(404);
    expect((await say(cid, 'support', { text: '' })).status).toBe(400);
    expect((await say(cid, 'support', { text: 'x'.repeat(2001) })).status).toBe(400);
    expect((await w.adm('GET', `/admin/clients/${cid}/threads/support/messages?after=abc`)).status).toBe(400);
    for (let i = 0; i < 20; i++) expect((await say(cid, 'support', { text: `вопрос ${i}` })).status).toBe(200);
    expect((await say(cid, 'support', { text: 'ещё один' })).status).toBe(429);
  }, 90_000);
});

describe('attachments and uploads', () => {
  it('upload (10 MB, allowlisted types, content checked), attach to a message, download through a signed link; the file lives under DATA_DIR/uploads/<client>/', async () => {
    const { cid, leadId } = await start();
    const up = await w.adm('POST', `/admin/clients/${cid}/uploads`, { name: 'logo салона.png', dataBase64: b64(PNG_BYTES) });
    expect(up.status, up.text).toBe(200);
    const file = up.json.item;
    expect(file).toMatchObject({ name: 'logo салона.png', type: 'image/png', size: PNG_BYTES.length });
    expect(file.url).toMatch(/^https:\/\/hq\.test\/media\/[0-9a-f]{32}\/uploads\/\d+\/[0-9a-f]{32}\.png\?e=\d+$/);
    expect(readdirSync(`${w.dataDir}/uploads/${cid}`)).toHaveLength(1);
    const dl = await w.http('GET', file.url.replace(MEDIA_BASE, '/media'));
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await dl.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
    // the link cannot be pointed at another file or kept forever
    expect((await w.http('GET', file.url.replace(MEDIA_BASE, '/media').replace(/\?e=\d+$/, ''))).status).toBe(404);
    expect((await w.http('GET', file.url.replace(MEDIA_BASE, '/media').replace(/\/uploads\/\d+\//, `/uploads/${cid + 1}/`))).status).toBe(404);
    // Word and zip are offered as downloads, never shown inline
    const docx = await w.adm('POST', `/admin/clients/${cid}/uploads`, { name: 'бриф.docx', dataBase64: b64(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40, 1)])) });
    expect(docx.status).toBe(200);
    const dd = await w.http('GET', docx.json.item.url.replace(MEDIA_BASE, '/media'));
    expect(dd.headers.get('content-disposition')).toBe('attachment');
    expect(dd.headers.get('x-content-type-options')).toBe('nosniff');
    // refused: unknown or dangerous types, a file that is not what its name says, an empty or broken body
    for (const name of ['setup.exe', 'run.sh', 'page.html', 'vector.svg', 'archive.tar.gz', 'noext', 'a.png.exe']) {
      expect((await w.adm('POST', `/admin/clients/${cid}/uploads`, { name, dataBase64: b64(PNG_BYTES) })).status, name).toBe(415);
    }
    expect((await w.adm('POST', `/admin/clients/${cid}/uploads`, { name: 'fake.png', dataBase64: b64('MZ-not-a-png-at-all') })).json).toMatchObject({ error: 'unsupported_type', reason: 'content_mismatch' });
    expect((await w.adm('POST', `/admin/clients/${cid}/uploads`, { name: 'bin.txt', dataBase64: b64(Buffer.from([0, 1, 2, 3])) })).status).toBe(415);
    expect((await w.adm('POST', `/admin/clients/${cid}/uploads`, { name: 'a.png', dataBase64: '***' })).status).toBe(400);
    expect((await w.adm('POST', `/admin/clients/${cid}/uploads`, { name: 'a.png' })).status).toBe(400);
    expect((await w.adm('POST', '/admin/clients/9999/uploads', { name: 'a.png', dataBase64: b64(PNG_BYTES) })).status).toBe(404);
    // 10 MB: over it is refused with 413 (the webhook accepts the body, the API says why)
    const big = await w.adm('POST', `/admin/clients/${cid}/uploads`, { name: 'big.pdf', dataBase64: b64(Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024)])) });
    expect(big.status).toBe(413);
    expect(big.json).toMatchObject({ error: 'too_large', maxBytes: 10 * 1024 * 1024 });
    const edge = await w.adm('POST', `/admin/clients/${cid}/uploads`, { name: 'edge.pdf', dataBase64: b64(Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024 - 5)])) });
    expect(edge.status).toBe(200);
    // attach: to the lead thread; the message shows the file with a signed link; a file of another client or too many files are refused
    const msg = await say(cid, `lead-${leadId}`, { text: 'Вот наш логотип', attachments: [file.id] });
    expect(msg.status, msg.text).toBe(200);
    expect(msg.json.item.attachments).toEqual([{ name: 'logo салона.png', url: expect.stringMatching(/^https:\/\/hq\.test\/media\//), size: PNG_BYTES.length }]);
    const stored = (await messages(cid, `lead-${leadId}`)).find((m) => m.text === 'Вот наш логотип');
    expect(stored.attachments[0]).toMatchObject({ name: 'logo салона.png', size: PNG_BYTES.length });
    const other = await w.adm('POST', '/admin/clients', { email: 'second@example.com', name: 'Second', telegram: '', locale: 'ru', supabaseId: 'sb-second' });
    const foreign = await w.adm('POST', `/admin/clients/${other.json.client.id}/uploads`, { name: 'mine.png', dataBase64: b64(PNG_BYTES) });
    expect((await say(cid, 'support', { text: 'вложение', attachments: [foreign.json.item.id] })).status).toBe(400);
    expect((await say(cid, 'support', { text: 'вложение', attachments: Array.from({ length: 6 }, () => file.id) })).status).toBe(400);
    expect((await say(cid, 'support', { text: '', attachments: [{ uploadId: file.id }] })).status).toBe(200); // a file alone is a message
    expect((await w.adm('POST', `/admin/clients/${cid}/uploads`, { name: 'x.png', dataBase64: b64(PNG_BYTES) })).status).toBe(200);
    expect(g.errors()).toEqual([]);
  }, 120_000);

  it('30 uploads an hour per client', async () => {
    const { cid } = await start();
    for (let i = 0; i < 30; i++) expect((await w.adm('POST', `/admin/clients/${cid}/uploads`, { name: `f${i}.png`, dataBase64: b64(PNG_BYTES) })).status).toBe(200);
    expect((await w.adm('POST', `/admin/clients/${cid}/uploads`, { name: 'f.png', dataBase64: b64(PNG_BYTES) })).status).toBe(429);
  }, 120_000);

  it('the signature body (a data URL of 200 KB) is accepted by the webhook, a body of any other route stays small', async () => {
    const { cid } = await start();
    const tiny = await w.adm('POST', `/admin/clients/${cid}/documents/1/sign`, { signaturePng: `data:image/png;base64,${'A'.repeat(250_000)}`, name: 'Дилярам', consent: true });
    expect(tiny.status).toBe(404); // no such document: but the body reached the API (not a 413)
    expect((await w.adm('POST', `/admin/clients/${cid}/threads/support/messages`, { text: 'x'.repeat(40_000) })).status).toBe(413);
  });
});

describe('the agent of the playground through the API', () => {
  it('create from the lead (the persona has the builder answers), settings with PATCH, chat in the cabinet thread, the agent thread, the public widget, the demo', async () => {
    const { cid, leadId } = await start();
    const created = await w.adm('POST', `/admin/clients/${cid}/agents`, { leadId });
    expect(created.status, created.text).toBe(200);
    const agent = created.json.item;
    expect(agent).toMatchObject({ company: 'Салон Диля', niche: 'салон красоты', state: 'draft', goals: ['запись клиентов', 'ответы на вопросы'], tone: 'тёплый', leadId });
    expect(agent.persona).toContain('Салон Диля');
    const token = created.json.token as string;
    expect(token).toMatch(/^ft_/);
    expect((await w.adm('GET', `/admin/clients/${cid}/agents`)).json.items).toHaveLength(1);
    // the agent thread appears with the agent
    expect((await threads(cid)).find((t) => t.id === `agent-${agent.id}`)).toMatchObject({ kind: 'agent', refId: agent.id, title: expect.any(String) });
    const direct = await w.adm('POST', `/admin/clients/${cid}/agents/${agent.id}/chat`, { text: 'Здравствуйте, вы кто?' });
    expect(direct.status, direct.text).toBe(200);
    expect(direct.json).toMatchObject({ ok: true, reply: expect.any(String), conversationId: `cab-${cid}-${agent.id}`, usedTools: [] });
    // the same through the thread: the client message and the agent's answer
    const viaThread = await say(cid, `agent-${agent.id}`, { text: 'А что вы умеете?' });
    expect(viaThread.status, viaThread.text).toBe(200);
    expect(viaThread.json.item.from).toBe('client');
    expect(viaThread.json.reply).toMatchObject({ from: 'agent', text: expect.any(String) });
    expect((await messages(cid, `agent-${agent.id}`)).map((m) => m.from)).toEqual(['client', 'agent']);
    // the agent talks to nobody else's thread and is not shown in the owner's chats of other clients
    const other = await w.adm('POST', '/admin/clients', { email: 'third@example.com', name: 'Third', telegram: '', locale: 'ru', supabaseId: 'sb-third' });
    expect((await w.adm('GET', `/admin/clients/${other.json.client.id}/agents/${agent.id}`)).status).toBe(404);
    expect((await w.adm('POST', `/admin/clients/${other.json.client.id}/threads/agent-${agent.id}/messages`, { text: 'x' })).status).toBe(404);

    // settings over PATCH (the one route that takes it), live, a site origin, a limit
    const patched = await w.adm('PATCH', `/admin/clients/${cid}/agents/${agent.id}`, { state: 'live', limits: { msgsPerDay: 4 }, channels: { siteWidget: 'https://dilya.example' } });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.json.item).toMatchObject({ state: 'live', limits: { msgsPerDay: 4 }, channels: { siteWidget: 'https://dilya.example' } });
    // the public route: token in the header, the origin checked, CORS answered, rate limited
    const pub = (t: string, origin = 'https://dilya.example', body: unknown = { text: 'Добрый день' }) =>
      w.http('POST', `/agent/${agent.publicId}/chat`, body, { 'x-agent-token': t, origin });
    const ok = await pub(token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://dilya.example');
    expect(await ok.json()).toMatchObject({ ok: true, reply: expect.any(String), conversationId: expect.stringMatching(/^w-/), usedTools: [] });
    const pre = await w.http('OPTIONS', `/agent/${agent.publicId}/chat`, undefined, { origin: 'https://dilya.example' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-agent-token');
    expect((await pub('ft_wrong')).status).toBe(401);
    expect((await pub(token, 'https://evil.example')).status).toBe(403);
    expect((await pub(token, 'https://dilya.example', { text: '' })).status).toBe(400);
    // the limit counts the cabinet messages above too (2 so far + 1 public = 3, the fourth is the last)
    expect((await pub(token)).status).toBe(200);
    expect((await pub(token)).status).toBe(429);
    // the owner reads counts, not texts, in the journal
    const journal = (await w.adm('GET', `/admin/clients/${cid}/agents/${agent.id}/journal`)).json.items[0].counts;
    expect(journal).toMatchObject({ message: 4, limit_hit: 1 });
    expect((await w.adm('GET', `/admin/clients/${cid}/agents/${agent.id}/conversations`)).json.items.length).toBeGreaterThanOrEqual(2);
    // a new token
    const rot = await w.adm('POST', `/admin/clients/${cid}/agents/${agent.id}/token`);
    expect(rot.json.token).not.toBe(token);
    expect((await pub(token)).status).toBe(401);
    // the demo of the builder preview: no token, open CORS, a session id, nothing stored
    const demo = await w.http('POST', '/agent/demo-salon/chat', { sessionId: 'session-demo-0001', text: 'Здравствуйте' }, { origin: 'https://firtech.pro' });
    expect(demo.status).toBe(200);
    expect(demo.headers.get('access-control-allow-origin')).toBe('*');
    expect(await demo.json()).toMatchObject({ ok: true, conversationId: 'session-demo-0001' });
    expect((await w.http('POST', '/agent/demo-nothing/chat', { sessionId: 'session-demo-0001', text: 'x' })).status).toBe(404);
    expect((await w.http('POST', '/agent/demo-salon/chat', { sessionId: 'x', text: 'x' })).status).toBe(400);
    expect(w.db.prepare("SELECT COUNT(*) n FROM pg_conversations WHERE channel = 'demo'").get()).toEqual({ n: 0 });
    // the demo is rate limited per visitor: 20 a minute
    let last = 200;
    for (let i = 0; i < 25; i++) last = (await w.http('POST', '/agent/demo-cafe/chat', { sessionId: `session-rate-${100 + i}`, text: 'привет' })).status;
    expect(last).toBe(429);
    expect(g.errors()).toEqual([]);
    expect(g.leaks(['dilya.chat', '@dilya_chat', token])).toEqual([]);
  }, 120_000);
});

describe('documents of somebody else', () => {
  it('another client\'s documents are 404, the list of a client with none is empty', async () => {
    const { cid } = await start();
    expect((await w.adm('GET', `/admin/clients/${cid}/documents`)).json).toEqual({ ok: true, items: [] });
    expect((await w.adm('GET', '/admin/clients/9999/documents')).status).toBe(404);
    expect((await w.adm('POST', `/admin/clients/${cid}/documents/abc/accept`)).status).toBe(404);
    expect((await w.adm('DELETE', `/admin/clients/${cid}/documents`)).status).toBe(405);
  });
});

