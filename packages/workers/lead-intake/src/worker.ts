import { z } from 'zod';
import { formatSlot, log, tryComplete, tryJson, zonedParts, zonedToMs, type KindSpec, type Payload } from '@fir/core';
import type { Task, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { LeadStore, type Lang, type Lead } from './store.js';
import { guessDeadline, guessNiche, hasMoney, hasPlaceholder, isPriceQuestion, scoreLead, TEMP_RU, tpl } from './text.js';

/**
 * `lead_reply`: the first answer to the client. Starts at `replyLevel` (1 by the brief) and goes through the normal
 * trust counter. `lead_price`: anything with a price or a term; locked at level 0, goes to the client only after the
 * owner filled [цена] / [срок] in.
 */
export const KIND_REPLY = 'lead_reply';
export const KIND_PRICE = 'lead_price';

/** The form lead as the webhook puts it into `task.meta.lead` (same fields as the firtech.pro form). */
export const webLeadSchema = z.object({
  name: z.string().trim().min(1).max(80),
  contact: z.string().trim().min(3).max(120),
  service: z.string().trim().max(40).default('unknown'),
  budget: z.string().trim().max(40).default(''),
  message: z.string().trim().max(2000).default(''),
  estimate: z.string().trim().max(1500).default(''),
  locale: z.enum(['ru', 'en']).default('ru'),
  slot: z.string().trim().max(40).default(''),
  source: z.string().trim().max(40).default(''),
});
export type WebLead = z.output<typeof webLeadSchema>;

export interface LeadIntakeOptions {
  /** Call slots offered to clients, local times in the HQ timezone. Default 11:00 and 15:00. */
  slotHours?: [string, string];
  /** Initial trust level of the first reply. Prices are always locked at 0. */
  replyLevel?: 0 | 1;
}

/** What `deliver` receives when the owner approved (or level 1 auto-approved) a reply. */
export interface Delivery {
  text: string;
  leadId: number;
  contact: string;
  name: string;
  kind: string;
}

const ExtractSchema = z.object({ niche: z.string().default(''), task: z.string().default(''), deadline: z.string().default('') });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.trim());

const stores = new WeakMap<object, LeadStore>();
/** The worker's own tables (`li_*`) live in the shared HQ database. */
export function leadStoreFor(ctx: Pick<WorkerCtx, 'db' | 'now'>): LeadStore {
  let s = stores.get(ctx.db);
  if (!s) {
    s = new LeadStore(ctx.db, ctx.now);
    stores.set(ctx.db, s);
  }
  return s;
}

/** Next two working days (Mon-Fri) after `now`, one slot each: the first at the first hour, the second at the second. */
export function nextSlots(now: number, tz: string, hours: [string, string]): [number, number] {
  const days: { y: number; mo: number; d: number }[] = [];
  let t = now;
  while (days.length < 2) {
    t += 24 * 3600_000;
    const p = zonedParts(t, tz);
    if (p.dow !== 0 && p.dow !== 6) days.push(p);
  }
  const at = (day: { y: number; mo: number; d: number }, hm: string) => {
    const [h, m] = hm.split(':').map(Number) as [number, number];
    return zonedToMs(day.y, day.mo, day.d, h, m, tz);
  };
  return [at(days[0]!, hours[0]), at(days[1]!, hours[1])];
}

/** Lead card for the owner (what the head puts above the reply draft and into the task result). */
export function leadCard(l: Lead, tz: string, service: string, slotText: string): string {
  return [
    `Лид #${l.id}: ${TEMP_RU[l.temperature].toUpperCase()}`,
    `Источник: форма firtech.pro (${service})`,
    `Имя: ${l.name || '-'}`,
    `Контакт: ${l.contact || '-'}`,
    `Ниша: ${l.niche || 'не выяснена'}`,
    `Задача: ${l.task || 'не выяснена'}`,
    `Срок: ${l.deadline || 'не выяснен'}`,
    ...(l.origin ? [`Метка источника: ${l.origin}`] : []),
    ...(l.budget ? [`Бюджет: ${l.budget}`] : []),
    `Звонок: ${slotText}`,
    'Клиент не писал боту: связаться вручную по контакту.',
    `(часовой пояс слотов: ${tz})`,
  ].join('\n');
}

