import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { migrate, type Db } from '@fir/core';
import { chunkText, PackIndexSchema, PACKAGE_DIR, redactSecrets, type Knowledge, type KnowledgeChunk } from '@fir/fira';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import { fail, ok } from './shell-crm.js';

/**
 * `/admin/knowledge*`: the knowledge of Fira for the owner (contract `docs/briefs/fira/knowledge-quality-api.md`, `docs/admin-crm-api.md`).
 * Documents of the company pack (read from disk, read-only) and the owner's own notes (table `kb_owner_notes`, they go into the knowledge search of the
 * lead manager with their tier). `secret` is never accepted. Texts go only to the owner; logs carry ids and counts.
 */
const COMPANY = 'firtech';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS kb_owner_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  tier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`;

interface NoteRow { id: number; title: string; text: string; tier: 'public' | 'internal'; created_at: number; updated_at: number }

/** The owner's notes as knowledge chunks (ids `owner-<n>#<i>`), for the search of the lead manager. */
export function ownerChunks(db: Db, now: number): KnowledgeChunk[] {
  migrate(db, SCHEMA);
  const out: KnowledgeChunk[] = [];
  for (const n of db.prepare('SELECT * FROM kb_owner_notes ORDER BY id').all() as NoteRow[]) out.push(...noteChunks(n, now));
  return out;
}

function noteChunks(n: NoteRow, now: number): KnowledgeChunk[] {
  const text = redactSecrets(n.text).text;
  return chunkText(text).map((c, i) => ({ id: `owner-${n.id}#${i}`, companyId: COMPANY, source: 'document' as const, title: n.title, text: c, ref: 'owner', tier: n.tier, updatedAt: n.updated_at || now }));
}

const tierSchema = z.enum(['public', 'internal']);
const createBody = z.object({ title: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(20_000), tier: tierSchema }).strict();
const patchBody = z.object({ title: z.string().trim().min(1).max(200).optional(), text: z.string().trim().min(1).max(20_000).optional(), tier: tierSchema.optional() }).strict();

type Source = 'site' | 'company' | 'playbook' | 'owner';
const SOURCES: Source[] = ['site', 'company', 'playbook', 'owner'];
const sourceOf = (id: string, path: string): Source => (/playbook/i.test(id) || /playbook/i.test(path) ? 'playbook' : /^public-site-|src\/content/i.test(id + ' ' + path) ? 'site' : 'company');
const iso = (ms: number): string => new Date(ms).toISOString();
const noteId = (id: string): number | null => (/^owner-\d{1,9}$/.test(id) ? Number(id.slice(6)) : null);

export interface ShellKnowledgeDeps {
  db: Db;
  now: () => number;
  /** The lead manager's store, when it is on: owner notes are written into it at once and the rebuild reloads it. */
  fira?: (() => { stores: { knowledge: Knowledge }; reload(): Promise<number> } | null) | undefined;
  /** Where the pack lives (tests); default `packages/fira/company-packs/firtech`. */
  packDir?: string | undefined;
}

