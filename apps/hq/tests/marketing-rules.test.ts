/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { readFileSync } from 'node:fs';
import { MockChatLlm, MockLlm, type LlmRequest } from '@fir/core';
import { FIRA_SIGNATURE } from '@fir/worker-content-maker';
import { describe, expect, it } from 'vitest';
import type { Worker } from '@fir/hq';
import { MarketingHead } from '../src/heads/marketing.js';
import { DEFAULT_RULES, RULED_WORKERS, RULES_HEADING, currentRules, firaVoiceOn, rulesLlm, rulesOf, withRules } from '../src/marketing-rules.js';
import { OWNER, instructionsDir, routedLlm } from './helpers.js';
import { serve, shellWorld } from './shell-helpers.js';

const rulesText = (extra: string) => `${DEFAULT_RULES}\n- ${extra}`;

describe('marketing rules: one section of the marketing head instructions', () => {
  it('rulesOf / withRules: the section is found, replaced in place, appended when missing; defaults while missing', () => {
    expect(rulesOf('# Head\n\n## Цикл\nтекст')).toEqual({ text: DEFAULT_RULES, stored: false });
    const added = withRules('# Head\n\n## Цикл\nтекст', '- одно');
    expect(added).toBe(`# Head\n\n## Цикл\nтекст\n\n${RULES_HEADING}\n- одно`);
    expect(rulesOf(added)).toEqual({ text: '- одно', stored: true });
    const middle = `# Head\n\n${RULES_HEADING}\n- старое\n\n## Отчёт\nкоротко`;
    const replaced = withRules(middle, '- новое');
    expect(replaced).toBe(`# Head\n\n${RULES_HEADING}\n- новое\n\n## Отчёт\nкоротко`);
    expect(rulesOf(replaced).text).toBe('- новое');
  });

  it('Fira voice toggle: on by default, [ ] turns it off, a removed line is off', () => {
    expect(firaVoiceOn(DEFAULT_RULES)).toBe(true);
    expect(firaVoiceOn(DEFAULT_RULES.replace('[x]', '[ ]'))).toBe(false);
    expect(firaVoiceOn('- только одно правило')).toBe(false);
  });

  it('the seed file carries exactly the default rules (one source for fresh databases)', () => {
    const file = readFileSync(`${instructionsDir}/marketing-head.md`, 'utf8');
    expect(rulesOf(file)).toEqual({ text: DEFAULT_RULES, stored: true });
  });

  it('rulesLlm: complete, completeDetailed and chat get the block at call time, once', async () => {
    let block = 'ПРАВИЛА v1';
    const inner = new MockLlm(() => 'ok', { inputTokens: 1, outputTokens: 1, model: 'm' });
    const llm = rulesLlm(inner, () => block);
    await llm.complete({ tier: 'haiku', system: 'SYS', messages: [{ role: 'user', content: 'x' }] });
    block = 'ПРАВИЛА v2';
    await llm.completeDetailed!({ tier: 'haiku', system: 'SYS\n\nПРАВИЛА v2', messages: [{ role: 'user', content: 'x' }] });
    expect(inner.calls.map((c) => c.system)).toEqual(['SYS\n\nПРАВИЛА v1', 'SYS\n\nПРАВИЛА v2']);
    const chat = new MockChatLlm([{ text: 'hi' }]);
    await rulesLlm(chat, () => block).chat!({ tier: 'sonnet', system: [{ text: 'A', cache: true }], messages: [{ role: 'user', content: 'x' }] });
    expect(chat.chats[0]!.system).toEqual([{ text: 'A', cache: true }, { text: 'ПРАВИЛА v2' }]);
  });
});

