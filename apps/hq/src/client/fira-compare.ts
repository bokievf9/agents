import { MockChatLlm, MockLlm, type LlmChatRequest, type LlmClient, type LlmRequest, type LlmTurn } from '@fir/core';
import { InMemoryJournal, InMemoryKnowledge, firtechGuardContext, runEval, specOf, type EvalCase, type EvalReport, type EvalSet, type Outcome, type TurnFn } from '@fir/fira';
import { createFiraLead } from './fira-lead.js';
import { HANDOFF, merge, newQ, receptionistTurn, type QState, type ReceptionistDeps, type ReceptionistOut } from './receptionist.js';

/**
 * Old runtime vs new on one eval set (`docs/fira-migration-lead-manager.md`, «Как сравнить»). Both are the HQ receptionist end to end (the code paths, the
 * model step, the offers): `old` is the JSON runtime, `new` Fira's `run()` through `fira-lead.ts`. Script mode (CI, no network): the case's script plays the
 * model; for the old runtime it is turned into the JSON answer (the final text, `record_brief` as `extract`, `handoff_owner` person/anger as `intent: handoff`).
 * Live mode: one real model for both (`apps/hq/scripts/fira-compare.ts --live`).
 */

const NOW = Date.UTC(2026, 10, 22, 9, 0, 0);
const FALLBACK = { ru: 'Передал ваш вопрос человеку из команды, он ответит здесь же.', en: 'I passed your question to a person on the team, who will answer here.' };

/** The state the conversation would have: the visitor's earlier words merged, one model turn per earlier answer. */
function stateOf(c: EvalCase): QState {
  let q = newQ();
  for (const t of c.history) if (t.role === 'user') q = merge(q, { reply: '' }, t.text);
  q.turns = c.history.filter((t) => t.role === 'assistant').length;
  return q;
}

/** The scripted model as the old runtime's JSON (the words, what was heard, a hand-off). */
function jsonOf(c: EvalCase): string {
  const s = c.script ?? [];
  const text = [...s].reverse().find((x) => x.text)?.text ?? '';
  const tools = s.flatMap((x) => x.tools ?? []);
  const brief = tools.find((t) => t.name === 'record_brief')?.input ?? {};
  const owner = tools.find((t) => t.name === 'handoff_owner')?.input;
  const { intent, ready, ...extract } = brief as Record<string, unknown>;
  const handoff = owner && (owner.reason === 'person' || owner.reason === 'anger');
  return JSON.stringify({ reply: text, ...(handoff ? { intent: 'handoff' } : intent ? { intent } : {}), ...(ready !== undefined ? { ready } : {}), extract });
}

/** The scripted model for Fira: the dialogue plays the script; Haiku (extraction) and the rewrite answer nothing, as a model that has nothing to add. */
function scriptedChat(c: EvalCase): LlmClient {
  const inner = new MockChatLlm(c.script ?? []);
  return {
    enabled: true,
    complete: () => Promise.resolve(''),
    chat: (req: LlmChatRequest): Promise<LlmTurn> => (req.tier === 'haiku' ? Promise.resolve({ content: [], stopReason: 'end_turn' }) : inner.chat(req)),
  };
}

function outOf(c: EvalCase, out: ReceptionistOut, tools: string[]): Awaited<ReturnType<TurnFn>> {
  const lang = c.lang === 'en' ? 'en' : 'ru';
  const outcome: Outcome = { used: tools, unknown: false };
  if (out.kind === 'fallback') return { reply: FALLBACK[lang], outcome: { ...outcome, handoff: 'fallback' }, fallback: true };
  if (out.kind === 'handoff') return { reply: HANDOFF[lang][out.why], outcome: { ...outcome, handoff: out.why }, fallback: false };
  if (out.kind === 'client') return { reply: HANDOFF[lang].client, outcome: { ...outcome, handoff: 'client' }, fallback: false };
  // a contact the code caught counts as `capture_contact` (the web chat makes the lead from it)
  if (out.contact) {
    outcome.contact = { contact: out.contact, name: '', note: '' };
    if (!tools.includes('capture_contact')) outcome.used = [...tools, 'capture_contact'];
  }
  return { reply: out.text, outcome, fallback: false };
}

