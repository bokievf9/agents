import { createHash } from 'node:crypto';
import { errMsg, log, migrate, type Db } from '@fir/core';
import { chunkText, redactSecrets, type Knowledge, type KnowledgeChunk } from '@fir/fira';
import { crawlSite, MAX_PAGES, parseSiteUrl, publicFetcher, type Fetcher } from './site-crawl.js';

/**
 * «Знания клиента» (2026-11-23): the text of the client's own website becomes knowledge of the client's playground/demo agent. Scope is the client:
 * every chunk is stored under the company id `client-<clientId>` with tier `internal` (the client's agent reads it, nobody else's agent does) and never
 * into the Fir Tech pack (`firtech`). Pages are kept in `ck_pages` so the store is rebuilt after a restart; a job per import in `ck_jobs`. Logs carry ids
 * and counts, never page text. Instagram is NOT crawled: only the handle is stored (`ck_sources.ig_handle`); TODO: read the profile through the Agent Reach queue.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ck_sources (
  client_id INTEGER PRIMARY KEY,
  site_url TEXT NOT NULL DEFAULT '',
  ig_handle TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ck_pages (
  client_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, url)
);
CREATE TABLE IF NOT EXISTS ck_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  origin TEXT NOT NULL,
  state TEXT NOT NULL,
  pages INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS ck_jobs_client ON ck_jobs (client_id, id);`;

export const scopeOf = (clientId: number): string => `client-${clientId}`;
const HOUR = 3_600_000;
const CHUNKS_CAP = 1200;

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}
const ok = (body: Record<string, unknown> = {}): Reply => ({ status: 200, body: { ok: true, ...body } });
const fail = (status: number, error: string, more: Record<string, unknown> = {}): Reply => ({ status, body: { ok: false, error, ...more } });

interface JobRow {
  id: number; client_id: number; url: string; origin: string; state: 'running' | 'done' | 'failed'; pages: number; chunks: number; chars: number;
  errors: number; skipped: number; truncated: number; error: string; created_at: number; finished_at: number | null;
}
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const job = (j: JobRow) => ({
  id: j.id, url: j.url, origin: j.origin, state: j.state, pages: j.pages, chunks: j.chunks, chars: j.chars, errors: j.errors, skipped: j.skipped, truncated: j.truncated === 1,
  error: j.error, startedAt: iso(j.created_at), finishedAt: iso(j.finished_at),
});

export interface ClientKnowledgeDeps {
  db: Db;
  now: () => number;
  /** The store the chunks go to (the shared in-memory store with the Voyage or hash embedder). Never the lead manager's store. */
  knowledge: Knowledge;
  /** Default: public addresses only. Tests give a plain one. */
  fetcher?: Fetcher;
  /** `KNOWLEDGE_AUTO_IMPORT` (default on). */
  autoImport?: boolean;
  /** Politeness pause between pages (tests 0). */
  delayMs?: number;
}

export class ClientKnowledge {
  private readonly running = new Map<number, Promise<void>>();
  private readonly loaded = new Map<number, Promise<void>>();
  private readonly fetcher: Fetcher;
  private readonly autoOn: boolean;

  constructor(private readonly d: ClientKnowledgeDeps) {
    migrate(d.db, SCHEMA);
    this.fetcher = d.fetcher ?? publicFetcher();
    this.autoOn = d.autoImport ?? true;
    // a restart killed a running job: it is not running any more
    d.db.prepare("UPDATE ck_jobs SET state = 'failed', error = 'restart', finished_at = ? WHERE state = 'running'").run(d.now());
  }

  private clientExists(id: number): boolean {
    try {
      return d_has(this.d.db, 'cab_clients') && this.d.db.prepare('SELECT 1 FROM cab_clients WHERE id = ?').get(id) !== undefined;
    } catch {
      return false;
    }
  }

