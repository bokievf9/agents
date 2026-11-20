import { readFileSync } from 'node:fs';
import { costsLine, paymentLine, type Infrastructure, type PaymentStage } from '@fir/core';

export type DocType = 'contract' | 'offer' | 'privacy' | 'act';
export const DOC_TYPES: DocType[] = ['contract', 'offer', 'privacy', 'act'];
export const DOC_RU: Record<DocType, string> = {
  contract: 'Договор оказания услуг', offer: 'Публичная оферта', privacy: 'Политика конфиденциальности', act: 'Акт сдачи',
};

const ALIASES: [RegExp, DocType][] = [
  [/^(contract|договор)/i, 'contract'],
  [/^(offer|оферт)/i, 'offer'],
  [/^(privacy|политик|конфиденц)/i, 'privacy'],
  [/^(act|акт)/i, 'act'],
];

export function parseDocType(word: string): DocType | null {
  return ALIASES.find(([re]) => re.test(word.trim()))?.[1] ?? null;
}

export const TEMPLATES_DIR = new URL('../templates/', import.meta.url);

export function loadTemplate(type: DocType, dir: URL = TEMPLATES_DIR): string {
  return readFileSync(new URL(`${type}.md`, dir), 'utf8');
}

export interface DocData {
  client: string;
  what: string;
  /** DD.MM.YYYY */
  date: string;
  number: string;
  /** Milestone lines, `- Прототип: до 25.11`; empty when there is no project. */
  milestones: string[];
  /** The exact price from the approved КП («$N», or «$N + $M в месяц»); absent: `[цена]` stays for the owner to fill. */
  price?: string;
  /** What the client already has; absent or unknown: the default conditions line (domain, hosting and third-party services are paid by the client). */
  infra?: Infrastructure;
  /** The stages of the approved КП (amounts included); absent: the general rule without amounts, the estimate has the split. */
  stages?: PaymentStage[];
}

/**
 * Fills `{{client}}`, `{{what}}`, `{{date}}`, `{{number}}`, `{{milestones}}`, `{{price}}`, `{{payment_clause}}` and `{{conditions}}`. What the data does not have becomes
 * `[заполнить: ...]`, never a made-up value; `[цена]` and `[срок]` stay as they are: the owner names money and terms.
 */
export function fillTemplate(template: string, d: DocData): string {
  const val: Record<string, string> = {
    client: d.client.trim() || '[заполнить: заказчик]',
    what: d.what.trim() || '[заполнить: предмет работ]',
    date: d.date,
    number: d.number,
    milestones: d.milestones.length ? d.milestones.join('\n') : '- [заполнить: этапы и даты]',
    price: d.price?.trim() || '[цена]',
    conditions: costsLine(d.infra),
    payment_clause: paymentLine(d.stages ?? []),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => val[k] ?? `[заполнить: ${k}]`);
}

/** Placeholders the owner still has to fill: an unfilled document must not be approved as final. */
export const OPEN_PLACEHOLDER = /\[(?:заполнить[^\]]*|цена|срок)\]/g;

export function openPlaceholders(text: string): string[] {
  return [...new Set(text.match(OPEN_PLACEHOLDER) ?? [])];
}
