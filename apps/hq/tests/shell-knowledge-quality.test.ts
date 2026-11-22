/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@fir/core';
import { InMemoryKnowledge } from '@fir/fira';
import { Hq } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { createKnowledgeApi, ownerChunks } from '../src/shell-knowledge.js';
import { createQualityApi, saveEvalRun } from '../src/shell-quality.js';

const NOW = Date.UTC(2026, 10, 23, 9, 0);
const q = (s = '') => new URLSearchParams(s);

function packDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pack-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'public-site-terms.md'), '---\nid: public-site-terms\n---\nГарантия на сайт два месяца.\n');
  writeFileSync(join(dir, 'internal-company.md'), '---\nid: internal-company\n---\nКак устроена компания изнутри.\n');
  writeFileSync(join(dir, 'public-sales-playbook-site.md'), '---\nid: x\n---\nПлейбук продаж.\n');
  const d = (id: string, tier: string, source: string) => ({ id, title: `Док ${id}`, tier, source, file: `${id}.md`, chars: 30, sha: 'abcdef012345' });
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ company: 'firtech', docs: [d('public-site-terms', 'public', 'firtech/src/content/terms.ts'), d('internal-company', 'internal', 'COMPANY.md'), d('public-sales-playbook-site', 'public', 'firtech/docs/sales-playbook-site.md')] }));
  return dir;
}

function setupK() {
  const db = openDb(':memory:');
  const knowledge = new InMemoryKnowledge();
  let reloaded = 0;
  const api = createKnowledgeApi({ db, now: () => NOW, packDir: packDir(), fira: () => ({ stores: { knowledge }, reload: () => Promise.resolve(++reloaded) }) });
  const call = async (method: string, seg: string[], body?: unknown, query = '') => {
    const r = await api.handle(method, seg, q(query), body);
    return { status: r.status, json: r.body as Record<string, any> };
  };
  return { db, knowledge, call, reloaded: () => reloaded };
}

describe('GET/POST/PATCH/DELETE /admin/knowledge', () => {
  it('lists pack documents with sources and tiers, filters and searches', async () => {
    const { call } = setupK();
    const all = await call('GET', []);
    expect(all.status).toBe(200);
    expect(all.json.total).toBe(3);
    expect(all.json.builtAt).toMatch(/^2/);
    const src = Object.fromEntries(all.json.items.map((i: any) => [i.id, i.source]));
    expect(src).toEqual({ 'public-site-terms': 'site', 'internal-company': 'company', 'public-sales-playbook-site': 'playbook' });
    expect((await call('GET', [], undefined, 'tier=internal')).json.items.map((i: any) => i.id)).toEqual(['internal-company']);
    expect((await call('GET', [], undefined, 'source=playbook')).json.total).toBe(1);
    expect((await call('GET', [], undefined, 'q=гарантия')).json.items.map((i: any) => i.id)).toEqual(['public-site-terms']);
    expect((await call('GET', [], undefined, 'tier=secret')).status).toBe(400);
    expect((await call('GET', [], undefined, 'source=nope')).status).toBe(400);
  });

  it('a missing pack is an empty list, not an error', async () => {
    const api = createKnowledgeApi({ db: openDb(':memory:'), now: () => NOW, packDir: '/nonexistent-pack' });
    const r = await api.handle('GET', [], q(), undefined);
    expect(r.body).toMatchObject({ ok: true, items: [], total: 0, builtAt: null });
  });

  it('shows a document text; unknown id is 404', async () => {
    const { call } = setupK();
    const r = await call('GET', ['public-site-terms']);
    expect(r.json.item).toMatchObject({ id: 'public-site-terms', tier: 'public', source: 'site' });
    expect(r.json.item.text).toContain('Гарантия');
    expect((await call('GET', ['nope'])).status).toBe(404);
  });

  it('owner notes: create, search by Fira, edit, delete; pack documents are read-only (409); secret is refused (400)', async () => {
    const { call, knowledge, db } = setupK();
    const c = await call('POST', [], { title: 'Скидка студентам', text: 'Студентам вуза даём скидку на лендинг.', tier: 'public' });
    expect(c.status).toBe(200);
    const id = c.json.item.id as string;
    expect(id).toMatch(/^owner-\d+$/);
    expect((await call('GET', [], undefined, 'source=owner')).json.items).toHaveLength(1);
    expect((await call('GET', [id])).json.item).toMatchObject({ source: 'owner', text: 'Студентам вуза даём скидку на лендинг.' });
    // searchable by Fira with its tier
    expect((await knowledge.search('firtech', 'скидка студентам', 3)).map((h) => h.id)).toEqual([`${id}#0`]);
    const p = await call('PATCH', [id], { tier: 'internal', text: 'Теперь только по заявке.' });
    expect(p.json.item).toMatchObject({ tier: 'internal' });
    expect(await knowledge.search('firtech', 'скидка студентам', 3)).toEqual([]); // internal: not for a visitor
    expect((await knowledge.search('firtech', 'только по заявке', 3, { audience: 'owner' })).length).toBe(1);
    expect(ownerChunks(db, NOW)).toHaveLength(1);
    expect((await call('PATCH', [id], {})).status).toBe(400);
    expect((await call('PATCH', [id], { x: 1 })).status).toBe(400);
    expect((await call('PATCH', ['internal-company'], { title: 'x' })).status).toBe(409);
    expect((await call('PATCH', ['internal-company'], { title: 'x' })).json.error).toBe('readonly_source');
    expect((await call('DELETE', ['public-site-terms'])).status).toBe(409);
    expect((await call('DELETE', ['owner-999'])).status).toBe(404);
    expect((await call('POST', [], { title: 'k', text: 'ключ', tier: 'secret' })).status).toBe(400);
    expect((await call('POST', [], { title: '', text: 'x', tier: 'public' })).status).toBe(400);
    expect((await call('DELETE', [id])).status).toBe(200);
    expect(await knowledge.search('firtech', 'только по заявке', 3, { audience: 'owner' })).toEqual([]);
    expect(ownerChunks(db, NOW)).toHaveLength(0);
  });

  it('rebuild answers at once and reloads the Fira store', async () => {
    const { call, reloaded } = setupK();
    const r = await call('POST', ['rebuild']);
    expect(r.json).toEqual({ ok: true, queued: true });
    expect(reloaded()).toBe(1);
    expect((await call('GET', ['rebuild'])).status).toBe(405);
  });
});

