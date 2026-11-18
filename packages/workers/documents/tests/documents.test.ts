import { describe, expect, it } from 'vitest';
import { DOC_TYPES, fillTemplate, loadTemplate, openPlaceholders, parseDocType } from '../src/index.js';

const data = { client: 'Салон Роза', what: 'Telegram-бот', date: '18.11.2026', number: '2026-4', milestones: ['- Бриф: до 20.11'] };

describe('document templates', () => {
  it('all four templates exist and fill without leftover {{ }}', () => {
    expect(DOC_TYPES).toEqual(['contract', 'offer', 'privacy', 'act']);
    for (const t of DOC_TYPES) expect(fillTemplate(loadTemplate(t), data)).not.toContain('{{');
  });

  it('fills client, subject, date, number and milestones; leaves [цена] and [срок] for the owner', () => {
    const text = fillTemplate(loadTemplate('contract'), data);
    expect(text).toContain('Договор оказания услуг № 2026-4');
    expect(text).toContain('Салон Роза');
    expect(text).toContain('Telegram-бот');
    expect(text).toContain('- Бриф: до 20.11');
    expect(openPlaceholders(text)).toContain('[цена]');
    expect(openPlaceholders(text)).toContain('[срок]');
  });

  it('missing data becomes [заполнить: ...], never an invented value', () => {
    const text = fillTemplate(loadTemplate('act'), { ...data, client: '', what: '', milestones: [] });
    expect(text).toContain('[заполнить: заказчик]');
    expect(text).toContain('[заполнить: этапы и даты]');
  });

  it('parses Russian and English type words', () => {
    expect(['Договор', 'оферта', 'политика', 'Акт', 'contract'].map(parseDocType)).toEqual(['contract', 'offer', 'privacy', 'act', 'contract']);
    expect(parseDocType('счёт')).toBeNull();
  });
});
