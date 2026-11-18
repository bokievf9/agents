#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '@fir/core';
import { Hq } from './hq.js';
import { exportOrg, importOrg } from './orgyaml.js';

const [cmd, ...rest] = process.argv.slice(2);
const dataDir = resolve(process.env.DATA_DIR ?? './data');
const dbFile = process.env.HQ_DB ?? `${dataDir}/hq.db`;

function usage(): never {
  console.error('usage: hq export [file.yaml]   (stdout when no file)\n       hq import <file.yaml>\nDB: $HQ_DB or $DATA_DIR/hq.db');
  process.exit(2);
}

if (cmd === 'export') {
  const out = exportOrg(new Hq(openDb(dbFile)));
  if (rest[0]) writeFileSync(rest[0], out);
  else process.stdout.write(out);
} else if (cmd === 'import') {
  if (!rest[0]) usage();
  const r = importOrg(new Hq(openDb(dbFile)), readFileSync(rest[0], 'utf8'));
  console.log(`imported: ${r.agents} agents, ${r.routines} routines, ${r.settings} settings`);
} else usage();
