/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { describe, expect, it } from 'vitest';
import { addCabMessage, ensureCabinetTables, registerCabinetLead } from '../src/cabinet.js';
import { contactKey } from '../src/chats.js';
import { ChatStore } from '../src/client/store.js';
import { WebSessionStore } from '../src/client/web-store.js';
import { serve } from './pult-helpers.js';
import { reviewWorld, type ReviewWorld } from './review-helpers.js';

const DAY = 86_400_000;
const threads = async (p: ReviewWorld, qs = 'status=all') => (await p.call('GET', `/admin/chats?${qs}`)).json.items as any[];
const thread = async (p: ReviewWorld, id: string) => (await p.call('GET', `/admin/chats/${id}`)).json;

/** A lead of a signed-in cabinet client (account and lead row exist, linked); `lead.chatId` / `lead.sessionId` ride on the lead task like in the real flow. */
function cabinetLead(p: ReviewWorld, email: string, name: string, lead: Record<string, unknown> = {}) {
  const task = p.w.hq.createTask({ title: `Лид ${name}`, dept: 'sales', creator: 'routine', meta: { action: 'lead', lead: { name, ...lead } } });
  const r = registerCabinetLead(p.w.db, p.t, task.id, { clientEmail: email, cabinetId: 'sb-1', clientName: name, name, contact: email, service: 'bot', budget: '$500', message: 'Хочу бота для салона', estimate: '', locale: 'ru', source: 'cabinet' });
  return { ...r, taskId: task.id };
}

describe('contactKey', () => {
  it('one key per identity however the contact is written', () => {
    expect(contactKey(' Anna@Example.COM ')).toBe('em:anna@example.com');
    expect(contactKey('@Anna_K')).toBe('tg:anna_k');
    expect(contactKey('anna_k')).toBe('tg:anna_k');
    expect(contactKey('https://t.me/Anna_K')).toBe('tg:anna_k');
    expect(contactKey('+992 (900) 12-34-56')).toBe('ph:992900123456');
    for (const none of ['', '  ', '12', 'привет всем']) expect(contactKey(none), none).toBeNull();
  });
});

