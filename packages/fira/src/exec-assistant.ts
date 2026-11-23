import { okv, type LlmToolDef } from '@fir/core';
import { priceList } from './firtech-tools.js';
import { MARKETING_GUARDS, MARKETING_MODEL, MARKETING_TOOL_DEFS } from './marketing-head.js';
import { loadCompanyPack, loadNichePack, loadRolePack } from './packs.js';
import { makeSpec, type AgentSpec, type GuardPolicy, type ModelPolicy } from './spec.js';
import type { Audience } from './stores.js';
import type { FiraTool, ToolRegistry } from './tools.js';

/**
 * The executive assistant (`role-packs/executive-assistant.md`): the owner's questions in the one HQ bot of Telegram, answered from the data of HQ
 * with read-only tools. The tool *definitions* live here, so the eval set (`evals/executive-assistant.eval.json`, mock data) and HQ
 * (`apps/hq/src/assistant-tools.ts`, the real stores) describe the same tools to the model; HQ gives each its `run`.
 */

const obj = (properties: Record<string, unknown> = {}, required: string[] = []): LlmToolDef['input_schema'] => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const period = { type: 'string', enum: ['today', 'week', 'month'], description: 'за какой срок: сегодня, 7 дней, с начала месяца' };

export const EXEC_TOOL_DEFS: Record<string, LlmToolDef> = {
  hq_overview: {
    name: 'hq_overview',
    description: 'Счётчики компании одним вызовом: заявки сегодня и за неделю, новые клиенты, ждёт одобрения, открытые и застрявшие задачи, оплаты за неделю, LLM сегодня. Для простых вопросов «сколько».',
    input_schema: obj(),
  },
  leads: {
    name: 'leads',
    description: 'Заявки (лиды): число за срок, по стадиям, последние с именем, источником, нишей, продуктом и стадией. Без контактов. query ищет по имени или нише, id открывает одну.',
    input_schema: obj({ period, query: { type: 'string' }, id: { type: 'integer' } }),
  },
  clients: {
    name: 'clients',
    description: 'Клиенты кабинета: сколько всего и новых, последние по имени, у кого какие заявки и проекты. query ищет по имени.',
    input_schema: obj({ query: { type: 'string' } }),
  },
  projects: {
    name: 'projects',
    description: 'Проекты и их этапы оплаты: клиент, состояние, этапы (номер, сумма, оплачен, готов, принят), следующий шаг. query ищет по клиенту или названию, id открывает один.',
    input_schema: obj({ query: { type: 'string' }, id: { type: 'integer' } }),
  },
  approvals_queue: {
    name: 'approvals_queue',
    description: 'Что ждёт одобрения владельца в ревью-центре: число по видам, самое старое, список (вид, клиент, сколько ждёт, ссылка).',
    input_schema: obj(),
  },
  chats: {
    name: 'chats',
    description: 'Чаты клиентов: сколько тредов ждут ответа, последние по клиенту и каналу. Тексты анонимных посетителей не отдаются.',
    input_schema: obj(),
  },
  money: {
    name: 'money',
    description: 'Деньги: оплаты за срок (сумма, сколько счетов), неоплаченные и просроченные счета (клиент, этап, сумма).',
    input_schema: obj({ period }),
  },
  llm_costs: {
    name: 'llm_costs',
    description: 'Расходы на модели (LLM): вызовы и доллары за срок, по отделам, процент месячного лимита отдела.',
    input_schema: obj({ period }),
  },
  tasks: {
    name: 'tasks',
    description: 'Задачи отделов: открытые по статусам, застрявшие с причиной, ближайшая рутина. dept: marketing, sales, support, production, backoffice.',
    input_schema: obj({ dept: { type: 'string' } }),
  },
  director_history: {
    name: 'director_history',
    description: 'Последние поручения владельца и ответы Shell (Пульт «Поручения» и этот чат).',
    input_schema: obj({ limit: { type: 'integer' } }),
  },
  services_status: {
    name: 'services_status',
    description: 'Состояние сервисов: сайт, модели (Claude), клиентский Telegram, сервер, публикации; что не в норме и с какого времени.',
    input_schema: obj(),
  },
  company_settings: {
    name: 'company_settings',
    description: 'Настройки компании только на чтение: расписание (сводка, дайджест, тихие часы), какие напоминания включены, пороги доверия, лимиты расходов отделов и расход месяца, окна созвонов, срок КП. Менять нельзя: на просьбу поменять дать ссылку из поля link.',
    input_schema: obj(),
  },
  shell_link: {
    name: 'shell_link',
    description: 'Ссылка на экран Пульта: review (одобрения), leads, lead, clients, projects, project, chats, money, tasks, company, settings (настройки компании), home. Для просьб что-то сделать: дать ссылку, где это делается.',
    input_schema: obj({ screen: { type: 'string', enum: ['review', 'leads', 'lead', 'clients', 'projects', 'project', 'chats', 'money', 'tasks', 'company', 'settings', 'home'] }, id: { type: 'integer' } }, ['screen']),
  },
};

