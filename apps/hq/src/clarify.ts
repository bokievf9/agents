import { migrate, type Db } from '@fir/core';
import { guessNiche, type Lead } from '@fir/worker-lead-intake';

/**
 * Clarifying questions before the КП (ИИ-менеджер заявок 2.0, 2026-11-22). A lead from the cabinet that arrives with gaps (no niche, no goal, no channel, unclear
 * scope) gets at most three questions in its thread (and by email when Resend is set) BEFORE the Sales head proposes the КП. The client's messages in the thread
 * are the answers and go into the КП; after 24 hours without an answer the КП is made with the assumptions listed. One round per lead.
 */
export const CLARIFY_WAIT_MS = 24 * 3_600_000;
export const MAX_QUESTIONS = 3;

export type Gap = 'scope' | 'niche' | 'goal' | 'channel';
const ORDER: Gap[] = ['scope', 'niche', 'goal', 'channel'];

const CHANNEL_WORDS = /instagram|инстаграм|телеграм|telegram|whatsapp|ватсап|\bсайт|website|звонк|сарафан|вайбер|viber|facebook|фейсбук|tiktok|тикток|olx|2gis|2гис/i;
const GOAL_WORDS = /заявк|запис|клиент|ответ|рутин|продаж|лид|заказ|оплат|напомин|отчёт|отчет|поддержк|requests?|booking|leads?|orders?|sales|support|routine|customers?|reports?/i;

/** What a lead lacks. Pure: reads the card fields and the words the client sent. */
export function gapsOf(l: Pick<Lead, 'niche' | 'task' | 'service' | 'estimate'>, raw: { product?: unknown; message?: unknown } = {}): Gap[] {
  const words = `${l.task} ${typeof raw.message === 'string' ? raw.message : ''} ${l.estimate}`;
  const service = l.service.trim().toLowerCase();
  const hasProduct = typeof raw.product === 'string' && raw.product.trim() !== '';
  const gaps: Gap[] = [];
  if ((service === '' || service === 'unknown' || service === 'other') && !hasProduct) gaps.push('scope');
  if (!l.niche.trim() && !guessNiche(words)) gaps.push('niche');
  if (!GOAL_WORDS.test(words)) gaps.push('goal');
  if (!CHANNEL_WORDS.test(words)) gaps.push('channel');
  return ORDER.filter((g) => gaps.includes(g));
}

/**
 * The gaps that hold the КП back: the scope is unclear, or both the niche and the goal are missing. A missing channel alone (or with one other gap) is
 * asked about only when there is a question to ask anyway; it never delays a lead whose service and goal are clear.
 */
export const isBlocking = (gaps: Gap[]): boolean => gaps.includes('scope') || (gaps.includes('niche') && gaps.includes('goal'));

const Q: Record<'ru' | 'en', Record<Gap, string>> = {
  ru: {
    scope: 'Что именно вам нужно: бот-администратор для записи, приёмщик заявок, автоматизация рутины, Mini App, сайт или что-то другое?',
    niche: 'Чем занимается ваш бизнес (ниша, город, примерный размер)?',
    goal: 'Какую задачу это должно решать в первую очередь: что сейчас теряется или отнимает время?',
    channel: 'Где клиенты пишут вам сейчас: Instagram, Telegram, сайт, звонки?',
  },
  en: {
    scope: 'What exactly do you need: a booking bot, a request receptionist, workflow automation, a Mini App, a website or something else?',
    niche: 'What does your business do (field, city, rough size)?',
    goal: 'What should it solve first: what gets lost or takes your time now?',
    channel: 'Where do clients write to you now: Instagram, Telegram, your website, phone calls?',
  },
};

/** At most three questions, in the order scope, niche, goal, channel. */
export const questionsFor = (gaps: Gap[], lang: 'ru' | 'en'): string[] => gaps.slice(0, MAX_QUESTIONS).map((g) => Q[lang][g]);

