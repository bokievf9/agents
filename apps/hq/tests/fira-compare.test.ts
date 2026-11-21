import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_DIR, parseEvalSet } from '@fir/fira';
import { describe, expect, it } from 'vitest';
import { compare } from '../src/client/fira-compare.js';

describe('old runtime vs Fira on one eval set (script mode, the release criteria)', () => {
  it('the lead manager set: Fira passes every case, no new failure on prices, dates or banned words, hand-offs and fallbacks not up', async () => {
    const set = parseEvalSet(JSON.parse(readFileSync(join(PACKAGE_DIR, 'evals', 'lead-manager.eval.json'), 'utf8')) as unknown);
    expect(set.cases.length).toBe(30);
    const r = await compare(set);
    expect(r.fresh.results.filter((x) => !x.pass).map((x) => `${x.id}: ${x.failures.join('; ')}`)).toEqual([]);
    expect(r.newFailures).toEqual([]);
    expect(r.release.ok).toBe(true);
    expect(r.fresh.passed).toBeGreaterThan(r.old.passed);
  }, 60_000);
});
