import { errMsg, log, migrate, type Tools } from '@fir/core';
import { toolsOf, type Task, type Worker, type WorkerCtx, type WorkerResult } from '@fir/hq';
import { checkLlms, checkPage, checkServices, pageFacts, type Finding, type PageFacts } from './checks.js';
import { gscText } from './gsc.js';
import { AUDIT_KIND, auditText, collectFacts, composeFindings, defaultNet, hostOfUrl, type AuditLocale, type AuditPayload } from './audit.js';

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
  /** The free audit's network only (tests, an egress proxy); the site check goes through `ctx.tools`, Search Console through `tools.google.searchConsole`. */
  fetch?: FetchFn;
  /** Resolver of the public-address guard for `audit` (tests); with an injected `fetch` and no resolver the guard is off. */
  auditLookup?: (host: string) => Promise<string[]>;
}

export type SeoProposalPayload = { key: string; page: string; title: string; change: string; needsBuilder: boolean };

const UA = { 'user-agent': 'FirTechSeoCheck/1.0 (+https://firtech.pro)' };

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
  private readonly site: string;

  constructor(private readonly opts: SeoOptions = {}) {
    this.site = (opts.siteUrl ?? 'https://firtech.pro').replace(/\/$/, '');
  }

  /** Our own site only: the check never leaves this host (redirects included). */
  private get hosts(): string[] {
    return [new URL(this.site).hostname];
  }

  private async pages(tools: Tools): Promise<{ urls: string[]; note: string }> {
    const res = await tools.web.getText(`${this.site}/sitemap.xml`, { hosts: this.hosts, headers: UA, timeoutMs: 10_000 });
    if (res.ok) {
      const urls = sitemapUrls(res.value.text, new URL(this.site).host);
      if (urls.length > 0) return { urls, note: `sitemap: ${urls.length} страниц` };
    }
    return { urls: FALLBACK_PATHS.map((p) => `${this.site}${p}`), note: 'sitemap нет, проверены /, /ru, /en' };
  }

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    if (task.meta.action === 'audit') return this.audit(task, ctx);
    if (task.meta.action !== 'seo') return { ok: false, result: '', error: `Неизвестное действие: ${String(task.meta.action)}` };
    try {
      return await this.check(ctx);
    } catch (e) {
      log('error', 'seo check failed', { err: errMsg(e) });
      return { ok: false, result: '', error: errMsg(e) };
    }
  }

  /**
   * Action `audit`: the free 24-hour audit of a visitor's page. Page facts (title, description, h1, canonical, OG, speed,
   * viewport, Telegram/WhatsApp button, form, Instagram link) go to the LLM as booleans, never as HTML; the result is five
   * findings with one fix each and a closing line, proposed as approval kind `audit` (level 0). An unreachable site still
   * gets findings about that fact.
   */
  private async audit(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    const url = typeof task.meta.url === 'string' ? task.meta.url : '';
    const auditId = Number(task.meta.auditId);
    const locale: AuditLocale = task.meta.locale === 'en' ? 'en' : 'ru';
    if (!url || !Number.isInteger(auditId)) return { ok: false, result: '', error: 'audit: no url or audit id' };
    const host = hostOfUrl(url);
    // response time is real wall-clock time, not the (possibly frozen) company clock
    const facts = await collectFacts(url, { ...defaultNet(this.opts.fetch, this.opts.auditLookup), now: Date.now });
    const found = await composeFindings(ctx.llm, facts, locale);
    const text = auditText(host, found, locale);
    const payload: AuditPayload = { auditId, host, locale, text };
    const contact = typeof task.meta.contact === 'string' ? task.meta.contact : '';
    await ctx.requestApproval(AUDIT_KIND, payload as unknown as Record<string, unknown>, `Аудит ${host}${contact ? ` для ${contact}` : ''} (${locale}):\n\n${text}`);
    ctx.log('audit_composed', `${host}, reachable ${facts.reachable}`);
    return { ok: true, result: `Аудит ${host}: ${facts.reachable ? 'сайт открылся' : `сайт не открылся (${facts.reason ?? '?'})`}, пять находок на одобрение.` };
  }

  private async check(ctx: WorkerCtx): Promise<WorkerResult> {
    migrate(ctx.db, SCHEMA);
    const tools = toolsOf(ctx, 'marketing', this.id);
    const { urls, note } = await this.pages(tools);
    const facts: PageFacts[] = [];
    const findings: Finding[] = [];
    const failed: string[] = [];
    for (const url of urls) {
      try {
        const res = await tools.web.getText(url, { hosts: this.hosts, headers: UA, timeoutMs: 10_000 });
        if (!res.ok) {
          failed.push(`${url}: ${res.status ? `HTTP ${res.status}` : res.error}`);
          if (res.status) findings.push({ key: `page_down:${new URL(url).pathname}`, severity: 3, page: url, problem: `страница отдаёт HTTP ${res.status}`, change: `Починить ${url}: вернуть 200 или убрать из sitemap.`, needsBuilder: true });
          continue;
        }
        const f = pageFacts(url, res.value.text);
        facts.push(f);
        findings.push(...checkPage(f, { home: isHome(url) }));
      } catch (e) {
        failed.push(`${url}: ${errMsg(e)}`);
      }
    }
    if (facts.length === 0) return { ok: false, result: '', error: `Сайт не отдал ни одной страницы. ${failed.join('; ')}` };

    let llms: { status: number; text: string; lastModified: string | null } | null = null;
    const lr = await tools.web.getText(`${this.site}/llms.txt`, { hosts: this.hosts, headers: UA, timeoutMs: 10_000 });
    if (lr.ok) llms = { status: lr.value.status, text: lr.value.text, lastModified: lr.value.lastModified };
    else if (lr.status) llms = { status: lr.status, text: '', lastModified: null }; // a transport failure counts as missing
    findings.push(...checkLlms(llms, this.site, ctx.now()));
    findings.push(...checkServices([...facts.map((f) => f.text), llms?.text ?? ''].join(' ')));

    let gsc = '';
    if (tools.configured('google.searchConsole')) {
      const r = await tools.google.searchConsole();
      gsc = r.ok ? gscText(r.value) : `Search Console: ошибка (${r.message.slice(0, 120)})`;
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
