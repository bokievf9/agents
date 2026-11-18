import { errMsg, log, migrate } from '@fir/core';
import type { Task, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { checkLlms, checkPage, checkServices, pageFacts, type Finding, type PageFacts } from './checks.js';
import { fetchGsc, gscText } from './gsc.js';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export const KIND = 'seo_proposal';
const DAY = 86_400_000;
export const REPEAT_DAYS = 28;
export const MAX_PROPOSALS = 5;
export const MAX_PAGES = 12;
const FALLBACK_PATHS = ['/', '/ru', '/en'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seo_seen (
  key TEXT PRIMARY KEY,
  proposed_at INTEGER NOT NULL
);
`;

export interface SeoOptions {
  /** Default https://firtech.pro */
  siteUrl?: string;
  gscServiceAccountJson?: string | undefined;
  /** Search Console property: `sc-domain:firtech.pro` or `https://firtech.pro/`. */
  gscSiteUrl?: string | undefined;
  fetch?: FetchFn;
}

export type SeoProposalPayload = { key: string; page: string; title: string; change: string; needsBuilder: boolean };

const get = async (fetchFn: FetchFn, url: string) => fetchFn(url, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'FirTechSeoCheck/1.0 (+https://firtech.pro)' } });

/** Sitemap `<loc>` entries on the site's own host, capped. */
export function sitemapUrls(xml: string, host: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    try {
      const u = new URL(m[1]!);
      if (u.host === host && !u.pathname.endsWith('.xml')) out.push(u.toString());
    } catch {
      /* ignore broken entries */
    }
  }
  return [...new Set(out)].slice(0, MAX_PAGES);
}

const isHome = (url: string) => /^\/(ru|en)?\/?$/.test(new URL(url).pathname);

/**
 * SEO and AI-SEO, stage 1. Action `seo`: fetches the site (sitemap, else /, /ru, /en) and llms.txt, runs fixed checks
 * (title, description, h1, canonical, hreflang, JSON-LD, llms.txt freshness, the services table against the site text),
 * and proposes up to five concrete changes through the approval queue (kind `seo_proposal`). The head turns an
 * approved proposal into a task, tagged `builder` when the code has to change. Search Console only when configured.
 */
export class SeoWorker implements Worker {
  readonly id = 'seo';
  private readonly fetchFn: FetchFn;
  private readonly site: string;

  constructor(private readonly opts: SeoOptions = {}) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.site = (opts.siteUrl ?? 'https://firtech.pro').replace(/\/$/, '');
  }

  get gscEnabled(): boolean {
    return Boolean(this.opts.gscServiceAccountJson && this.opts.gscSiteUrl);
  }

  private async pages(): Promise<{ urls: string[]; note: string }> {
    try {
      const res = await get(this.fetchFn, `${this.site}/sitemap.xml`);
      if (res.ok) {
        const urls = sitemapUrls(await res.text(), new URL(this.site).host);
        if (urls.length > 0) return { urls, note: `sitemap: ${urls.length} страниц` };
      }
    } catch {
      /* fall through to the fixed list */
    }
    return { urls: FALLBACK_PATHS.map((p) => `${this.site}${p}`), note: 'sitemap нет, проверены /, /ru, /en' };
  }

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    if (task.meta.action !== 'seo') return { ok: false, result: '', error: `Неизвестное действие: ${String(task.meta.action)}` };
    try {
      return await this.check(ctx);
    } catch (e) {
      log('error', 'seo check failed', { err: errMsg(e) });
      return { ok: false, result: '', error: errMsg(e) };
    }
  }

  private async check(ctx: WorkerCtx): Promise<WorkerResult> {
    migrate(ctx.db, SCHEMA);
    const { urls, note } = await this.pages();
    const facts: PageFacts[] = [];
    const findings: Finding[] = [];
    const failed: string[] = [];
    for (const url of urls) {
      try {
        const res = await get(this.fetchFn, url);
        if (!res.ok) {
          failed.push(`${url}: HTTP ${res.status}`);
          findings.push({ key: `page_down:${new URL(url).pathname}`, severity: 3, page: url, problem: `страница отдаёт HTTP ${res.status}`, change: `Починить ${url}: вернуть 200 или убрать из sitemap.`, needsBuilder: true });
          continue;
        }
        const f = pageFacts(url, await res.text());
        facts.push(f);
        findings.push(...checkPage(f, { home: isHome(url) }));
      } catch (e) {
        failed.push(`${url}: ${errMsg(e)}`);
      }
    }
    if (facts.length === 0) return { ok: false, result: '', error: `Сайт не отдал ни одной страницы. ${failed.join('; ')}` };

    let llms: { status: number; text: string; lastModified: string | null } | null = null;
    try {
      const res = await get(this.fetchFn, `${this.site}/llms.txt`);
      llms = { status: res.status, text: res.ok ? await res.text() : '', lastModified: res.headers.get('last-modified') };
    } catch {
      /* treated as missing */
    }
    findings.push(...checkLlms(llms, this.site, ctx.now()));
    findings.push(...checkServices([...facts.map((f) => f.text), llms?.text ?? ''].join(' ')));

    let gsc = '';
    if (this.gscEnabled) {
      try {
        gsc = gscText(await fetchGsc(this.fetchFn, this.opts.gscServiceAccountJson!, this.opts.gscSiteUrl!, ctx.now()));
      } catch (e) {
        gsc = `Search Console: ошибка (${errMsg(e).slice(0, 120)})`;
      }
    }

    const seen = new Map((ctx.db.prepare('SELECT key, proposed_at FROM seo_seen').all() as { key: string; proposed_at: number }[]).map((r) => [r.key, r.proposed_at]));
    const fresh = findings
      .filter((f) => ctx.now() - (seen.get(f.key) ?? 0) >= REPEAT_DAYS * DAY)
      .sort((a, b) => b.severity - a.severity || (a.key < b.key ? -1 : 1))
      .slice(0, MAX_PROPOSALS);
    const mark = ctx.db.prepare('INSERT INTO seo_seen (key, proposed_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET proposed_at = excluded.proposed_at');
    for (const f of fresh) {
      const payload: SeoProposalPayload = { key: f.key, page: f.page, title: f.problem, change: f.change, needsBuilder: f.needsBuilder };
      await ctx.requestApproval(KIND, payload, `SEO${f.needsBuilder ? ' (нужен строитель)' : ''}: ${f.problem}.\nИзменение: ${f.change}\nСтраница: ${f.page}`);
      mark.run(f.key, ctx.now());
    }
    ctx.log('seo_checked', `${facts.length} pages, ${findings.length} findings, ${fresh.length} proposed`);
    const lines = fresh.map((f, i) => `${i + 1}. [${f.severity}] ${f.problem}. ${f.change}`);
    const result = [
      `SEO-проверка ${this.site}: страниц ${facts.length} (${note}), замечаний ${findings.length}, предложено ${fresh.length}.`,
      lines.length ? lines.join('\n') : 'Новых предложений нет (прежние замечания уже предлагались за последние 4 недели или их нет).',
      failed.length ? `Не открылись: ${failed.join('; ')}` : '',
      gsc,
    ].filter(Boolean).join('\n');
    return { ok: true, result };
  }
}
