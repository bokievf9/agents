import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb } from '@fir/core';
import { ProspectStore } from '@fir/worker-prospector';

// pnpm --filter hq run import-prospects <file.csv>   (DATA_DIR from env or ./data; the base lives in hq.db, tables pr_*)
// Server: docker compose exec hq node dist/import-prospects.js /app/data/prospects.csv
const file = process.argv[2];
if (!file) {
  console.error('Usage: import-prospects <prospects.csv>');
  process.exit(1);
}
const dataDir = resolve(process.env.DATA_DIR?.trim() || './data');
const store = new ProspectStore(openDb(join(dataDir, 'hq.db')));
const res = store.importCsv(readFileSync(resolve(file), 'utf8'));
console.log(`Imported: ${res.added} new, ${res.duplicates} duplicates skipped, ${res.invalid} invalid rows. Base: ${store.stats().total}.`);
