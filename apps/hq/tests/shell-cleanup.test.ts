import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalQueue, MemoryMessenger, openDb } from '@fir/core';
import { Hq } from '@fir/hq';
import { CsStore } from '@fir/worker-customer-support';
import { LeadStore } from '@fir/worker-lead-intake';
import { PmStore } from '@fir/worker-project-manager';
import { ensureDocTables } from '../src/cab-docs.js';
import { apply, dryRun, isTestEmail, judge, main, readIds, restore } from '../src/shell-cleanup.js';
import { seed, ZAKUP_TITLE } from '../src/seed-zakup-project.js';

const NOW = Date.UTC(2026, 10, 26, 6, 0);

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'fir-clean-'));
  const file = join(dir, 'hq.db');
  const db = openDb(file);
  const hq = new Hq(db, { now: () => NOW });
  hq.attachQueue(new ApprovalQueue(db, new MemoryMessenger(), 1));
  new LeadStore(db, () => NOW);
  new CsStore(db, () => NOW);
  new PmStore(db, () => NOW);
  ensureDocTables(db);
  const cab = db.prepare('INSERT INTO cab_clients (email, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
  const alice = Number(cab.run('alice@example.com', 'Алиса', NOW, NOW).lastInsertRowid);
  const real = Number(cab.run('anna@gmail.com', 'Anna Real', NOW, NOW).lastInsertRowid);
  const realTest = Number(cab.run('boss@gmail.com', 'Test Cafe', NOW, NOW).lastInsertRowid); // marker + real email: doubtful
  db.prepare('INSERT INTO cab_messages (client_id, lead_id, "from", text, at) VALUES (?, 1, ?, ?, ?)').run(alice, 'client', 'hi', NOW);
  const t = (title: string, creator: 'owner' | 'director' = 'owner') => hq.createTask({ title, dept: 'sales', creator }).id;
  const tTest = t('Тест: нужен сайт');
  const tReal = t('Подготовить КП для клиента');
  const tWeak = t('Prototype demo review');
  const tRun = t('e2e smoke');
  db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(tRun);
  const lead = (name: string, contact: string, task: number) =>
    db.prepare("INSERT INTO li_leads (task_id, name, contact, service, created_at) VALUES (?, ?, ?, 'site', ?)").run(task, name, contact, NOW).lastInsertRowid;
  const lTest = Number(lead('Bob', 'bob@example.com', tTest));
  const lReal = Number(lead('Dilnoza', '+992900000000', tReal));
  const pm = new PmStore(db, () => NOW);
  const pTest = pm.createProject({ client: 'Алиса', what: 'сайт', product: 'site', source: 'owner', taskId: null }).id;
  const pReal = pm.createProject({ client: 'Anna Real', what: 'бот', product: 'bot', source: 'owner', taskId: null }).id;
  pm.addMilestone({ projectId: pTest, kind: 'stage', title: 'Этап 1', dueAt: NOW });
  pm.addMilestone({ projectId: pReal, kind: 'stage', title: 'Этап 1', dueAt: NOW });
  const doc = db.prepare("INSERT INTO cab_documents (client_id, kind, title, state, created_at) VALUES (?, 'contract', ?, 'draft', ?)");
  const dTest = Number(doc.run(alice, 'Договор', NOW).lastInsertRowid);
  const dReal = Number(doc.run(real, 'Договор', NOW).lastInsertRowid);
  db.prepare('UPDATE cab_documents SET project_id = ? WHERE id = ?').run(pTest, dTest);
  db.prepare('INSERT INTO bo_signatures (doc_id, signature_png, name, at, sha256) VALUES (?, ?, ?, ?, ?)').run(dTest, Buffer.from([1, 2, 3]), 'A', NOW, 'x');
  db.close();
  return { dir, file, ids: { alice, real, realTest, tTest, tReal, tWeak, tRun, lTest, lReal, pTest, pReal, dTest, dReal } };
}
const counts = (file: string): Record<string, number> => {
  const db = new Database(file, { readonly: true });
  const q = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
  const r = Object.fromEntries(['tasks', 'li_leads', 'cab_clients', 'cab_messages', 'pm_projects', 'pm_milestones', 'cab_documents', 'bo_signatures'].map((t) => [t, q(t)]));
  db.close();
  return r;
};
const keys = (r: { A: { type: string; id: number }[] }) => r.A.map((a) => `${a.type}:${a.id}`).sort();

describe('judge', () => {
  it('flags only clear patterns', () => {
    expect(isTestEmail('alice@example.com')).toBe(true);
    expect(isTestEmail('x@y.z')).toBe(true);
    expect(isTestEmail('anna@gmail.com')).toBe(false);
    expect(judge({ names: ['Demo Barbershop'], contacts: ['+992900000000'] })?.level).toBe('B');
    expect(judge({ names: ['Real Client'], contacts: ['a@b.co'] })?.level).toBe('A');
    expect(judge({ names: ['Алиса'], contacts: ['@alice_tg'] })?.level).toBe('B');
    expect(judge({ names: ['Пётр'] })).toBeNull();
  });
});

