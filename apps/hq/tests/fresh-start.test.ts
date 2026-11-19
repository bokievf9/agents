import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Hq } from '@fir/hq';
import { ApprovalQueue, MemoryMessenger, openDb } from '@fir/core';
import { freshStart, refusal } from '../src/fresh-start.js';

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'fir-fresh-'));
  const file = join(dir, 'hq.db');
  const db = openDb(file);
  const hq = new Hq(db);
  hq.attachQueue(new ApprovalQueue(db, new MemoryMessenger(), 1));
  hq.upsertAgent({ id: 'marketing-head', dept: 'marketing', role: 'head', title: 'M' });
  hq.syncRoutines('marketing', [{ name: 'r', cron: '0 9 * * *', dept: 'marketing', title: 'R' }]);
  for (let i = 0; i < 5; i++) hq.createTask({ title: `T${i}`, dept: 'marketing', creator: 'owner' });
  hq.runRoutine('r');
  hq.setSetting('hq_group_id', '-100');
  db.close(); // closes the last connection: the WAL is checkpointed and removed
  const renders = join(dir, 'renders');
  mkdirSync(join(renders, '3'), { recursive: true });
  writeFileSync(join(renders, '3', 'reel.mp4'), 'x');
  return { dir, file, renders };
}

describe('fresh start', () => {
  it('refuses without --i-stopped-hq and while a WAL shows a connection', () => {
    const s = seeded();
    expect(refusal({ db: s.file, stopped: false })).toContain('--i-stopped-hq');
    expect(refusal({ db: s.file, stopped: true })).toBeNull();
    const open = new Database(s.file);
    open.pragma('journal_mode = WAL');
    open.exec('CREATE TABLE IF NOT EXISTS probe (x)');
    open.exec('INSERT INTO probe VALUES (1)');
    expect(refusal({ db: s.file, stopped: true })).toContain('still has hq.db open');
    open.close();
  });

  it('refuses while another connection holds the file even with an empty WAL', () => {
    const s = seeded();
    const live = new Database(s.file);
    live.pragma('journal_mode = WAL');
    live.pragma('wal_checkpoint(TRUNCATE)');
    live.exec('BEGIN');
    live.prepare('SELECT COUNT(*) FROM sqlite_master').get();
    expect(refusal({ db: s.file, stopped: true })).toContain('in use');
    live.exec('ROLLBACK');
    live.close();
    expect(refusal({ db: s.file, stopped: true })).toBeNull();
  });

  it('wipes work rows, keeps agents, routines and settings, never resets sqlite_sequence, backs up first, clears renders', async () => {
    const s = seeded();
    const peek = new Database(s.file, { readonly: true });
    const seqBefore = peek.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'tasks'").get() as { seq: number };
    peek.close();
    const r = await freshStart({ db: s.file, stopped: true, rendersDir: s.renders, now: () => 0 });
    expect(existsSync(r.backup)).toBe(true);
    expect(r.counts.tasks).toBe(6);
    expect(r.rendersRemoved).toBe(1);
    expect(existsSync(join(s.renders, '3'))).toBe(false);
    const db = new Database(s.file);
    expect(db.prepare('SELECT COUNT(*) c FROM tasks').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM agents').get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'hq_group_id'").get()).toEqual({ value: '-100' });
    expect(db.prepare('SELECT last_task_id FROM routines').get()).toEqual({ last_task_id: null });
    // ids keep growing: an old button can never hit a new row
    expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'tasks'").get()).toEqual(seqBefore);
    const hq = new Hq(db);
    expect(hq.createTask({ title: 'new', dept: 'marketing', creator: 'owner' }).id).toBe(seqBefore.seq + 1);
    db.close();
    // the backup still has the old rows
    const bak = new Database(r.backup, { readonly: true });
    expect(bak.prepare('SELECT COUNT(*) c FROM tasks').get()).toEqual({ c: 6 });
    bak.close();
  });
});
