import type { Enrichment, Lang, Lead, Temperature } from './store.js';

const CYR = /[Ѐ-ӿ]/g;
const LAT = /[A-Za-z]/g;

/** Russian unless the client clearly writes English. */
export function detectLang(text: string, fallback: Lang = 'ru'): Lang {
  const cyr = (text.match(CYR) ?? []).length;
  const lat = (text.match(LAT) ?? []).length;
  if (cyr + lat < 4) return fallback;
  return lat > cyr ? 'en' : 'ru';
}

export const isPriceQuestion = (text: string): boolean =>
  /сколько\s+(это\s+)?(стоит|будет|денег)|за\s+сколько|\bцен[аыуе]\b|стоимост|прайс|расценк|тариф|\bprice|pricing|\bcost|how much|\bquote\b|how long will/i.test(text);

const NICHES: [RegExp, string][] = [
  [/салон|барбер|маникюр|парикмах|beauty|salon|barber/i, 'салон красоты / барбершоп'],
  [/стоматолог|зубн|клиник|dental|dentist|clinic/i, 'стоматология / клиника'],
  [/учебн|курс|репетитор|школ[аыу]|обучен|tutor|course|school|academy/i, 'учебный центр / репетитор'],
  [/магазин|интернет-магазин|товар|shop|store|e-?commerce/i, 'магазин'],
  [/кафе|ресторан|доставк|еда|cafe|restaurant|delivery|food/i, 'кафе / доставка еды'],
  [/автосервис|сто\b|авто|car service|garage/i, 'автосервис'],
  [/фитнес|спортзал|gym|fitness/i, 'фитнес'],
  [/недвижимост|риелтор|real estate/i, 'недвижимость'],
  [/турагент|туризм|travel/i, 'турагентство'],
];

export function guessNiche(text: string): string {
  return NICHES.find(([re]) => re.test(text))?.[1] ?? '';
}

const DEADLINE = /срочно|как можно скорее|сегодня|завтра|на этой неделе|до конца (недели|месяца)|до \d{1,2}[\s./]\S+|\b\d+\s*(дн|недел|месяц|day|week|month)\w*|за\s+(неделю|месяц|пару недель)|asap|urgent|this week|next week|by (the )?end of/i;
const URGENT = /срочно|как можно скорее|сегодня|завтра|на этой неделе|asap|urgent|this week|за неделю|\b[1-9]\s*(дн|day)\w*|\b[1-3]\s*(недел|week)\w*/i;

export function guessDeadline(text: string): string {
  const m = DEADLINE.exec(text);
  return m ? m[0] : '';
}
export const isUrgent = (text: string): boolean => URGENT.test(text);

/** Rough "hot / warm / cold" from what is known; deterministic so it works with LLM off. */
export function scoreLead(lead: Pick<Lead, 'niche' | 'task' | 'deadline' | 'budget' | 'priceAsked' | 'chosenSlot'>, extra: { estimate?: boolean } = {}): Temperature {
  let p = 0;
  if (lead.task) p += 1;
  if (lead.niche) p += 1;
  if (lead.deadline) p += 1;
  if (isUrgent(lead.deadline)) p += 2;
  if (lead.budget) p += 1;
  if (extra.estimate) p += 1;
  if (lead.priceAsked) p += 1;
  if (lead.chosenSlot) p += 2;
  return p >= 5 ? 'hot' : p >= 3 ? 'warm' : 'cold';
}

export const TEMP_RU: Record<Temperature, string> = { hot: 'горячий', warm: 'тёплый', cold: 'холодный' };

const T = {
  ru: {
    reply: (name: string) => `Здравствуйте${name ? `, ${name}` : ''}! Спасибо за заявку в Fir Tech.`,
    slots: (a: string, b: string) => `Предлагаю короткий звонок, на выбор:\n1) ${a}\n2) ${b}\nНапишите 1 или 2, или назовите другое время.`,
    slotChosen: (s: string) => `Записал звонок: ${s}. Подтвержу время и свяжусь с вами.`,
    hold: 'Стоимость и сроки уточню с командой и вернусь с цифрами.',
    priceDraft: 'Стоимость и сроки по вашей задаче: [цена], [срок]. Если удобно, обсудим детали на звонке.',
  },
  en: {
    reply: (name: string) => `Hello${name ? `, ${name}` : ''}! Thank you for your request to Fir Tech.`,
    slots: (a: string, b: string) => `I suggest a short call, pick one:\n1) ${a}\n2) ${b}\nReply 1 or 2, or suggest another time.`,
    slotChosen: (s: string) => `Noted the call: ${s}. I will confirm the time and get in touch.`,
    hold: 'I am confirming the price and timing with the team and will come back with numbers.',
    priceDraft: 'Price and timing for your task: [price], [term]. Happy to go through the details on a call.',
  },
} as const;

export const tpl = (lang: Lang) => T[lang];

/** A draft that still carries a [placeholder] must never go to a client. */
export const hasPlaceholder = (text: string): boolean => /\[[^\]]*\]/.test(text);

/** Any amount of money: a model draft with a number in it is not allowed to name prices itself. */
export const hasMoney = (text: string): boolean => /(\$\s?\d|\d\s?(\$|usd|долл|сум|тенге|сом|руб|₽|₸)|\d\s?(к|тыс)\b)/i.test(text);

/** The site path of a builder link (`/ru/builder?b=...`, also the estimate page) found in a text, or ''. */
export function builderLinkIn(text: string): string {
  return /\/(?:ru|en)\/builder(?:\/estimate)?\?b=[^\s)"'<>]+/.exec(text)?.[0] ?? '';
}

const FAMILY_OF_SERVICE: Record<string, string> = { web: 'site', websites: 'site', site: 'site', bots: 'bot', bot: 'bot', app: 'app', automation: 'automation', bundle: 'bundle' };
const INTENT_OF: Record<Temperature, number> = { hot: 80, warm: 55, cold: 25 };

/**
 * The enrichment of a lead that did not bring its own (the contact form, the builder hand-off, the cabinet): the first lines of its words, the product family
 * of its service or chosen product, its niche, an intent score from its temperature and the builder link of its estimate. Pure.
 */
export function deriveEnrichment(l: { message: string; estimate: string; service: string; product: string; niche: string; temperature: Temperature }): Enrichment {
  const lines = `${l.message}\n${l.estimate}`.split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length > 2 && !/https?:\/\/|\/(?:ru|en)\/builder/.test(x));
  const family = l.product || FAMILY_OF_SERVICE[l.service.toLowerCase()] || (l.service && l.service !== 'unknown' && l.service !== 'other' ? l.service : '');
  return {
    summary: lines.slice(0, 3).map((x) => (x.length > 160 ? `${x.slice(0, 159)}…` : x)),
    productFamily: family,
    niche: l.niche,
    intentScore: INTENT_OF[l.temperature],
    builderLink: builderLinkIn(l.estimate) || builderLinkIn(l.message),
  };
}

/** The lines of a lead card about the conversation (empty when there is nothing to show). */
export function enrichmentLines(e: Enrichment | null | undefined): string[] {
  if (!e) return [];
  return [
    ...(e.summary.length ? ['Разговор:', ...e.summary.map((x) => `  ${x}`)] : []),
    ...(e.productFamily ? [`Семейство продукта: ${e.productFamily}`] : []),
    `Намерение: ${e.intentScore}/100`,
    ...(e.builderLink ? [`Сборка, которую предложил ИИ-менеджер заявок: ${e.builderLink}`] : []),
  ];
}
