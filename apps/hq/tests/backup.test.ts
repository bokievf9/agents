import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '@fir/core';
import { findDatabases, makeBackup, rotate } from '../src/backup.js';
import { cleanRenders } from '../src/housekeeping.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 19, 3, 30);

function dataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fir-backup-'));
  const db = openDb(join(dir, 'hq.db'));
  db.exec('CREATE TABLE t (x TEXT)');
  db.prepare('INSERT INTO t VALUES (?)').run('hello');
  mkdirSync(join(dir, 'polly'));
  const p = openDb(join(dir, 'polly', 'polly.db'));
  p.exec('CREATE TABLE u (y TEXT)');
  p.close();
  mkdirSync(join(dir, 'renders', '1'), { recursive: true });
  writeFileSync(join(dir, 'renders', '1', 'reel.mp4'), 'x'.repeat(5000));
  return { dir, db };
}

describe('backup', () => {
  it('finds every SQLite file except renders and backups', () => {
    const { dir, db } = dataDir();
    mkdirSync(join(dir, 'backups'));
    writeFileSync(join(dir, 'backups', 'old.db'), '');
    expect(findDatabases(dir)).toEqual(['hq.db', 'polly/polly.db']);
    db.close();
  });

  it('copies the live DB consistently, tars without renders, keeps the data readable', async () => {
    const { dir, db } = dataDir();
    const r = await makeBackup({ dataDir: dir, now: () => T0 });
    expect(r.encrypted).toBe(false);
    expect(r.file).toMatch(/hq-backup-20261119-0330\.tar\.gz$/);
    expect(r.databases).toEqual(['hq.db', 'polly/polly.db']);
    const list = execFileSync('tar', ['-tzf', r.file]).toString();
    expect(list).toContain('hq.db');
    expect(list).toContain('polly.db');
    expect(list).not.toContain('renders');
    expect(list).not.toContain('reel.mp4');
    const out = mkdtempSync(join(tmpdir(), 'fir-restore-'));
    execFileSync('tar', ['-xzf', r.file, '-C', out]);
    const copy = new Database(join(out, 'hq.db'), { readonly: true });
    expect(copy.prepare('SELECT x FROM t').get()).toEqual({ x: 'hello' });
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    copy.close();
    expect(readdirSync(join(dir, 'backups')).some((n) => n.startsWith('.stage'))).toBe(false);
    db.close();
  });

  it('encrypts with age when a recipient is set and removes the plain copy', async () => {
    const { dir, db } = dataDir();
    const calls: string[][] = [];
    const r = await makeBackup({
      dataDir: dir, now: () => T0, ageRecipient: 'age1abc',
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'tar') execFileSync('tar', args);
        if (cmd === 'age') writeFileSync(args[args.indexOf('-o') + 1]!, 'encrypted');
      },
    });
    expect(r.encrypted).toBe(true);
    expect(r.file.endsWith('.tar.gz.age')).toBe(true);
    expect(calls[1]!.slice(0, 3)).toEqual(['age', '-r', 'age1abc']);
    expect(readdirSync(join(dir, 'backups'))).toEqual(['hq-backup-20261119-0330.tar.gz.age']);
    db.close();
  });

  it('keeps the newest seven archives', async () => {
    const { dir, db } = dataDir();
    for (let i = 0; i < 9; i++) await makeBackup({ dataDir: dir, now: () => T0 - (9 - i) * DAY });
    const last = await makeBackup({ dataDir: dir, now: () => T0 });
    const left = readdirSync(join(dir, 'backups')).sort();
    expect(left).toHaveLength(7);
    expect(left.at(-1)).toContain('20261119');
    expect(last.removed.length).toBeGreaterThan(0);
    expect(rotate(join(dir, 'backups'), 7, 'x')).toEqual([]);
    db.close();
  });
});

describe('renders cleanup', () => {
  function world() {
    const dir = mkdtempSync(join(tmpdir(), 'fir-rc-'));
    const db = openDb(':memory:');
    migrate(db, `
      CREATE TABLE cm_items (id INTEGER PRIMARY KEY, status TEXT);
      CREATE TABLE cm_ready (id INTEGER PRIMARY KEY, item_id INTEGER);
      CREATE TABLE pb_posts (ready_id INTEGER PRIMARY KEY, item_id INTEGER, platform TEXT, sent_on TEXT, published_at INTEGER);
    `);
    const folder = (id: number, ageDays: number) => {
      const d = join(dir, String(id));
      mkdirSync(d);
      writeFileSync(join(d, 'reel.mp4'), 'x');
      const t = new Date(T0 - ageDays * DAY);
      utimesSync(d, t, t);
    };
    return { dir, db, folder };
  }

  it('removes items published or rejected more than 14 days ago, keeps the rest', () => {
    const { dir, db, folder } = world();
    db.exec("INSERT INTO cm_items VALUES (1,'ready'),(2,'ready'),(3,'rejected'),(4,'rejected'),(5,'ready'),(6,'ready')");
    db.exec('INSERT INTO cm_ready VALUES (10,1),(11,2),(12,5),(13,6),(14,6)');
    db.prepare('INSERT INTO pb_posts (ready_id, item_id, platform, published_at) VALUES (?,?,?,?)').run(10, 1, 'instagram', T0 - 20 * DAY); // published long ago
    db.prepare('INSERT INTO pb_posts (ready_id, item_id, platform, published_at) VALUES (?,?,?,?)').run(11, 2, 'instagram', T0 - 3 * DAY); // recently
    // item 5: approved, never published; item 6: published on one of two platforms
    db.prepare('INSERT INTO pb_posts (ready_id, item_id, platform, published_at) VALUES (?,?,?,?)').run(13, 6, 'instagram', T0 - 30 * DAY);
    for (const [id, age] of [[1, 20], [2, 3], [3, 30], [4, 2], [5, 40], [6, 40], [99, 40], [100, 1]] as const) folder(id, age);
    const removed = cleanRenders({ db, rendersDir: dir, now: T0 });
    expect(removed.sort((a, b) => a - b)).toEqual([1, 3, 99]);
    expect(readdirSync(dir).sort()).toEqual(['100', '2', '4', '5', '6']);
    expect(existsSync(join(dir, '1'))).toBe(false);
  });

  it('a database without the content tables (nothing written yet) is not a block: old folders are orphans, young ones stay (drill 2026-11-21: "no such table: cm_items")', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fir-renders-'));
    for (const [id, age] of [[7, 40], [8, 1]] as const) {
      const d = join(dir, String(id));
      mkdirSync(d);
      writeFileSync(join(d, 'reel.mp4'), 'x');
      utimesSync(d, new Date(T0 - age * DAY), new Date(T0 - age * DAY));
    }
    expect(cleanRenders({ db: openDb(':memory:'), rendersDir: dir, now: T0 })).toEqual([7]);
    expect(readdirSync(dir)).toEqual(['8']);
  });

  it('a missing renders dir is not an error', () => {
    const { db } = world();
    expect(cleanRenders({ db, rendersDir: '/nonexistent/renders', now: T0 })).toEqual([]);
  });
});