const deps = (llm: LlmClient, fira: ReceptionistDeps['fira']): ReceptionistDeps => ({
  llm, instructions: '', gate: { llmAllowed: () => true, llmUsed: () => undefined }, now: () => NOW, tz: () => 'Asia/Dushanbe', slots: () => Promise.resolve([]), fira,
});

const inputOf = (c: EvalCase, conversationId?: string) => ({
  lang: (c.lang === 'en' ? 'en' : 'ru') as 'ru' | 'en', text: c.user, q: stateOf(c), turns: c.history.map((t) => ({ role: t.role, content: t.text })),
  ...(c.mode === 'live' ? { client: { email: 'client@example.com', name: 'Клиент' } } : {}), ...(conversationId ? { conversationId } : {}),
});

/** The old JSON runtime as a turn of the eval. */
export function oldTurn(live?: LlmClient): TurnFn {
  return async (c) => {
    if (!live && c.script && !c.script.length) return outOf(c, { kind: 'fallback', q: newQ(), down: true }, []);
    const llm = live ?? new MockLlm((req: LlmRequest) => (req.system.includes('Перепиши реплику') ? '' : jsonOf(c)));
    const out = await receptionistTurn(deps(llm, null), inputOf(c));
    const tools = out.kind === 'reply' ? [...(out.cta.builder ? ['builder_link'] : []), ...(out.cta.call ? ['call_slots'] : []), ...(/Цены на сайте|Prices as on the site/.test(out.text) ? ['price_list'] : [])] : [];
    return outOf(c, out, tools);
  };
}

/** Fira's run() through the HQ adapter as a turn of the eval (the case's history goes into its memory). */
export function newTurn(live?: LlmClient): TurnFn {
  return async (c) => {
    const journal = new InMemoryJournal();
    const fira = createFiraLead({ now: () => NOW, knowledge: new InMemoryKnowledge(), journal });
    const conv = `eval-${c.id}`;
    if (c.history.length) await fira.stores.memory.append('firtech', conv, c.history.map((h) => ({ role: h.role, text: h.text, at: NOW - 60_000 })), NOW + 86_400_000);
    const out = await receptionistTurn(deps(live ?? scriptedChat(c), fira), inputOf(c, conv));
    const tools = [...new Set(journal.entries.flatMap((e) => e.tools))];
    return outOf(c, out, out.kind === 'reply' && /Цены на сайте|Prices as on the site/.test(out.text) && !tools.includes('price_list') ? [...tools, 'price_list'] : tools);
  };
}

export interface Comparison {
  old: EvalReport;
  fresh: EvalReport;
  /** Cases the new runtime fails and the old passes. */
  newFailures: string[];
  /** Release criteria 1-3 of the migration plan. */
  release: { morePasses: boolean; noNewHardFailures: boolean; judge: boolean; handoff: boolean; fallback: boolean; ok: boolean };
}

const HARD = /\$|дн|недел|month|day|запрет|must not contain/i;

export async function compare(set: EvalSet, o: { live?: LlmClient; judge?: Parameters<typeof runEval>[1]['judge'] } = {}): Promise<Comparison> {
  const base = { spec: specOf(set.spec), guard: firtechGuardContext, ...(o.judge ? { judge: o.judge } : {}) };
  const old = await runEval(set, { ...base, turn: oldTurn(o.live) });
  const fresh = await runEval(set, { ...base, turn: newTurn(o.live) });
  const passedOld = new Set(old.results.filter((r) => r.pass).map((r) => r.id));
  const failedNew = fresh.results.filter((r) => !r.pass);
  const newFailures = failedNew.filter((r) => passedOld.has(r.id)).map((r) => r.id);
  const hard = failedNew.filter((r) => passedOld.has(r.id) && r.failures.some((f) => HARD.test(f)));
  const jm = (r: EvalReport) => r.metrics.judgeMean;
  const release = {
    morePasses: fresh.passed >= old.passed,
    noNewHardFailures: hard.length === 0,
    judge: jm(fresh) === null || jm(old) === null || jm(fresh)! >= jm(old)! - 0.02,
    handoff: fresh.metrics.handoffRate <= old.metrics.handoffRate + 0.05,
    fallback: fresh.metrics.fallbackRate <= old.metrics.fallbackRate,
    ok: false,
  };
  release.ok = release.morePasses && release.noNewHardFailures && release.judge && release.handoff && release.fallback;
  return { old, fresh, newFailures, release };
}