describe('GET/PUT /admin/marketing/rules, rollback', () => {
  it('401 without the token', async () => {
    const p = shellWorld();
    const s = await serve(p);
    expect((await s.http('GET', '/admin/marketing/rules', undefined, {})).status).toBe(401);
    expect((await s.http('PUT', '/admin/marketing/rules', { text: 'x' }, {})).status).toBe(401);
    expect((await s.http('GET', '/admin/marketing/rules')).status).toBe(200);
    await s.close();
  });

  it('versions are the instruction versions of marketing-head: same entity as the Agents section, history, audit rows', async () => {
    const p = shellWorld();
    const g = await p.call('GET', '/admin/marketing/rules');
    expect(g.status).toBe(200);
    expect(g.json).toMatchObject({ ok: true, text: DEFAULT_RULES, version: 0, history: [], firaVoice: true });
    const put = await p.call('PUT', '/admin/marketing/rules', { text: rulesText('Рилсы до 30 секунд.'), note: 'короче рилсы' });
    expect(put.status).toBe(200);
    // the first change stores the seed as v1, the new text is v2
    expect(put.json.version).toBe(2);
    expect(put.json.text).toContain('Рилсы до 30 секунд.');
    expect(put.json.history.map((h: any) => [h.version, h.note])).toEqual([[2, 'короче рилсы'], [1, '']]);
    const card = await p.call('GET', '/admin/agents/marketing-head');
    expect(card.json.instructions.version).toBe(2);
    expect(card.json.instructions.text).toContain('Рилсы до 30 секунд.');
    expect(card.json.instructions.text).toContain('## Чек-лист проверки материала'); // the rest of the head's instructions stays
    expect(card.json.fira).toMatchObject({ pack: 'marketing-head' });
    expect((await p.call('PUT', '/admin/marketing/rules', { text: rulesText('Рилсы до 30 секунд.') })).status).toBe(409);
    expect((await p.call('PUT', '/admin/marketing/rules', { text: '' })).status).toBe(400);
    expect((await p.call('PUT', '/admin/marketing/rules', { text: 'x'.repeat(9000) })).status).toBe(400);
    expect((await p.call('PUT', '/admin/marketing/rules', { text: 'x', extra: 1 })).status).toBe(400);
    // the Agents section writes the same entity: the rules section changes there too
    const viaAgents = await p.call('POST', '/admin/agents/marketing-head/instructions', { text: withRules(card.json.instructions.text, '- только одно'), note: 'agents' });
    expect(viaAgents.status).toBe(200);
    expect((await p.call('GET', '/admin/marketing/rules')).json).toMatchObject({ version: 3, text: '- только одно', firaVoice: false });
    const back = await p.call('POST', '/admin/marketing/rules/rollback', { version: 2 });
    expect(back.status).toBe(200);
    expect(back.json).toMatchObject({ version: 4, firaVoice: true });
    expect(back.json.text).toContain('Рилсы до 30 секунд.');
    expect((await p.call('POST', '/admin/marketing/rules/rollback', { version: 2 })).status).toBe(409);
    expect((await p.call('POST', '/admin/marketing/rules/rollback', { version: 99 })).status).toBe(404);
    const audit = await p.call('GET', '/admin/audit?kind=instruction');
    expect(audit.json.entries.filter((e: any) => e.objectId === 'marketing-head').map((e: any) => e.detail)).toEqual(['v4', 'v3', 'v2', 'v1']);
  });
});

