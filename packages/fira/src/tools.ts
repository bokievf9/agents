import { fail, okv, type LlmToolDef, type ToolResult } from '@fir/core';
import type { Knowledge, Mode } from './stores.js';

/**
 * Tools of a Fira agent. A tool is its definition for the model (native tool use: name, description, JSON Schema) and a `run` that never throws
 * and answers `ToolResult` like the tools of `@fir/core` (`docs/tools.md`). Three are built in (knowledge, contact, hand-off); the app adds its own
 * (Fir Tech: `price_list`, `builder_link`, `call_slots`; later the core registry through an adapter with the company's rights).
 */

/** What happened during a turn that the app must act on: the runtime fills it, the app reads it after `run`. */
export interface Outcome {
  handoff?: string;
  contact?: { contact: string; name: string; note: string };
  /** Tool names in call order. */
  used: string[];
  /** A knowledge search came back empty. */
  unknown: boolean;
}

export interface ToolCtx {
  companyId: string;
  agentId: string;
  conversationId: string;
  mode: Mode;
  lang: string;
  now: () => number;
  knowledge: Knowledge;
  outcome: Outcome;
}

export interface FiraTool {
  def: LlmToolDef;
  run(input: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult<unknown>>;
}

export type ToolRegistry = Record<string, FiraTool>;

const str = (v: unknown, n: number): string => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/** A contact as people write it: email, @handle, t.me link, or a phone of 7-15 digits. */
export function looksLikeContact(s: string): boolean {
  return /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/.test(s) || /(^|\s)@[A-Za-z][A-Za-z0-9_]{4,31}\b/.test(s) || /t\.me\/[A-Za-z]/.test(s)
    || ((s.match(/\d/g)?.length ?? 0) >= 7 && (s.match(/\d/g)?.length ?? 0) <= 15);
}

export const knowledgeSearch: FiraTool = {
  def: {
    name: 'knowledge_search',
    description: 'Найти факты компании и сферы (услуги, условия, часы, частые вопросы). Звать перед ответом на вопрос о фактах; пустой результат значит «не знаю», тогда не выдумывать.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'вопрос своими словами' } }, required: ['query'] },
  },
  async run(input, ctx) {
    const q = str(input.query, 300);
    if (!q) return fail('invalid', 'query is required');
    const hits = await ctx.knowledge.search(ctx.companyId, q, 4);
    if (!hits.length) ctx.outcome.unknown = true;
    return okv({ hits: hits.map((h) => ({ title: h.title, text: h.text.slice(0, 600), source: h.source })) });
  },
};

export const captureContact: FiraTool = {
  def: {
    name: 'capture_contact',
    description: 'Сохранить контакт собеседника, только когда он сам его написал (телефон, Telegram @username или email).',
    input_schema: {
      type: 'object',
      properties: { contact: { type: 'string' }, name: { type: 'string' }, note: { type: 'string', description: 'одна строка: что нужно человеку' } },
      required: ['contact'],
    },
  },
  run(input, ctx) {
    if (ctx.mode === 'demo') return Promise.resolve(okv({ demo: true, note: 'в демо контакты не сохраняются' }));
    const contact = str(input.contact, 120);
    if (!looksLikeContact(contact)) return Promise.resolve(fail('invalid', 'not a contact'));
    ctx.outcome.contact = { contact, name: str(input.name, 80), note: str(input.note, 300) };
    return Promise.resolve(okv({ saved: true }));
  },
};

export const handoffHuman: FiraTool = {
  def: {
    name: 'handoff_human',
    description: 'Передать разговор человеку: просьба позвать человека, раздражение, жалоба, деньги и договор, вопрос вне границ должности.',
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
  run(input, ctx) {
    ctx.outcome.handoff = str(input.reason, 200) || 'по запросу';
    return Promise.resolve(okv({ passed: true }));
  },
};

export const BUILTIN_TOOLS: ToolRegistry = {
  [knowledgeSearch.def.name]: knowledgeSearch,
  [captureContact.def.name]: captureContact,
  [handoffHuman.def.name]: handoffHuman,
};

/** Runs a tool by name for the model: unknown or not allowed names and thrown errors become a failed result, never an exception. */
export async function runTool(registry: ToolRegistry, allowed: readonly string[], name: string, input: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult<unknown>> {
  const t = registry[name];
  if (!t || !allowed.includes(name)) return fail('not_allowed', `tool ${name} is not available to this agent`);
  try {
    return await t.run(input, ctx);
  } catch {
    return fail('internal', `tool ${name} failed`);
  }
}
