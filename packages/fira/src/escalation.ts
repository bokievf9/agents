import type { Outcome, OwnerReason } from './tools.js';

/**
 * The escalation policy of a talking agent (Autopilot v0, owner 2026-11-23). What goes to the owner: money and discounts, legal questions, anger or the
 * same message three times, a request for a person, uncertainty (the agent had no knowledge for the answer or asked for the owner itself), a VIP (a
 * client with a project). Everything else the agent does itself. The owner chooses how much he wants to hear (setting `autopilot.leadManager` of HQ):
 * - `ask_me`: every reason, and every question about prices too (he wants to see them all);
 * - `policy` (default): the reasons above;
 * - `autopilot`: only what an agent must never decide alone: a person asked for, anger, legal.
 * The result is one line for the owner (the app sends it, in HQ `hq.alert(kind: 'human')`) and one sentence for the person; no text of the person in
 * the short line.
 */

export const ESCALATION_MODES = ['ask_me', 'policy', 'autopilot'] as const;
export type EscalationMode = (typeof ESCALATION_MODES)[number];
export const DEFAULT_ESCALATION_MODE: EscalationMode = 'policy';

export const escalationModeOf = (v: string | undefined | null): EscalationMode => ((ESCALATION_MODES as readonly string[]).includes(v ?? '') ? (v as EscalationMode) : DEFAULT_ESCALATION_MODE);

/** A discount, a lower price, an installment, a refund, «бесплатно». */
export const asksMoney = (t: string): boolean =>
  /скидк|подешевле|дешевле|торг(?![\p{L}])|поторгу|уступ(ите|и|ить)|рассрочк|в долг|частями|бесплатно сделаете|верн(ите|уть) деньги|возврат денег|discount|cheaper|lower (the )?price|installments?|pay (it )?in parts|refund|money back|for free\?/iu.test(t);

/** Contracts, law, liability, personal data, a court. */
export const asksLegal = (t: string): boolean =>
  /юрист|юридическ|(?<![\p{L}])суд(?![\p{L}])|судеб|претензи|неустойк|штраф|ответственност\p{L}*\s+(по|за|сторон)|договор\p{L}*\s+(измен|правк|поправ|юрист|расторг|с\s+юр)|(измен|поправ|правк|правит)\p{L}*\s+(в\s+)?договор|расторж|nda(?![\p{L}])|персональн\p{L}*\s+данн|gdpr|авторск\p{L}*\s+прав|интеллектуальн\p{L}*\s+собственн|lawyer|legal|lawsuit|liabilit|contract terms|terminate the contract|penalt|personal data/iu.test(t);

/** A price question (only `ask_me` escalates it: the agent answers prices from the list itself). */
export const asksPrice = (t: string): boolean => /сколько стоит|стоимост|цен[аыуе](?![\p{L}])|прайс|how much|price|cost/iu.test(t);

export interface EscalationIn {
  text: string;
  lang: string;
  mode: EscalationMode;
  /** The app's own reading of the person: asked for a person, upset (incl. three equal messages). */
  person?: 'ask' | 'upset' | null;
  /** What the turn did (a `handoff_owner` call, an empty knowledge search). */
  outcome?: Pick<Outcome, 'owner' | 'unknown'>;
  /** A client with a project. */
  vip?: boolean;
}

export interface Escalation {
  reason: OwnerReason;
  /** One line for the owner (the Пульт); may carry the agent's own summary, never a contact. */
  line: string;
  /** The same without any words of the person (Telegram reminder). */
  short: string;
  /** One sentence for the person; empty when the app answers itself (a person asked for: its hand-off flow). */
  tell: string;
}

const REASON_RU: Record<OwnerReason, string> = {
  money: 'вопрос о скидке или деньгах', legal: 'юридический вопрос', unsure: 'вопрос без ответа в знаниях', vip: 'вопрос клиента с проектом',
  person: 'просит человека', anger: 'клиент раздражён',
};

const TELL: Record<OwnerReason, { ru: string; en: string }> = {
  money: { ru: 'Скидки и исключения по цене решает основатель: я передал ему ваш вопрос, ответ придёт сюда же.', en: 'Discounts and price exceptions are decided by the founder: I passed your question on, the answer will come here.' },
  legal: { ru: 'Юридические вопросы и условия договора решает основатель: я передал ему вопрос, ответ придёт сюда же.', en: 'Legal questions and contract terms are decided by the founder: I passed the question on, the answer will come here.' },
  unsure: { ru: 'Точно ответить сейчас не могу: уточню у команды, вопрос передал основателю, ответ придёт сюда же.', en: 'I cannot answer that exactly right now: I asked the team, the founder has the question and the answer will come here.' },
  vip: { ru: 'Передал ваш вопрос основателю, он ответит здесь или в кабинете.', en: 'I passed your question to the founder, who will answer here or in your cabinet.' },
  person: { ru: '', en: '' },
  anger: { ru: '', en: '' },
};

/** Which reasons a mode sends to the owner. */
export function escalates(mode: EscalationMode, reason: OwnerReason): boolean {
  if (reason === 'person' || reason === 'anger' || reason === 'legal') return true;
  return mode !== 'autopilot';
}

/** The escalation of a turn under the mode, or null (the agent handles it). Order: person, anger, legal, money, VIP, uncertainty. */
export function escalationOf(i: EscalationIn, o: { channel?: string } = {}): Escalation | null {
  const asked = i.outcome?.owner?.reason as OwnerReason | undefined;
  const candidates: OwnerReason[] = [];
  if (i.person === 'ask' || asked === 'person') candidates.push('person');
  if (i.person === 'upset' || asked === 'anger') candidates.push('anger');
  if (asksLegal(i.text) || asked === 'legal') candidates.push('legal');
  if (asksMoney(i.text) || asked === 'money' || (i.mode === 'ask_me' && asksPrice(i.text))) candidates.push('money');
  if (i.vip || asked === 'vip') candidates.push('vip');
  if (i.outcome?.unknown || asked === 'unsure') candidates.push('unsure');
  const reason = candidates.find((r) => escalates(i.mode, r));
  if (!reason) return null;
  const where = o.channel ? ` (${o.channel})` : '';
  const short = `ИИ-менеджер заявок: ${REASON_RU[reason]}${where}, нужен ответ основателя.`;
  const summary = i.outcome?.owner?.line?.trim();
  return { reason, short, line: summary ? `${short} Суть: ${summary.slice(0, 160)}` : short, tell: i.lang === 'en' ? TELL[reason].en : TELL[reason].ru };
}