/**
 * Lead intake (Приёмщик лидов): a lead from the site form becomes a card for the owner, a temperature, two call slots
 * and a first reply draft. Nothing goes out by itself: the reply (and a separate price draft when the client asked
 * about money) are proposed through `ctx.requestApproval`. Action `lead`: `task.meta.lead` holds the form fields.
 * Idempotent per task: a rework reuses the lead row and drafts the answer again with `meta.feedback`.
 */
export class LeadIntakeWorker implements Worker {
  readonly id = 'lead-intake';
  private readonly slotHours: [string, string];
  private readonly replyLevel: 0 | 1;

  constructor(opts: LeadIntakeOptions = {}) {
    this.slotHours = opts.slotHours ?? ['11:00', '15:00'];
    this.replyLevel = opts.replyLevel ?? 1;
  }

  /** The approval kinds to register in the HQ; `deliver` hands the approved text to the owner for sending. */
  kindSpecs(ctx: Pick<WorkerCtx, 'db' | 'now'>, deliver: (d: Delivery) => Promise<void>): Record<string, KindSpec> {
    const toDelivery = (p: Payload, kind: string): Delivery => {
      if (typeof p.text !== 'string' || !p.text.trim()) throw new Error('nothing to deliver');
      return { text: p.text, leadId: Number(p.leadId), contact: String(p.contact ?? ''), name: String(p.name ?? ''), kind };
    };
    return {
      [KIND_REPLY]: {
        initialLevel: this.replyLevel,
        execute: async (p) => {
          const d = toDelivery(p, KIND_REPLY);
          if (hasPlaceholder(d.text)) throw new Error('reply still has a placeholder');
          await deliver(d);
        },
      },
      [KIND_PRICE]: {
        initialLevel: 0,
        locked: true,
        execute: async (p) => {
          const d = toDelivery(p, KIND_PRICE);
          if (hasPlaceholder(d.text)) throw new Error('price text still has a placeholder');
          await deliver(d);
          if (Number.isInteger(d.leadId)) {
            const store = leadStoreFor(ctx);
            store.setPriceApproved(d.leadId);
          }
        },
      },
    };
  }

  /** Niche, task and deadline: the model extracts them (strict JSON), plain heuristics when it cannot. */
  private async classify(ctx: WorkerCtx, w: WebLead): Promise<{ niche: string; task: string; deadline: string }> {
    const text = `${w.message} ${w.estimate}`.trim();
    const fallback = {
      niche: guessNiche(text),
      task: clip(w.message || `форма: ${w.service}`, 300),
      deadline: guessDeadline(text),
    };
    const ex = await tryJson(
      ctx.llm,
      {
        tier: 'haiku',
        maxTokens: 300,
        system:
          'Extract from a request to a web and bot studio three fields as JSON only: {"niche":"business type","task":"what they want built","deadline":"when they need it"}. Use an empty string when unknown. Do not invent anything. Reply with the JSON object and nothing else.',
        messages: [{ role: 'user', content: `${w.service}: ${text}`.slice(0, 3000) }],
      },
      ExtractSchema,
    );
    return {
      niche: clip(ex?.niche.trim() || fallback.niche, 100),
      task: clip(ex?.task.trim() || fallback.task, 300),
      deadline: clip(ex?.deadline.trim() || fallback.deadline, 100),
    };
  }

