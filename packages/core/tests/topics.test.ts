import { describe, expect, it } from 'vitest';
import { PLAYBOOK_TOPICS, PLAYBOOK_TOPIC_RU, TOPIC_EXCERPT_MAX, isPlaybookTopic, loadProfileRubric, loadTopic, profileRubricText, scoreProfile, topicExcerpt, topicsExcerpt } from '../src/index.js';
import { tools } from './tools/helpers.js';

describe('topic playbooks (the owner\'s Instagram skills, condensed)', () => {
  it('every topic exists with the sections, a source and licence line, and an excerpt under its cap', () => {
    for (const t of PLAYBOOK_TOPICS) {
      const text = loadTopic(t);
      expect(text, t).not.toBe('');
      const lines = text.split('\n').length;
      expect(lines, `${t} lines`).toBeGreaterThanOrEqual(35);
      expect(lines, `${t} lines`).toBeLessThanOrEqual(140);
      expect(text.split('\n')[0], t).toMatch(/^# Плейбук-тема: /);
      expect(text, t).toMatch(/^Источники /m);
      expect(text, t).toMatch(/^Лицензии: .*MIT/m);
      for (const h of ['Цель', 'Правила', 'Чеклист перед сдачей', 'Шаблоны', 'Чего не делать', 'Метрики успеха']) expect(text, `${t} ${h}`).toContain(`\n## ${h}`);
      const ex = topicExcerpt(t);
      expect(ex.length, `${t} excerpt`).toBeGreaterThan(600);
      expect(ex.length, `${t} excerpt`).toBeLessThanOrEqual(TOPIC_EXCERPT_MAX);
      expect(ex, t).toContain('Чеклист перед сдачей:');
      expect(text, t).not.toMatch(/—|–/);
      expect(PLAYBOOK_TOPIC_RU[t].length).toBeGreaterThan(3);
    }
    expect(isPlaybookTopic('ig-reels')).toBe(true);
    expect(isPlaybookTopic('seo')).toBe(false);
  });

  it('the reel topic carries the rules that matter and points at the tools and the hook file', () => {
    const text = loadTopic('ig-reels');
    expect(text).toContain('knowledge/hooks.json');
    expect(text).toContain('text.hookScore');
    expect(text).toContain('text.beats');
    const comments = loadTopic('ig-engage');
    expect(comments).toContain('девять типов');
    expect(comments).toMatch(/Дожимов два/);
    expect(comments).toMatch(/Отличный пост/);
  });

  it('topicsExcerpt joins the excerpts; a missing folder gives an empty string', () => {
    const joined = topicsExcerpt(['ig-reels', 'ig-human']);
    expect(joined).toContain('Рилсы: хук, сценарий, тайминг');
    expect(joined).toContain('Человеческий текст');
    expect(topicExcerpt('ig-reels', TOPIC_EXCERPT_MAX, '/nowhere/at/all')).toBe('');
  });

  it('playbook.excerpt gives a topic to any agent and refuses an unknown name', async () => {
    const { t } = tools({ dept: 'support', agentId: 'support' });
    const r = await t.playbook.excerpt('ig-engage');
    expect(r.ok && r.value).toContain('Комментарии, ответы, директ');
    expect(await t.playbook.excerpt('nonsense')).toMatchObject({ ok: false, error: 'invalid' });
    const role = await t.playbook.excerpt('sales');
    expect(role.ok && role.value).toContain('Плейбук роли');
  });
});

describe('knowledge/profile-rubric.json', () => {
  it('has twelve items worth 100 points, in Russian and English', () => {
    const r = loadProfileRubric()!;
    expect(r.items).toHaveLength(12);
    expect(r.items.reduce((s, i) => s + i.points, 0)).toBe(100);
    for (const i of r.items) {
      expect(i.ru.name.length).toBeGreaterThan(3);
      expect(i.ru.full_marks.length).toBeGreaterThan(30);
      expect(i.en.full_marks.length).toBeGreaterThan(30);
    }
    expect(profileRubricText()).toContain('Поле имени (12)');
  });

  it('scores a profile: points per item capped at the maximum, the biggest losses first', () => {
    const s = scoreProfile({ name_field: 2, bio_first_line: 3, pinned_three: 0, highlights: 2, grid_legibility: 4, photo: 99, story_presence: -5 })!;
    expect(s.max).toBe(100);
    expect(s.total).toBe(2 + 3 + 0 + 2 + 4 + 6);
    expect(s.lost[0]!.lost).toBeGreaterThanOrEqual(s.lost[1]!.lost);
    expect(s.lost.some((l) => l.id === 'photo')).toBe(false);
    expect(s.lost.find((l) => l.id === 'story_presence')!.lost).toBe(6);
    expect(scoreProfile({}, '/nowhere/at/all')).toBeNull();
  });
});
