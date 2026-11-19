import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '@fir/core';
import { Hq } from '@fir/hq';

/**
 * `pnpm --filter hq reload-instructions` (server: `docker compose exec hq node dist/reload-instructions.js`): copies `instructions/*.md` into
 * `agents.instructions` of the heads. After the first start the database copy is the truth, so a change of a file in the repo reaches the
 * heads only this way. Rules the owner added through the Director's rule-change flow live in the same column and are replaced by the file;
 * `--dry-run` only lists what would change.
 */
export const HEAD_INSTRUCTIONS: Readonly<Record<string, string>> = {
  director: 'director.md',
  'marketing-head': 'marketing-head.md',
  'sales-head': 'sales-head.md',
  'support-head': 'support-head.md',
  'production-head': 'production-head.md',
  'backoffice-head': 'backoffice-head.md',
};

export interface ReloadResult {
  /** Agents whose text was replaced (or would be, in a dry run). */
  changed: string[];
  same: string[];
  /** Listed heads that are not in the database yet, or whose file is missing. */
  skipped: string[];
}

/** Updates the heads' instructions from `dir`; one `instructions_changed` journal line per changed agent (`hq.setInstructions`, actor `owner`). */
export function reloadInstructions(hq: Hq, dir: string, o: { dryRun?: boolean } = {}): ReloadResult {
  const out: ReloadResult = { changed: [], same: [], skipped: [] };
  for (const [id, file] of Object.entries(HEAD_INSTRUCTIONS)) {
    const path = join(dir, file);
    const agent = hq.agent(id);
    if (!agent || !existsSync(path)) {
      out.skipped.push(id);
      continue;
    }
    const text = readFileSync(path, 'utf8').trim();
    if (agent.instructions === text) {
      out.same.push(id);
      continue;
    }
    if (!o.dryRun) hq.setInstructions(id, text, 'owner');
    out.changed.push(id);
  }
  return out;
}

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const dryRun = argv.includes('--dry-run');
  const dataDir = resolve(env.DATA_DIR?.trim() || './data');
  const dir = resolve(env.INSTRUCTIONS_DIR?.trim() || fileURLToPath(new URL('../instructions', import.meta.url)));
  const file = join(dataDir, 'hq.db');
  if (!existsSync(file)) {
    console.error(`refused: ${file} does not exist (DATA_DIR)`);
    return 1;
  }
  const db = openDb(file);
  try {
    const r = reloadInstructions(new Hq(db), dir, { dryRun });
    console.log(`${dryRun ? 'Would update' : 'Updated'}: ${r.changed.join(', ') || 'nothing'}. Unchanged: ${r.same.length}.${r.skipped.length ? ` Skipped (no agent or no file): ${r.skipped.join(', ')}.` : ''}`);
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
