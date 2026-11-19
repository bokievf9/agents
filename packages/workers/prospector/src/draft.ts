import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryJson, withPlaybook, type LlmClient } from '@fir/core';
import { z } from 'zod';
import { offerFor, priceLabel } from './offers.js';
import type { Prospect } from './store.js';

export interface Prompts {
  first: string;
  followup: string;
  reply: string;
}

export function loadPrompts(dir: string): Prompts {
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  return { first: read('first.md'), followup: read('followup.md'), reply: read('reply.md') };
}

const Reply = z.object({ message: z.string().min(1) });
const SENDER = 'Фирдавс';

const MONEY = /(\$\s?\d|\d\s?(\$|usd|долл|сум|тенге|сом|руб|₽|₸)|\d\s?(к|тыс)\b)/i;
const LONG_DASH = /[—–]/;
/** Metka for the owner: price or term to fill in by hand. Such a draft cannot be marked as sent. */
export const PLACEHOLDER = /\[(цена|срок)\]/i;

/** The first message: 2-4 sentences' worth of text, the approved price, exactly one question. */
export function checkFirst(text: string, price: string): boolean {
  if (text.length < 60 || text.length > 700 || LONG_DASH.test(text) || PLACEHOLDER.test(text)) return false;
  if (!text.includes(price)) return false;
  const rest = text.split(price).join('');
  return !MONEY.test(rest) && (text.match(/\?/g) ?? []).length === 1;
}

export function checkFollowup(text: string): boolean {
  return text.length >= 20 && text.length <= 400 && !LONG_DASH.test(text) && !MONEY.test(text) && !PLACEHOLDER.test(text) && text.includes('?');
}

/** Answers never carry money: the model leaves [цена] and the owner approves the numbers (level 0). */
export function checkReply(text: string): boolean {
  return text.length >= 10 && text.length <= 800 && !LONG_DASH.test(text) && !MONEY.test(text);
}

export function firstFallback(p: Prospect): string {
  const price = priceLabel(offerFor(p.offer));
  const hook = p.hook || `${p.name}: ${p.noticed}`;
  return `Здравствуйте! Это ${SENDER} из Fir Tech. ${hook.replace(/[—–]/g, '-')} Настроим под ваши услуги, ${price}. Как у вас сейчас принимают заявки?`;
}

export function followupFallback(stage: 1 | 2): string {
  return stage === 1
    ? 'Добрый день! Напомню про моё сообщение: могу за 5 минут показать, как это выглядит на вашем прайсе. Актуально?'
    : 'Последний раз напишу про бота для записи. Если сейчас не актуально, просто скажите, больше не побеспокою. Вернуться к вопросу позже?';
}

export function replyFallback(): string {
  return 'Спасибо, что ответили! Давайте коротко созвонимся, я покажу пример на ваших данных. Удобно сегодня или завтра в 11:00 или в 15:00 по Ташкенту?';
}

async function ask(llm: LlmClient, system: string, input: unknown, ok: (t: string) => boolean): Promise<string | null> {
  const res = await tryJson(llm, { tier: 'sonnet', system: withPlaybook(system, 'sales'), messages: [{ role: 'user', content: JSON.stringify(input) }], maxTokens: 600 }, Reply);
  const text = res?.message.trim();
  return text && ok(text) ? text : null;
}

export async function draftFirst(llm: LlmClient, prompts: Prompts, p: Prospect): Promise<string> {
  const offer = offerFor(p.offer);
  const price = priceLabel(offer);
  const input = { business: p.name, city: p.city, niche: p.niche, noticed: p.noticed, hook: p.hook, offer: offer.title, price, sender: SENDER };
  return (await ask(llm, prompts.first, input, (t) => checkFirst(t, price))) ?? firstFallback(p);
}

export async function draftFollowup(llm: LlmClient, prompts: Prompts, p: Prospect, stage: 1 | 2, firstMessage: string): Promise<string> {
  const input = { business: p.name, city: p.city, niche: p.niche, first_message: firstMessage, stage, sender: SENDER };
  return (await ask(llm, prompts.followup, input, checkFollowup)) ?? followupFallback(stage);
}

export async function draftReply(llm: LlmClient, prompts: Prompts, p: Prospect, ourMessages: string, replyText: string): Promise<string> {
  const input = { business: p.name, city: p.city, niche: p.niche, offer: offerFor(p.offer).title, our_messages: ourMessages, reply: replyText, sender: SENDER };
  return (await ask(llm, prompts.reply, input, checkReply)) ?? replyFallback();
}
