import { MockLlm } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { Hq, exportOrg, importOrg, meterLlm } from '../src/index.js';
import { setup } from './helpers.js';

describe('costs and budget', () => {
  it('records usage per task and agent with a price table (a model nobody knows is estimated, not free)', () => {
    const { hq } = setup();
    hq.prices = { sonnet: { in: 3, out: 15 } };
    const t = hq.createTask({ title: 'A', dept: 'marketing', creator: 'owner' });
    expect(hq.recordCost({ taskId: t.id, agentId: 'content-maker', model: 'sonnet', inputTokens: 1_000_000, outputTokens: 100_000 }).usd).toBeCloseTo(4.5);
    expect(hq.recordCost({ taskId: t.id, agentId: 'content-maker', model: 'haiku', inputTokens: 500, outputTokens: 500 }).usd).toBeCloseTo(0.0025); // 500 * 1 + 500 * 4 per 1M
    expect(hq.task(t.id)!.costUsd).toBeCloseTo(4.5025);
    expect(hq.costSummary(0)[0]).toMatchObject({ dept: 'marketing', inputTokens: 1_000_500, outputTokens: 100_500 });
  });

  it('prices Claude 5.5 by the owner list (also over old generic rows), cache reads at 10%, limits 80% and 100% by those prices', async () => {
    const { hq } = setup();
    // an old database has the generic rows only; the seeded 5.5 rows are longer prefixes and win
    expect(hq.prices['claude-sonnet-5-5']).toEqual({ in: 2, out: 10 });
    expect(hq.recordCost({ agentId: 'content-maker', model: 'claude-haiku-5-5', inputTokens: 1_000_000, outputTokens: 1_000_000 }).usd).toBeCloseTo(0.6);
    expect(hq.recordCost({ agentId: 'content-maker', model: 'claude-sonnet-5-5', inputTokens: 1_000_000, outputTokens: 100_000 }).usd).toBeCloseTo(3);
    expect(hq.recordCost({ agentId: 'content-maker', model: 'claude-opus-5-5', inputTokens: 1_000_000, outputTokens: 100_000 }).usd).toBeCloseTo(6);
    expect(hq.recordCost({ agentId: 'content-maker', model: 'claude-sonnet-5-5', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 }).usd).toBeCloseTo(0.2);
    expect(hq.llmUsage(0).calls).toBe(4);
    expect(hq.llmUsage(0).usd).toBeCloseTo(0.6 + 3 + 6 + 0.2);
    const alerts: string[] = [];
    hq.onAlert((t) => void alerts.push(t));
    hq.upsertAgent({ ...hq.agent('marketing-head')!, budgetUsdMonth: 20 });
    // spent so far 9.8; one more Sonnet call of 6M input costs 12: over 100%; at 80% (16) a warning comes first
    hq.recordCost({ agentId: 'content-maker', model: 'claude-sonnet-5-5', inputTokens: 3_000_000, outputTokens: 0 }); // +6 = 15.8 (79%)
    expect(hq.overBudget('marketing')).toBe(false);
    hq.recordCost({ agentId: 'content-maker', model: 'claude-sonnet-5-5', inputTokens: 200_000, outputTokens: 0 }); // +0.4 = 16.2 (81%)
    await Promise.resolve();
    expect(alerts.some((a) => a.includes('81%'))).toBe(true);
    hq.recordCost({ agentId: 'content-maker', model: 'claude-sonnet-5-5', inputTokens: 2_000_000, outputTokens: 0 }); // +4 = 20.2
    expect(hq.overBudget('marketing')).toBe(true);
  });

  it('over the department limit: the task is blocked, one alert per month, calls refused', async () => {
    const { hq, clock } = setup();
    hq.upsertAgent({ ...hq.agent('marketing-head')!, budgetUsdMonth: 1 });
    const alerts: string[] = [];
    hq.onAlert((t) => void alerts.push(t));
    const t = hq.createTask({ title: 'A', dept: 'marketing', creator: 'owner' });
    hq.claim(t.id, 'marketing-head');
    expect(hq.recordCost({ taskId: t.id, agentId: 'content-maker', model: 'm', inputTokens: 0, outputTokens: 0, usd: 0.6 }).blocked).toBe(false);
    const r = hq.recordCost({ taskId: t.id, agentId: 'content-maker', model: 'm', inputTokens: 0, outputTokens: 0, usd: 0.6 });
    expect(r.blocked).toBe(true);
    expect(hq.task(t.id)!.status).toBe('blocked');
    await Promise.resolve();
    expect(alerts).toHaveLength(1);
    hq.recordCost({ agentId: 'content-maker', model: 'm', inputTokens: 0, outputTokens: 0, usd: 0.1 });
    expect(alerts).toHaveLength(1);
    expect(hq.overBudget('marketing')).toBe(true);
    const llm = meterLlm(new MockLlm(() => 'x'), hq, { agentId: 'content-maker' });
    await expect(llm.complete({ tier: 'haiku', system: 's', messages: [{ role: 'user', content: 'u' }] })).rejects.toThrow(/Лимит/);
    // next month: the spend resets
    clock.t = Date.UTC(2026, 11, 2, 7, 0);
    expect(hq.overBudget('marketing')).toBe(false);
  });

  it('meterLlm writes estimated tokens to costs for the task', async () => {
    const { hq } = setup();
    const t = hq.createTask({ title: 'A', dept: 'marketing', creator: 'owner' });
    const llm = meterLlm(new MockLlm(() => 'abcdefgh'), hq, { agentId: 'content-maker', taskId: t.id });
    expect(await llm.complete({ tier: 'sonnet', system: 'abcd', messages: [{ role: 'user', content: 'abcdabcd' }] })).toBe('abcdefgh');
    expect(hq.costSummary(0)[0]).toMatchObject({ inputTokens: 3, outputTokens: 2 });
    expect(llm.enabled).toBe(true);
  });
});

