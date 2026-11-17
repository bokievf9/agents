import { z } from 'zod';
import { formatSlot, log, tryComplete, tryJson, zonedParts, zonedToMs, type ApprovalQueue, type LlmClient, type Messenger } from '@fir/core';
import type { Config } from './config.js';
import { exportLeads } from './exporter.js';
import type { Field, Lang, Lead, LeadStore } from './store.js';
import { detectLang, guessDeadline, guessNiche, hasPlaceholder, isPriceQuestion, scoreLead, TEMP_RU, tpl } from './text.js';

export const KIND_REPLY = 'client_reply';
export const KIND_PRICE = 'price_quote';
const FIELDS: Field[] = ['niche', 'task', 'deadline'];
const MAX_QUESTIONS = 3;
const STALE_MS = 24 * 3600_000;

export interface IncomingMessage {
  chatId: number;
  name: string;
  username?: string | undefined;
  isBot: boolean;
  text: string;
}

export interface WebLead {
  name: string;
  contact: string;
  service: string;
  budget: string;
  message: string;
  estimate: string;
  locale: Lang;
  slot: string;
}

type AgentConfig = Pick<Config, 'ownerId' | 'tz' | 'slotHours' | 'rateLimit' | 'rateWindowMs' | 'leadsFile' | 'replyLevel'>;

export interface AgentDeps {
  store: LeadStore;
  queue: ApprovalQueue;
  messenger: Messenger;
  llm: LlmClient;
  cfg: AgentConfig;
  now?: () => number;
}

const ExtractSchema = z.object({ niche: z.string().default(''), task: z.string().default(''), deadline: z.string().default('') });

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.trim());

/**
 * The lead intake head: answers a client at once, asks at most three short questions (business, task,
 * deadline), offers two call slots, hands the owner a lead card. Prices and terms go to the owner as a
 * `price_quote` approval and reach the client only after "approve". Logs hold ids and counts, no client text.
 */
export class LeadAgent {
  private readonly now: () => number;
  constructor(private readonly d: AgentDeps) {
    this.now = d.now ?? Date.now;
    d.queue.register(KIND_REPLY, {
      initialLevel: d.cfg.replyLevel,
      execute: (p) => this.deliver(p),
    });
    d.queue.register(KIND_PRICE, { initialLevel: 0, locked: true, execute: (p) => this.deliverPrice(p) });
  }

  // ---- Telegram client messages ----

  async onClientMessage(m: IncomingMessage): Promise<void> {
    const { store } = this.d;
    if (m.isBot) return;
    const text = m.text.trim().slice(0, 2000);
    if (!text) return;
    const t = this.now();
    if (store.recentClientMessages(m.chatId, t - this.d.cfg.rateWindowMs) >= this.d.cfg.rateLimit) {
      log('warn', 'rate limited, message ignored');
      return;
    }
    const isStart = text === '/start';
    let lead: Lead =
      store.byChat(m.chatId) ??
      store.create({
        source: 'telegram', chatId: m.chatId, name: clip(m.name, 80),
        contact: m.username ? `@${m.username}` : `tg:${m.chatId}`, lang: detectLang(text), state: 'asking',
      });
    if (isStart) {
      await this.say(lead, tpl(lead.lang).greet);
      return;
    }
    store.addMessage(lead.id, 'client', text);
    lead = store.update(lead.id, { lang: detectLang(text, lead.lang) });

    if (isPriceQuestion(text)) await this.onPriceQuestion(lead);

    if (lead.state === 'card_sent') return this.afterCard(lead, text);
    lead = await this.fill(lead, text);
    const missing = FIELDS.filter((f) => !lead[f]);
    if (missing.length && lead.questions < MAX_QUESTIONS) {
      const field = missing[0]!;
      lead = store.update(lead.id, { askField: field, questions: lead.questions + 1 });
      await this.say(lead, tpl(lead.lang).ask[field]);
      return;
    }
    await this.finish(lead, true);
  }

