import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { check, FIRTECH_TOOLS, firtechGuardContext, MockJudge, PACKAGE_DIR, parseEvalSet, runEval, type EvalSet } from '../src/index.js';
import { leadManagerSpec } from './helpers.js';

const file = join(PACKAGE_DIR, 'evals', 'lead-manager.eval.json');
const set = (): EvalSet => parseEvalSet(JSON.parse(readFileSync(file, 'utf8')) as unknown);
const opts = { spec: leadManagerSpec(), tools: FIRTECH_TOOLS, guard: firtechGuardContext };

describe('eval sets', () => {
  it('the lead manager set parses: cases from the old tests, scripts for CI, banned names', () => {
    const s = set();
    expect(s.cases.length).toBeGreaterThanOrEqual(10);
    expect(s.cases.every((c) => c.script)).toBe(true);
    expect(s.banned).toContain('приёмщик');
    expect(() => parseEvalSet({ ...JSON.parse(readFileSync(file, 'utf8')), cases: [s.cases[0], s.cases[0]] })).toThrow(/duplicate/);
  });

  it('the lead manager set passes on Fira in script mode (the CI regression), with its metrics', async () => {
    const r = await runEval(set(), opts);
    expect(r.results.filter((x) => !x.pass)).toEqual([]);
    expect(r.passed).toBe(r.total);
    expect(r.metrics.handoffRate).toBeGreaterThan(0);
    expect(r.metrics.fallbackRate).toBeGreaterThan(0);
    expect(r.metrics.toolUseRate).toBeGreaterThan(0.4);
    expect(r.metrics.judgeMean).toBeNull();
  });

  it('the judge scores only cases with a rubric; a score under the threshold fails the case', async () => {
    const judge = new MockJudge((i) => ({ score: /ровно один вопрос/.test(i.rubric) ? 0.4 : 0.9, notes: 'n' }));
    const r = await runEval(set(), { ...opts, judge });
    expect(judge.asked.length).toBe(set().cases.filter((c) => c.expect.rubric).length);
    expect(r.results.find((x) => x.id === 'salon-need-one-question')!.failures[0]).toMatch(/judge 0.40 < 0.7/);
    expect(r.metrics.judgeMean).not.toBeNull();
  });

  it('check(): every kind of expectation reports its own failure', () => {
    const c = parseEvalSet({
      name: 'x', spec: { company: 'firtech', role: 'lead-manager', niche: 'it-services' },
      cases: [{ id: 'a', user: 'u', expect: { contains: ['да'], notContains: ['нет'], matches: ['^Ок'], callsTool: ['t1'], notCallsTool: ['t2'], handoff: true, fallback: false, maxChars: 5 } }],
    }).cases[0]!;
    const f = check(c, { banned: ['запрет'] }, { reply: 'нет, запрет', outcome: { used: ['t2'], unknown: false }, fallback: true });
    expect(f).toEqual(['must contain «да»', 'must not contain «нет»', 'must not contain «запрет»', 'must match one of ^Ок', 'must call t1', 'must not call t2', 'must hand off', 'must not fall back', 'longer than 5']);
  });

  it('the same set runs against another runtime through `turn` (old vs new on one set); a throwing runtime fails its cases', async () => {
    const old = await runEval(set(), { ...opts, turn: async () => ({ reply: 'Передал менеджеру, он напишет.', outcome: { used: [], unknown: false, handoff: 'x' }, fallback: false }) });
    expect(old.passed).toBeLessThan(old.total);
    const broken = await runEval(set(), { ...opts, turn: () => Promise.reject(new Error('boom')) });
    expect(broken.passed).toBe(0);
    expect(broken.results[0]!.failures[0]).toBe('error: boom');
  });

  it('`pnpm --filter fira eval <file>` runs the set from the command line and exits 0', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--conditions=source', join(PACKAGE_DIR, 'src/eval/cli.ts'), 'evals/lead-manager.eval.json'], {
      cwd: PACKAGE_DIR, encoding: 'utf8', env: { ...process.env, INIT_CWD: PACKAGE_DIR, LLM_API_KEY: '', ANTHROPIC_API_KEY: '' },
    });
    expect(out).toMatch(/lead-manager \/ firtech: (\d+)\/\1 passed/);
  }, 30_000);
});
