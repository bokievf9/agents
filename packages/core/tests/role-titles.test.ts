import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROLE_TITLES, roleGloss, roleTitle, roleTitleWithGloss, syncedTitle } from '../src/index.js';

/** COMPANY.md sits next to the repo in the workspace (`../COMPANY.md`); clones may point `COMPANY_MD` at it, else the owner's checkout. */
function companyMd(): string | null {
  const candidates = [process.env.COMPANY_MD, fileURLToPath(new URL('../../../../COMPANY.md', import.meta.url)), join(homedir(), 'fir-tech', 'COMPANY.md')];
  const f = candidates.find((c) => c && existsSync(c));
  return f ? readFileSync(f, 'utf8') : null;
}

/** First cell of every org-chart table row of the «Оргструктура» section (the job titles), minus table headers. */
function chartTitles(md: string): string[] {
  const org = md.slice(md.indexOf('## Оргструктура'));
  const end = org.indexOf('\n## ', 5);
  const out: string[] = [];
  for (const line of (end > 0 ? org.slice(0, end) : org).split('\n')) {
    const m = /^\|\s*([^|]+?)\s*\|/.exec(line);
    if (m && !/^(Должность|Продукт|-+)$/.test(m[1]!) && !/^-+$/.test(m[1]!)) out.push(m[1]!);
  }
  return out;
}

describe('role titles', () => {
  it('ids are unique, titles are English without Cyrillic, glosses are Russian', () => {
    expect(new Set(ROLE_TITLES.map((r) => r.id)).size).toBe(ROLE_TITLES.length);
    for (const r of ROLE_TITLES) {
      expect(r.en, r.id).toMatch(/^[A-Za-z][A-Za-z &-]+$/);
      expect(r.ru, r.id).toMatch(/[а-яё]/i);
      for (const l of r.legacy) expect(l, r.id).toMatch(/[а-яёА-ЯЁ]|^SEO$/);
    }
  });

  it('no banned client words in titles or glosses', () => {
    const text = ROLE_TITLES.map((r) => `${r.en} ${r.ru}`).join('\n');
    expect(text).not.toMatch(/бот|приёмщик|калькулятор|конструктор/i);
  });

  it('is in sync with the org chart of COMPANY.md, both ways', () => {
    const md = companyMd();
    if (!md) return; // the workspace file is not reachable from this checkout (CI of the repo alone)
    const chart = chartTitles(md).filter((t) => t !== 'Owner (CEO)' && t !== 'Architect' && t !== 'Director (main window)' && t !== 'Developers' && !/^(Dono|Polly)$/.test(t) && !/^(Бот-администратор|Приёмщик заявок)$/.test(t));
    const mapped = new Set(ROLE_TITLES.map((r) => r.company).filter((c): c is string => c !== null));
    // every agent role of the chart has an id in the map
    for (const t of chart) expect(mapped, `COMPANY.md role «${t}» has no entry in role-titles.ts`).toContain(t);
    // every mapped chart title (and its English title) is a real row of the chart
    for (const r of ROLE_TITLES) {
      if (r.company === null) continue;
      expect(r.company, r.id).toBe(r.en);
      expect(md, `role-titles.ts «${r.company}» is not in COMPANY.md`).toMatch(new RegExp(`\\|\\s*${r.company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|`));
    }
  });

  it('roleTitle, gloss and sync', () => {
    expect(roleTitle('prospector')).toBe('Prospector');
    expect(roleTitle('custom-agent', 'My agent')).toBe('My agent');
    expect(roleTitle('custom-agent')).toBe('custom-agent');
    expect(roleGloss('prospector')).toMatch(/бизнес/);
    expect(roleTitleWithGloss('custom-agent')).toBe('custom-agent');
    expect(syncedTitle('prospector', 'Разведчик')).toBe('Prospector');
    expect(syncedTitle('seo', 'SEO')).toBe('SEO Specialist');
    expect(syncedTitle('prospector', 'Мой разведчик')).toBe('Мой разведчик');
    expect(syncedTitle('nobody', 'Разведчик')).toBe('Разведчик');
  });
});
