import { EXCERPT_MAX, MockLlm, playbookExcerpt } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { generateItem, loadPrompts } from '../src/generate.js';
import { lintReelScript } from '../src/lint.js';
import { renderClip } from '../src/format.js';
import { ALL_TOPICS } from '../src/topics.js';
import { clipJson, promptsDir } from './helpers.js';

describe('Content maker: the playbook is in the prompt', () => {
  it('the system prompt carries the brand rules first and then the capped playbook excerpt', async () => {
    const llm = new MockLlm(() => clipJson());
    const prompts = loadPrompts(promptsDir);
    const res = await generateItem(llm, prompts, { type: 'clip', topic: ALL_TOPICS[0]!, week: 'с 23.11' });
    expect(res).not.toBeNull();
    const system = llm.calls[0]!.system;
    const excerpt = playbookExcerpt('content-maker');
    expect(excerpt.length).toBeGreaterThan(800);
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(system.startsWith(prompts.system)).toBe(true);
    expect(system.endsWith(excerpt)).toBe(true);
    expect(system).toContain('Чеклист перед сдачей:');
    expect(system.length - prompts.system.length).toBeLessThanOrEqual(EXCERPT_MAX + 2);
  });
});

const script = (over: Record<string, unknown> = {}) => renderClip(JSON.parse(clipJson(over)));

describe('lintReelScript: the hard rules of the Content maker checklist', () => {
  it('accepts a good script', () => {
    expect(lintReelScript(script())).toEqual([]);
  });

  it('ignores texts that are not a reel script', () => {
    expect(lintReelScript('Карусель, 6 слайдов: x\n\nCTA: firtech.pro')).toEqual([]);
  });

  it('skips the line the head puts before the script (the tone warning there is not the script)', () => {
    expect(lintReelScript(`Пакет, материал 1 из 7. Проверка тона нашла: оборот «не X, а Y».\n\n${script()}`)).toEqual([]);
  });

  it('rejects a script with no hook sentence', () => {
    expect(lintReelScript(script({ hook: 'Ну' }))).toContain('нет предложения-хука в первых секундах');
    expect(lintReelScript(script().replace(/^Хук.*$/m, ''))).toContain('нет предложения-хука в первых секундах');
    expect(lintReelScript(script({ hook: 'Клиент пишет ночью, а бот отвечает так долго и подробно, что хук уже не прозвучит за две секунды, жаль' }))).toContain('хук длиннее 90 знаков, его не произнести за 2 секунды');
  });

  it('rejects two calls to action: two targets, or two asks', () => {
    expect(lintReelScript(script({ cta: 'Напишите в @firtech_bot или зайдите на firtech.pro' }))).toContain('больше одного призыва');
    expect(lintReelScript(script({ cta: 'Напишите нам и подпишитесь, ссылка firtech.pro' }))).toContain('больше одного призыва');
  });

  it('rejects AI tells: contrast reveal, negation list, self-answered question, colon reveal, em dash, emoji', () => {
    const bad = (voice: string) => lintReelScript(script({ scenes: [{ voice, subtitle: 'Текст' }, { voice: 'Бот предлагает окна.', subtitle: 'Окна' }, { voice: 'Клиент выбирает время.', subtitle: 'Выбор' }, { voice: 'Мастер видит запись.', subtitle: 'Запись' }] }));
    expect(bad('Это не чат-бот, а администратор.').join(' ')).toMatch(/оборот/);
    expect(bad('Без звонков, без ожидания, без очередей.').join(' ')).toContain('перечисление');
    expect(bad('Результат? Быстрее ответы.').join(' ')).toContain('самоответный вопрос');
    expect(bad('Главное: бот учится.').join(' ')).toContain('двоеточие');
    expect(bad('Бот отвечает — сразу.').join(' ')).toContain('длинное тире');
    expect(bad('Бот отвечает сразу 🚀').join(' ')).toContain('эмодзи');
  });

  it('rejects a price that is not in the price list', () => {
    expect(lintReelScript(script({ cta: 'Бот от $12345, ссылка firtech.pro' })).join(' ')).toContain('цена не из справки');
  });
});

describe('Content maker: the craft topics of the item type go into the request', () => {
  it('a reel gets the reel and human-text topics, a post the caption topic, the profile kit the rubric', async () => {
    const { craftNotes, CRAFT_TOPICS } = await import('../src/generate.js');
    expect(CRAFT_TOPICS.clip).toEqual(['ig-reels', 'ig-human']);
    expect(craftNotes('clip')).toContain('Рилсы: хук, сценарий, тайминг');
    expect(craftNotes('clip')).toContain('Человеческий текст');
    expect(craftNotes('post')).toContain('Подписи и хэштеги');
    expect(craftNotes('profile')).toContain('Рубрика профиля, 100 баллов');
    expect(craftNotes('profile')).toContain('Поле имени (12)');
  });

  it('the request of a generation carries them and the system prompt stays as before', async () => {
    const llm = new MockLlm(() => clipJson());
    const prompts = loadPrompts(promptsDir);
    await generateItem(llm, prompts, { type: 'clip', topic: ALL_TOPICS[0]!, week: 'с 23.11' });
    const user = llm.calls[0]!.messages[0]!.content;
    expect(user.startsWith('Составь сценарий')).toBe(true);
    expect(user).toContain('Приёмы ремесла: Рилсы: хук, сценарий, тайминг');
    expect(llm.calls[0]!.system).not.toContain('Приёмы ремесла');
  });
});
