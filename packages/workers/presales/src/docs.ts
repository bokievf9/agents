import { costsLine, tryJson, usd, zonedParts, type LlmClient } from '@fir/core';
import { z } from 'zod';
import { DOC_RU, type NewDoc } from './store.js';
import { supportMonthlyUsd, type Offer } from './offers.js';
import type { PackageQuote } from './package.js';
import { render, type Templates } from './template.js';

/** The studio's payment (owner decision 2026-11-19): USDT on TRC20 or TON, or an online wallet named in the estimate. */
export const PAYMENT_METHODS = 'USDT (сеть TRC20 или TON) или онлайн-кошелёк, который назван в смете';
export const DAY = 86_400_000;

export interface PresalesTerms {
  prepaymentPercent: number;
  validDays: number;
}

/** What the proposal is about. The Sales head gets it from a lead card or from the owner's `/kp <text>`. */
export interface Brief {
  leadId: number | null;
  client: string;
  niche: string;
  request: string;
  /** The builder's summary from the site (the chosen package, its total); the package is read from it. */
  estimate?: string;
  /** What the client already has: true or false when known, null or absent when nobody asked (the КП then says both are paid by the client). */
  hasDomain?: boolean | null;
  hasHosting?: boolean | null;
}

const Wording = z.object({
  context: z.string().min(1).max(600),
  problem: z.string().min(1).max(600),
  solution: z.string().min(1).max(900),
  scope: z.array(z.string().min(1).max(200)).min(5).max(8),
});
export type Wording = z.infer<typeof Wording>;

const MONEY = /(\$\s?\d|\d\s?(\$|usd|долл|сум|тенге|сом|руб|₽|₸|%)|\d\s?(к|тыс)\b)/i;
const TERM = /\d+\s*(дн|рабоч|недел|мес|час)/i;
const LONG_DASH = /[—–]/;
const MARK = /\[(цена|срок)\]/gi;

/** The model may write only wording: no numbers with money or terms, no long dashes. `[цена]` and `[срок]` are allowed. */
export function wordingOk(w: Wording): boolean {
  return [w.context, w.problem, w.solution, ...w.scope].every((s) => {
    const bare = s.replace(MARK, '');
    return !MONEY.test(bare) && !TERM.test(bare) && !LONG_DASH.test(bare);
  });
}

/** The exact price of the package: one total, with the monthly fee of a subscription after a plus sign. No «от». */
export const exactLabel = (q: PackageQuote): string => `${usd(q.totalUsd)}${q.monthlyUsd ? ` + ${usd(q.monthlyUsd)} в месяц` : ''}`;

/** Template fills the marks from the price list and the offers table: the only way a price gets into the text. */
export function fillMarks(text: string, o: Offer, q: PackageQuote): string {
  return text.replace(MARK, (_m, k: string) => (k.toLowerCase() === 'цена' ? exactLabel(q) : o.timeline));
}

const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);
const BLANK = '____________';

export function fallbackWording(b: Brief, o: Offer): Wording {
  return {
    context: b.niche ? `${b.client === BLANK ? 'Клиент' : b.client}: сфера «${oneLine(b.niche, 80)}».` : `${b.client === BLANK ? 'Клиент' : b.client} обратился в Fir Tech.`,
    problem: b.request ? `Задача со слов клиента: ${oneLine(b.request, 400)}` : 'Задачу уточним на звонке и запишем в договоре.',
    solution: `Предлагаем решение «${o.title}». Стоимость: [цена].`,
    scope: o.scope,
  };
}

export async function draftWording(llm: LlmClient, prompt: string, b: Brief, o: Offer): Promise<Wording> {
  const input = { client: b.client, niche: b.niche, request: oneLine(b.request, 1500), direction: o.title, scope_hint: o.scope, language: 'ru' };
  const w = await tryJson(llm, { tier: 'sonnet', system: prompt, messages: [{ role: 'user', content: JSON.stringify(input) }], maxTokens: 1200 }, Wording);
  return w && wordingOk(w) ? w : fallbackWording(b, o);
}

const fmtDate = (ms: number, tz: string): string => {
  const p = zonedParts(ms, tz);
  return `${String(p.d).padStart(2, '0')}.${String(p.mo).padStart(2, '0')}.${p.y}`;
};

const bullets = (items: string[]) => items.map((s) => `- ${s}`).join('\n');

