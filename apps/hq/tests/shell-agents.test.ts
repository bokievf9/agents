/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { describe, expect, it } from 'vitest';
import { ROLE_TITLES } from '@fir/core';
import { shellWorld, serve } from './shell-helpers.js';

describe('Agents section: GET /admin/agents and /admin/agents/:id', () => {
  it('401 without the token', async () => {
    const p = shellWorld();
    const s = await serve(p);
    expect((await s.http('GET', '/admin/agents', undefined, {})).status).toBe(401);
    await s.close();
  });

  it('list: every agent with an English title, departments with their limit and spend', async () => {
    const p = shellWorld({ budget: 25 });
    p.w.hq.recordCost({ agentId: 'content-maker', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 500, usd: 0.5 });
    const r = await p.call('GET', '/admin/agents');
    expect(r.status).toBe(200);
    const agents = r.json.agents as any[];
    expect(agents.length).toBeGreaterThan(5);
    for (const a of agents) {
      expect(Object.keys(a).sort()).toEqual(['bossId', 'dept', 'gloss', 'hasFira', 'id', 'instructionVersion', 'monthUsd', 'openTasks', 'role', 'status', 'title', 'trustLevel']);
      const known = ROLE_TITLES.find((t) => t.id === a.id);
      if (known) expect(a.title).toBe(known.en);
    }
    expect(agents.find((a) => a.id === 'content-maker').monthUsd).toBe(0.5);
    expect(agents.find((a) => a.id === 'client-bot')?.hasFira ?? true).toBe(true);
    const marketing = (r.json.departments as any[]).find((d) => d.id === 'marketing');
    expect(marketing).toMatchObject({ budgetUsd: 25, monthUsd: 0.5 });
  });

  it('card: role, instructions, trust, tools, budget, Fira pack, history counters; unknown id is 404', async () => {
    const p = shellWorld({ budget: 25 });
    const r = await p.call('GET', '/admin/agents/content-maker');
    expect(r.status).toBe(200);
    expect(r.json.agent).toMatchObject({ id: 'content-maker', title: 'Content Maker', dept: 'marketing', role: 'worker' });
    expect(Object.keys(r.json).sort()).toEqual(['agent', 'budget', 'fira', 'history', 'instructions', 'ok', 'tools', 'trust']);
    expect(r.json.instructions).toMatchObject({ version: 0, versions: [] });
    expect(r.json.tools.length).toBeGreaterThan(5);
    expect(r.json.budget).toMatchObject({ dept: 'marketing', deptLimitUsd: 25 });
    expect(r.json.fira).toBeNull();
    expect(Object.keys(r.json.history).sort()).toEqual(['decisionsByKind', 'recentDecisions', 'recentTasks', 'tasksByStatus']);
    expect((await p.call('GET', '/admin/agents/nope')).status).toBe(404);
    expect((await p.call('GET', '/admin/agents/..%2Fx')).status).toBe(404);
  });

  it('Fira pack for the director (executive assistant) is described without a file error', async () => {
    const p = shellWorld();
    const r = await p.call('GET', '/admin/agents/director');
    expect(r.json.fira).toMatchObject({ pack: 'executive-assistant' });
    expect(r.json.fira.error).toBeUndefined();
    expect(r.json.fira.tier).toMatch(/haiku|sonnet|opus/);
  });

  it('history carries ids and counters only, never task titles or client text', async () => {
    const p = shellWorld();
    p.w.hq.createTask({ title: 'Секретный клиент Иванов', dept: 'marketing', creator: 'owner', assigneeId: 'content-maker' });
    const r = await p.call('GET', '/admin/agents/content-maker');
    expect(r.json.history.tasksByStatus).toEqual({ assigned: 1 });
    expect(r.json.history.recentTasks).toHaveLength(1);
    expect(JSON.stringify(r.json.history)).not.toContain('Иванов');
  });
});

describe('Agents section: instruction versions', () => {
  it('the first edit stores the old text as v1, then v2; list is newest first, version text is readable', async () => {
    const p = shellWorld();
    const before = (await p.call('GET', '/admin/agents/marketing-head')).json.instructions.text as string;
    expect(before.length).toBeGreaterThan(0);
    const w = await p.call('POST', '/admin/agents/marketing-head/instructions', { text: 'Новая инструкция', note: 'проба' });
    expect(w.status).toBe(200);
    expect(w.json.instructions).toMatchObject({ text: 'Новая инструкция', version: 2 });
    expect(w.json.instructions.versions.map((v: any) => [v.version, v.actor])).toEqual([[2, 'owner'], [1, 'seed']]);
    expect(w.json.instructions.versions[0].note).toBe('проба');
    const v1 = await p.call('GET', '/admin/agents/marketing-head/instructions/1');
    expect(v1.json.text).toBe(before);
    expect(p.w.hq.agent('marketing-head')!.instructions).toBe('Новая инструкция');
    expect((await p.call('GET', '/admin/agents/marketing-head/instructions/9')).status).toBe(404);
  });

  it('rollback makes a new version with the old text and keeps the history', async () => {
    const p = shellWorld();
    const before = p.w.hq.agent('marketing-head')!.instructions;
    await p.call('POST', '/admin/agents/marketing-head/instructions', { text: 'Правка' });
    const r = await p.call('POST', '/admin/agents/marketing-head/instructions/rollback', { version: 1 });
    expect(r.status).toBe(200);
    expect(r.json.instructions.version).toBe(3);
    expect(r.json.instructions.text).toBe(before);
    expect(r.json.instructions.versions).toHaveLength(3);
    expect((await p.call('POST', '/admin/agents/marketing-head/instructions/rollback', { version: 3 })).status).toBe(409);
    expect((await p.call('POST', '/admin/agents/marketing-head/instructions/rollback', { version: 77 })).status).toBe(404);
  });

  it('a worker without instructions: the first edit is v1 by the owner, no seed row', async () => {
    const p = shellWorld();
    const w = await p.call('POST', '/admin/agents/content-maker/instructions', { text: 'Первая' });
    expect(w.json.instructions.versions.map((v: any) => [v.version, v.actor])).toEqual([[1, 'owner']]);
  });

  it('refuses empty, oversized, extra-field and unchanged text; unknown agent is 404', async () => {
    const p = shellWorld();
    expect((await p.call('POST', '/admin/agents/marketing-head/instructions', { text: '   ' })).status).toBe(400);
    expect((await p.call('POST', '/admin/agents/marketing-head/instructions', { text: 'x'.repeat(20_001) })).status).toBe(400);
    expect((await p.call('POST', '/admin/agents/marketing-head/instructions', { text: 'ok', extra: 1 })).status).toBe(400);
    const same = p.w.hq.agent('marketing-head')!.instructions;
    expect((await p.call('POST', '/admin/agents/marketing-head/instructions', { text: same })).status).toBe(409);
    expect((await p.call('POST', '/admin/agents/ghost/instructions', { text: 'ok' })).status).toBe(404);
    expect(p.w.hq.instructionVersions('marketing-head')).toHaveLength(0);
  });
});