  /** Merge what the message tells us: LLM extraction when on, plain heuristics otherwise. */
  private async fill(lead: Lead, text: string): Promise<Lead> {
    const patch: Partial<Record<Field, string>> = {};
    const extracted = await tryJson(
      this.d.llm,
      {
        tier: 'haiku',
        maxTokens: 300,
        system:
          'Extract from a client dialogue with a web and bot studio three fields as JSON only: {"niche":"business type","task":"what they want built","deadline":"when they need it"}. Use an empty string when unknown. Do not invent anything. Reply with the JSON object and nothing else.',
        messages: [{ role: 'user', content: this.d.store.clientTexts(lead.id).join('\n---\n') }],
      },
      ExtractSchema,
    );
    for (const f of FIELDS) {
      if (lead[f]) continue;
      const v = extracted?.[f]?.trim();
      if (v) patch[f] = clip(v, 300);
    }
    if (!extracted) {
      if (!lead.niche) patch.niche = guessNiche(text);
      if (!lead.deadline) patch.deadline = guessDeadline(text);
      // The answer to the question just asked belongs to that field; the first free-form message is the task.
      if (lead.askField && !lead[lead.askField] && !patch[lead.askField]) patch[lead.askField] = clip(text, 300);
      else if (!lead.task && !lead.askField && text.length >= 12) patch.task = clip(text, 300);
    }
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v));
    return Object.keys(clean).length ? this.d.store.update(lead.id, clean) : lead;
  }

  /** Enough answers (or three questions asked): offer slots, send the card. */
  private async finish(lead: Lead, offerSlots: boolean): Promise<void> {
    const { store } = this.d;
    let l = lead;
    if (offerSlots && l.chatId !== null) {
      const slots = this.nextSlots();
      l = store.update(l.id, { slots, askField: null });
      const [a, b] = slots.map((s) => formatSlot(s, this.d.cfg.tz, l.lang)) as [string, string];
      await this.say(l, tpl(l.lang).slots(a, b));
    }
    l = store.update(l.id, { state: 'card_sent', temperature: scoreLead(l) });
    await this.sendCard(l);
  }

  private async afterCard(lead: Lead, text: string): Promise<void> {
    const { store } = this.d;
    const choice = /^\s*([12])\s*[.)]?\s*$/.exec(text)?.[1];
    if (choice && lead.slots.length === 2 && !lead.chosenSlot) {
      const slot = lead.slots[Number(choice) - 1]!;
      const l = store.update(lead.id, { chosenSlot: slot });
      const when = formatSlot(slot, this.d.cfg.tz, l.lang);
      await this.say(l, tpl(l.lang).slotChosen(when));
      const scored = store.update(l.id, { temperature: scoreLead(l) });
      await this.d.messenger.send(this.d.cfg.ownerId, `Лид #${l.id}: клиент выбрал звонок ${formatSlot(slot, this.d.cfg.tz, 'ru')}. Оценка: ${TEMP_RU[scored.temperature]}.`);
      this.export();
      return;
    }
    if (isPriceQuestion(text)) return; // already handled: holding message and price proposal
    await this.d.messenger.send(this.d.cfg.ownerId, `Лид #${lead.id} (${lead.name || lead.contact}) пишет:\n${clip(text, 600)}`);
    await this.say(lead, tpl(lead.lang).followUp);
  }

  // ---- prices and terms: always through the owner ----

  private async onPriceQuestion(lead: Lead): Promise<void> {
    const { queue, store } = this.d;
    const l = store.update(lead.id, { priceAsked: true, temperature: scoreLead({ ...lead, priceAsked: true }) });
    const open = queue.pending().some((p) => p.kind === KIND_PRICE && p.payload.leadId === l.id);
    if (open) return;
    await this.say(l, tpl(l.lang).hold);
    const draft =
      (await tryComplete(this.d.llm, {
        tier: 'sonnet',
        maxTokens: 400,
        system: `You draft a short reply to a client of a web and Telegram-bot studio who asks about price or timing. Write in ${l.lang === 'ru' ? 'Russian' : 'English'}. Never state a number, price or deadline yourself: put [price] and [term] placeholders for the owner to fill. Two sentences at most, polite, no emoji.`,
        messages: [{ role: 'user', content: `Business: ${l.niche || 'unknown'}\nTask: ${l.task || 'unknown'}\nDeadline wish: ${l.deadline || 'unknown'}` }],
      })) ?? tpl(l.lang).priceDraft;
    await queue.propose(
      KIND_PRICE,
      { text: draft, chatId: l.chatId, leadId: l.id },
      `Клиент спрашивает цену или сроки. Лид #${l.id}: ниша ${l.niche || '?'}, задача ${l.task || '?'}, срок ${l.deadline || '?'}. Нажмите «Править» и впишите цену и срок вместо [цена] и [срок].`,
    );
  }

  private async deliverPrice(p: { text?: string; chatId?: unknown; leadId?: unknown }): Promise<void> {
    if (typeof p.text !== 'string' || hasPlaceholder(p.text)) throw new Error('price text still has a placeholder');
    await this.deliver(p);
    if (typeof p.leadId === 'number') {
      const l = this.d.store.update(p.leadId, { priceApproved: true });
      this.d.store.update(l.id, { temperature: scoreLead(l) });
      this.export();
    }
  }

  // ---- web form ----

  async onWebLead(w: WebLead): Promise<number> {
    const { store } = this.d;
    const text = `${w.message} ${w.estimate}`;
    let lead = store.create({ source: 'web', chatId: null, name: clip(w.name, 80), contact: clip(w.contact, 120), lang: w.locale, state: 'card_sent' });
    store.addMessage(lead.id, 'client', clip(`${w.service}: ${w.message}`, 2000));
    const slot = Date.parse(w.slot);
    lead = store.update(lead.id, {
      task: clip(w.message || `форма: ${w.service}`, 300),
      niche: guessNiche(text),
      deadline: guessDeadline(text),
      budget: clip(w.budget, 40),
      ...(Number.isNaN(slot) ? {} : { chosenSlot: slot, slots: [slot] }),
    });
    lead = store.update(lead.id, { temperature: scoreLead(lead, { estimate: Boolean(w.estimate) }) });
    log('info', 'lead created', { leadId: lead.id, source: 'web' });
    await this.sendCard(lead, w.service);
    return lead.id;
  }

  // ---- owner side ----

  async sendCard(lead: Lead, service?: string): Promise<void> {
    const slot = lead.chosenSlot ? formatSlot(lead.chosenSlot, this.d.cfg.tz, 'ru') : lead.slots.length ? 'предложены, ответа нет' : 'нет';
    const rows = [
      `Лид #${lead.id}: ${TEMP_RU[lead.temperature].toUpperCase()}`,
      `Источник: ${lead.source === 'web' ? 'форма firtech.pro' : 'Telegram-бот'}${service ? ` (${service})` : ''}`,
      `Имя: ${lead.name || '-'}`,
      `Контакт: ${lead.contact || '-'}`,
      `Ниша: ${lead.niche || 'не выяснена'}`,
      `Задача: ${lead.task || 'не выяснена'}`,
      `Срок: ${lead.deadline || 'не выяснен'}`,
      ...(lead.budget ? [`Бюджет: ${lead.budget}`] : []),
      `Звонок: ${slot}`,
      ...(lead.source === 'web' ? ['Клиент не писал боту: связаться вручную по контакту.'] : []),
    ];
    await this.d.messenger.send(this.d.cfg.ownerId, rows.join('\n'));
    this.export();
  }

  /** Daily job: a client who went silent for 24 hours still gets a card with what we know. */
  async finalizeStale(): Promise<number> {
    const stale = this.d.store.staleAsking(this.now() - STALE_MS);
    for (const l of stale) await this.finish(l, false);
    return stale.length;
  }

  export(): void {
    exportLeads(this.d.cfg.leadsFile, this.d.store.withCards());
  }

  // ---- sending to the client ----

  /** Ordinary reply (questions, holding answer): level 1 sends at once, level 0 asks the owner first. */
  private async say(lead: Lead, text: string): Promise<void> {
    if (lead.chatId === null) return;
    await this.d.queue.propose(KIND_REPLY, { text, chatId: lead.chatId, leadId: lead.id }, `Ответ клиенту (лид #${lead.id})`);
  }

  private async deliver(p: { text?: string; chatId?: unknown; leadId?: unknown }): Promise<void> {
    if (typeof p.text !== 'string' || typeof p.chatId !== 'number') throw new Error('nothing to deliver');
    await this.d.messenger.send(p.chatId, p.text);
    if (typeof p.leadId === 'number') this.d.store.addMessage(p.leadId, 'agent', p.text);
  }

  private nextSlots(): [number, number] {
    const { tz, slotHours } = this.d.cfg;
    const days: { y: number; mo: number; d: number }[] = [];
    let t = this.now();
    while (days.length < 2) {
      t += 24 * 3600_000;
      const p = zonedParts(t, tz);
      if (p.dow !== 0 && p.dow !== 6) days.push(p);
    }
    const at = (day: { y: number; mo: number; d: number }, hm: string) => {
      const [h, m] = hm.split(':').map(Number) as [number, number];
      return zonedToMs(day.y, day.mo, day.d, h, m, tz);
    };
    return [at(days[0]!, slotHours[0]), at(days[1]!, slotHours[1])];
  }
}
