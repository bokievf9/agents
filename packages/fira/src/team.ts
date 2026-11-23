import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmToolDef } from '@fir/core';
import { EXEC_TOOL_DEFS } from './exec-assistant.js';
import { MARKETING_TOOL_DEFS } from './marketing-head.js';
import { loadCompanyPack, loadNichePack, loadRolePack, PACKAGE_DIR } from './packs.js';
import { makeSpec, type AgentSpec, type GuardPolicy, type ModelPolicy } from './spec.js';

/**
 * «Команда» (2026-11-24): the owner's chat with ANY agent of HQ. Each agent has a short role pack in `role-packs/team/<agentId>.md` (Fira's own
 * format); its front matter `tools:` is the agent's whole toolbox in the chat, nothing else reaches the model (`compile` and `runTool` both check it).
 * The definitions of the new team tools live here (HQ gives each its `run`, `apps/hq/src/team-chat-tools.ts`); the read tools of the executive
 * assistant (`EXEC_TOOL_DEFS`) and of the Head of Marketing (`MARKETING_TOOL_DEFS`) are reused by name. Writes are the existing actions of HQ only:
 * a task, an assignment to another agent, a Studio order, a ticket answer drafted by Support (lands in Approvals), a КП started by Presales (lands in
 * Approvals, locked), a call booking, a note on a client. Nothing publishes, nothing pays, nothing signs. Head of Marketing keeps its own pack.
 */

const obj = (properties: Record<string, unknown> = {}, required: string[] = []): LlmToolDef['input_schema'] => ({ type: 'object', properties, ...(required.length ? { required } : {}) });

export const TEAM_TOOL_DEFS: Record<string, LlmToolDef> = {
  my_queue: {
    name: 'my_queue',
    description: 'Твоя очередь: назначенные тебе задачи (номер, статус, с какого времени), что ждёт одобрения владельца, последние результаты. Звать на «что делаешь», «что в работе», «что сделала».',
    input_schema: obj(),
  },
  tickets: {
    name: 'tickets',
    description: 'Тикеты клиентов поддержки: номер, клиент, статус (open, answered, closed), когда пришёл, короткий текст. status фильтрует, id открывает один.',
    input_schema: obj({ status: { type: 'string', enum: ['open', 'answered', 'closed'] }, id: { type: 'integer' } }),
  },
  quotes: {
    name: 'quotes',
    description: 'КП, сметы и черновики договоров (Presales): номер, заявка, вид, статус (draft, approved, rejected), когда. leadId фильтрует по заявке.',
    input_schema: obj({ leadId: { type: 'integer' } }),
  },
  create_task: {
    name: 'create_task',
    description: 'Поставить задачу своему отделу (уходит голове отдела в очередь): title одна строка, body подробности. Только когда владелец просит что-то сделать, а готового инструмента нет.',
    input_schema: obj({ title: { type: 'string' }, body: { type: 'string' } }, ['title']),
  },
  assign_agent: {
    name: 'assign_agent',
    description: 'Передать поручение другому агенту команды: agent это его id (например sales-head, presales, finance), text само поручение. Агент ответит в своём чате, результат придёт в Задачи или Одобрения.',
    input_schema: obj({ agent: { type: 'string' }, text: { type: 'string' } }, ['agent', 'text']),
  },
  draft_reply: {
    name: 'draft_reply',
    description: 'Подготовить ответ клиенту на тикет ticketId: черновик пишет Customer Support и кладёт в Одобрения, отправляется только после решения владельца. note: пожелание к ответу.',
    input_schema: obj({ ticketId: { type: 'integer' }, note: { type: 'string' } }, ['ticketId']),
  },
  propose_quote: {
    name: 'propose_quote',
    description: 'Запустить КП, смету и черновик договора по заявке leadId: готовит Presales, всё уходит в Одобрения (цены и договор решает владелец). note: пожелание.',
    input_schema: obj({ leadId: { type: 'integer' }, note: { type: 'string' } }, ['leadId']),
  },
  schedule_call: {
    name: 'schedule_call',
    description: 'Записать созвон по заявке leadId на время at (ISO 8601 с часовым поясом, например 2026-11-25T15:00:00+05:00). Клиенту уходит подтверждение тем каналом, которым он писал.',
    input_schema: obj({ leadId: { type: 'integer' }, at: { type: 'string' } }, ['leadId', 'at']),
  },
  client_note: {
    name: 'client_note',
    description: 'Дописать заметку к карточке: kind lead (заявка), ticket (тикет) или prospect (бизнес Разведчика), id номер, text одна-две строки. Заметку видит владелец в Пульте, клиент нет.',
    input_schema: obj({ kind: { type: 'string', enum: ['lead', 'ticket', 'prospect'] }, id: { type: 'integer' }, text: { type: 'string' } }, ['kind', 'id', 'text']),
  },
};

/** Every tool a team pack may list: the team tools, the read tools of the assistant and of marketing, and Fira's built-ins. */
export const TEAM_KNOWN_TOOLS: readonly string[] = [
  ...Object.keys(TEAM_TOOL_DEFS), ...Object.keys(EXEC_TOOL_DEFS), ...Object.keys(MARKETING_TOOL_DEFS), 'knowledge_search', 'price_list',
];

/** Tools that change something (each run is audited by HQ). */
export const TEAM_WRITE_TOOLS: readonly string[] = ['create_task', 'assign_agent', 'draft_reply', 'propose_quote', 'schedule_call', 'client_note', 'create_order'];

/** The owner reads numbers and dates of his own company in the chat; the price guard stays. */
export const TEAM_GUARDS: Partial<GuardPolicy> = { prices: true, dates: false, stock: true, maxChars: 1200, note: 'Цены живут в прайс-листе сайта.' };
export const TEAM_MODEL: Partial<ModelPolicy> = { default: 'sonnet', byTask: { faq: 'haiku', extract: 'haiku', judge: 'haiku' }, maxTokens: 900, maxRounds: 5 };

export const TEAM_PACK_DIR = join(PACKAGE_DIR, 'role-packs', 'team');

/** Agent ids that have a team pack, sorted. */
export const teamPackIds = (dir = TEAM_PACK_DIR): string[] => readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();

const specs = new Map<string, AgentSpec>();
/** The spec of an agent in the team chat (cached): its team pack, the company, audience owner. Throws on an unknown id. */
export function teamSpec(agentId: string, dir = TEAM_PACK_DIR): AgentSpec {
  const key = `${dir}:${agentId}`;
  const hit = specs.get(key);
  if (hit) return hit;
  const s = makeSpec({
    role: loadRolePack(agentId, dir), niche: loadNichePack('it-services'), company: loadCompanyPack('firtech'), version: 1,
    guards: TEAM_GUARDS, model: TEAM_MODEL, audience: 'owner',
  });
  specs.set(key, s);
  return s;
}