describe('GET /admin/chats: one thread per client', () => {
  it('joins by the cabinet client id: both leads, the cabinet messages, a ticket from the cabinet (once) and the approved replies', async () => {
    const p = reviewWorld();
    ensureCabinetTables(p.w.db);
    const a = cabinetLead(p, 'anna@example.com', 'Анна');
    const b = cabinetLead(p, 'anna@example.com', 'Анна', {});
    expect(b.clientId).toBe(a.clientId);
    p.w.clock.t += 1000;
    addCabMessage(p.w.db, p.t(), { clientId: a.clientId, leadId: a.leadId, from: 'client', text: 'Когда будет готов макет?' });
    p.w.clock.t += 1000;
    addCabMessage(p.w.db, p.t(), { clientId: a.clientId, leadId: a.leadId, from: 'manager', text: 'Макет в четверг.', by: 'hq' });
    p.w.clock.t += 1000;
    addCabMessage(p.w.db, p.t(), { clientId: a.clientId, leadId: b.leadId, from: 'manager', text: 'Звонил, не дозвонился.', by: 'owner' });
    p.w.clock.t += 1000;
    addCabMessage(p.w.db, p.t(), { clientId: a.clientId, leadId: b.leadId, from: 'client', text: 'Перезвоните после трёх', ticketId: 5 });
    const list = await threads(p);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: `c${a.clientId}`, client: { id: a.clientId, name: 'Анна', email: 'anna@example.com' }, channels: expect.arrayContaining(['cabinet']), unread: 1, leadId: b.leadId, textsStored: true });
    expect(list[0].preview).toBe('Перезвоните после трёх');
    const t = await thread(p, `c${a.clientId}`);
    const texts = t.messages.filter((m: any) => m.id.startsWith('cab_')).map((m: any) => [m.from, m.text]);
    expect(texts).toEqual([['client', 'Когда будет готов макет?'], ['hq', 'Макет в четверг.'], ['owner', 'Звонил, не дозвонился.'], ['client', 'Перезвоните после трёх']]);
    // the first request of each lead is the client's own first message
    expect(t.messages.filter((m: any) => m.id.startsWith('lead_')).map((m: any) => m.text)).toEqual(['Хочу бота для салона', 'Хочу бота для салона']);
    // any alias of the thread opens it (the id survives a merge)
    expect((await thread(p, `l${a.leadId}`)).thread.id).toBe(`c${a.clientId}`);
    expect((await p.call('GET', '/admin/chats/nope')).status).toBe(404);
  });

  it('joins by contact without a cabinet: the same Telegram handle or email, however written, a ticket by contact, an approved reply', async () => {
    const p = reviewWorld();
    const l1 = p.lead('Анна', { contact: '@Anna_K', at: p.t() - 3 * DAY });
    const l2 = p.lead('Анна К', { contact: 'anna_k', at: p.t() - 2 * DAY });
    const other = p.lead('Борис', { contact: '@boris' });
    const tk = p.cs.addTicket({ clientName: 'Анна', text: 'Как оплатить?', money: false });
    p.w.db.prepare('UPDATE cs_tickets SET contact = ? WHERE id = ?').run('https://t.me/anna_k', tk.id);
    p.w.db.prepare('UPDATE li_leads SET task = ? WHERE id = ?').run('Нужен бот записи', l1.id);
    // an approved reply to the first lead (executed, later than the ticket): from HQ
    p.w.clock.t += 1000;
    const x = await p.propose('sales', 'lead_reply', { text: 'Здравствуйте, Анна!', leadId: l1.id, contact: '@Anna_K', name: 'Анна' }, 'ответ');
    await p.act(x.id, { action: 'approve' });
    const list = await threads(p);
    expect(list.map((t) => t.id).sort()).toEqual([`l${l1.id}`, `l${other.id}`].sort());
    const anna = list.find((t) => t.id === `l${l1.id}`)!;
    expect(anna).toMatchObject({ client: { id: null, name: 'Анна К', contact: 'anna_k' }, leadId: l2.id, ticketId: tk.id, channels: ['web'], textsStored: true });
    const t = await thread(p, anna.id);
    expect(t.messages.map((m: any) => [m.from, m.text])).toEqual([['client', 'Нужен бот записи'], ['client', 'Как оплатить?'], ['hq', 'Здравствуйте, Анна!']]);
    expect(anna.unread).toBe(0);
    // by email: a cabinet client without leads and a lead that wrote the same email are one person
    const c = p.w.db.prepare("INSERT INTO cab_clients (email, name, created_at, updated_at) VALUES ('boris@example.com', 'Борис Б', 1, 1)").run();
    p.w.db.prepare("UPDATE li_leads SET contact = 'Boris@Example.com' WHERE id = ?").run(other.id);
    const merged = (await threads(p)).find((t2) => t2.client.email === 'boris@example.com')!;
    expect(merged.id).toBe(`c${Number(c.lastInsertRowid)}`);
    expect(merged.leadId).toBe(other.id);
  });

  it('joins website sessions and @firtech_bot dialogues through the lead; a session alone is a thread without stored texts (only the masked summary)', async () => {
    const p = reviewWorld();
    const web = new WebSessionStore(p.w.db, p.t);
    web.create('s-1', 'ru');
    web.update('s-1', { summary: 'спросил про цену бота' });
    web.create('s-alone', 'ru');
    web.update('s-alone', { summary: 'листает прайс' });
    const bot = new ChatStore(p.w.db, p.t);
    bot.touch(777, 'anna_k', 'ru');
    bot.update(777, { summary: 'анкета: шаг 2' });
    bot.touch(888, 'ghost', 'ru');
    const viaWeb = p.lead('Анна', { contact: '+992900123456', meta: { sessionId: 's-1' } });
    const viaBot = p.lead('Борис', { contact: '@boris', meta: { chatId: 777 } });
    const list = await threads(p);
    expect(list.find((t) => t.id === `l${viaWeb.id}`)).toMatchObject({ channels: ['web'], textsStored: true });
    const boris = list.find((t) => t.id === `l${viaBot.id}`)!;
    expect(boris.channels).toEqual(expect.arrayContaining(['telegram']));
    // the bot chat of the lead is the same person: no second thread for chat 777 or session s-1
    expect(list.map((t) => t.id).sort()).toEqual([`g888`, `l${viaWeb.id}`, `l${viaBot.id}`, `ws-alone`].sort());
    const alone = list.find((t) => t.id === 'ws-alone')!;
    expect(alone).toMatchObject({ textsStored: false, unread: 0, preview: 'листает прайс', client: { name: 'Посетитель сайта' } });
    expect((await thread(p, 'ws-alone')).messages).toEqual([]);
    expect(list.find((t) => t.id === 'g888')).toMatchObject({ client: { name: '@ghost', contact: '@ghost' }, preview: '', channels: ['telegram'] });
  });

  it('unread = client messages after the last owner or HQ message; the open filter keeps unread, open tickets and the last week', async () => {
    const p = reviewWorld();
    const a = cabinetLead(p, 'anna@example.com', 'Анна');
    const old = p.lead('Старый', { contact: '@old', at: p.t() - 30 * DAY });
    p.w.db.prepare("UPDATE li_leads SET task = '' WHERE id = ?").run(old.id);
    p.w.clock.t += 1000;
    addCabMessage(p.w.db, p.t(), { clientId: a.clientId, leadId: a.leadId, from: 'client', text: 'один' });
    p.w.clock.t += 1000;
    addCabMessage(p.w.db, p.t(), { clientId: a.clientId, leadId: a.leadId, from: 'client', text: 'два' });
    expect((await threads(p, 'status=open')).map((t) => [t.id, t.unread])).toEqual([[`c${a.clientId}`, 3]]);
    // the lead's own request is the first message
    expect((await p.call('GET', '/admin/chats?status=all')).json.items.map((t: any) => t.id)).toEqual([`c${a.clientId}`, `l${old.id}`]);
    p.w.clock.t += 1000;
    addCabMessage(p.w.db, p.t(), { clientId: a.clientId, leadId: a.leadId, from: 'manager', text: 'ответ', by: 'owner' });
    p.w.clock.t += 1000;
    addCabMessage(p.w.db, p.t(), { clientId: a.clientId, leadId: a.leadId, from: 'client', text: 'три' });
    expect((await threads(p, 'status=open'))[0]).toMatchObject({ unread: 1 });
    expect((await p.call('GET', '/admin/chats')).json.unread).toBe(1);
    // an open ticket keeps an old thread open
    const tk = p.cs.addTicket({ clientName: 'Старый', text: 'Не работает', money: false });
    p.w.db.prepare("UPDATE cs_tickets SET contact = '@old', created_at = ? WHERE id = ?").run(p.t() - 30 * DAY, tk.id);
    expect((await threads(p, 'status=open')).map((t) => t.id)).toContain(`l${old.id}`);
    // paging
    const page = (await p.call('GET', '/admin/chats?status=all&limit=1')).json;
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('1');
    expect((await p.call('GET', '/admin/chats?status=all&limit=1&cursor=1')).json.nextCursor).toBeNull();
    for (const bad of ['status=x', 'limit=0x', 'cursor=a']) expect((await p.call('GET', `/admin/chats?${bad}`)).status, bad).toBe(400);
  });

  it('needs the admin token', async () => {
    const p = reviewWorld();
    const s = await serve(p);
    expect((await s.http('GET', '/admin/chats', undefined, {})).status).toBe(401);
    expect((await s.http('POST', '/admin/chats/c1/reply', { text: 'x' }, {})).status).toBe(401);
    expect((await s.http('GET', '/admin/chats')).status).toBe(200);
    await s.close();
  });
});

