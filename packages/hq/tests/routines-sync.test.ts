import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

const def = { name: 'weekly-pack', cron: '0 9 * * 1', dept: 'marketing', title: 'Пакет недели', meta: { action: 'pack' } };

describe('a routine whose previous task failed', () => {
  it('fires again when the previous task is blocked, and logs the outcome', () => {
    const { hq } = setup();
    hq.syncRoutines('marketing', [def]);
    const first = hq.runRoutine('weekly-pack')!;
    hq.claim(first.id, 'marketing-head');
    hq.block(first.id, 'marketing-head', 'SEO не открыл сайт');
    const second = hq.runRoutine('weekly-pack');
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first.id);
    const fired = hq.activity().find((a) => a.action === 'routine_fired');
    expect(fired?.detail).toContain(`#${first.id}`);
    expect(fired?.detail).toContain('blocked');
  });

  it('still skips while the previous task is moving, and alerts after three skips in a row', () => {
    const { hq } = setup();
    const alerts: string[] = [];
    hq.onAlert((t) => void alerts.push(t));
    hq.syncRoutines('marketing', [def]);
    hq.runRoutine('weekly-pack');
    for (let i = 0; i < 3; i++) expect(hq.runRoutine('weekly-pack')).toBeNull();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('weekly-pack');
  });
});

describe('syncRoutines', () => {
  it('creates new routines, updates a changed cron/title, disables ones removed from code (never deletes)', () => {
    const { hq } = setup();
    const a = hq.syncRoutines('marketing', [def, { ...def, name: 'old', cron: '0 8 * * *' }]);
    expect(a.created.sort()).toEqual(['old', 'weekly-pack']);
    expect(hq.syncRoutines('marketing', [def, { ...def, name: 'old', cron: '0 8 * * *' }])).toEqual({ created: [], updated: [], disabled: [] });
    const b = hq.syncRoutines('marketing', [{ ...def, cron: '0 10 * * 1', title: 'Новый заголовок' }]);
    expect(b.updated).toEqual(['weekly-pack']);
    expect(b.disabled).toEqual(['old']);
    expect(hq.routineByName('weekly-pack')).toMatchObject({ cron: '0 10 * * 1', title: 'Новый заголовок', enabled: true });
    expect(hq.routineByName('old')).toMatchObject({ enabled: false });
    expect(hq.routines()).toHaveLength(2);
  });

  it('leaves routines of other sources and owner-edited ones alone', () => {
    const { hq } = setup();
    hq.syncRoutines('sales', [{ ...def, name: 'sales-x', dept: 'sales' }]);
    hq.syncRoutines('marketing', [def]);
    expect(hq.routineByName('sales-x')!.enabled).toBe(true);
    hq.scheduleRoutine({ ...def, cron: '0 12 * * 1' }); // the owner's edit
    expect(hq.syncRoutines('marketing', [def]).updated).toEqual([]);
    expect(hq.routineByName('weekly-pack')!.cron).toBe('0 12 * * 1');
    expect(hq.syncRoutines('marketing', []).disabled).toEqual([]);
    expect(hq.routineByName('weekly-pack')!.enabled).toBe(true);
  });

  it('adopts a routine that the old code created without a source', () => {
    const { hq } = setup();
    hq.db.exec("INSERT INTO routines (name, cron, dept, title) VALUES ('legacy', '0 1 * * *', 'marketing', 'Старая')");
    expect(hq.syncRoutines('marketing', [{ ...def, name: 'legacy', cron: '0 2 * * *' }]).updated).toEqual(['legacy']);
    expect(hq.routineByName('legacy')!.cron).toBe('0 2 * * *');
  });
});

describe('the clock of a routine (company or owner)', () => {
  it('defaults to the company clock; the sync moves a routine to the owner clock and the other way', () => {
    const { hq } = setup();
    hq.syncRoutines('marketing', [def]);
    expect(hq.routineByName('weekly-pack')!.tz).toBe('company');
    expect(hq.routineTz(hq.routineByName('weekly-pack')!)).toBe('Asia/Dushanbe');
    expect(hq.syncRoutines('marketing', [{ ...def, tz: 'owner' }]).updated).toEqual(['weekly-pack']);
    expect(hq.routineTz(hq.routineByName('weekly-pack')!)).toBe('Asia/Kuala_Lumpur');
    expect(hq.syncRoutines('marketing', [{ ...def, tz: 'owner' }]).updated).toEqual([]); // nothing changed, nothing rewritten
    expect(hq.syncRoutines('marketing', [def]).updated).toEqual(['weekly-pack']);
    expect(hq.routineByName('weekly-pack')!.tz).toBe('company');
  });

  it('an old database gains the column without losing its routines', () => {
    const { hq } = setup();
    hq.db.exec('DROP TABLE routines');
    hq.db.exec(`CREATE TABLE routines (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, cron TEXT NOT NULL, dept TEXT NOT NULL, assignee_id TEXT, title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', priority INTEGER NOT NULL DEFAULT 0, overlap TEXT NOT NULL DEFAULT 'skip', enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER, last_task_id INTEGER)`);
    hq.db.exec("INSERT INTO routines (name, cron, dept, title) VALUES ('old', '0 1 * * *', 'marketing', 'Старая')");
    const again = new (hq.constructor as new (db: typeof hq.db) => typeof hq)(hq.db);
    expect(again.routineByName('old')).toMatchObject({ cron: '0 1 * * *', tz: 'company' });
  });
});

describe('held proposals (a weekly pack stands for its items)', () => {
  it('an old database gains the held column; held proposals leave the batch until the pack opens them', async () => {
    const { hq } = setup();
    hq.db.exec('DROP TABLE task_approvals');
    hq.db.exec(`CREATE TABLE task_approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, approval_id INTEGER, dept TEXT NOT NULL, kind TEXT NOT NULL,
      payload TEXT NOT NULL, summary TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','asked','executed','rejected','failed')), created_at INTEGER NOT NULL)`);
    hq.db.exec("INSERT INTO task_approvals (task_id, dept, kind, payload, summary, created_at) VALUES (1, 'marketing', 'x', '{}', 's', 1)");
    const again = new (hq.constructor as new (db: typeof hq.db) => typeof hq)(hq.db);
    expect(again.queuedApprovals()).toHaveLength(1);
    expect(again.queuedApprovals()[0]).toMatchObject({ held: false, state: 'queued' });
    expect(again.holdApprovals([1])).toBe(1);
    expect(again.queuedApprovals()).toHaveLength(0);
    expect(again.heldApprovals()).toHaveLength(1);
    expect(again.heldApprovals([2])).toHaveLength(0);
    expect(again.holdApprovals([1])).toBe(1); // idempotent
  });
});