describe('the rules reach the prompts of Content Maker, Publisher, Trend Scout and the head', () => {
  it('a topic order: the Content Maker system prompt carries the current rules block; a new version applies on the next call', async () => {
    const llm = routedLlm();
    const p = shellWorld({ llm });
    await p.call('PUT', '/admin/marketing/rules', { text: rulesText('Правило номер один.') });
    await p.call('POST', '/admin/content/orders', { mode: 'prompt', prompt: 'Про ночные заявки в барбершопе', type: 'post' });
    await p.w.marketing.onHeartbeat();
    const gen = (c: LlmRequest) => c.messages[0]!.content.startsWith('Составь пост');
    const first = llm.calls.filter(gen);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((c) => c.system.includes('Правило номер один.') && c.system.includes('(версия 2;'))).toBe(true);
    // the head's own check reads them too
    expect(llm.calls.filter((c) => c.system.includes('Проверь материал по чек-листу')).every((c) => c.system.includes('Правило номер один.'))).toBe(true);
    await p.call('PUT', '/admin/marketing/rules', { text: rulesText('Правило номер два.') });
    const before = llm.calls.length;
    await p.call('POST', '/admin/content/orders', { mode: 'prompt', prompt: 'Про запись в салон ночью', type: 'post' });
    await p.w.marketing.onHeartbeat();
    const second = llm.calls.slice(before).filter(gen);
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((c) => c.system.includes('Правило номер два.') && !c.system.includes('Правило номер один.'))).toBe(true);
  });

  it('a database without the section (seeded before it existed): the defaults are the block, the head reads them too', async () => {
    const llm = routedLlm();
    const p = shellWorld({ llm });
    const a = p.w.hq.agent('marketing-head')!;
    p.w.hq.db.prepare('UPDATE agents SET instructions = ? WHERE id = ?').run(a.instructions.slice(0, a.instructions.indexOf(RULES_HEADING)).trim(), 'marketing-head');
    expect(currentRules(p.w.hq).stored).toBe(false);
    await p.call('POST', '/admin/content/orders', { mode: 'prompt', prompt: 'Про ночные заявки в барбершопе', type: 'post' });
    await p.w.marketing.onHeartbeat();
    const gen = llm.calls.filter((c) => c.messages[0]!.content.startsWith('Составь пост'));
    expect(gen.length).toBeGreaterThan(0);
    expect(gen.every((c) => c.system.includes(DEFAULT_RULES))).toBe(true);
  });

  it('Fira voice on: post captions end with the signature; off ([ ]): no signature', async () => {
    const on = shellWorld({ llm: routedLlm() });
    const r = await on.call('POST', '/admin/content/orders', { mode: 'prompt', prompt: 'Про ночные заявки в барбершопе', type: 'post' });
    await on.w.marketing.onHeartbeat();
    const item = (await on.call('GET', '/admin/content/orders')).json.items.find((o: any) => o.id === r.json.order.id);
    const text = (on.w.hq.db.prepare('SELECT text FROM cm_items WHERE id = ?').get(item.itemId) as { text: string }).text;
    expect(text).toContain(`\n${FIRA_SIGNATURE}`);
    const off = shellWorld({ llm: routedLlm() });
    await off.call('PUT', '/admin/marketing/rules', { text: DEFAULT_RULES.replace('[x]', '[ ]') });
    const r2 = await off.call('POST', '/admin/content/orders', { mode: 'prompt', prompt: 'Про ночные заявки в барбершопе', type: 'post' });
    await off.w.marketing.onHeartbeat();
    const item2 = (await off.call('GET', '/admin/content/orders')).json.items.find((o: any) => o.id === r2.json.order.id);
    expect((off.w.hq.db.prepare('SELECT text FROM cm_items WHERE id = ?').get(item2.itemId) as { text: string }).text).not.toContain(FIRA_SIGNATURE);
  });

  it('the Trend Scout (and the Publisher by id) get the block and the brand; the Analyst does not', async () => {
    const p = shellWorld({ llm: routedLlm() });
    const seen: Record<string, { system: string; brand: unknown }> = {};
    const spy = (id: string): Worker => ({
      id,
      async run(_t, ctx) {
        await ctx.llm.complete({ tier: 'haiku', system: `SYS ${id}`, messages: [{ role: 'user', content: 'x' }] });
        seen[id] = { system: (llm.calls.at(-1) as LlmRequest).system, brand: ctx.brand };
        return { ok: true, result: 'ok' };
      },
    });
    const llm = new MockLlm(() => '{"ok":true,"issues":[]}');
    const head = new MarketingHead({ hq: p.w.hq, llm, queue: p.w.queue, messenger: p.w.messenger, ownerId: OWNER, reporter: p.w.reporter, trendScout: spy('trend-scout'), analyst: spy('analyst') });
    p.w.hq.runRoutine('marketing-trends-daily');
    p.w.hq.runRoutine('marketing-analyst-weekly');
    await head.onHeartbeat();
    expect(seen['trend-scout']!.system).toContain(`${RULES_HEADING} владельца`);
    expect(seen['trend-scout']!.brand).toEqual({ firaVoice: true });
    expect(seen.analyst!.system).toBe('SYS analyst');
    expect(seen.analyst!.brand).toBeUndefined();
    expect([...RULED_WORKERS].sort()).toEqual(['content-maker', 'publisher', 'trend-scout']);
  });
});
