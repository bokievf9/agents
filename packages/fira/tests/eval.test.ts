import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MockChatLlm } from '@fir/core';
import { check, compile, EXEC_TOOL_DEFS, execAssistantSpec, FIRTECH_TOOLS, firtechGuardContext, memoryStores, mockTools, MockJudge, PACKAGE_DIR, parseEvalSet, run, runEval, type EvalSet } from '../src/index.js';
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

describe('the executive assistant (HQ bot answers, owner 2026-11-22)', () => {
  const execFile = join(PACKAGE_DIR, 'evals', 'executive-assistant.eval.json');
  const execSet = (): EvalSet => parseEvalSet(JSON.parse(readFileSync(execFile, 'utf8')) as unknown);

  it('its eval set has 10-15 scripted cases on mock data and passes in script mode', async () => {
    const s = execSet();
    expect(s.cases.length).toBeGreaterThanOrEqual(10);
    expect(s.cases.length).toBeLessThanOrEqual(15);
    expect(s.cases.every((c) => c.script && c.mode === 'live')).toBe(true);
    expect(Object.keys(s.mocks).sort()).toEqual(Object.keys(EXEC_TOOL_DEFS).sort());
    const r = await runEval(s, { spec: execAssistantSpec(), guard: firtechGuardContext });
    expect(r.results.filter((x) => !x.pass)).toEqual([]);
    expect(r.metrics.toolUseRate).toBe(1);
    expect(r.metrics.handoffRate).toBe(0);
  });

  it('the spec: read-only tools only, no price or date guard (its answers are the company numbers), Sonnet and Haiku for counts', () => {
    const spec = execAssistantSpec();
    expect(spec.id).toBe('firtech/executive-assistant');
    expect(spec.guards).toMatchObject({ prices: false, dates: false });
    expect(spec.model.default).toBe('sonnet');
    expect(spec.model.byTask.faq).toBe('haiku');
    const c = compile(spec, { ...mockTools(Object.fromEntries(Object.keys(EXEC_TOOL_DEFS).map((k) => [k, {}]))) });
    expect(c.missingTools).toEqual([]);
    expect(c.toolNames).toEqual(Object.keys(EXEC_TOOL_DEFS).concat('price_list').sort());
    expect(c.toolNames.some((t) => /approve|reject|send|mark|create|set_/.test(t))).toBe(false);
    expect(c.system[0]!.text).toContain('Никаких действий из чата');
  });

  it('a tool the role does not have is refused by the runtime (the model cannot act through a name it invents)', async () => {
    const llm = new MockChatLlm([{ tools: [{ name: 'mark_paid', input: { number: 'FT-1' } }] }, { text: 'Это в Пульте.' }]);
    const stores = memoryStores();
    const out = await run(execAssistantSpec(), { id: 'owner', text: 'отметь оплату', mode: 'live', lang: 'ru' }, { llm, ...stores, now: () => 0, guard: firtechGuardContext('ru'), tools: mockTools({}) });
    expect(out.reply).toBe('Это в Пульте.');
    const second = llm.chats[1]!.messages.at(-1)!.content as { content: string; is_error?: boolean }[];
    expect(second[0]!.is_error).toBe(true);
    expect(second[0]!.content).toContain('not_allowed');
  });

  it('a count question with task faq goes to Haiku, an open question to Sonnet', async () => {
    for (const [task, tier] of [['faq', 'haiku'], [undefined, 'sonnet']] as const) {
      const llm = new MockChatLlm([{ text: 'Три.' }]);
      await run(execAssistantSpec(), { id: 'o', text: 'сколько?', mode: 'live', lang: 'ru', ...(task ? { task } : {}) }, { llm, ...memoryStores(), now: () => 0, guard: firtechGuardContext('ru'), tools: mockTools({}) });
      expect(llm.chats[0]!.tier).toBe(tier);
    }
  });
});