describe('POST /admin/chats/:id/reply: the owner writes himself, no approval', () => {
  it('goes out on the client last channel: Telegram through the client bot, stored in the thread and in the lead journal', async () => {
    const p = reviewWorld();
    const lead = p.lead('Борис', { contact: '@boris', meta: { chatId: 777 } });
    new ChatStore(p.w.db, p.t).touch(777, 'boris', 'ru');
    const id = `l${lead.id}`;
    const r = await p.call('POST', `/admin/chats/${id}/reply`, { text: 'Привет, Борис! Созвонимся в среду?' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, sent: true, via: 'telegram', message: { from: 'owner', channel: 'telegram', text: 'Привет, Борис! Созвонимся в среду?' } });
    expect(p.toClient).toEqual([{ chatId: 777, text: 'Привет, Борис! Созвонимся в среду?' }]);
    expect(p.w.queue.pending()).toHaveLength(0); // no approval
    expect(p.w.db.prepare("SELECT COUNT(*) n FROM approvals").get()).toEqual({ n: 0 });
    const t = await thread(p, id);
    expect(t.messages.map((m: any) => [m.from, m.channel])).toEqual([['owner', 'telegram']]);
    const task = p.w.hq.events(lead.taskId).map((e) => e.body).find((b) => b.startsWith('Ответ владельца'));
    expect(task).toBe('Ответ владельца (telegram): Привет, Борис! Созвонимся в среду?');
    const log = p.w.db.prepare("SELECT detail FROM activity WHERE action = 'chat_reply'").get() as any;
    expect(log.detail).toBe('telegram:sent');
  });

  it('a website visitor: the text waits for his next chat answer; a vanished session is not delivered, the text is kept and told so', async () => {
    const p = reviewWorld();
    const web = new WebSessionStore(p.w.db, p.t);
    web.create('s-1', 'ru');
    const live = p.lead('Анна', { contact: '+992900123456', meta: { sessionId: 's-1' } });
    const gone = p.lead('Дима', { contact: '+992900000000', meta: { sessionId: 'gone' } });
    const r = await p.call('POST', `/admin/chats/l${live.id}/reply`, { text: 'Здравствуйте!' });
    expect(r.json).toMatchObject({ ok: true, sent: true, via: 'web', message: { channel: 'web' } });
    expect(p.toWeb).toEqual([{ sessionId: 's-1', text: 'Здравствуйте!' }]);
    const lost = await p.call('POST', `/admin/chats/l${gone.id}/reply`, { text: 'Вы тут?' });
    expect(lost.json).toMatchObject({ ok: true, sent: false, via: 'none', message: { text: 'Вы тут?' } });
    expect((await thread(p, `l${gone.id}`)).messages.map((m: any) => m.text)).toEqual(['Вы тут?']);
    expect(p.w.hq.events(gone.taskId).map((e) => e.body)).toContain('Ответ владельца (none, не доставлен): Вы тут?');
  });

  it('a cabinet client: the reply is written to cab_messages (author owner) and the lead journal; Telegram too when he wrote there last', async () => {
    const p = reviewWorld();
    const a = cabinetLead(p, 'anna@example.com', 'Анна', { chatId: 777 });
    p.w.clock.t += 1000;
    const c = await p.call('POST', `/admin/chats/c${a.clientId}/reply`, { text: 'Макет готов, смотрите в кабинете.' });
    // the thread has no «last channel» of the client besides the lead's own request (cabinet source, but a chat id rides on the lead): the bot goes first
    expect(c.json).toMatchObject({ ok: true, sent: true, via: 'telegram', message: { from: 'owner', channel: 'cabinet' } });
    expect(p.toClient).toEqual([{ chatId: 777, text: 'Макет готов, смотрите в кабинете.' }]);
    const row = p.w.db.prepare('SELECT "from", text, author, lead_id FROM cab_messages ORDER BY id DESC LIMIT 1').get() as any;
    expect(row).toEqual({ from: 'manager', text: 'Макет готов, смотрите в кабинете.', author: 'owner', lead_id: a.leadId });
    expect(p.w.hq.events(a.taskId).map((e) => e.body)).toContain('Ответ владельца (telegram): Макет готов, смотрите в кабинете.');
    // he writes in the cabinet: the reply stays in the cabinet (no other address)
    const b = cabinetLead(p, 'boris@example.com', 'Борис');
    p.w.clock.t += 1000;
    addCabMessage(p.w.db, p.t(), { clientId: b.clientId, leadId: b.leadId, from: 'client', text: 'Есть вопрос' });
    const r2 = await p.call('POST', `/admin/chats/c${b.clientId}/reply`, { text: 'Слушаю.' });
    expect(r2.json).toMatchObject({ ok: true, sent: true, via: 'cabinet' });
    const t = await thread(p, `c${b.clientId}`);
    expect(t.messages.at(-1)).toMatchObject({ from: 'owner', channel: 'cabinet', text: 'Слушаю.' });
    expect(t.thread.unread).toBe(0);
    expect(p.toClient).toHaveLength(1);
  });

  it('the client last channel wins when he has several (he wrote on the website: the website first); when it fails the next address takes it', async () => {
    const p = reviewWorld();
    const web = new WebSessionStore(p.w.db, p.t);
    web.create('s-1', 'ru');
    new ChatStore(p.w.db, p.t).touch(777, 'anna', 'ru'); // the same person has the bot too: @anna
    const lead = p.lead('Анна', { contact: '@anna', meta: { sessionId: 's-1' } });
    p.w.db.prepare("UPDATE li_leads SET task = 'Вопрос с сайта' WHERE id = ?").run(lead.id);
    const t0 = await thread(p, `l${lead.id}`);
    expect(t0.thread.channels.sort()).toEqual(['telegram', 'web']);
    expect(t0.messages.map((m: any) => m.channel)).toEqual(['web']);
    const r = await p.call('POST', `/admin/chats/l${lead.id}/reply`, { text: 'Ответил на сайте.' });
    expect(r.json).toMatchObject({ sent: true, via: 'web' });
    expect(p.toWeb).toEqual([{ sessionId: 's-1', text: 'Ответил на сайте.' }]);
    expect(p.toClient).toEqual([]);
    // the session is gone (the site's chat answers «no such session»): the bot is the way, and the thread shows both owner lines in their channels
    new ChatStore(p.w.db, p.t).touch(888, 'boris', 'ru');
    const gone = p.lead('Борис', { contact: '@boris', meta: { sessionId: 'gone' } });
    p.w.db.prepare("UPDATE li_leads SET task = 'Вопрос с сайта' WHERE id = ?").run(gone.id);
    const r2 = await p.call('POST', `/admin/chats/l${gone.id}/reply`, { text: 'Тогда в Telegram.' });
    expect(r2.json).toMatchObject({ sent: true, via: 'telegram' });
    expect(p.toClient).toEqual([{ chatId: 888, text: 'Тогда в Telegram.' }]);
    expect((await thread(p, `l${gone.id}`)).messages.map((m: any) => [m.from, m.channel])).toEqual([['client', 'web'], ['owner', 'telegram']]);
  });

  it('validates: unknown thread 404, empty or too long text 400, extra fields 400', async () => {
    const p = reviewWorld();
    const lead = p.lead('Анна', { contact: '@anna' });
    expect((await p.call('POST', '/admin/chats/zzz/reply', { text: 'x' })).status).toBe(404);
    for (const bad of [{}, { text: '  ' }, { text: 'x'.repeat(2001) }, { text: 'x', extra: 1 }]) expect((await p.call('POST', `/admin/chats/l${lead.id}/reply`, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await p.call('GET', `/admin/chats/l${lead.id}`)).json.messages).toEqual([]);
  });
});
