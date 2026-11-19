import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXCERPT_MAX, PLAYBOOK_ROLES, clearPlaybookCache, knowledgeDir, loadPlaybook, playbookExcerpt, playbookRules, playbookSection, withPlaybook } from '../src/playbooks.js';

const PLAYBOOK = (rules: string, check = '1. Первое.\n2. Второе.') => `# Плейбук: Тест\n\n## Цель роли\nЦель.\n\n## Правила\n${rules}\n\n## Чеклист перед сдачей\n${check}\n\n## Шаблоны\nШаблон.\n`;

let dir: string;
beforeEach(() => {
  clearPlaybookCache();
  dir = mkdtempSync(join(tmpdir(), 'pb-'));
  mkdirSync(join(dir, 'playbooks'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadPlaybook', () => {
  it('reads the file once: later changes are not seen until the cache is cleared', () => {
    writeFileSync(join(dir, 'playbooks', 'seo.md'), PLAYBOOK('- одно'));
    expect(loadPlaybook('seo', dir)).toContain('- одно');
    writeFileSync(join(dir, 'playbooks', 'seo.md'), PLAYBOOK('- другое'));
    expect(loadPlaybook('seo', dir)).toContain('- одно');
    clearPlaybookCache();
    expect(loadPlaybook('seo', dir)).toContain('- другое');
  });

  it('a missing file gives an empty string, an empty excerpt and the prompt as it was', () => {
    expect(loadPlaybook('analyst', dir)).toBe('');
    expect(playbookExcerpt('analyst', EXCERPT_MAX, dir)).toBe('');
    expect(withPlaybook('система', 'analyst', dir)).toBe('система');
    expect(loadPlaybook('analyst', join(dir, 'nowhere'))).toBe('');
  });

  it('finds the repo knowledge folder without any setting', () => {
    expect(knowledgeDir()).toBeTruthy();
  });
});

describe('sections and the excerpt cap', () => {
  it('splits the Правила and Чеклист sections', () => {
    const t = PLAYBOOK('- а\n- б');
    expect(playbookSection(t, 'Правила')).toBe('- а\n- б');
    expect(playbookSection(t, 'Чеклист')).toBe('1. Первое.\n2. Второе.');
    expect(playbookSection(t, 'Нет такого')).toBe('');
  });

  it('keeps the checklist whole and cuts the rules by bullets when the text is too long', () => {
    const rules = Array.from({ length: 80 }, (_, i) => `- правило номер ${i} с длинным пояснением чтобы заполнить место`).join('\n');
    writeFileSync(join(dir, 'playbooks', 'sales.md'), PLAYBOOK(rules));
    const ex = playbookExcerpt('sales', EXCERPT_MAX, dir);
    expect(ex.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(ex).toContain('1. Первое.\n2. Второе.');
    expect(ex).toContain('- правило номер 0 ');
    expect(ex).not.toContain('правило номер 79');
    expect(ex.split('\n').filter((l) => l.startsWith('- ')).every((l) => l.endsWith('место'))).toBe(true);
    expect(ex.length).toBeLessThanOrEqual(withPlaybook('', 'sales', dir).length);
  });

  it('a small custom cap is respected', () => {
    writeFileSync(join(dir, 'playbooks', 'sales.md'), PLAYBOOK('- а'.repeat(500)));
    expect(playbookExcerpt('sales', 300, dir).length).toBeLessThanOrEqual(300);
  });

  it('playbookRules returns the rules section only', () => {
    writeFileSync(join(dir, 'playbooks', 'seo.md'), PLAYBOOK('- правило'));
    expect(playbookRules('seo', dir)).toBe('- правило');
  });
});

describe('the shipped playbooks', () => {
  it('exist for every role, have the six sections and 60-180 lines, and their excerpt stays under the cap', () => {
    for (const role of PLAYBOOK_ROLES) {
      const text = loadPlaybook(role);
      expect(text, role).not.toBe('');
      const lines = text.split('\n').length;
      expect(lines, `${role} lines`).toBeGreaterThanOrEqual(60);
      expect(lines, `${role} lines`).toBeLessThanOrEqual(180);
      expect(text.split('\n')[0], role).toMatch(/^# Плейбук: /);
      expect(text, role).toMatch(/^Источники /m);
      expect(text, role).toMatch(/^Лицензии: /m);
      for (const h of ['Цель роли', 'Правила', 'Чеклист перед сдачей', 'Шаблоны', 'Чего не делать', 'Метрики успеха']) expect(text, `${role} ${h}`).toContain(`\n## ${h}`);
      const ex = playbookExcerpt(role);
      expect(ex.length, `${role} excerpt`).toBeGreaterThan(800);
      expect(ex.length, `${role} excerpt`).toBeLessThanOrEqual(EXCERPT_MAX);
      expect(ex, role).toContain('Чеклист перед сдачей:');
      expect(ex, role).not.toMatch(/—|–/);
    }
  });
});
