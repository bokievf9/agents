import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeFor } from '@fir/worker-content-maker';
import { describe, expect, it } from 'vitest';
import { shellWorld, serve, type ShellWorld } from './shell-helpers.js';

const count = (p: ShellWorld, t: string) => (p.w.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;

/** old (ready, 2026-10-01, files + versions), mid (rejected, 2026-11-10), fresh (rejected, 2026-11-20), pending (proposed, 2026-10-02), old article. */
function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'purge-renders-'));
  const p = shellWorld({ rendersDir: dir });
  const s = storeFor({ db: p.w.db, now: p.w.hq.now });
  const mk = (date: string, key: string) => s.insertItem({ packId: null, seq: 1, total: 1, type: 'post', topicKey: key, topicText: key, plannedDate: date });
  const link = (itemId: number, state: string, core: number | null) => Number(p.w.db.prepare("INSERT INTO task_approvals (task_id, approval_id, dept, kind, payload, summary, state, created_at) VALUES (1, ?, 'marketing', 'content_item', ?, 's', ?, 1)").run(core, JSON.stringify({ itemId }), state).lastInsertRowid);
  const old = mk('2026-10-01', 'old');
  s.setProposed(old, 'text', 't');
  s.markReady(old, 'text', false, [{ platform: 'instagram', text: 'cap' }]);
  mkdirSync(join(dir, String(old)));
  writeFileSync(join(dir, String(old), '1.png'), 'png-bytes');
  s.setFiles(old, [`${old}/1.png`]);
  const oldLink = link(old, 'executed', null);
  p.w.db.exec("CREATE TABLE IF NOT EXISTS review_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, approval_id TEXT NOT NULL, v INTEGER NOT NULL, created_at INTEGER NOT NULL, text TEXT NOT NULL, media TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '', author TEXT NOT NULL, UNIQUE (approval_id, v))");
  p.w.db.prepare("INSERT INTO review_versions (approval_id, v, created_at, text, author) VALUES (?, 1, 1, '{}', 'worker')").run(`ap_${oldLink}`);
  const mid = mk('2026-11-10', 'mid');
  s.setStatus(mid, 'rejected');
  link(mid, 'rejected', null);
  const fresh = mk('2026-11-20', 'fresh');
  s.setStatus(fresh, 'rejected');
  const pending = mk('2026-10-02', 'pending');
  s.setProposed(pending, 'text', 't');
  link(pending, 'asked', null);
  const art = s.insertArticle('ai');
  s.setArticle(art, { status: 'rejected', title: 'a' });
  return { p, s, dir, old, mid, fresh, pending, art };
}
const ids = (w: ReturnType<typeof seed>) => (w.p.w.db.prepare('SELECT id FROM cm_items ORDER BY id').all() as { id: number }[]).map((r) => r.id);

describe('POST /admin/content/purge', () => {
  it('dryRun counts and changes nothing', async () => {
    const w = seed();
    const before = JSON.stringify(ids(w));
    const r = await w.p.call('POST', '/admin/content/purge', { dryRun: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, dryRun: true, counts: { materials: 4, approvals: 2, reviews: 1, files: 1, orders: 0, bytes: 9 } });
    expect(JSON.stringify(ids(w))).toBe(before);
    expect(existsSync(join(w.dir, String(w.old), '1.png'))).toBe(true);
    expect(count(w.p, 'task_approvals')).toBe(3);
    expect(count(w.p, 'review_versions')).toBe(1);
  });

  it('a real run removes rows and files, keeps pending, writes one audit line without content, and is idempotent', async () => {
    const w = seed();
    const r = await w.p.call('POST', '/admin/content/purge', {});
    expect(r.json.counts).toMatchObject({ materials: 4, approvals: 2, reviews: 1, files: 1 });
    expect(ids(w)).toEqual([w.pending]);
    expect(w.s.article(w.art)).toBeUndefined();
    expect(existsSync(join(w.dir, String(w.old)))).toBe(false);
    expect(count(w.p, 'task_approvals')).toBe(1);
    expect(count(w.p, 'review_versions')).toBe(0);
    expect(count(w.p, 'cm_ready')).toBe(0);
    const log = w.p.w.db.prepare("SELECT agent_id, detail FROM activity WHERE action = 'content_purged'").all() as { agent_id: string; detail: string }[];
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0]!.detail)).toMatchObject({ materials: 4 });
    expect(log[0]!.detail).not.toContain('text');
    const again = await w.p.call('POST', '/admin/content/purge', {});
    expect(again.json.counts).toMatchObject({ materials: 0, approvals: 0, reviews: 0, files: 0, orders: 0 });
    expect(ids(w)).toEqual([w.pending]);
  });

  it('pending is never deleted, even when listed', async () => {
    const w = seed();
    const r = await w.p.call('POST', '/admin/content/purge', { statuses: ['pending', 'rejected'] });
    expect(r.json.counts.materials).toBe(3);
    expect(ids(w)).toContain(w.pending);
  });

  it('before is a cutoff on the planned day; statuses narrows', async () => {
    const w = seed();
    let r = await w.p.call('POST', '/admin/content/purge', { before: '2026-11-15T00:00:00Z', statuses: ['ready'] });
    expect(r.json.counts.materials).toBe(1);
    expect(ids(w)).toEqual([w.mid, w.fresh, w.pending]);
    r = await w.p.call('POST', '/admin/content/purge', { before: '2026-11-15' });
    expect(r.json.counts.materials).toBe(1); // mid only: the article was made today, the old item is gone
    expect(ids(w)).toEqual([w.fresh, w.pending]);
  });

  it('rejects bad bodies, and only the admin token reaches it', async () => {
    const w = seed();
    for (const bad of [{ before: 'yesterday' }, { statuses: ['gone'] }, { dryRun: 'yes' }, { extra: 1 }]) expect((await w.p.call('POST', '/admin/content/purge', bad)).status).toBe(400);
    expect(ids(w)).toHaveLength(4);
    const s = await serve(w.p);
    expect((await s.http('POST', '/admin/content/purge', {}, {})).status).toBe(401);
    expect((await s.http('POST', '/admin/content/purge', { dryRun: true }, { 'x-cabinet-token': 'x' })).status).toBe(401);
    expect((await s.http('POST', '/admin/content/purge', { dryRun: true })).status).toBe(200);
    await s.close();
  });
});
