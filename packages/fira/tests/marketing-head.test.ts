import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS, MARKETING_TOOL_DEFS, compile, loadRolePack, marketingHeadSpec, mockTools, systemText, toolNamesOf } from '../src/index.js';

describe('Fira as Head of Marketing (role pack marketing-head)', () => {
  it('the pack: goal, duties, boundaries (never publish, never touch prices), style (Fira, no «бот»), the marketing tools', () => {
    const r = loadRolePack('marketing-head');
    expect(r.title).toBe('Фира, Head of Marketing');
    expect(r.tier).toBe('sonnet');
    expect(r.duties.length).toBeGreaterThanOrEqual(5);
    expect(r.boundaries.join(' ')).toMatch(/ничего не публикуешь/);
    expect(r.boundaries.join(' ')).toMatch(/Цены не меняешь/);
    expect(r.style.join(' ')).toMatch(/спокойная всезнайка/);
    expect(r.duties.join(' ')).toMatch(/один короткий вопрос/);
    expect(r.tools.filter((t) => !(t in MARKETING_TOOL_DEFS)).sort()).toEqual(['knowledge_search', 'price_list']);
  });

  it('the spec talks to the owner, keeps the price guard, no date guard; every tool has its definition', () => {
    const s = marketingHeadSpec();
    expect(s.id).toBe('firtech/marketing-head');
    expect(s.audience).toBe('owner');
    expect(s.guards).toMatchObject({ prices: true, dates: false });
    const reg = { ...BUILTIN_TOOLS, ...mockTools(Object.fromEntries(Object.keys(MARKETING_TOOL_DEFS).map((k) => [k, {}]))) };
    const c = compile(s, reg);
    expect(c.missingTools).toEqual([]);
    expect(c.toolNames).toEqual(toolNamesOf(s));
    expect(c.tools.find((t) => t.name === 'create_order')!.input_schema).toMatchObject({ required: ['mode'] });
    const text = systemText(s, c.toolNames);
    expect(text).toContain('Ты Фира, Head of Marketing компании «Fir Tech»');
    expect(text).not.toMatch(/(ии|ai)[- ]бот/iu);
  });
});
