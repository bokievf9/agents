import { MockChatLlm } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { asksLegal, asksMoney, escalates, escalationModeOf, escalationOf, run, type EscalationMode } from '../src/index.js';
import { deps, leadManagerSpec } from './helpers.js';

describe('escalation policy (Autopilot v0)', () => {
  it('reads money, discounts and legal questions in both languages; ordinary talk is neither', () => {
    for (const t of ['А скидку дадите?', 'Можно подешевле?', 'Можно в рассрочку?', 'Can I get a discount?', 'Верните деньги']) expect(asksMoney(t), t).toBe(true);
    for (const t of ['Нужен юрист, проверить договор', 'Кто несёт ответственность за ошибки агента?', 'Хочу изменить договор', 'Что с персональными данными клиентов?', 'Is there a legal contract?']) expect(asksLegal(t), t).toBe(true);
    for (const t of ['У меня салон', 'Сколько стоит?', 'Нужен ИИ-отдел под ключ']) {
      expect(asksMoney(t), t).toBe(false);
      expect(asksLegal(t), t).toBe(false);
    }
  });

  it('the three modes: ask_me hears everything (prices too), policy the reasons, autopilot only person, anger and legal', () => {
    const at = (mode: EscalationMode, text: string, extra: Partial<Parameters<typeof escalationOf>[0]> = {}) => escalationOf({ text, lang: 'ru', mode, ...extra })?.reason ?? null;
    expect(at('policy', 'Дадите скидку 20%?')).toBe('money');
    expect(at('autopilot', 'Дадите скидку 20%?')).toBeNull();
    expect(at('ask_me', 'Сколько стоит ИИ-администратор?')).toBe('money');
    expect(at('policy', 'Сколько стоит ИИ-администратор?')).toBeNull();
    for (const m of ['ask_me', 'policy', 'autopilot'] as const) {
      expect(at(m, 'Нужен юрист проверить договор'), m).toBe('legal');
      expect(at(m, 'что угодно', { person: 'ask' }), m).toBe('person');
      expect(at(m, 'бред', { person: 'upset' }), m).toBe('anger');
    }
    expect(at('policy', 'Интегрируетесь с 1С?', { outcome: { unknown: true } })).toBe('unsure');
    expect(at('autopilot', 'Интегрируетесь с 1С?', { outcome: { unknown: true } })).toBeNull();
    expect(at('policy', 'Когда созвон?', { vip: true })).toBe('vip');
    expect(at('policy', 'Расскажите', { outcome: { unknown: false, owner: { reason: 'money', line: 'просит торг' } } })).toBe('money');
    expect(at('policy', 'У меня салон')).toBeNull();
    expect(escalates('autopilot', 'money')).toBe(false);
    expect(escalationModeOf('autopilot')).toBe('autopilot');
    expect(escalationModeOf('')).toBe('policy');
    expect(escalationModeOf('anything')).toBe('policy');
  });

  it('one line for the owner without the person\'s words (the short one), the agent\'s summary only in the Pult line; one sentence for the person', () => {
    const e = escalationOf({ text: 'Дадите скидку 50%, мой номер +992 90 123 45 67?', lang: 'ru', mode: 'policy', outcome: { unknown: false, owner: { reason: 'money', line: 'Салон просит скидку на ИИ-администратора' } } }, { channel: 'веб-чат' })!;
    expect(e.short).toBe('ИИ-менеджер заявок: вопрос о скидке или деньгах (веб-чат), нужен ответ основателя.');
    expect(e.short).not.toMatch(/\+992|50%/);
    expect(e.line).toContain('Суть: Салон просит скидку на ИИ-администратора');
    expect(e.tell).toMatch(/Скидки и исключения по цене решает основатель/);
    expect(escalationOf({ text: 'discount?', lang: 'en', mode: 'policy' })!.tell).toMatch(/founder/);
    expect(escalationOf({ text: 'x', lang: 'ru', mode: 'policy', person: 'ask' })!.tell).toBe('');
  });

  it('handoff_owner is a native tool of the lead manager: the model asks for the owner, the outcome carries the line', async () => {
    const llm = new MockChatLlm([{ tools: [{ name: 'handoff_owner', input: { reason: 'legal', line: 'Вопрос о договоре и ответственности' } }] }, { text: 'Передал основателю.' }]);
    const out = await run(leadManagerSpec(), { id: 'e1', text: 'Кто отвечает по договору, если агент ошибётся?', mode: 'anon', lang: 'ru' }, deps(llm));
    expect(out.outcome.owner).toEqual({ reason: 'legal', line: 'Вопрос о договоре и ответственности' });
    expect(out.outcome.handoff).toBe('legal');
  });
});