describe('real usage and prices', () => {
  it('meterLlm uses the usage the client reports: tokens and the model that answered, priced from the table', async () => {
    const { hq } = setup();
    const t = hq.createTask({ title: 'A', dept: 'marketing', creator: 'owner' });
    const llm = meterLlm(new MockLlm(() => 'x', { inputTokens: 2_000_000, outputTokens: 100_000, model: 'claude-sonnet-5-5' }), hq, { agentId: 'content-maker', taskId: t.id });
    await llm.complete({ tier: 'sonnet', system: 's', messages: [{ role: 'user', content: 'u' }] });
    const row = hq.db.prepare('SELECT model, input_tokens i, output_tokens o, usd FROM costs').get() as { model: string; i: number; o: number; usd: number };
    expect(row).toMatchObject({ model: 'claude-sonnet-5-5', i: 2_000_000, o: 100_000 });
    expect(row.usd).toBeCloseTo(5); // 2M * $2 + 0.1M * $10
    expect(llm.completeDetailed).toBeDefined();
  });

  it('a :free model costs 0, an unknown one the estimate (and says so once); the longest prefix wins; setPrice persists', () => {
    const { hq, db } = setup();
    const rec = (model: string) => hq.recordCost({ agentId: 'content-maker', model, inputTokens: 1_000_000, outputTokens: 0 }).usd;
    expect(rec('qwen/qwen3:free')).toBe(0);
    expect(rec('glm-4.6')).toBeCloseTo(1); // unknown: 1M input at the estimate (in $1)
    expect(rec('auto')).toBeCloseTo(1); // the alias itself tells nothing about the model
    expect(hq.activity().filter((a) => a.action === 'cost_unknown_model')).toHaveLength(2); // once per model
    rec('glm-4.6');
    expect(hq.activity().filter((a) => a.action === 'cost_unknown_model')).toHaveLength(2);
    hq.setPrice('glm', 0, 0);
    expect(rec('glm-4.6')).toBe(0);
    expect(rec('claude-haiku-5-5')).toBeCloseTo(0.1);
    hq.setPrice('claude-haiku-5-5', 0.5, 2.5);
    expect(rec('claude-haiku-5-5')).toBeCloseTo(0.5);
    expect(new Hq(db).prices['claude-haiku-5-5']).toEqual({ in: 0.5, out: 2.5 });
    expect(() => hq.setPrice('x', -1, 0)).toThrow();
  });
});

