import type { LlmChatRequest, LlmClient, LlmRequest } from '@fir/core';
import type { Hq } from '@fir/hq';

/**
 * The marketing rules of the owner (2026-11-24, «Маркетинг-чат»): ONE source, the section `## Правила маркетинга` of the instructions of the agent
 * `marketing-head` (the same entity as `/admin/agents/marketing-head/instructions`: its versions, its rollback, its audit rows). Every new version
 * reaches, on their next call, the prompts of the Content Maker, the Publisher and the Trend Scout (the head wraps their model client, `rulesLlm`),
 * the head's own checks and Fira in the marketing chat. A database seeded before the section existed has no section: the defaults apply until the
 * first write puts them in. The routes (`GET/PUT /admin/marketing/rules`, `POST /admin/marketing/rules/rollback`) are in `shell-marketing.ts`; contract `docs/admin-crm-api.md`, «Маркетинг-чат».
 */

export const RULES_AGENT = 'marketing-head';
export const RULES_HEADING = '## Правила маркетинга';
export const MAX_RULES = 8000;
/** The toggle line of Fira's voice in the content: `- [x] Голос Фиры: …` on, `- [ ] Голос Фиры: …` off, no such line: off (the owner removed it). */
export const FIRA_VOICE = 'Голос Фиры';

export const DEFAULT_RULES = [
  `- [x] ${FIRA_VOICE}: подписи и тексты Content Maker говорят от первого лица Фиры (спокойная всезнайка, «я посмотрела», «покажу»), в конце подписи строка «Фира · Fir Tech». Это правило важнее строк про «мы» и «лица нет» в промпте исполнителя.`,
  '- Публикует только владелец через ревью-центр; отдел сам ничего не публикует и не планирует публикацию в обход одобрения.',
  '- Цены не трогаем: только из прайс-листа сайта и с «от»; посты, истории и профиль без цен.',
  '- Один призыв на материал: firtech.pro или @firtech_bot.',
  '- О продуктах Fir Tech не говорим «бот»: агент, ИИ-менеджер, автопилот, отдел.',
  '- Тексты короткие и конкретные, без оборотов «не X, а Y», без эмодзи и длинных тире.',
].join('\n');

const sectionRe = /^## Правила маркетинга[^\n]*$/m;

/** The rules inside the instructions: the section's body, or the defaults when the instructions have no section yet. */
export function rulesOf(instructions: string): { text: string; stored: boolean } {
  const m = sectionRe.exec(instructions);
  if (!m) return { text: DEFAULT_RULES, stored: false };
  const rest = instructions.slice(m.index + m[0].length);
  const next = /^## /m.exec(rest);
  return { text: (next ? rest.slice(0, next.index) : rest).trim(), stored: true };
}

/** The instructions with the rules section replaced (or appended at the end when there is none). */
export function withRules(instructions: string, rules: string): string {
  const body = rules.replace(/\r\n/g, '\n').trim();
  const m = sectionRe.exec(instructions);
  if (!m) return `${instructions.trimEnd()}\n\n${RULES_HEADING}\n${body}`.trim();
  const before = instructions.slice(0, m.index);
  const rest = instructions.slice(m.index + m[0].length);
  const next = /^## /m.exec(rest);
  const after = next ? rest.slice(next.index) : '';
  return `${before}${RULES_HEADING}\n${body}${after ? `\n\n${after}` : ''}`.trim();
}

/** Fira's voice in the content: the toggle line ticked (or without a box). */
export function firaVoiceOn(rules: string): boolean {
  const line = rules.split('\n').find((l) => l.includes(FIRA_VOICE));
  if (!line) return false;
  return !/\[\s\]/.test(line);
}

/** The block every ruled prompt gets: the rules with their version. */
export function rulesBlock(rules: string, version: number): string {
  return `${RULES_HEADING} владельца (версия ${version}; если они расходятся с правилами выше, действуют эти)\n${rules.trim()}`;
}

/** The current rules of the company: text, version (of the instructions), the prompt block, Fira's voice. */
export function currentRules(hq: Hq): { text: string; stored: boolean; version: number; updatedAt: number | null; block: string; firaVoice: boolean } {
  const a = hq.agent(RULES_AGENT);
  const r = rulesOf(a?.instructions ?? '');
  const last = hq.instructionVersions(RULES_AGENT)[0];
  const version = last?.version ?? 0;
  return { ...r, version, updatedAt: last?.at ?? null, block: rulesBlock(r.text, version), firaVoice: firaVoiceOn(r.text) };
}

/** The head's own instructions as its checks read them: the stored text, plus the default rules block while the section is missing. */
export function headInstructions(hq: Hq): string {
  const a = hq.agent(RULES_AGENT);
  const text = a?.instructions ?? '';
  return rulesOf(text).stored ? text : `${text}\n\n${currentRules(hq).block}`;
}

/** Workers of the department whose prompts carry the rules (the owner's brief: Content Maker, Publisher, Trend Scout; the head reads them itself). */
export const RULED_WORKERS: ReadonlySet<string> = new Set(['content-maker', 'publisher', 'trend-scout']);

/**
 * A model client whose every system prompt ends with the rules block, read at call time (a new version applies on the next call, no restart).
 * Wraps `complete`, `completeDetailed` and `chat`; usage and metering stay those of the wrapped client.
 */
export function rulesLlm(llm: LlmClient, block: () => string): LlmClient {
  const withText = (system: string): string => {
    const b = block().trim();
    return b && !system.includes(b) ? `${system}\n\n${b}` : system;
  };
  const req = (r: LlmRequest): LlmRequest => ({ ...r, system: withText(r.system) });
  const chatReq = (r: LlmChatRequest): LlmChatRequest => {
    const b = block().trim();
    if (!b) return r;
    return typeof r.system === 'string' ? { ...r, system: withText(r.system) } : { ...r, system: [...r.system, { text: b }] };
  };
  return {
    get enabled() {
      return llm.enabled;
    },
    complete: (r) => llm.complete(req(r)),
    ...(llm.completeDetailed ? { completeDetailed: (r: LlmRequest) => llm.completeDetailed!(req(r)) } : {}),
    ...(llm.chat ? { chat: (r: LlmChatRequest) => llm.chat!(chatReq(r)) } : {}),
  };
}
