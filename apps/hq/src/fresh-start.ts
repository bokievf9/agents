import Database from 'better-sqlite3';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Work rows of hq.db: everything the company produced while working. Kept: agents, routines (their run marks are cleared),
 * settings (group, topics, prices cache; only transient keys go), prices, trust levels, the prospect base (statuses reset),
 * `kb_lessons`, the monitored URLs.
 */
export const WIPE_TABLES = [
  'tasks', 'task_events', 'task_approvals', 'approvals', 'approval_cards', 'decisions', 'owner_inbox', 'activity', 'heartbeats', 'costs',
  'cm_items', 'cm_packs', 'cm_ready', 'cm_topic_history', 'cm_render_jobs', 'cm_articles', 'cm_kv', 'mk_audits', 'crm_notes',
  'li_leads', 'bl_invoices', 'bl_subscriptions', 'bo_documents', 'cs_clients', 'cs_tickets', 'ob_items', 'ob_onboardings',
  'pm_milestones', 'pm_projects', 'dp_targets', 'ps_documents', 'rf_referrals', 'pb_posts', 'ts_items', 'seo_seen', 'an_snapshots',
  'mon_incidents', 'mon_samples', 'mon_state', 'cb_chats', 'cb_notices', 'cb_demo', 'cb_refs', 'web_chat_sessions',
] as const;

const TRANSIENT_SETTINGS = ['held_alerts', 'pending_seq', 'drill_started', 'drill_reported'];

export interface FreshStartOptions {
  /** Path of hq.db. */
  db: string;
  /** The flag `--i-stopped-hq`: the operator confirms `docker compose stop hq renderer` was run. */
  stopped: boolean;
  /** `<DATA_DIR>/renders`: emptied when given. */
  rendersDir?: string;
  now?: () => number;
}

export interface FreshStartResult {
  backup: string;
  counts: Record<string, number>;
  removedRows: number;
  rendersRemoved: number;
}

/** Why a fresh start must not run now, or null when it may. */
export function refusal(o: FreshStartOptions): string | null {
  if (!o.stopped) return 'refused: pass --i-stopped-hq after `docker compose stop hq renderer` (a fresh start under a running HQ corrupts its state)';
  if (!existsSync(o.db)) return `refused: ${o.db} does not exist`;
  // a clean shutdown of the last connection removes the WAL; a non-empty one means HQ (or the renderer) still has the file
  // open, or crashed with unwritten changes
  const wal = `${o.db}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) {
    return `refused: ${wal} is not empty, a process still has hq.db open (or crashed). Stop hq and renderer, start hq once and stop it cleanly to checkpoint, then retry`;
  }
  // a live connection with a checkpointed (empty) WAL still holds its locks: an exclusive probe fails while anyone is attached
  try {
    const probe = new Database(o.db, { timeout: 300 });
    try {
      probe.pragma('locking_mode = EXCLUSIVE');
      probe.exec('BEGIN IMMEDIATE');
      probe.prepare('SELECT COUNT(*) FROM sqlite_master').get();
      probe.exec('ROLLBACK');
    } finally {
      probe.close();
    }
  } catch (e) {
    return `refused: hq.db is in use by another process (${e instanceof Error ? e.message : String(e)}). Stop hq and renderer first`;
  }
  return null;
}

/**
 * Wipes the work rows. Never resets `sqlite_sequence` (ids keep growing, so an old button `ap:5:a` in the chat can never
 * approve a new proposal #5), never VACUUMs, makes a `.bak-<ts>` copy first, prints counts.
 */
export async function freshStart(o: FreshStartOptions): Promise<FreshStartResult> {
  const why = refusal(o);
  if (why) throw new Error(why);
  const ts = new Date((o.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
  const backup = `${o.db}.bak-${ts}`;
  const db = new Database(o.db);
  try {
    await db.backup(backup);
    const have = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name));
    const counts: Record<string, number> = {};
    let removedRows = 0;
    db.transaction(() => {
      for (const t of WIPE_TABLES) {
        if (!have.has(t)) continue;
        const c = (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
        db.exec(`DELETE FROM ${t}`);
        counts[t] = c;
        removedRows += c;
      }
      for (const k of TRANSIENT_SETTINGS) db.prepare('DELETE FROM settings WHERE key = ?').run(k);
      db.prepare("DELETE FROM settings WHERE key LIKE 'routine_skips:%' OR key LIKE 'budget_alert:%' OR key LIKE 'gateway_%'").run();
      // a routine must not wait for a task that no longer exists
      db.exec('UPDATE routines SET last_task_id = NULL, last_run_at = NULL');
      if (have.has('pr_prospects')) db.exec("UPDATE pr_prospects SET status = 'new' WHERE status != 'new'");
    })();
    let rendersRemoved = 0;
    if (o.rendersDir && existsSync(o.rendersDir)) {
      const dir = resolve(o.rendersDir);
      for (const name of readdirSync(dir)) {
        rmSync(join(dir, name), { recursive: true, force: true });
        rendersRemoved++;
      }
    }
    return { backup, counts, removedRows, rendersRemoved };
  } finally {
    db.close();
  }
}

/** CLI: `node dist/fresh-start.js --i-stopped-hq [--db /app/data/hq.db] [--renders /app/data/renders]`. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataDir = env.DATA_DIR ?? '/app/data';
  const opts: FreshStartOptions = {
    db: arg('--db') ?? `${dataDir}/hq.db`,
    stopped: argv.includes('--i-stopped-hq'),
    rendersDir: argv.includes('--keep-renders') ? undefined : (arg('--renders') ?? `${dataDir}/renders`),
  };
  try {
    const r = await freshStart(opts);
    console.log(`backup: ${r.backup}`);
    for (const [t, c] of Object.entries(r.counts)) console.log(`${t}: ${c}`);
    console.log(`rows removed: ${r.removedRows}; render folders removed: ${r.rendersRemoved}; sqlite_sequence untouched, no VACUUM`);
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file://').href) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
