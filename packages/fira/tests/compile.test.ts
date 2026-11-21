import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS, compile, FIRTECH_TOOLS, tierFor, toolNamesOf, withBudget, type ModelPolicy } from '../src/index.js';
import { leadManagerSpec } from './helpers.js';

const registry = { ...BUILTIN_TOOLS, ...FIRTECH_TOOLS };

describe('compile(spec)', () => {
  it('is deterministic: the same spec gives byte-identical system, tools and fingerprint', () => {
    const a = compile(leadManagerSpec(), registry);
    const b = compile(leadManagerSpec(), registry);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the system prompt of the lead manager of Fir Tech (snapshot: a change of a pack shows here)', () => {
    const c = compile(leadManagerSpec(), registry);
    expect(c.system).toHaveLength(1);
    expect(c.system[0]!.cache).toBe(true);
    expect(c.system[0]!.text).toMatchSnapshot();
  });

  it('tools are native definitions, sorted, from the role plus the company allow minus deny', () => {
    const c = compile(leadManagerSpec(), registry);
    expect(c.toolNames).toEqual(['builder_link', 'call_slots', 'capture_contact', 'demo_link', 'handoff_owner', 'knowledge_search', 'price_list', 'record_brief']);
    expect(c.tools.map((t) => t.name)).toEqual(c.toolNames);
    expect(c.tools.every((t) => t.input_schema.type === 'object' && t.description.length > 10)).toBe(true);
    expect(c.missingTools).toEqual([]);
    expect(c.tools).toMatchSnapshot();
    const spec = leadManagerSpec();
    spec.company = { ...spec.company, rights: { ...spec.company.rights, allow: ['web_search'], deny: ['call_slots'] } };
    expect(toolNamesOf(spec)).toEqual(['builder_link', 'capture_contact', 'demo_link', 'handoff_owner', 'knowledge_search', 'price_list', 'record_brief', 'web_search']);
    const c2 = compile(spec, registry);
    expect(c2.missingTools).toEqual(['web_search']);
    expect(c2.toolNames).not.toContain('call_slots');
    expect(c2.fingerprint).not.toBe(c.fingerprint);
  });

  it('without app tools only the built-ins are available and the rest is reported missing', () => {
    const c = compile(leadManagerSpec(), BUILTIN_TOOLS);
    expect(c.toolNames).toEqual(['capture_contact', 'handoff_owner', 'knowledge_search']);
    expect(c.missingTools).toEqual(['builder_link', 'call_slots', 'demo_link', 'price_list', 'record_brief']);
    expect(c.system[0]!.text).toContain('Доступны: capture_contact, handoff_owner, knowledge_search.');
  });

  it('the system text carries role, niche, company, boundaries, hand-off, style and the safety rules', () => {
    const t = compile(leadManagerSpec(), registry).system[0]!.text;
    for (const part of ['# ИИ-менеджер заявок, Fir Tech', '## Обязанности', '## Как продаёт менеджер', '## Кому продаём и что у них болит', '## Оффер', '## Возражения и ответы', '## Сфера: ИТ-услуги', '## Компания: Fir Tech', '## Границы', '## Когда передать человеку', '## Стиль', '## Инструменты', '## Безопасность']) {
      expect(t).toContain(part);
    }
    expect(t).toContain('не больше 3 предложений в ответе, без эмодзи');
    expect(t).toContain('Это решает человек, ты только передаёшь: цены, договоры, деньги.');
    expect(t).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe('model policy', () => {
  const p: ModelPolicy = { default: 'sonnet', byTask: { extract: 'haiku', consult: 'opus' }, maxTokens: 600, maxRounds: 4, monthlyBudgetUsd: 10 };
  it('tier by task: the default for the dialogue, Haiku for extraction, Opus for a consultation', () => {
    expect(tierFor(p)).toBe('sonnet');
    expect(tierFor(p, 'extract')).toBe('haiku');
    expect(tierFor(p, 'consult')).toBe('opus');
    expect(compile(leadManagerSpec({ model: { byTask: { consult: 'opus' } } }), registry, { task: 'consult' }).model).toEqual({ tier: 'opus', maxTokens: 600 });
  });
  it('budget: below 80% as is, from 80% one step down, at 100% no call; no budget, no cap', () => {
    expect(withBudget('opus', p, 7.9)).toBe('opus');
    expect(withBudget('opus', p, 8)).toBe('sonnet');
    expect(withBudget('sonnet', p, 9)).toBe('haiku');
    expect(withBudget('haiku', p, 9)).toBe('haiku');
    expect(withBudget('sonnet', p, 10)).toBeNull();
    expect(withBudget('opus', { ...p, monthlyBudgetUsd: undefined }, 1e6)).toBe('opus');
  });
});
