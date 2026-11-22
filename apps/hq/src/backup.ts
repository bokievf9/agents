import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Telegram bots send files up to 50 MB; stay below it. */
export const MAX_SEND_BYTES = 49 * 1024 * 1024;
const NAME = /^hq-backup-\d{8}-\d{4}\.tar\.gz(\.age)?$/;

export interface BackupOptions {
  /** `DATA_DIR`: hq.db and any other SQLite file in it are copied; `renders/` and `backups/` are skipped. */
  dataDir: string;
  /** `DATA_DIR/renders`: only its `cabinet/` folder (the clients' contract, invoice and signature PDFs) goes into the archive, as `renders/cabinet`; the rest of the renders are rebuildable. Default `<dataDir>/renders`. */
  rendersDir?: string;
  /** Default `<dataDir>/backups`. */
  backupsDir?: string;
  now?: () => number;
  /** age public key (`age1...`): the archive is encrypted to it. Unset: the archive stays plain, and the message says so. */
  ageRecipient?: string | undefined;
  /** Local copies to keep (default 7). */
  keep?: number;
  /** Tests inject the process runner (tar, age). */
  exec?: (cmd: string, args: string[]) => Promise<unknown>;
}

export interface BackupResult {
  file: string;
  bytes: number;
  encrypted: boolean;
  /** SQLite files in the archive, relative to the data dir. */
  databases: string[];
  /** Old archives removed by the rotation. */
  removed: string[];
}

/** SQLite files of a data dir (`*.db`, `*.sqlite`), without `renders/`, `backups/` and the -wal/-shm companions. */
export function findDatabases(dataDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === 'renders' || e.name === 'backups' || e.name.startsWith('.stage-')) continue;
        walk(join(dir, e.name));
      } else if (/\.(db|sqlite)$/.test(e.name)) out.push(relative(dataDir, join(dir, e.name)));
    }
  };
  if (existsSync(dataDir)) walk(dataDir);
  return out.sort();
}

const stamp = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
};

/**
 * One consistent snapshot of every SQLite file in the data dir (better-sqlite3 `backup()`, safe while HQ writes), tarred and
 * gzipped with `renders/cabinet` only (no other renders), encrypted with age when a recipient is set, the newest `keep` archives kept in `backups/`.
 * Polly keeps its own volume and OmniRoute's `storage.sqlite` lives in its own: they are not in HQ's data dir, so they are
 * not in this archive (see the HQ README).
 */
export async function makeBackup(o: BackupOptions): Promise<BackupResult> {
  const now = (o.now ?? Date.now)();
  const backupsDir = o.backupsDir ?? join(o.dataDir, 'backups');
  mkdirSync(backupsDir, { recursive: true });
  const exec = o.exec ?? ((cmd: string, args: string[]) => run(cmd, args));
  const stage = join(backupsDir, `.stage-${stamp(now)}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const databases = findDatabases(o.dataDir);
  if (!databases.length) throw new Error(`no SQLite files in ${o.dataDir}`);
  const base = join(backupsDir, `hq-backup-${stamp(now)}.tar.gz`);
  try {
    for (const rel of databases) {
      const dest = join(stage, rel);
      mkdirSync(dirname(dest), { recursive: true });
      const db = new Database(join(o.dataDir, rel), { fileMustExist: true });
      try {
        await db.backup(dest);
      } finally {
        db.close();
      }
    }
    // the clients' PDFs are not rebuildable the same way (the signed copy carries the signature as it was): they travel with the databases
    const cabinet = join(o.rendersDir ?? join(o.dataDir, 'renders'), 'cabinet');
    if (existsSync(cabinet)) cpSync(cabinet, join(stage, 'renders', 'cabinet'), { recursive: true });
    await exec('tar', ['-czf', base, '-C', stage, '.']);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  let file = base;
  const encrypted = Boolean(o.ageRecipient);
  if (o.ageRecipient) {
    file = `${base}.age`;
    try {
      await exec('age', ['-r', o.ageRecipient, '-o', file, base]);
    } finally {
      rmSync(base, { force: true }); // never leave the plain copy next to the encrypted one
    }
  }
  const removed = rotate(backupsDir, o.keep ?? 7, basename(file));
  return { file, bytes: statSync(file).size, encrypted, databases, removed };
}

/** Keeps the newest `keep` archives (names sort by time), removes the rest. */
export function rotate(backupsDir: string, keep: number, current: string): string[] {
  const all = readdirSync(backupsDir).filter((n) => NAME.test(n)).sort();
  const old = all.slice(0, Math.max(0, all.length - keep)).filter((n) => n !== current);
  for (const n of old) rmSync(join(backupsDir, n), { force: true });
  return old;
}