/** The split of the exact total into the prepayment and the rest, USD (whole dollars, the rest takes the rounding). */
export const splitPayment = (totalUsd: number, pct: number): { pre: number; rest: number } => {
  const pre = Math.round((totalUsd * pct) / 100);
  return { pre, rest: totalUsd - pre };
};

export function priceTable(q: PackageQuote, pct: number): string {
  const { pre, rest } = splitPayment(q.totalUsd, pct);
  const rows: [string, string][] = [
    ...q.lines.map((l): [string, string] => [l.label, usd(l.usd)]),
    ...(q.lines.length > 1 ? [['Итого', usd(q.totalUsd)] as [string, string]] : []),
    ...(q.monthlyUsd ? [['Ежемесячно (подписка)', `${usd(q.monthlyUsd)} в месяц`] as [string, string]] : []),
    [`Предоплата ${pct}%`, usd(pre)],
    [`Оплата после приёмки ${100 - pct}%`, usd(rest)],
    ['Сопровождение (по желанию)', `${usd(supportMonthlyUsd())} в месяц`],
  ];
  return ['| Позиция | Стоимость, USD |', '|---|---|', ...rows.map(([a, b]) => `| ${a} | ${b} |`)].join('\n');
}

const paymentTerms = (pct: number) =>
  `Предоплата ${pct}% до старта, оставшиеся ${100 - pct}% после приёмки результата. Способы оплаты: ${PAYMENT_METHODS}. Реквизиты вы получите в смете.`;

/** Builds the three documents from the templates. Prices come from the price list through `q` only. */
export function buildDocs(tpl: Templates, o: Offer, q: PackageQuote, b: Brief, w: Wording, terms: PresalesTerms, now: number, tz: string): NewDoc[] {
  const pct = terms.prepaymentPercent;
  const { pre, rest } = splitPayment(q.totalUsd, pct);
  const client = b.client || BLANK;
  const date = fmtDate(now, tz);
  const validUntil = fmtDate(now + terms.validDays * DAY, tz);
  const fill = (s: string) => fillMarks(s, o, q);
  const scope = w.scope.map(fill);
  const conditions = costsLine({ hasDomain: b.hasDomain ?? null, hasHosting: b.hasHosting ?? null });
  const kp = render(tpl.kp, {
    client, date, valid_until: validUntil, valid_days: String(terms.validDays), title: o.title,
    context: fill(w.context), problem: fill(w.problem), solution: fill(w.solution), scope: bullets(scope),
    timeline: o.timeline, price_table: priceTable(q, pct), payment_terms: paymentTerms(pct), conditions,
    support: `После запуска можно подключить сопровождение: ${usd(supportMonthlyUsd())} в месяц (правки, мониторинг, помощь). Решение вы принимаете после запуска.`,
  });
  const estimate = render(tpl.estimate, {
    client, title: o.title, date, valid_until: validUntil, conditions,
    line_items: ['| № | Позиция | Стоимость |', '|---|---|---|', ...scope.map((s, i) => `| ${i + 1} | ${s} | входит |`)].join('\n'),
    totals: [
      '| Позиция | USD |', '|---|---|',
      ...q.lines.map((l) => `| ${l.label} | ${usd(l.usd)} |`),
      `| Итого | ${exactLabel(q)} |`,
      `| Предоплата ${pct}% | ${usd(pre)} |`,
      `| Остаток ${100 - pct}% после приёмки | ${usd(rest)} |`,
      `| Сопровождение (по желанию) | ${usd(supportMonthlyUsd())} в месяц |`,
    ].join('\n'),
  });
  const contract = render(tpl.contract, {
    client, title: o.title, date, timeline: o.timeline, price: exactLabel(q),
    price_note: 'цена точная для состава работ из Сметы, в долларах США', prepay_percent: String(pct), prepay_amount: usd(pre),
    rest_percent: String(100 - pct), rest_amount: usd(rest), payment_methods: PAYMENT_METHODS,
    support_price: `${usd(supportMonthlyUsd())} в месяц`, conditions,
  });
  return [
    { kind: 'kp', title: DOC_RU.kp, body: kp },
    { kind: 'estimate', title: DOC_RU.estimate, body: estimate },
    { kind: 'contract', title: DOC_RU.contract, body: contract },
  ];
}
