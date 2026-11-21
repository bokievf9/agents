import { MockChatLlm, type LlmClient } from '@fir/core';
import { memoryStores } from '../adapters/memory.js';
import { applyGuards, type GuardContext } from '../guards.js';
import { run, type RunOut } from '../run.js';
import type { AgentSpec } from '../spec.js';
import type { ToolRegistry } from '../tools.js';
import type { EvalCase, EvalSet } from './format.js';
import type { Judge } from './judge.js';

/**
 * Runs an eval set against a spec: every case gets fresh in-memory stores (its knowledge, its history), the scripted model unless `live`,
 * then the expectations and the judge. The report has a line per case and the metrics of the set (hand-off share, fallback share, «не знал»,
 * tool use). Old runtime vs new on one set: run the set twice with two `turn` functions (`docs/fira-migration-lead-manager.md`).
 */

export interface CaseResult {
  id: string;
  pass: boolean;
  failures: string[];
  reply: string;
  tools: string[];
  handoff: boolean;
  fallback: boolean;
  unknown: boolean;
  score?: number;
}

export interface EvalReport {
  name: string;
  total: number;
  passed: number;
  results: CaseResult[];
  metrics: { handoffRate: number; fallbackRate: number; unknownRate: number; toolUseRate: number; judgeMean: number | null };
}

/** One turn of the system under test: Fira's `run` by default, the old runtime through an adapter when comparing. */
export type TurnFn = (c: EvalCase, setup: { now: number }) => Promise<Pick<RunOut, 'reply' | 'outcome' | 'fallback'>>;

export interface EvalOptions {
  spec: AgentSpec;
  tools?: ToolRegistry;
  guard: GuardContext | ((lang: string) => GuardContext);
  /** The real model (`--live`); absent: each case's script. A case without a script and without a live model fails. */
  live?: LlmClient;
  judge?: Judge;
  /** Replace the system under test (comparison with the old runtime). */
  turn?: TurnFn;
  now?: number;
}

const NOW = Date.UTC(2026, 10, 22, 9, 0, 0);

function firaTurn(o: EvalOptions, set: EvalSet): TurnFn {
  return async (c, { now }) => {
    if (!o.live && !c.script) throw new Error('no script and no live model');
    const stores = memoryStores();
    const kn = [...set.knowledge, ...c.knowledge];
    await stores.knowledge.add(kn.map((k, i) => ({ id: `k${i}`, companyId: o.spec.company.id, source: 'manual', title: k.title, text: k.text, updatedAt: now })));
    if (c.history.length) await stores.memory.append(o.spec.company.id, `eval-${c.id}`, c.history.map((h) => ({ role: h.role, text: h.text, at: now - 60_000 })), now + 86_400_000);
    const guard = typeof o.guard === 'function' ? o.guard(c.lang) : o.guard;
    return run(o.spec, { id: `eval-${c.id}`, text: c.user, mode: c.mode, lang: c.lang }, {
      llm: o.live ?? new MockChatLlm(c.script ?? []), ...stores, now: () => now, guard, ...(o.tools ? { tools: o.tools } : {}),
    });
  };
}

/** The checks of one case on a reply; empty list: pass. */
export function check(c: EvalCase, set: Pick<EvalSet, 'banned'>, out: Pick<RunOut, 'reply' | 'outcome' | 'fallback'>): string[] {
  const f: string[] = [];
  const low = out.reply.toLowerCase();
  for (const w of c.expect.contains) if (!low.includes(w.toLowerCase())) f.push(`must contain «${w}»`);
  for (const w of [...c.expect.notContains, ...set.banned]) if (low.includes(w.toLowerCase())) f.push(`must not contain «${w}»`);
  if (c.expect.matches.length && !c.expect.matches.some((re) => new RegExp(re, 'iu').test(out.reply))) f.push(`must match one of ${c.expect.matches.join(' | ')}`);
  for (const t of c.expect.callsTool) if (!out.outcome.used.includes(t)) f.push(`must call ${t}`);
  for (const t of c.expect.notCallsTool) if (out.outcome.used.includes(t)) f.push(`must not call ${t}`);
  if (c.expect.handoff !== undefined && Boolean(out.outcome.handoff) !== c.expect.handoff) f.push(c.expect.handoff ? 'must hand off' : 'must not hand off');
  if (c.expect.fallback !== undefined && out.fallback !== c.expect.fallback) f.push(c.expect.fallback ? 'must fall back' : 'must not fall back');
  if (c.expect.maxChars !== undefined && out.reply.length > c.expect.maxChars) f.push(`longer than ${c.expect.maxChars}`);
  return f;
}

const share = (xs: boolean[]): number => (xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 1000) / 1000 : 0);

export async function runEval(set: EvalSet, o: EvalOptions): Promise<EvalReport> {
  const turn = o.turn ?? firaTurn(o, set);
  const results: CaseResult[] = [];
  const scores: number[] = [];
  for (const c of set.cases) {
    let out: Pick<RunOut, 'reply' | 'outcome' | 'fallback'>;
    try {
      out = await turn(c, { now: o.now ?? NOW });
    } catch (e) {
      results.push({ id: c.id, pass: false, failures: [`error: ${e instanceof Error ? e.message : String(e)}`], reply: '', tools: [], handoff: false, fallback: true, unknown: false });
      continue;
    }
    const failures = check(c, set, out);
    let score: number | undefined;
    if (o.judge && c.expect.rubric) {
      const v = await o.judge.score({ rubric: c.expect.rubric, user: c.user, reply: out.reply, lang: c.lang });
      score = v.score;
      scores.push(v.score);
      if (v.score < set.threshold) failures.push(`judge ${v.score.toFixed(2)} < ${set.threshold}: ${v.notes}`);
    }
    results.push({
      id: c.id, pass: failures.length === 0, failures, reply: out.reply, tools: [...out.outcome.used], handoff: Boolean(out.outcome.handoff), fallback: out.fallback,
      unknown: out.outcome.unknown, ...(score !== undefined ? { score } : {}),
    });
  }
  return {
    name: set.name,
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    results,
    metrics: {
      handoffRate: share(results.map((r) => r.handoff)),
      fallbackRate: share(results.map((r) => r.fallback)),
      unknownRate: share(results.map((r) => r.unknown)),
      toolUseRate: share(results.map((r) => r.tools.length > 0)),
      judgeMean: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000 : null,
    },
  };
}

/** The guards as a turn of their own: lets an eval check a fixed reply (e.g. a reply of the old runtime) through the new guards. */
export const guardOnly = (spec: AgentSpec, guard: GuardContext) => (reply: string) => applyGuards(reply, spec.guards, guard);