export function createKnowledgeApi(d: ShellKnowledgeDeps) {
  migrate(d.db, SCHEMA);
  const dir = d.packDir ?? join(PACKAGE_DIR, 'company-packs', COMPANY);

  function pack() {
    const path = join(dir, 'index.json');
    if (!existsSync(path)) return { docs: [] as { id: string; title: string; tier: 'public' | 'internal'; source: Source; file: string; chars: number; path: string }[], builtAt: null as string | null };
    const index = PackIndexSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    return { docs: index.docs.map((x) => ({ id: x.id, title: x.title, tier: x.tier, source: sourceOf(x.id, x.source), file: x.file, chars: x.chars, path: x.source })), builtAt: iso(statSync(path).mtimeMs) };
  }
  const packText = (file: string): { text: string; at: number } | null => {
    const p = join(dir, file);
    if (!existsSync(p)) return null;
    return { text: redactSecrets(readFileSync(p, 'utf8').replace(/^---\n[\s\S]*?\n---\n?/, '')).text, at: statSync(p).mtimeMs };
  };
  const notes = (): NoteRow[] => d.db.prepare('SELECT * FROM kb_owner_notes ORDER BY id DESC').all() as NoteRow[];
  const note = (id: number): NoteRow | undefined => d.db.prepare('SELECT * FROM kb_owner_notes WHERE id = ?').get(id) as NoteRow | undefined;

  async function sync(id: number, drop = false): Promise<void> {
    const f = d.fira?.();
    if (!f) return;
    const k = f.stores.knowledge;
    try {
      await k.remove?.(COMPANY, `owner-${id}#`);
      const n = drop ? undefined : note(id);
      if (n) await k.add(noteChunks(n, d.now()));
    } catch {
      /* the next reload brings the store back in line */
    }
  }

  function list(q: URLSearchParams): AdminReply {
    const tier = q.get('tier');
    const source = q.get('source');
    if (tier && tier !== 'public' && tier !== 'internal') return fail(400, 'invalid');
    if (source && !SOURCES.includes(source as Source)) return fail(400, 'invalid');
    const needle = (q.get('q') ?? '').trim().toLowerCase().slice(0, 64);
    const limit = Math.min(500, Math.max(1, Number(q.get('limit')) || 100));
    const p = pack();
    let items = [
      ...notes().map((n) => ({ id: `owner-${n.id}`, title: n.title, tier: n.tier, source: 'owner' as Source, updatedAt: iso(n.updated_at), chars: n.text.length, hay: () => n.text })),
      ...p.docs.map((x) => {
        const t = packText(x.file);
        return { id: x.id, title: x.title, tier: x.tier, source: x.source, updatedAt: iso(t?.at ?? 0), chars: x.chars, hay: () => t?.text ?? '' };
      }),
    ];
    if (tier) items = items.filter((x) => x.tier === tier);
    if (source) items = items.filter((x) => x.source === source);
    if (needle) items = items.filter((x) => x.title.toLowerCase().includes(needle) || x.hay().toLowerCase().includes(needle));
    // P2-11: sites of clients without a confirmed account wait here for the owner; «Импортировать» = `POST /admin/clients/:id/knowledge/import { url }`
    let pendingImports: { clientId: number; clientName: string; url: string; since: string | null }[] = [];
    try {
      pendingImports = (d.db.prepare("SELECT p.client_id, COALESCE(c.name, '') AS name, p.url, p.created_at FROM ck_pending p LEFT JOIN cab_clients c ON c.id = p.client_id ORDER BY p.created_at DESC LIMIT 100").all() as { client_id: number; name: string; url: string; created_at: number }[])
        .map((r) => ({ clientId: r.client_id, clientName: r.name, url: r.url, since: iso(r.created_at) }));
    } catch {
      /* no pending table or no clients table yet: nothing waits */
    }
    return ok({ items: items.slice(0, limit).map(({ hay, ...x }) => (void hay, x)), total: items.length, builtAt: p.builtAt, pendingImports });
  }

  function get(id: string): AdminReply {
    const n = noteId(id);
    if (n !== null) {
      const r = note(n);
      return r ? ok({ item: { id, title: r.title, tier: r.tier, source: 'owner', text: r.text, updatedAt: iso(r.updated_at) } }) : fail(404, 'not_found');
    }
    const x = pack().docs.find((y) => y.id === id);
    const t = x ? packText(x.file) : null;
    return x && t ? ok({ item: { id, title: x.title, tier: x.tier, source: x.source, text: t.text, updatedAt: iso(t.at) } }) : fail(404, 'not_found');
  }

  async function create(body: unknown): Promise<AdminReply> {
    const b = createBody.safeParse(body ?? {});
    if (!b.success) return fail(400, 'invalid');
    const at = d.now();
    const id = Number(d.db.prepare('INSERT INTO kb_owner_notes (title, text, tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(b.data.title, b.data.text, b.data.tier, at, at).lastInsertRowid);
    await sync(id);
    return ok({ item: { id: `owner-${id}`, title: b.data.title, tier: b.data.tier, source: 'owner', updatedAt: iso(at), chars: b.data.text.length } });
  }

  async function patch(id: string, body: unknown): Promise<AdminReply> {
    const n = noteId(id);
    if (n === null) return pack().docs.some((x) => x.id === id) ? fail(409, 'readonly_source') : fail(404, 'not_found');
    const cur = note(n);
    if (!cur) return fail(404, 'not_found');
    const b = patchBody.safeParse(body ?? {});
    if (!b.success || !Object.keys(b.data).length) return fail(400, 'invalid');
    const at = d.now();
    d.db.prepare('UPDATE kb_owner_notes SET title = ?, text = ?, tier = ?, updated_at = ? WHERE id = ?').run(b.data.title ?? cur.title, b.data.text ?? cur.text, b.data.tier ?? cur.tier, at, n);
    await sync(n);
    const r = note(n)!;
    return ok({ item: { id, title: r.title, tier: r.tier, source: 'owner', updatedAt: iso(r.updated_at), chars: r.text.length } });
  }

  async function remove(id: string): Promise<AdminReply> {
    const n = noteId(id);
    if (n === null) return pack().docs.some((x) => x.id === id) ? fail(409, 'readonly_source') : fail(404, 'not_found');
    if (!note(n)) return fail(404, 'not_found');
    d.db.prepare('DELETE FROM kb_owner_notes WHERE id = ?').run(n);
    await sync(n, true);
    return ok({});
  }

  /** Re-reads the pack from disk into the lead manager's store (the builder of the sources is not run inside the container). */
  function rebuild(): AdminReply {
    const f = d.fira?.();
    if (f) void f.reload().catch(() => undefined);
    return ok({ queued: true });
  }

  async function handle(method: string, seg: string[], query: URLSearchParams, body: unknown): Promise<AdminReply> {
    // seg: after `knowledge`
    if (seg.length === 0) return method === 'GET' ? list(query) : method === 'POST' ? create(body) : fail(405, 'method_not_allowed');
    let id: string;
    try {
      id = decodeURIComponent(seg[0]!);
    } catch {
      return fail(404, 'not_found');
    }
    if (seg.length === 1 && id === 'rebuild') return method === 'POST' ? rebuild() : fail(405, 'method_not_allowed');
    if (seg.length !== 1) return fail(404, 'not_found');
    if (method === 'GET') return get(id);
    if (method === 'PATCH') return patch(id, body);
    if (method === 'DELETE') return remove(id);
    return fail(405, 'method_not_allowed');
  }

  return { handle, sync };
}