describe('export and import', () => {
  it('round-trips org, instructions, routines and settings; no secrets, no tasks', () => {
    const { hq } = setup();
    hq.upsertAgent({ ...hq.agent('marketing-head')!, bot: 'MARKETING_BOT_TOKEN', instructions: 'Правила\nвторая строка', budgetUsdMonth: 5 });
    hq.scheduleRoutine({ name: 'daily', cron: '0 9 * * *', dept: 'marketing', title: 'Сегодня', meta: { action: 'daily' } });
    hq.setSetting('quiet_hours', '23:00-07:00');
    hq.setSetting('budget_alert:marketing:2026-11', '1');
    hq.createTask({ title: 'secret-task', dept: 'marketing', creator: 'owner' });
    const yaml = exportOrg(hq);
    expect(yaml).toContain('MARKETING_BOT_TOKEN');
    expect(yaml).not.toContain('secret-task');
    expect(yaml).not.toContain('budget_alert');

    const fresh = setup().hq;
    fresh.db.exec('DELETE FROM agents; DELETE FROM routines;');
    expect(importOrg(fresh, yaml)).toEqual({ agents: 4, routines: 1, settings: 6 });
    expect(fresh.agent('marketing-head')).toMatchObject({ bot: 'MARKETING_BOT_TOKEN', instructions: 'Правила\nвторая строка', budgetUsdMonth: 5, bossId: 'director' });
    expect(fresh.routineByName('daily')!.meta).toEqual({ action: 'daily' });
    expect(fresh.setting('quiet_hours')).toBe('23:00-07:00');
    expect(exportOrg(fresh)).toBe(yaml);
  });

  it('rejects unknown fields, bot values that are not env var names, and foreign settings', () => {
    const { hq } = setup();
    const base = 'version: 1\nagents:\n  - id: x\n    dept: d\n    role: worker\n    title: T\n';
    expect(() => importOrg(hq, `${base}    token: 123:ABC\n`)).toThrow();
    expect(() => importOrg(hq, `${base}    bot: "123456:AAEhBP0av28"\n`)).toThrow();
    expect(() => importOrg(hq, 'version: 1\nsettings:\n  hq_secret: x\n')).toThrow(/not importable/);
    expect(importOrg(hq, base)).toMatchObject({ agents: 1 });
  });
});

describe('limits: 80% alert, 100% soft stop, urgent work goes on', () => {
  const limited = () => {
    const w = setup();
    w.hq.upsertAgent({ ...w.hq.agent('marketing-head')!, budgetUsdMonth: 10 });
    const alerts: string[] = [];
    w.hq.onAlert((t) => void alerts.push(t));
    const rec = (usd: number, taskId?: number, urgent = false) => w.hq.recordCost({ taskId: taskId ?? null, agentId: 'content-maker', model: 'm', inputTokens: 0, outputTokens: 0, usd, ...(urgent ? { urgent } : {}) });
    return { ...w, alerts, rec };
  };

  it('one alert at 80% and one at 100% per month', async () => {
    const { rec, alerts } = limited();
    rec(7.9);
    expect(alerts).toHaveLength(0);
    rec(0.2); // 8.1
    rec(0.5);
    await Promise.resolve();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('81%');
    rec(2); // 10.6: over
    await Promise.resolve();
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toContain('исчерпан');
    rec(1);
    expect(alerts).toHaveLength(2);
  });

  it('at 100% a routine task is blocked, a priority-2 task and a client-bot call are not', async () => {
    const { hq, rec } = limited();
    const normal = hq.createTask({ title: 'n', dept: 'marketing', creator: 'routine' });
    const rush = hq.createTask({ title: 'r', dept: 'marketing', creator: 'owner', priority: 2 });
    hq.claim(normal.id, 'marketing-head');
    hq.claim(rush.id, 'marketing-head');
    rec(10.5);
    expect(rec(0.1, normal.id).blocked).toBe(true);
    expect(rec(0.1, rush.id).blocked).toBe(false);
    expect(hq.task(rush.id)!.status).toBe('running');
    const refused = meterLlm(new MockLlm(() => 'x'), hq, { agentId: 'content-maker', taskId: normal.id });
    await expect(refused.complete({ tier: 'haiku', system: 's', messages: [{ role: 'user', content: 'u' }] })).rejects.toThrow(/Лимит/);
    const urgent = meterLlm(new MockLlm(() => 'x'), hq, { agentId: 'content-maker', urgent: true });
    expect(await urgent.complete({ tier: 'haiku', system: 's', messages: [{ role: 'user', content: 'u' }] })).toBe('x');
    const prio = meterLlm(new MockLlm(() => 'x'), hq, { agentId: 'content-maker', taskId: rush.id });
    expect(await prio.complete({ tier: 'haiku', system: 's', messages: [{ role: 'user', content: 'u' }] })).toBe('x');
  });
});
