import { tryComplete, type LlmClient } from '@fir/core';
import { isPriceQuestion } from '@fir/worker-lead-intake';
import { systemPrompt, TEAM_MARK } from './prompt.js';
import { sanitizeAnswer } from './sanitize.js';
import type { Draft } from './store.js';
import { SERVICE, T, type Lang } from './texts.js';

/**
 * Transport-independent parts of the client conversation, used by both the Telegram engine and the web chat:
 * clipping, the bare-greeting test, the in-memory turns for the LLM, the lead record of a finished intake and the
 * free LLM answer (price rule, quiet hours, sanitiser). The Telegram and web engines are thin state machines on top.
 */
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s.trim());

export const GREETING = /^(привет[а-яё]*|здравствуй[а-яё]*|здрасьте|добр[а-яё]+\s+(день|утро|вечер)|салам[а-яё]*|ассалом[а-яё]*|hi|hello|hey|good (morning|afternoon|evening))[\s!.,)]*$/i;

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

const HISTORY_TURNS = 6;
const HISTORY_TTL = 30 * 60_000;

/** The last few turns per conversation, in memory only (never in the database or logs), 30 minutes. */
export class TurnHistory<K extends string | number> {
  private readonly map = new Map<K, { at: number; turns: Turn[] }>();

  constructor(private readonly now: () => number) {}

  turns(key: K): Turn[] {
    const h = this.map.get(key);
    if (!h || h.at < this.now() - HISTORY_TTL) return [];
    const turns = h.turns.slice(-HISTORY_TURNS);
    while (turns.length && turns[0]!.role !== 'user') turns.shift();
    // Strict alternation: a delivered head reply right after the bot's answer would put two assistant turns in a row.
    return turns.filter((x, i) => i === 0 || x.role !== turns[i - 1]!.role);
  }

  remember(key: K, role: Turn['role'], content: string): void {
    const now = this.now();
    const h = this.map.get(key);
    const turns = h && h.at >= now - HISTORY_TTL ? h.turns : [];
    turns.push({ role, content: clip(content, 800) });
    this.map.set(key, { at: now, turns: turns.slice(-HISTORY_TURNS) });
  }

  forget(key: K): void {
    this.map.delete(key);
  }

  /** Drops expired conversations (the web chat calls it on access). */
  sweep(): void {
    const cutoff = this.now() - HISTORY_TTL;
    for (const [k, h] of this.map) if (h.at < cutoff) this.map.delete(k);
  }
}

/** The finished intake as the Sales lead fields (Russian, for the owner and the Sales head); `shown` is for the person. */
export function intakeRecord(
  d: Draft, lang: Lang, origin: string,
): { message: string; budget: string; service: string; masked: string; shown: { need: string; deadline: string; budget: string } } {
  const t = T[lang];
  const ru = T.ru;
  const shown = {
    need: d.need ? t.needLabel[d.need] : clip(d.needText ?? '', 60),
    deadline: d.deadline ? t.deadlineLabel[d.deadline] : d.deadlineText ?? '',
    budget: d.budget ? t.budget[d.budget] : d.budgetText ?? '',
  };
  const message = [
    d.needText ? `Задача (словами клиента): ${d.needText}` : `Нужно: ${ru.needLabel[d.need ?? 'other']}`,
    `Срок: ${d.deadline ? ru.deadlineLabel[d.deadline] : d.deadlineText || 'не указан'}`,
    origin,
  ].join('\n');
  const budget = d.budget ? (d.budget === 'unknown' ? '' : ru.budget[d.budget]) : d.budgetText ?? '';
  const masked = `проект: ${d.need ? ru.needLabel[d.need] : 'своими словами'}, ${d.deadline ? ru.deadlineLabel[d.deadline] : 'срок словами'}, ${d.budget ? ru.budget[d.budget] : 'бюджет словами'}`;
  return { message, budget, service: SERVICE[d.need ?? 'other'], masked, shown };
}

export type FreeResult =
  | { kind: 'price' }
  | { kind: 'fallback' }
  | { kind: 'answer'; text: string; team: boolean; removed: number };

export interface FreeDeps {
  llm: LlmClient;
  instructions: string;
  /** LLM budget gate (the daily cap shared by Telegram and the web chat). */
  gate: { llmAllowed(): boolean; llmUsed(): void };
}

/**
 * One free-conversation turn: a direct price question gets the template, LLM off or the daily cap fall back, otherwise the model answers and the sanitiser cleans it (prices, dates, markdown, length).
 */
export async function freeAnswer(d: FreeDeps, lang: Lang, text: string, turns: Turn[], beforeCall?: () => Promise<void>): Promise<FreeResult> {
  if (isPriceQuestion(text)) return { kind: 'price' };
  if (!d.llm.enabled || !d.gate.llmAllowed()) return { kind: 'fallback' };
  await beforeCall?.();
  d.gate.llmUsed();
  const raw = await tryComplete(d.llm, {
    tier: 'sonnet', maxTokens: 400, system: systemPrompt(d.instructions, lang), messages: [...turns, { role: 'user', content: text }],
  });
  if (!raw?.trim()) return { kind: 'fallback' };
  const team = raw.includes(TEAM_MARK);
  const clean = sanitizeAnswer(raw.split(TEAM_MARK).join(' '), T[lang].priceNote);
  if (clean.text.length < 2) return { kind: 'fallback' };
  return { kind: 'answer', text: clean.text, team, removed: clean.removed };
}
