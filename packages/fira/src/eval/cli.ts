import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLlm } from '@fir/core';
import { firtechGuardContext } from '../guards.js';
import { FIRTECH_TOOLS } from '../firtech-tools.js';
import { loadCompanyPack, loadNichePack, loadRolePack } from '../packs.js';
import { makeSpec } from '../spec.js';
import { parseEvalSet } from './format.js';
import { LlmJudge } from './judge.js';
import { runEval } from './runner.js';

/**
 * `pnpm --filter fira eval <file> [--live]`: runs an eval set. Without `--live` the cases play their scripts (no network, the CI mode); with it the
 * model of the env answers (`LLM_BASE_URL` + `LLM_API_KEY` or `ANTHROPIC_API_KEY`) and the LLM judge scores the rubrics. Exit 1 when a case fails.
 */
async function main(argv: string[]): Promise<number> {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: pnpm --filter fira eval <evals/name.eval.json> [--live]');
    return 2;
  }
  // relative to where pnpm was called (INIT_CWD), else to the package (`evals/<name>.eval.json` works from the repo root too)
  const path = [resolve(process.env.INIT_CWD ?? process.cwd(), file), resolve(process.cwd(), file)].find((p) => existsSync(p)) ?? file;
  const set = parseEvalSet(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  const spec = makeSpec({ role: loadRolePack(set.spec.role), niche: loadNichePack(set.spec.niche), company: loadCompanyPack(set.spec.company) });
  const live = argv.includes('--live')
    ? createLlm({
      baseUrl: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY, modelFast: process.env.LLM_MODEL_FAST,
      modelSmart: process.env.LLM_MODEL_SMART, timeoutMs: 30_000, maxRetries: 2,
    })
    : undefined;
  if (live && !live.enabled) {
    console.error('--live needs a model key in the env');
    return 2;
  }
  const report = await runEval(set, { spec, tools: FIRTECH_TOOLS, guard: firtechGuardContext, ...(live ? { live, judge: new LlmJudge(live) } : {}) });
  for (const r of report.results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id}${r.tools.length ? ` [${r.tools.join(', ')}]` : ''}${r.score !== undefined ? ` judge=${r.score.toFixed(2)}` : ''}`);
    for (const f of r.failures) console.log(`     - ${f}`);
    if (!r.pass) console.log(`     reply: ${r.reply.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  console.log(`\n${report.name}: ${report.passed}/${report.total} passed; ${JSON.stringify(report.metrics)}`);
  return report.passed === report.total ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  },
);