  /** First reply: the model writes it (no numbers, both slots inside), otherwise a template. */
  private async draftReply(ctx: WorkerCtx, l: Lead, slotLines: string, slotsText: string, feedback: string): Promise<string> {
    const t = tpl(l.lang);
    const template = `${t.reply(l.name)} ${l.priceAsked ? `${t.hold} ` : ''}${slotsText}`.replace(/\s+\n/g, '\n');
    const draft = await tryComplete(ctx.llm, {
      tier: 'sonnet',
      maxTokens: 500,
      system: `You write the first reply of Fir Tech studio (websites, Telegram bots, automation) to a person who left a request on the site. Write in ${l.lang === 'ru' ? 'Russian' : 'English'}, polite, at most 4 sentences, no emoji, no markdown, no long dashes. Greet by name, thank for the request, show you understood the task in your own words. Never state a price, number of money or deadline yourself. Then include this call proposal exactly as given, line by line:\n${slotsText}${feedback ? `\nThe reviewer asked to fix: ${feedback}` : ''}`,
      messages: [{ role: 'user', content: `Name: ${l.name}\nBusiness: ${l.niche || 'unknown'}\nTask: ${l.task || 'unknown'}\nPrice asked: ${l.priceAsked ? 'yes (say the team will confirm price and terms)' : 'no'}` }],
    });
    const text = draft?.trim();
    const ok = text && text.length >= 40 && text.length <= 900 && !hasMoney(text) && !hasPlaceholder(text) && !/[—–]/.test(text) && slotLines.split('\n').every((s) => text.includes(s));
    return ok ? text : template;
  }

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    if (task.meta.action !== 'lead') return { ok: false, result: '', error: `Неизвестное действие: ${String(task.meta.action)}` };
    const parsed = webLeadSchema.safeParse(task.meta.lead);
    if (!parsed.success) return { ok: false, result: '', error: 'В задаче нет корректных данных лида' };
    const w = parsed.data;
    const store = leadStoreFor(ctx);
    const feedback = typeof task.meta.feedback === 'string' ? task.meta.feedback : '';
    const lang: Lang = w.locale;
    const c = await this.classify(ctx, w);
    const priceAsked = isPriceQuestion(`${w.message} ${w.estimate}`);
    const picked = Date.parse(w.slot);
    const chosenSlot = Number.isNaN(picked) ? null : picked;
    const slots = chosenSlot ? [chosenSlot] : nextSlots(ctx.now(), ctx.tz, this.slotHours);
    const base = { name: clip(w.name, 80), contact: clip(w.contact, 120), service: w.service, ...c, budget: clip(w.budget, 40), origin: w.source, lang, slots, chosenSlot, priceAsked };
    const temperature = scoreLead({ ...base }, { estimate: Boolean(w.estimate) });
    const lead = store.upsert(task.id, { ...base, temperature });

    const t = tpl(lang);
    const slotText = chosenSlot ? formatSlot(chosenSlot, ctx.tz, 'ru') : `предложены: ${slots.map((s) => formatSlot(s, ctx.tz, 'ru')).join(' / ')}`;
    const card = leadCard(lead, ctx.tz, w.service, slotText);
    const slotLines = chosenSlot ? t.slotChosen(formatSlot(chosenSlot, ctx.tz, lang)) : slots.map((s) => formatSlot(s, ctx.tz, lang)).join('\n');
    const slotsText = chosenSlot ? slotLines : t.slots(formatSlot(slots[0]!, ctx.tz, lang), formatSlot(slots[1]!, ctx.tz, lang));
    const reply = await this.draftReply(ctx, lead, slotLines, slotsText, feedback);

    await ctx.requestApproval(
      KIND_REPLY,
      { text: reply, leadId: lead.id, contact: lead.contact, name: lead.name },
      `${card}\n\nПервый ответ клиенту. Отправьте его сами по контакту (одобрение = «ответ ушёл»).`,
    );
    if (priceAsked) {
      const draft =
        (await tryComplete(ctx.llm, {
          tier: 'sonnet',
          maxTokens: 400,
          system: `You draft a short reply to a client of a web and Telegram-bot studio who asks about price or timing. Write in ${lang === 'ru' ? 'Russian' : 'English'}. Never state a number, price or deadline yourself: put [price] and [term] placeholders for the owner to fill. Two sentences at most, polite, no emoji.`,
          messages: [{ role: 'user', content: `Business: ${lead.niche || 'unknown'}\nTask: ${lead.task || 'unknown'}\nDeadline wish: ${lead.deadline || 'unknown'}` }],
        })) ?? t.priceDraft;
      const safe = hasMoney(draft) || !hasPlaceholder(draft) ? t.priceDraft : draft;
      await ctx.requestApproval(
        KIND_PRICE,
        { text: safe, leadId: lead.id, contact: lead.contact, name: lead.name },
        `Клиент спрашивает цену или сроки. Лид #${lead.id}: ниша ${lead.niche || '?'}, задача ${lead.task || '?'}, срок ${lead.deadline || '?'}. Нажмите «Править» и впишите цену и срок вместо меток.`,
      );
    }
    log('info', 'lead processed', { leadId: lead.id, temperature, priceAsked });
    ctx.log('lead', `lead ${lead.id} ${temperature}`);
    return { ok: true, result: `${card}\n\nЧерновик первого ответа:\n${reply}${priceAsked ? '\n\nЗапрошена цена: отдельное предложение уровня 0 с метками [цена] / [срок].' : ''}` };
  }
}
