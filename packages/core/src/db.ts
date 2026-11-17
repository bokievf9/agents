import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

/** Opens (and creates) a SQLite file; ':memory:' for tests. WAL and foreign keys on. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Idempotent schema step: each app runs its own `CREATE TABLE IF NOT EXISTS` through this. */
export function migrate(db: Db, sql: string): void {
  db.exec(sql);
}
