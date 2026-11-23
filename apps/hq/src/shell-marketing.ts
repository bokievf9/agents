import type { Hq } from '@fir/hq';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import type { MarketingChat } from './marketing-chat.js';
import { currentRules, MAX_RULES, RULES_AGENT, rulesOf, withRules } from './marketing-rules.js';
import { MAX_INSTRUCTIONS } from './shell-agents.js';
import { fail, ok } from './shell-crm.js';

/**
 * `/admin/marketing/*` (2026-11-24, contract `docs/admin-crm-api.md`, «Маркетинг-чат»): the rules of the owner (`GET`/`PUT /admin/marketing/rules`,
 * `POST /admin/marketing/rules/rollback`: the versions of the instructions of `marketing-head`, one entity with the Agents section), the chat
 * (`GET`/`POST /admin/marketing/chat`), the plans (`POST /admin/marketing/plan/accept`, `GET /admin/marketing/plan/:id`, `GET /admin/marketing/plans`).
 */

const putBody = z.object({ text: z.string().min(1).max(MAX_RULES), note: z.string().max(200).optional() }).strict();
const rollbackBody = z.object({ version: z.number().int().min(1), note: z.string().max(200).optional() }).strict();
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export type RulesWrite = { ok: true; version: number } | { ok: false; status: number; error: string };

export function createMarketingRules(hq: Hq) {
  function view() {
    const r = currentRules(hq);
    return {
      text: r.text, version: r.version, updatedAt: iso(r.updatedAt), firaVoice: r.firaVoice, stored: r.stored,
      history: hq.instructionVersions(RULES_AGENT).map((v) => ({ version: v.version, at: iso(v.at), note: v.note, actor: v.actor })),
    };
  }

  /** A new version of the rules (the section of the instructions); `actor` is who typed it (the owner, in the chat or the rules screen). */
  function write(text: string, note: string, actor = 'owner'): RulesWrite {
    const a = hq.agent(RULES_AGENT);
    if (!a) return { ok: false, status: 503, error: 'unavailable' };
    const clean = text.replace(/\r\n/g, '\n').trim();
    if (!clean || clean.length > MAX_RULES) return { ok: false, status: 400, error: 'invalid' };
    const cur = rulesOf(a.instructions);
    if (cur.stored && cur.text === clean) return { ok: false, status: 409, error: 'unchanged' };
    const next = withRules(a.instructions, clean);
    if (next.length > MAX_INSTRUCTIONS) return { ok: false, status: 400, error: 'too_long' };
    if (next === a.instructions) return { ok: false, status: 409, error: 'unchanged' };
    hq.setInstructions(RULES_AGENT, next, actor, (note.trim() || 'правила маркетинга').slice(0, 200));
    return { ok: true, version: hq.instructionVersions(RULES_AGENT)[0]?.version ?? 0 };
  }

  function get(): AdminReply {
    if (!hq.agent(RULES_AGENT)) return fail(503, 'unavailable');
    return ok(view());
  }

  function put(body: unknown): AdminReply {
    const p = putBody.safeParse(body ?? {});
    if (!p.success) return fail(400, 'invalid', { maxChars: MAX_RULES });
    const r = write(p.data.text, p.data.note ?? '', 'owner');
    return r.ok ? ok(view()) : fail(r.status, r.error, r.error === 'invalid' || r.error === 'too_long' ? { maxChars: MAX_RULES } : {});
  }

  /** The instructions of that version again, as a new version (history stays), like `/admin/agents/:id/instructions/rollback`. */
  function rollback(body: unknown): AdminReply {
    if (!hq.agent(RULES_AGENT)) return fail(503, 'unavailable');
    const p = rollbackBody.safeParse(body ?? {});
    if (!p.success) return fail(400, 'invalid');
    const target = hq.instructionVersion(RULES_AGENT, p.data.version);
    if (!target) return fail(404, 'unknown_version');
    if (target.text === hq.agent(RULES_AGENT)!.instructions) return fail(409, 'unchanged');
    hq.setInstructions(RULES_AGENT, target.text, 'owner', p.data.note ?? `rollback to v${target.version}`);
    return ok(view());
  }

  return { view, write, get, put, rollback };
}

export type MarketingRules = ReturnType<typeof createMarketingRules>;

/** `seg`: the path after `/admin/marketing`. */
export async function handleMarketing(rules: MarketingRules, chat: MarketingChat | null, method: string, seg: string[], query: URLSearchParams, body: unknown): Promise<AdminReply> {
  const [a, b] = seg;
  if (a === 'rules') {
    if (seg.length === 1) return method === 'GET' ? rules.get() : method === 'PUT' ? rules.put(body) : fail(405, 'method_not_allowed');
    if (seg.length === 2 && b === 'rollback') return method === 'POST' ? rules.rollback(body) : fail(405, 'method_not_allowed');
    return fail(404, 'not_found');
  }
  if (!chat) return fail(503, 'unavailable');
  if (a === 'chat' && seg.length === 1) return method === 'GET' ? chat.get(query) : method === 'POST' ? chat.post(body) : fail(405, 'method_not_allowed');
  if (a === 'plan' && seg.length === 2 && b === 'accept') return method === 'POST' ? chat.accept(body) : fail(405, 'method_not_allowed');
  if (a === 'plan' && seg.length === 2 && b) return method === 'GET' ? chat.planView(b) : fail(405, 'method_not_allowed');
  if (a === 'plans' && seg.length === 1) return method === 'GET' ? chat.planList(query) : fail(405, 'method_not_allowed');
  return fail(404, 'not_found');
}