  /** The site and Instagram handle of the client's brief (`brief.discovery.si` and `ig`): stored, the site is queued when auto-import is on. */
  onBrief(clientId: number, b: { si?: string | undefined; ig?: string | undefined }): void {
    const si = (b.si ?? '').trim().slice(0, 300);
    const ig = (b.ig ?? '').trim().replace(/^@/, '').replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '').replace(/[/?#].*$/, '').slice(0, 60);
    if (!si && !ig) return;
    const url = si ? parseSiteUrl(/^[a-z][a-z0-9+.-]*:/i.test(si) ? si : `https://${si}`) : null;
    this.d.db.prepare(
      `INSERT INTO ck_sources (client_id, site_url, ig_handle, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET site_url = CASE WHEN excluded.site_url != '' THEN excluded.site_url ELSE site_url END,
         ig_handle = CASE WHEN excluded.ig_handle != '' THEN excluded.ig_handle ELSE ig_handle END, updated_at = excluded.updated_at`,
    ).run(clientId, si ? (url?.href ?? '') : '', /^[A-Za-z0-9._]{1,30}$/.test(ig) ? ig : '', this.d.now());
    // a non-http address ("javascript:", "ftp:") is never queued
    if (url && this.autoOn) void this.start(clientId, url.href, 'auto', undefined);
  }

  /** `POST /admin/clients/:id/knowledge/import { url?, maxPages? }`: without `url`, the site of the client's brief. */
  importRoute(clientId: number, body: unknown): Reply {
    if (!this.clientExists(clientId)) return fail(404, 'not_found');
    const b = (body ?? {}) as { url?: unknown; maxPages?: unknown };
    if (b.maxPages !== undefined && !(Number.isInteger(b.maxPages) && (b.maxPages as number) >= 1 && (b.maxPages as number) <= MAX_PAGES)) return fail(400, 'invalid');
    let raw = typeof b.url === 'string' ? b.url : '';
    if (!raw) raw = (this.d.db.prepare('SELECT site_url FROM ck_sources WHERE client_id = ?').get(clientId) as { site_url: string } | undefined)?.site_url ?? '';
    const url = raw ? parseSiteUrl(raw) : null;
    if (!url) return fail(400, 'invalid_url');
    const r = this.start(clientId, url.href, 'manual', b.maxPages as number | undefined);
    return r.status === 'running' ? { status: 202, body: { ok: true, jobId: r.id, state: 'running', already: r.already } } : fail(429, 'too_soon');
  }

  /** Starts a job unless one runs for the client (then that job is returned) or, for auto, one ran within the hour. */
  private start(clientId: number, url: string, origin: 'auto' | 'manual', maxPages: number | undefined): { status: 'running' | 'skipped'; id: number; already: boolean } {
    const live = this.d.db.prepare("SELECT id FROM ck_jobs WHERE client_id = ? AND state = 'running' ORDER BY id DESC LIMIT 1").get(clientId) as { id: number } | undefined;
    if (live && this.running.has(clientId)) return { status: 'running', id: live.id, already: true };
    const t = this.d.now();
    if (origin === 'auto') {
      const recent = this.d.db.prepare('SELECT id FROM ck_jobs WHERE client_id = ? AND created_at > ? LIMIT 1').get(clientId, t - HOUR) as { id: number } | undefined;
      if (recent) return { status: 'skipped', id: recent.id, already: true };
    }
    const id = Number(this.d.db.prepare("INSERT INTO ck_jobs (client_id, url, origin, state, created_at) VALUES (?, ?, ?, 'running', ?)").run(clientId, url, origin, t).lastInsertRowid);
    const p = this.run(clientId, id, url, maxPages).finally(() => void this.running.delete(clientId));
    this.running.set(clientId, p);
    return { status: 'running', id, already: false };
  }

  /** Resolves when the client's running job (if any) is over (tests, shutdown). */
  idle(clientId: number): Promise<void> {
    return this.running.get(clientId) ?? Promise.resolve();
  }

  private async run(clientId: number, id: number, url: string, maxPages: number | undefined): Promise<void> {
    const scope = scopeOf(clientId);
    try {
      const res = await crawlSite(new URL(url), { fetcher: this.fetcher, ...(maxPages ? { maxPages } : {}), ...(this.d.delayMs !== undefined ? { delayMs: this.d.delayMs } : {}) });
      const t = this.d.now();
      if (!res.pages.length) {
        // nothing readable (robots, errors): the old knowledge stays as it was
        this.d.db.prepare("UPDATE ck_jobs SET state = 'failed', error = 'no_pages', errors = ?, skipped = ?, finished_at = ? WHERE id = ?").run(res.errors, res.skipped, t, id);
        log('warn', 'client knowledge import found no pages', { client: clientId, job: id, errors: res.errors, skipped: res.skipped });
        return;
      }
      const chunks = this.chunksOf(clientId, res.pages.map((p) => ({ ...p, fetchedAt: t })));
      // a re-import replaces the site knowledge of this client only: the same site gives the same rows
      const tx = this.d.db.transaction(() => {
        this.d.db.prepare('DELETE FROM ck_pages WHERE client_id = ?').run(clientId);
        for (const p of res.pages) this.d.db.prepare('INSERT INTO ck_pages (client_id, url, title, text, fetched_at) VALUES (?, ?, ?, ?, ?)').run(clientId, p.url, p.title, p.text, t);
      });
      tx();
      await this.d.knowledge.remove?.(scope, 'site-');
      await this.d.knowledge.add(chunks);
      this.loaded.set(clientId, Promise.resolve());
      this.d.db.prepare("UPDATE ck_jobs SET state = 'done', pages = ?, chunks = ?, chars = ?, errors = ?, skipped = ?, truncated = ?, finished_at = ? WHERE id = ?")
        .run(res.pages.length, chunks.length, res.chars, res.errors, res.skipped, res.truncated ? 1 : 0, this.d.now(), id);
      log('info', 'client knowledge imported', { client: clientId, job: id, pages: res.pages.length, chunks: chunks.length, chars: res.chars, errors: res.errors });
    } catch (e) {
      this.d.db.prepare("UPDATE ck_jobs SET state = 'failed', error = 'crawl', finished_at = ? WHERE id = ?").run(this.d.now(), id);
      log('warn', 'client knowledge import failed', { client: clientId, job: id, err: errMsg(e) });
    }
  }

  private chunksOf(clientId: number, pages: { url: string; title: string; text: string; fetchedAt: number }[]): KnowledgeChunk[] {
    const out: KnowledgeChunk[] = [];
    for (const p of pages) {
      const key = createHash('sha256').update(p.url).digest('hex').slice(0, 10);
      chunkText(redactSecrets(p.text).text).forEach((text, i) => {
        if (out.length < CHUNKS_CAP) out.push({ id: `site-${key}#${i}`, companyId: scopeOf(clientId), source: 'site', title: p.title || p.url, text, ref: p.url, tier: 'internal', updatedAt: p.fetchedAt });
      });
    }
    return out;
  }

  /** `GET /admin/clients/:id/knowledge`: the state of the import (counts, the pages list, never texts). */
  statusRoute(clientId: number): Reply {
    if (!this.clientExists(clientId)) return fail(404, 'not_found');
    const src = this.d.db.prepare('SELECT * FROM ck_sources WHERE client_id = ?').get(clientId) as { site_url: string; ig_handle: string } | undefined;
    const last = this.d.db.prepare('SELECT * FROM ck_jobs WHERE client_id = ? ORDER BY id DESC LIMIT 1').get(clientId) as JobRow | undefined;
    const pages = this.d.db.prepare('SELECT url, title, length(text) AS chars, fetched_at FROM ck_pages WHERE client_id = ? ORDER BY url').all(clientId) as { url: string; title: string; chars: number; fetched_at: number }[];
    const lastAt = pages.reduce((m, p) => Math.max(m, p.fetched_at), 0);
    const chunks = this.d.db.prepare("SELECT chunks FROM ck_jobs WHERE client_id = ? AND state = 'done' ORDER BY id DESC LIMIT 1").get(clientId) as { chunks: number } | undefined;
    const errors = this.d.db.prepare('SELECT COALESCE(SUM(errors), 0) AS n FROM ck_jobs WHERE client_id = ?').get(clientId) as { n: number };
    return ok({
      site: src?.site_url || null, instagram: src?.ig_handle || null,
      // Instagram is not crawled yet (TODO: Agent Reach); only the handle is kept
      instagramImported: false,
      state: last?.state ?? 'none', job: last ? job(last) : null,
      pages: pages.length, chunks: chunks?.chunks ?? 0, lastAt: lastAt ? iso(lastAt) : null, errors: errors.n,
      items: pages.map((p) => ({ url: p.url, title: p.title, chars: p.chars, fetchedAt: iso(p.fetched_at) })),
    });
  }

  /** Brings the client's pages back into the store after a restart (once per process, never blocks longer than `wait` ms). */
  private async ensureLoaded(clientId: number, wait: number): Promise<void> {
    let p = this.loaded.get(clientId);
    if (!p) {
      const rows = this.d.db.prepare('SELECT url, title, text, fetched_at AS fetchedAt FROM ck_pages WHERE client_id = ?').all(clientId) as { url: string; title: string; text: string; fetchedAt: number }[];
      p = rows.length ? this.d.knowledge.add(this.chunksOf(clientId, rows)).then(() => undefined).catch((e) => log('warn', 'client knowledge reload failed', { client: clientId, err: errMsg(e) })) : Promise.resolve();
      this.loaded.set(clientId, p);
    }
    await Promise.race([p, new Promise<void>((r) => setTimeout(r, wait).unref())]);
  }

  /** Chunks of this client's site that answer the question. Another client's or Fir Tech's knowledge is never searched: the scope is fixed here. */
  async search(clientId: number, query: string, k = 4): Promise<{ title: string; text: string; ref: string }[]> {
    await this.ensureLoaded(clientId, 3000);
    const hits = await this.d.knowledge.search(scopeOf(clientId), query, k, { audience: 'owner' });
    return hits.filter((h) => h.companyId === scopeOf(clientId)).map((h) => ({ title: h.title, text: h.text.slice(0, 700), ref: h.ref ?? '' }));
  }
}

function d_has(db: Db, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}
