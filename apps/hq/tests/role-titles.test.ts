import { openDb, ROLE_TITLES, roleTitle } from '@fir/core';
import { Hq } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { seedOrg, syncRoleTitles } from '../src/org.js';
import { seedBackoffice } from '../src/heads/backoffice.js';
import { seedProduction } from '../src/heads/production.js';
import { seedSales } from '../src/heads/sales.js';
import { seedSupport } from '../src/heads/support.js';
import { buildOffice } from '../src/office.js';
import { instructionsDir, NOW } from './helpers.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) => readFileSync(join(instructionsDir, f), 'utf8').trim();

function seeded() {
  const hq = new Hq(openDb(':memory:'), { now: () => NOW });
  const cfg = { instructionsDir, marketingBudgetUsd: 1, salesBudgetUsd: 1, productionBudgetUsd: 1, backofficeBudgetUsd: 1, supportBudgetUsd: 1 };
  seedOrg(hq, cfg);
  seedSupport(hq, cfg, read);
  seedSales(hq, cfg);
  seedProduction(hq, cfg, read);
  seedBackoffice(hq, cfg, read);
  return hq;
}

describe('agent titles in HQ are the English job titles', () => {
  it('every seeded agent is in the map and carries its English title', () => {
    const hq = seeded();
    const ids = new Set(ROLE_TITLES.map((r) => r.id));
    for (const a of hq.agents()) {
      expect(ids, `agent ${a.id} is missing from role-titles.ts`).toContain(a.id);
      expect(a.title).toBe(roleTitle(a.id));
      expect(a.title).not.toMatch(/[а-яё]/i);
    }
    for (const r of ROLE_TITLES) expect(hq.agent(r.id), `role-titles.ts has ${r.id}, the seeds do not`).toBeTruthy();
  });

  it('old Russian titles in a stored database are read and renamed as English, an owner edit stays', () => {
    const hq = seeded();
    const db = (hq as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db;
    db.prepare('UPDATE agents SET title = ? WHERE id = ?').run('Разведчик', 'prospector');
    db.prepare('UPDATE agents SET title = ? WHERE id = ?').run('Мой аналитик', 'analyst');
    expect(hq.agent('prospector')!.title).toBe('Prospector');
    expect(syncRoleTitles(hq)).toBe(1);
    expect(syncRoleTitles(hq)).toBe(0);
    expect(hq.agent('analyst')!.title).toBe('Мой аналитик');
  });

  it('the office API carries English titles for the director, heads and workers', () => {
    const hq = seeded();
    const o = buildOffice(hq, NOW) as { director: { title: string }; departments: { head: { title: string } | null; workers: { title: string }[] }[] };
    expect(o.director.title).toBe('Director');
    for (const d of o.departments) {
      if (d.head) expect(d.head.title).not.toMatch(/[а-яё]/i);
      for (const w of d.workers) expect(w.title).not.toMatch(/[а-яё]/i);
    }
  });
});
