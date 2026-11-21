import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockLlm, openDb, type Button, type LlmRequest } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { ClientBlockedError } from '../src/client/channel.js';
import { ClientEngine, type ClientSinks, type ClientTransport, type From } from '../src/client/engine.js';
import { decodeBuild } from '../src/client/builder-link.js';
import { instructionsDir, NOW, OWNER } from './sales-helpers.js';

/** ИИ-менеджер заявок 2.0 in the Telegram client bot: the same receptionist, no Telegram offer (the person is already there), a call becomes a lead with the summary. */
class Transport implements ClientTransport {
  private id = 1000;
  readonly sent: { chatId: number; html: string; buttons?: Button[][] }[] = [];
  send(chatId: number, html: string, buttons?: Button[][]): Promise<number> {
    if (chatId < 0) return Promise.reject(new ClientBlockedError(chatId));
    this.sent.push({ chatId, html, ...(buttons ? { buttons } : {}) });
    return Promise.resolve(++this.id);
  }
  edit(): Promise<void> { return Promise.resolve(); }
  clearButtons(): Promise<void> { return Promise.resolve(); }
  typing(): Promise<void> { return Promise.resolve(); }
  to(chatId: number) { return this.sent.filter((m) => m.chatId === chatId); }
}

const CLIENT = 555_002;
const ME: From = { chatId: CLIENT, username: 'rustam_cafe', firstName: 'Рустам', langCode: 'ru' };
const json = (o: object) => JSON.stringify(o);

function world(turns: (req: LlmRequest, n: number) => string) {
  const clock = { t: NOW };
  const db = openDb(':memory:');
  const llm = new MockLlm((req, n) => turns(req, n));
  const transport = new Transport();
  const engine = new ClientEngine({
    db, now: () => clock.t, tz: () => 'Asia/Dushanbe', transport, llm, ownerId: OWNER, instructions: readFileSync(join(instructionsDir, 'client-bot.md'), 'utf8'), perHour: 50, dailyCap: 300,
  });
  const leads: Record<string, unknown>[] = [];
  const sinks: ClientSinks = { createLead: (lead) => (leads.push(lead), leads.length), createTicket: () => Promise.resolve(1), findClient: () => null, leadSlots: () => null };
  engine.connect(sinks);
  const say = async (text: string) => {
    const before = transport.to(CLIENT).length;
    await engine.onText(ME, text);
    return transport.to(CLIENT).slice(before).map((m) => m.html).join('\n');
  };
  return { engine, transport, leads, llm, say };
}

const cafeModel = (_req: LlmRequest, n: number): string =>
  n === 1
    ? json({ reply: 'Кафе, понятно. Что сейчас мешает больше всего: ночью никто не отвечает или заказы теряются?', extract: { kind: 'cafe', niche: 'кафе' } })
    : json({ reply: 'Ясно, ночью заявки остаются без ответа. Для кафе подойдёт ИИ-приёмщик заявок.', ready: true, extract: { pain: 'ночью никто не отвечает', product: 'receptionist', channels: ['instagram'] } });

describe('the receptionist in the Telegram bot', () => {
  it('qualifies, proposes the builder link and a call, and never offers Telegram (the person is in it)', async () => {
    const w = world(cafeModel);
    await w.engine.onCommand(ME, 'start', '');
    const a = await w.say('У меня кафе в Душанбе');
    expect(a).toMatch(/Что сейчас мешает больше всего/);
    const b = await w.say('Ночью никто не отвечает в Instagram');
    expect(b).toMatch(/https:\/\/firtech\.pro\/ru\/builder\?b=/);
    expect(b).toMatch(/напишите «созвон»/);
    expect(b).not.toMatch(/t\.me|Telegram/);
    const code = decodeURIComponent(/builder\?b=([^\s]+)/.exec(b)![1]!);
    expect(decodeBuild(code)).toMatchObject({ kind: 'cafe', products: ['intake'], channels: ['instagram'] });
    expect(w.leads).toEqual([]);
    expect(w.engine.store.get(CLIENT)!.draft.q).toMatchObject({ kind: 'cafe', product: 'receptionist', turns: 2 });
  });

  it('a call asked for becomes a lead with the conversation summary, the family, the niche, the score and the link', async () => {
    const w = world(cafeModel);
    await w.engine.onCommand(ME, 'start', '');
    await w.say('У меня кафе в Душанбе');
    await w.say('Ночью никто не отвечает в Instagram');
    const r = await w.say('Давайте созвонимся');
    expect(r).toMatch(/созвон/);
    expect(w.leads).toHaveLength(1);
    const lead = w.leads[0]!;
    expect(lead).toMatchObject({ chatId: CLIENT, service: 'bots', product: 'ИИ-приёмщик заявок 24/7', source: 'telegram' });
    const e = lead.enrichment as { summary: string[]; productFamily: string; niche: string; intentScore: number; builderLink: string };
    expect(e.summary).toHaveLength(3);
    expect(e).toMatchObject({ productFamily: 'receptionist', niche: 'кафе' });
    expect(e.builderLink).toMatch(/^\/ru\/builder\?b=k\.cafe~p\.intake/);
    expect(e.intentScore).toBeGreaterThan(40);
    // asked once: a second call request does not make a second lead
    await w.say('Созвон лучше завтра');
    expect(w.leads).toHaveLength(1);
  });

  it('a person asked for: the bot goes quiet and the owner is called (the older hand-off), the model is not asked', async () => {
    const w = world(cafeModel);
    await w.engine.onCommand(ME, 'start', '');
    await w.say('У меня кафе в Душанбе');
    const calls = w.llm.calls.length;
    await w.engine.onText(ME, 'Позовите живого менеджера');
    expect(w.llm.calls.length).toBe(calls);
    expect(w.engine.store.get(CLIENT)!.muted).toBe(true);
    expect(w.transport.to(OWNER).some((m) => /Зовут человека/.test(m.html))).toBe(true);
  });

  it('a price question keeps the template and calls no model', async () => {
    const w = world(cafeModel);
    await w.engine.onCommand(ME, 'start', '');
    const r = await w.say('Сколько стоит бот?');
    expect(w.llm.calls).toHaveLength(0);
    expect(r).toMatch(/Цены на сайте, в долларах/);
  });
});
