import { readFileSync } from 'node:fs';
import { createLlm, openDb } from '@fir/core';
import { LlmJudge, PACKAGE_DIR, parseEvalSet } from '@fir/fira';
import { join } from 'node:path';
import { Hq } from '@fir/hq';
import { compare } from '../src/client/fira-compare.js';
import { saveEvalRun } from '../src/pult-quality.js';

/**
 * `pnpm --filter hq fira-compare [--live] [file]`: the lead manager's eval set on the old JSON runtime and on Fira, side by side, with the release
 * criteria of `docs/fira-migration-lead-manager.md`. Without `--live` the cases' scripts play the model (free, the CI numbers); with it the model of
 * `apps/hq/.env.local` answers both and the Haiku judge scores the rubrics (the texts of the set are synthetic, no client data). Locally, not in CI.
 */
async function main(argv: string[]): Promise<number> {
  const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--record') ?? join(PACKAGE_DIR, 'evals', 'lead-manager.eval.json');
  const set = parseEvalSet(JSON.parse(readFileSync(file, 'utf8')) as unknown);
  const live = argv.includes('--live')
    ? createLlm({ baseUrl: process.env.LLM_BASE_URL, apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.LLM_API_KEY, modelFast: process.env.LLM_MODEL_FAST, modelSmart: process.env.LLM_MODEL_SMART, timeoutMs: 30_000, maxRetries: 2 })
    : undefined;
  if (live && !live.enabled) {
    console.error('--live needs a model key in the env');
    return 2;
  }
  const r = await compare(set, live ? { live, judge: new LlmJudge(live) } : {});
  for (const c of r.fresh.results) {
    const o = r.old.results.find((x) => x.id === c.id)!;
    const mark = (p: boolean) => (p ? 'PASS' : 'FAIL');
    console.log(`${c.id.padEnd(30)} old ${mark(o.pass)}${o.score !== undefined ? ` ${o.score.toFixed(2)}` : ''}  new ${mark(c.pass)}${c.score !== undefined ? ` ${c.score.toFixed(2)}` : ''}`);
    if (!c.pass) for (const f of c.failures) console.log(`     new: ${f}`);
  }
  console.log(`\nold ${r.old.passed}/${r.old.total} ${JSON.stringify(r.old.metrics)}\nnew ${r.fresh.passed}/${r.fresh.total} ${JSON.stringify(r.fresh.metrics)}`);
  console.log(`release: ${JSON.stringify(r.release)}${r.newFailures.length ? `; new failures: ${r.newFailures.join(', ')}` : ''}`);
  // `--record <hq.db>`: the result (the lead set and the red-team set on Fira) is written into that HQ database for `GET /admin/quality/eval`
  const rec = argv.indexOf('--record');
  if (rec >= 0 && argv[rec + 1]) {
    const red = await compare(parseEvalSet(JSON.parse(readFileSync(join(PACKAGE_DIR, 'evals', 'red-team.eval.json'), 'utf8')) as unknown), live ? { live, judge: new LlmJudge(live) } : {});
    saveEvalRun(new Hq(openDb(argv[rec + 1]!)), {
      at: new Date().toISOString(), runtime: 'fira', lead: { passed: r.fresh.passed, total: r.fresh.total }, red: { passed: red.fresh.passed, total: red.fresh.total },
      handoffRate: r.fresh.metrics.handoffRate, toolRate: r.fresh.metrics.toolUseRate,
    });
    console.log('recorded');
  }
  return r.release.ok ? 0 : 1;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