/** The executive assistant answers with numbers and dates of the company's own data: the price and date guards would cut exactly that. */
export const EXEC_GUARDS: Partial<GuardPolicy> = { prices: false, dates: false, stock: false, maxChars: 900, note: '' };
/** Sonnet for questions, Haiku for the trivial counts (`task: 'faq'`); a few tool rounds per question. */
export const EXEC_MODEL: Partial<ModelPolicy> = { default: 'sonnet', byTask: { faq: 'haiku', extract: 'haiku', judge: 'haiku' }, maxTokens: 700, maxRounds: 5 };

/** Spec overrides of roles whose job is not a visitor's dialogue (the eval CLI and the app build the same spec). */
export const ROLE_OVERRIDES: Record<string, { guards?: Partial<GuardPolicy>; model?: Partial<ModelPolicy>; audience?: Audience }> = {
  // the owner himself: internal knowledge is his, the visitor's secrecy rules do not apply
  'executive-assistant': { guards: EXEC_GUARDS, model: EXEC_MODEL, audience: 'owner' },
  // Fira as Head of Marketing talks to the owner too (`marketing-head.ts`)
  'marketing-head': { guards: MARKETING_GUARDS, model: MARKETING_MODEL, audience: 'owner' },
};

/** The spec of a role × niche × company with the role's overrides (lead manager: none). */
export function specOf(o: { role: string; niche: string; company: string; version?: number }): AgentSpec {
  const over = ROLE_OVERRIDES[o.role] ?? {};
  return makeSpec({
    role: loadRolePack(o.role), niche: loadNichePack(o.niche), company: loadCompanyPack(o.company), ...(o.version !== undefined ? { version: o.version } : {}),
    ...(over.guards ? { guards: over.guards } : {}), ...(over.model ? { model: over.model } : {}), ...(over.audience ? { audience: over.audience } : {}),
  });
}

/** The executive assistant of Fir Tech (tenant 0). */
export const execAssistantSpec = (): AgentSpec => specOf({ role: 'executive-assistant', niche: 'it-services', company: 'firtech', version: 1 });

/** Fira as Head of Marketing of Fir Tech (tenant 0): the owner's marketing chat. */
export const marketingHeadSpec = (): AgentSpec => specOf({ role: 'marketing-head', niche: 'it-services', company: 'firtech', version: 1 });

/**
 * Tools that answer fixed data (the eval's `mocks`: tool name → result). Known names get their real definition; `price_list` stays the real one
 * unless mocked. The result is wrapped as `ToolResult` ok, like the app's tools.
 */
export function mockTools(mocks: Record<string, unknown>): ToolRegistry {
  const out: ToolRegistry = { price_list: priceList };
  for (const [name, data] of Object.entries(mocks)) {
    const def = EXEC_TOOL_DEFS[name] ?? MARKETING_TOOL_DEFS[name] ?? { name, description: `mock ${name}`, input_schema: obj() };
    const tool: FiraTool = { def, run: () => Promise.resolve(okv(data)) };
    out[name] = tool;
  }
  return out;
}
