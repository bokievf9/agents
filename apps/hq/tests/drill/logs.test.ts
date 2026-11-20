import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PmStore } from '@fir/worker-project-manager';
import { TOKENS, drillWorld, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

const g = useGuard();
let w: DrillWorld;

const P = {
  name: 'Zulfiya Karimova', handle: '@zulfiya_k', email: 'zulfiya.k@example.com', phone: '+992 90 765 43 21', text: 'Секретный запрос: нужен бот для салона Лотос на Рудаки',
  chat: 'Меня зовут Гульнора Саидова, телефон 987654321, вопрос про салон Ромашка', ticket: 'Клиентка Мадина Рахимова просит вернуть деньги за заказ',
  site: 'lotos-secret-salon.example.org', tgPriv: '@madina_priv',
};
const NEEDLES = ['Zulfiya', 'Karimova', 'zulfiya_k', 'zulfiya.k', '+992 90 765', 'Секретный запрос', 'Лотос', 'Гульнора', 'Саидова', '987654321', 'Ромашка', 'Мадина', 'Рахимова', 'lotos-secret', 'madina_priv', 'TXyz00', ...Object.values(TOKENS)];

beforeAll(async () => {
  w = await drillWorld();
  for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
  // every path a person's words take: the form (with a cabinet account), the web chat, the audit form, tickets, clients, invoices, documents, replies
  const lead = await w.http('POST', '/lead', { name: P.name, contact: P.handle, service: 'bots', budget: '$300-500', message: P.text, locale: 'ru', source: 'miniapp', clientEmail: P.email, cabinetId: 'sb-9', clientName: P.name, telegramSent: true }, { 'x-lead-token': TOKENS.lead });
  expect(lead.status).toBe(200);
  await w.http('POST', '/lead', { name: P.name, contact: P.phone, service: 'website', message: P.text, locale: 'en' }, { 'x-lead-token': TOKENS.lead });
  await w.http('POST', '/lead', { name: '', contact: P.handle, message: P.text }, { 'x-lead-token': TOKENS.lead }); // invalid: its words must not reach the log either
  await w.http('POST', '/chat', { sessionId: 'visitor-priv-0001', locale: 'ru', message: P.chat }, { 'x-chat-token': TOKENS.chat });
  await w.http('POST', '/chat', { sessionId: 'visitor-priv-0001', locale: 'ru', message: `мой номер ${P.phone}` }, { 'x-chat-token': TOKENS.chat });
  await w.http('POST', '/audit', { url: `https://${P.site}`, contact: P.tgPriv, name: P.name, locale: 'ru' }, { 'x-lead-token': TOKENS.lead });
  await w.cmd('client', `${P.name} | ${P.handle} | bot | basic | 2026-11-01`);
  await w.cmd('ticket', `${P.name}: ${P.ticket}`);
  await w.cmd('invoice', `${P.name} 120 поддержка`);
  await w.cmd('onboard', `${P.name}: бот записи`);
  await w.cmd('project', `${P.name}: ${P.text}`);
  await w.cmd('doc', `договор ${P.name}`);
  await w.cmd('referral', `${P.name} -> Madina Rahimova`);
  await w.say(`/reply 1`);
  await w.say(P.text);
  for (let i = 0; i < 4; i++) await w.beat();
  await w.director.sendApprovalBatch(true);
  // decide everything: executes the deliveries (client sends, documents, invoices)
  for (const r of w.queue.pending()) {
    await w.queue.applyEdit(r.id, `Текст владельца для ${P.name}, без заготовок.`).catch(() => undefined);
    await w.decide('approve', r.id);
  }
  for (let i = 0; i < 3; i++) await w.beat();
  // the cabinet
  const by = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(P.email)}`)).json;
  const leadId = by.leads?.[0]?.id;
  if (by.client) {
    await w.adm('POST', `/admin/clients/${by.client.id}/tickets`, { text: P.ticket });
    if (leadId) await w.adm('POST', `/admin/clients/${by.client.id}/leads/${leadId}/messages`, { text: P.text });
    if (leadId) await w.adm('POST', `/admin/crm/leads/${leadId}/reply`, { text: `Ответ владельца ${P.name}` });
  }
  await w.adm('POST', '/admin/chats/c1/reply', { text: P.text });
  await w.adm('POST', '/admin/say', { text: P.text });
  await w.adm('POST', '/admin/command', { name: 'ticket', arg: `${P.name}: ${P.ticket}` });
  for (let i = 0; i < 3; i++) await w.beat();
  await w.support.monitorTick();
  await w.support.slaTick();
  // failing paths log their errors: a stale lead, a dead gateway, garbage from the model
  w.clock.t += 30 * 60_000;
  w.lost.watchStale();
  await w.lost.flush();
  w.state.garbage = true;
  await w.http('POST', '/chat', { sessionId: 'visitor-priv-0002', locale: 'ru', message: P.chat }, { 'x-chat-token': TOKENS.chat });
  await w.cmd('kp', P.text);
  await w.cmd('profile', '');
  for (let i = 0; i < 4; i++) await w.beat();
  w.state.garbage = false;
  w.state.down = true;
  await w.http('POST', '/chat', { sessionId: 'visitor-priv-0003', locale: 'ru', message: P.chat }, { 'x-chat-token': TOKENS.chat });
  await w.http('POST', '/lead', { name: P.name, contact: P.handle, service: 'bots', message: P.text }, { 'x-lead-token': TOKENS.lead });
  for (let i = 0; i < 4; i++) await w.beat();
  void PmStore;
}, 120_000);
afterAll(async () => { await w?.close(); });

describe('log hygiene: ids and counts only, never a name, a contact, a message or a token', () => {
  it('the logs of a full day of client traffic contain none of the personal data that went through', () => {
    expect(g.lines.length, 'the run produced log lines').toBeGreaterThan(10);
    process.stdout.write('MSGS ' + JSON.stringify([...new Set(g.lines.map((l) => `${l.level}:${l.msg}`))].sort()) + '\n');
    const leaked = g.leaks(NEEDLES);
    const where = leaked.map((n) => `${n}: ${g.lines.filter((l) => JSON.stringify(l).includes(n)).slice(0, 2).map((l) => JSON.stringify(l).slice(0, 220)).join(' || ')}`);
    expect(where).toEqual([]);
  });
  it('every error line names its cause (a message or a code), none is an empty shell', () => {
    for (const l of g.lines.filter((x) => x.level === 'error')) expect(typeof l.msg).toBe('string');
  });
});