function setupQ() {
  const db = openDb(':memory:');
  const hq = new Hq(db, { now: () => NOW });
  const api = createQualityApi({ db, now: () => NOW, setting: (k) => hq.setting(k) });
  const call = async (method: string, seg: string[], body?: unknown, query = '') => {
    const r = await api.handle(method, seg, q(query), body);
    return { status: r.status, json: r.body as Record<string, any> };
  };
  return { db, hq, call };
}

describe('/admin/quality', () => {
  it('rates answers; a bad rating with a note becomes a lesson, a good or note-less one does not; the list is newest first', async () => {
    const { call, db } = setupQ();
    db.exec(`CREATE TABLE ch_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, text TEXT, at INTEGER);
      CREATE TABLE ch_inbound (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, text TEXT, at INTEGER);`);
    db.prepare('INSERT INTO ch_inbound (chat_id, text, at) VALUES (5, ?, ?)').run('Сколько стоит сайт для салона?', NOW - 1000);
    db.prepare('INSERT INTO ch_messages (chat_id, text, at) VALUES (5, ?, ?)').run('Дёшево.', NOW);
    expect((await call('POST', ['rate'], { messageId: 'm1', thread: 't1', value: 1 })).json).toMatchObject({ ok: true });
    expect((await call('POST', ['rate'], { messageId: 'm2', thread: 't1', value: -1 })).json.lessonId).toBeUndefined();
    const bad = await call('POST', ['rate'], { messageId: 1, thread: 't9', value: -1, note: 'Назвать цену из прайса.' });
    expect(bad.json.lessonId).toBeTruthy();
    const lessons = (await call('GET', ['lessons'])).json.items;
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ source: 'rating', tag: 'rating', question: 'Сколько стоит сайт для салона?', bad: 'Дёшево.', good: 'Назвать цену из прайса.' });
    // the same message rated again replaces the rating and its lesson
    await call('POST', ['rate'], { messageId: '1', thread: 't9', value: -1, note: 'Другая правка.' });
    expect((await call('GET', ['lessons'])).json.items).toHaveLength(1);
    const ratings = (await call('GET', ['ratings'], undefined, 'limit=2')).json.items;
    expect(ratings).toHaveLength(2);
    expect(ratings[0]).toMatchObject({ messageId: '1', thread: 't9', value: -1, note: 'Другая правка.' });
    expect(ratings[0].at).toMatch(/^2026/);
    expect((await call('GET', ['ratings'])).json.items).toHaveLength(3);
  });

  it('bad bodies are 400; lessons are deleted by id (404 for a missing one)', async () => {
    const { call, db } = setupQ();
    for (const b of [{}, { messageId: 'a', thread: 't', value: 2 }, { messageId: 'a', thread: 't', value: 1, extra: 1 }, { messageId: '', thread: 't', value: 1 }]) expect((await call('POST', ['rate'], b)).status).toBe(400);
    db.prepare("INSERT INTO fira_lessons (company_id, agent_id, role_id, question, good, tag, source, created_at) VALUES ('firtech','*','lead-manager','q','g','thread','owner_review', ?)").run(NOW);
    const [l] = (await call('GET', ['lessons'])).json.items;
    expect(l).toMatchObject({ source: 'thread', question: 'q', good: 'g' });
    expect((await call('DELETE', ['lessons', l.id])).status).toBe(200);
    expect((await call('DELETE', ['lessons', l.id])).status).toBe(404);
    expect((await call('DELETE', ['lessons', 'abc'])).status).toBe(404);
    expect((await call('GET', ['nope'])).status).toBe(404);
  });

  it('eval: null before any run, the recorded run after', async () => {
    const { call, hq } = setupQ();
    expect((await call('GET', ['eval'])).json).toEqual({ ok: true, last: null });
    const run = { at: '2026-11-23T09:00:00.000Z', runtime: 'fira' as const, lead: { passed: 30, total: 30 }, red: { passed: 15, total: 15 }, handoffRate: 0.2, toolRate: 0.5 };
    saveEvalRun(hq, run);
    expect((await call('GET', ['eval'])).json.last).toEqual(run);
  });
});
