import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Hq } from '@fir/hq';
import { openDb } from '@fir/core';
import { HEAD_INSTRUCTIONS, main, reloadInstructions } from '../src/reload-instructions.js';
import { instructionsDir } from './helpers.js';

function world() {
  const hq = new Hq(openDb(':memory:'));
  hq.upsertAgent({ id: 'director', dept: 'hq', role: 'director', title: 'Д', instructions: 'old director' });
  hq.upsertAgent({ id: 'marketing-head', dept: 'marketing', role: 'head', title: 'М', instructions: 'old marketing' });
  hq.upsertAgent({ id: 'sales-head', dept: 'sales', role: 'head', title: 'П', instructions: 'same sales' });
  return hq;
}

describe('reload-instructions', () => {
  it('replaces the heads\' instructions from the files, one journal line each, leaves equal and unknown ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fir-instr-'));
    for (const f of Object.values(HEAD_INSTRUCTIONS)) writeFileSync(join(dir, f), `new text of ${f}\n`);
    writeFileSync(join(dir, 'sales-head.md'), 'same sales\n');
    const hq = world();
    const dry = reloadInstructions(hq, dir, { dryRun: true });
    expect(dry.changed).toEqual(['director', 'marketing-head']);
    expect(hq.agent('director')!.instructions).toBe('old director'); // a dry run writes nothing
    const r = reloadInstructions(hq, dir);
    expect(r).toEqual({ changed: ['director', 'marketing-head'], same: ['sales-head'], skipped: ['support-head', 'production-head', 'backoffice-head'] });
    expect(hq.agent('director')!.instructions).toBe('new text of director.md');
    expect(hq.agent('marketing-head')!.instructions).toBe('new text of marketing-head.md');
    expect(hq.activity().filter((a) => a.action === 'instructions_changed').map((a) => [a.agentId, a.objectId])).toEqual([['owner', 'marketing-head'], ['owner', 'director']]);
    // a second run changes nothing
    expect(reloadInstructions(hq, dir).changed).toEqual([]);
  });

  it('every file the map names exists in the repo instructions folder', () => {
    const hq = world();
    expect(reloadInstructions(hq, instructionsDir, { dryRun: true }).skipped).toEqual(['support-head', 'production-head', 'backoffice-head']); // not in this database, but the files exist
    for (const f of Object.values(HEAD_INSTRUCTIONS)) expect(existsSync(join(instructionsDir, f)), f).toBe(true);
  });

  it('the CLI: reads DATA_DIR/hq.db and INSTRUCTIONS_DIR, refuses a missing database', () => {
    const data = mkdtempSync(join(tmpdir(), 'fir-data-'));
    const dir = join(data, 'instr');
    mkdirSync(dir);
    writeFileSync(join(dir, 'director.md'), 'from the file');
    expect(main([], { DATA_DIR: data, INSTRUCTIONS_DIR: dir })).toBe(1);
    const db = openDb(join(data, 'hq.db'));
    new Hq(db).upsertAgent({ id: 'director', dept: 'hq', role: 'director', title: 'Д', instructions: 'old' });
    db.close();
    expect(main(['--dry-run'], { DATA_DIR: data, INSTRUCTIONS_DIR: dir })).toBe(0);
    expect(main([], { DATA_DIR: data, INSTRUCTIONS_DIR: dir })).toBe(0);
    const again = openDb(join(data, 'hq.db'));
    expect(new Hq(again).agent('director')!.instructions).toBe('from the file');
    again.close();
  });
});