describe('shell-cleanup', () => {
  it('dry run writes nothing and puts only clear test rows in A', () => {
    const s = seeded();
    const before = readFileSync(s.file);
    const rep = dryRun(s.file);
    expect(keys(rep)).toEqual([
      `client:${s.ids.alice}`, `document:${s.ids.dTest}`, `lead:${s.ids.lTest}`, `project:${s.ids.pTest}`, `task:${s.ids.tTest}`,
    ].sort());
    const b = rep.B.map((x) => `${x.type}:${x.id}`);
    expect(b).toEqual(expect.arrayContaining([`client:${s.ids.realTest}`, `task:${s.ids.tWeak}`, `task:${s.ids.tRun}`]));
    for (const r of rep.A) expect(rep.B.some((x) => x.type === r.type && x.id === r.id)).toBe(false);
    expect(rep.A.find((a) => a.type === 'client')!.rows.cab_messages).toHaveLength(1);
    expect(readdirSync(s.dir).filter((f) => !/-(shm|wal)$/.test(f))).toEqual(['hq.db']);
    expect(readFileSync(s.file).equals(before)).toBe(true);
  });

  it('main dry run writes the --out report only', () => {
    const s = seeded();
    const out = join(s.dir, 'report.json');
    expect(main(['--db', s.file, '--out', out])).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).A.length).toBe(5);
  });

  it('apply deletes only A ∩ ids, refuses B and unknown, and restore round-trips', () => {
    const s = seeded();
    const base = counts(s.file);
    expect(() => apply(s.file, [{ type: 'task', id: s.ids.tWeak }])).toThrow(/doubtful/);
    expect(() => apply(s.file, [{ type: 'task', id: s.ids.tTest }, { type: 'client', id: s.ids.realTest }])).toThrow(/refused/);
    expect(() => apply(s.file, [{ type: 'lead', id: 9999 }])).toThrow(/unknown/);
    expect(counts(s.file)).toEqual(base);
    expect(readdirSync(s.dir).filter((f) => f.includes('shell-cleanup'))).toEqual([]);

    const r = apply(s.file, [{ type: 'client', id: s.ids.alice }, { type: 'task', id: s.ids.tTest }]);
    expect(r.counts).toEqual({ client: 1, task: 1 });
    const after = counts(s.file);
    expect(after.cab_clients).toBe(base.cab_clients! - 1);
    expect(after.cab_messages).toBe(base.cab_messages! - 1);
    expect(after.tasks).toBe(base.tasks! - 1);
    expect(after.li_leads).toBe(base.li_leads); // not listed: kept
    expect(after.cab_documents).toBe(base.cab_documents); // its own A row, not listed: kept
    const db = new Database(s.file, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) c FROM activity WHERE action = 'shell_cleanup'").get()).toEqual({ c: 1 });
    db.close();

    // the whole of A, from a dry-run report as the ids file
    const idsFile = join(s.dir, 'ids.json');
    writeFileSync(idsFile, JSON.stringify(dryRun(s.file)));
    expect(readIds(idsFile).length).toBe(3);
    const r2 = apply(s.file, readIds(idsFile), () => NOW + 1000);
    expect(r2.counts).toEqual({ lead: 1, project: 1, document: 1 });
    const gone = counts(s.file);
    expect(gone.pm_milestones).toBe(base.pm_milestones! - 1);
    expect(gone.bo_signatures).toBe(0);
    expect(gone.cab_clients).toBe(base.cab_clients! - 1);

    restore(s.file, r2.backup);
    restore(s.file, r.backup);
    expect(counts(s.file)).toEqual(base);
    // idempotent
    restore(s.file, r.backup);
    expect(counts(s.file)).toEqual(base);
    const db2 = new Database(s.file, { readonly: true });
    expect((db2.prepare('SELECT length(signature_png) n FROM bo_signatures').get() as { n: number }).n).toBe(3);
    db2.close();
  });

  it('refuses when the backup cannot be written', () => {
    const s = seeded();
    const base = counts(s.file);
    mkdirSync(join(s.dir, 'x'));
    // a backup name that already exists: wx fails
    const stamp = () => NOW;
    const first = apply(s.file, [{ type: 'task', id: s.ids.tTest }], stamp);
    expect(existsSync(first.backup)).toBe(true);
    restore(s.file, first.backup);
    expect(() => apply(s.file, [{ type: 'task', id: s.ids.tTest }], stamp)).toThrow(/backup/);
    expect(counts(s.file)).toEqual(base);
  });
});

describe('seed zakup', () => {
  it('creates once, then is a no-op; amounts stay empty; dry run writes nothing', () => {
    const s = seeded();
    const plan = seed({ db: s.file, dryRun: true, today: '2026-11-26', now: () => NOW });
    expect(plan.plan).toBeTruthy();
    expect(counts(s.file).pm_projects).toBe(2);
    const a = seed({ db: s.file, today: '2026-11-26', now: () => NOW });
    expect(a.created).toBe(true);
    const b = seed({ db: s.file, today: '2026-11-26', now: () => NOW });
    expect(b).toEqual({ created: false, projectId: a.projectId });
    const db = new Database(s.file, { readonly: true });
    const p = db.prepare('SELECT * FROM pm_projects WHERE id = ?').get(a.projectId) as { what: string; source: string; spec: string };
    expect(p.what).toBe(ZAKUP_TITLE);
    expect(p.source).toBe('owner');
    expect(p.spec).toContain('2200 USD');
    const ms = db.prepare('SELECT * FROM pm_milestones WHERE project_id = ? ORDER BY stage_no').all(a.projectId) as { amount_usd: number | null; title: string; due_at: number }[];
    expect(ms).toHaveLength(5);
    expect(ms.every((m) => m.amount_usd === null)).toBe(true);
    expect(ms[0]!.title).toContain('Этап 1: Бот-знакомство');
    expect(db.prepare("SELECT COUNT(*) c FROM tasks WHERE title = 'Созвон с клиентом: заметки'").get()).toEqual({ c: 1 });
    db.close();
  });
});