/** The message for the thread and the email. */
export function questionsMessage(lang: 'ru' | 'en', name: string, questions: string[]): string {
  const list = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  return lang === 'ru'
    ? `Здравствуйте${name ? `, ${name}` : ''}! Чтобы подготовить предложение точнее, ответьте, пожалуйста, на ${questions.length === 1 ? 'вопрос' : 'вопросы'}:\n${list}\n\nОтветить можно здесь, в сообщениях кабинета. Если ответа не будет, через сутки подготовим предложение с допущениями и укажем их в нём.`
    : `Hello${name ? `, ${name}` : ''}! To prepare the proposal more precisely, please answer ${questions.length === 1 ? 'this question' : 'these questions'}:\n${list}\n\nYou can reply here, in the cabinet messages. If there is no answer, in a day we will prepare the proposal with assumptions and list them in it.`;
}

const ASSUME: Record<Gap, string> = {
  scope: 'состав работ: стандартный пакет продукта, который назван в заявке (или ИИ-приёмщик заявок), без дополнительных частей',
  niche: 'ниша: типовой малый бизнес в сфере услуг',
  goal: 'главная задача: приём и обработка обращений клиентов без потерь',
  channel: 'каналы: сайт и Telegram',
};
/** What the КП assumes for each question the client left unanswered. */
export const assumptionsFor = (gaps: Gap[]): string[] => gaps.slice(0, MAX_QUESTIONS).map((g) => ASSUME[g]);

export type ClarifyStatus = 'asked' | 'answered' | 'assumed';
export interface Clarification {
  leadId: number;
  taskId: number;
  gaps: Gap[];
  questions: string[];
  askedAt: number;
  status: ClarifyStatus;
  answers: string;
  closedAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS li_clarify (
  lead_id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL,
  gaps TEXT NOT NULL,
  questions TEXT NOT NULL,
  asked_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'asked',
  answers TEXT NOT NULL DEFAULT '',
  closed_at INTEGER
);
`;

interface Row { lead_id: number; task_id: number; gaps: string; questions: string; asked_at: number; status: string; answers: string; closed_at: number | null }
const toC = (r: Row): Clarification => ({
  leadId: r.lead_id, taskId: r.task_id, gaps: JSON.parse(r.gaps) as Gap[], questions: JSON.parse(r.questions) as string[], askedAt: r.asked_at, status: r.status as ClarifyStatus, answers: r.answers, closedAt: r.closed_at,
});

export class ClarifyStore {
  constructor(private readonly db: Db, private readonly now: () => number) {
    migrate(db, SCHEMA);
  }

  byLead(leadId: number): Clarification | undefined {
    const r = this.db.prepare('SELECT * FROM li_clarify WHERE lead_id = ?').get(leadId) as Row | undefined;
    return r ? toC(r) : undefined;
  }

  open(): Clarification[] {
    return (this.db.prepare("SELECT * FROM li_clarify WHERE status = 'asked' ORDER BY lead_id").all() as Row[]).map(toC);
  }

  /** One round per lead: false when this lead was already asked. */
  ask(leadId: number, taskId: number, gaps: Gap[], questions: string[]): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO li_clarify (lead_id, task_id, gaps, questions, asked_at) VALUES (?, ?, ?, ?, ?)').run(leadId, taskId, JSON.stringify(gaps), JSON.stringify(questions), this.now()).changes === 1;
  }

  close(leadId: number, status: 'answered' | 'assumed', answers = ''): void {
    this.db.prepare("UPDATE li_clarify SET status = ?, answers = ?, closed_at = ? WHERE lead_id = ? AND status = 'asked'").run(status, answers.slice(0, 3000), this.now(), leadId);
  }

  count(): { asked: number; answered: number; assumed: number } {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM li_clarify GROUP BY status').all() as { status: ClarifyStatus; n: number }[];
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<ClarifyStatus, number>>;
    return { asked: by.asked ?? 0, answered: by.answered ?? 0, assumed: by.assumed ?? 0 };
  }
}
