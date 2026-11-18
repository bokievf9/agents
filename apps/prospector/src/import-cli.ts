import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb } from '@fir/core';
import { ProspectStore } from './store.js';

// pnpm --filter prospector run import <file.csv>   (DATA_DIR from env or ./data)
const file = process.argv[2];
if (!file) {
  console.error('Usage: pnpm --filter prospector run import <prospects.csv>');
  process.exit(1);
}
const dataDir = resolve(process.env.DATA_DIR?.trim() || './data');
const store = new ProspectStore(openDb(join(dataDir, 'prospector.db')));
const res = store.importCsv(readFileSync(resolve(file), 'utf8'));
console.log(`Imported: ${res.added} new, ${res.duplicates} duplicates skipped, ${res.invalid} invalid rows. Base: ${store.stats().total}.`);
