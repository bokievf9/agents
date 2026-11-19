import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, escapeHtml, log, tryJson, zonedParts, type ApprovalQueue, type Button, type LlmClient, type Messenger } from '@fir/core';
import { meterLlm, type Agent, type Hq, type Task, type Worker, type WorkerCtx, type WorkerResult } from '@fir/hq';
import {
  ARTICLE_KIND, KIND, ContentMakerWorker, TYPE_RU, dayLabel, articleSchema, articleTargetPath, builderInstruction, editableParts, nicheById, partLabel, replacePart,
  findNiche, splitPlatforms, storeFor, titleOf, ymd, RenderQueue, parseReel, shortReason, type RenderJob,
  type PartId,
} from '@fir/worker-content-maker';
import { AnalystWorker } from '@fir/worker-analyst';
import { PublisherWorker, dayHeader, imagesOf, publishedButtons, renderItemMessage, publishDay, videoCaption, videoOf } from '@fir/worker-publisher';
import { AUDIT_KIND, KIND as SEO_KIND, SeoWorker, type AuditPayload, type SeoProposalPayload } from '@fir/worker-seo';
import { TrendScoutWorker, latestTrendHints } from '@fir/worker-trend-scout';
import { z } from 'zod';
import { AuditStore, type AuditInput } from '../audit-shared.js';
import { ClientBlockedError, type ClientChannel } from '../client/channel.js';
import type { ApprovalEditor } from '../editor.js';
import type { LostLeads } from '../lost-leads.js';
import type { Reporter } from '../reporter.js';

export const MARKETING = 'marketing';
/**
 * The weekly pack as ONE card (owner decision 2026-11-19): it lists every item, «Одобрить пакет» approves them all, «Посмотреть по одному»
 * opens the per-item cards, «Отклонить пакет» rejects them all. Content is not money: the pack and the items are ordinary
 * (included in «Одобрить все обычные»), only never promoted to level 1 by the counter.
 */
export const PACK_KIND = 'content_pack';
export const HEAD_ID = 'marketing-head';
const WORKER_ID = 'content-maker';

export interface MarketingDeps {
  hq: Hq;
  llm: LlmClient;
  queue: ApprovalQueue;
  messenger: Messenger;
  ownerId: number;
  reporter: Reporter;
  /** Default: the content-maker. Tests pass their own. */
  worker?: Worker;
  /** Optional workers (tests pass their own); the defaults are built from `integrations`. */
  trendScout?: Worker;
  publisher?: PublisherWorker;
  seo?: Worker;
  analyst?: Worker;
  integrations?: Integrations;
  clipsPerWeek?: number;
  carouselsPerWeek?: number;
  postsPerWeek?: number;
  storiesPerWeek?: number;
  /** Where approved posts, slides and stories are rendered to PNG (`DATA_DIR/renders`). Absent: no pictures, text only. */
  rendersDir?: string;
  /**
   * Reels are rendered by the `renderer` service: an approved reel is queued in `cm_render_jobs` (instead of a builder
   * task) and the morning message sends `DATA_DIR/renders/<item>/reel.mp4`. Default off (tests, local runs without it).
   */
  renderReels?: boolean;
  rng?: () => number;
  /** An audit request that cannot be prepared is written down as a lost request (kind `lost_lead`) and summed up in the hourly alert. */
  lost?: LostLeads;
  /** The client bot: an approved audit goes to the contact when that person already wrote to it (matched by username or chat id). */
  audit?: ClientChannel & { findChat(username: string): number | undefined };
}

/** Optional external sources (all keys optional: a source without its key is simply off). */
export interface Integrations {
  youtubeApiKey?: string | undefined;
  youtubeChannelId?: string | undefined;
  trendsRegions?: string[];
  gscServiceAccountJson?: string | undefined;
  gscSiteUrl?: string | undefined;
  siteUrl?: string | undefined;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

const splitSchema = z.object({
  action: z.enum(['pack', 'topic', 'daily', 'trends', 'trends_weekly', 'seo', 'report', 'profile', 'article', 'none']),
  topic: z.string().max(300).optional(),
  type: z.enum(['clip', 'carousel', 'post', 'story']).optional(),
});
/** Telegram bots upload videos up to 50 MB. */
const MAX_VIDEO_BYTES = 49 * 1024 * 1024;
const reviewSchema = z.object({ ok: z.boolean(), issues: z.array(z.string()).max(10).default([]) });

/** The pack's card: one decision for all, or the items one by one. `ap:` buttons keep the core's approve and reject; `pk:` ones are the app's own. */
export function packButtons(id: number, previews: number): Button[][] {
  return [
    [{ text: '✅ Одобрить пакет', data: `ap:${id}:a` }, { text: '👁 Посмотреть по одному', data: `pk:${id}:o` }],
    [{ text: '❌ Отклонить пакет', data: `ap:${id}:r` }, ...(previews > 0 ? [{ text: '🖼 Превью', data: `pk:${id}:v` }] : [])],
  ];
}

/** An audit not delivered this long after the request raises an alert (the promise is «в течение рабочего дня»). */
export const AUDIT_ALERT_AFTER_MS = 20 * 3_600_000;
const auditHostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 60);
  }
};

type Action = 'pack' | 'topic' | 'daily' | 'trends' | 'trends_weekly' | 'seo' | 'report' | 'profile' | 'article' | 'audit' | 'none';
const DIRECT: Action[] = ['trends', 'trends_weekly', 'seo', 'report'];
const ACTIONS: Action[] = ['pack', 'topic', 'daily', 'profile', 'article', 'audit', ...DIRECT];

/** Heuristics for the case without an LLM: only the obvious wordings. */
function guessAction(task: Task): { action: Action; topic?: string } {
  const text = `${task.title} ${task.body}`.toLowerCase();
  if (/пакет|на неделю|pack/.test(text)) return { action: 'pack' };
  if (/что публикуем|публикуем сегодня/.test(text)) return { action: 'daily' };
  if (/тренд/.test(text)) return { action: /недел|итог/.test(text) ? 'trends_weekly' : 'trends' };
  if (/seo|сео/.test(text)) return { action: 'seo' };
  if (/отч[её]т|аналитик/.test(text)) return { action: 'report' };
  if (/оформлен\S* профил|настройк\S* профил|шапк/.test(text)) return { action: 'profile' };
  if (/(?<!\p{L})(?:стать[яюи]|в блог|блог сайта)(?!\p{L})/u.test(text)) return { action: 'article', topic: task.body.trim() || '' };
  if (/клип|ролик|карусел|рилс|reels|shorts|пост|истори|stories/.test(text)) return { action: 'topic', topic: task.body.trim() || task.title };
  return { action: 'none' };
}

/**
 * Head of the Marketing department. One heartbeat cycle: take the department's tasks from the inbox, split them
 * for the worker, run it, review the result against the department checklist (LLM, strict JSON), send it back
 * once for rework, then to approval or done, and report. Proposals go to the Director's batch, never straight
 * to the owner. The head owns the worker's approval kind and the part-by-part editing of items.
 */
export class MarketingHead implements ApprovalEditor {
  readonly worker: Worker;
  readonly trendScout: Worker;
  readonly publisher: PublisherWorker;
  readonly seo: Worker;
  readonly analyst: Worker;
  /** Video render jobs (shared SQLite, the `renderer` service claims them). */
  readonly renderQueue: RenderQueue;

  constructor(private readonly d: MarketingDeps) {
    const i = d.integrations ?? {};
    const net = i.fetch ? { fetch: i.fetch } : {};
    this.trendScout = d.trendScout ?? new TrendScoutWorker({ youtubeApiKey: i.youtubeApiKey, regions: i.trendsRegions ?? ['KZ', 'UZ', 'RU'], ...net });
    this.renderQueue = new RenderQueue(d.hq.db, d.hq.now);
    this.publisher = d.publisher ?? new PublisherWorker({ render: (itemId) => this.renderedClip(itemId), renderNote: (itemId) => this.reelNote(itemId) });
    this.seo = d.seo ?? new SeoWorker({ ...(i.siteUrl ? { siteUrl: i.siteUrl } : {}), gscServiceAccountJson: i.gscServiceAccountJson, gscSiteUrl: i.gscSiteUrl, ...net });
    this.analyst = d.analyst ?? new AnalystWorker({ youtubeApiKey: i.youtubeApiKey, youtubeChannelId: i.youtubeChannelId, ...net });
    this.worker =
      d.worker ??
      new ContentMakerWorker({
        trends: (ctx) => latestTrendHints(ctx, d.hq.tz),
        ...(d.clipsPerWeek !== undefined ? { clipsPerWeek: d.clipsPerWeek } : {}),
        ...(d.carouselsPerWeek !== undefined ? { carouselsPerWeek: d.carouselsPerWeek } : {}),
        ...(d.postsPerWeek !== undefined ? { postsPerWeek: d.postsPerWeek } : {}),
        ...(d.storiesPerWeek !== undefined ? { storiesPerWeek: d.storiesPerWeek } : {}),
        ...(d.rendersDir ? { rendersDir: d.rendersDir } : {}),
        ...(d.rng ? { rng: d.rng } : {}),
      });
    if (this.worker instanceof ContentMakerWorker) {
      const spec = this.worker.kindSpec({ db: d.hq.db, now: d.hq.now }, (id) => d.queue.get(id)?.edited ?? false);
      const approve = spec.execute;
      d.hq.registerKind(KIND, {
        ...spec,
        execute: async (payload, approvalId) => {
          await approve(payload, approvalId);
          try {
            if (d.renderReels) this.queueReel(Number(payload.itemId));
            else this.requestClipBuild(Number(payload.itemId), d.hq.approvalByCoreId(approvalId)?.taskId ?? null);
          } catch (e) {
            log('error', 'clip build task not created', { err: errMsg(e) });
          }
        },
      });
    }
    // The pack's card: approving it approves every held item, «Посмотреть по одному» sends the items' own cards instead.
    d.hq.registerKind(PACK_KIND, {
      initialLevel: 0, keepManual: true, bulk: true,
      buttons: (id, payload) => packButtons(id, Number(payload.previews ?? 0)),
      execute: (payload, approvalId) => this.decidePack(payload, approvalId),
    });
    // An approved article becomes a `builder` task whose issue carries the article JSON and the target file path.
    d.hq.registerKind(ARTICLE_KIND, {
      initialLevel: 0, locked: true,
      execute: (payload, approvalId) => {
        this.requestArticleBuild(Number(payload.articleId), d.hq.approvalByCoreId(approvalId)?.taskId ?? null);
        return Promise.resolve();
      },
    });
    // An approved SEO proposal becomes a task: tagged `builder` when the site's code has to change.
    d.hq.registerKind(SEO_KIND, {
      initialLevel: 0, locked: true,
      execute: (payload) => {
        const p = payload as unknown as SeoProposalPayload;
        const t = d.hq.createTask({ title: `SEO: ${p.title}`.slice(0, 200), body: `${p.change}\nСтраница: ${p.page}`, dept: MARKETING, creator: 'head', meta: { action: 'seo_fix', key: p.key } });
        d.hq.block(t.id, HEAD_ID, p.needsBuilder ? 'Нужна правка кода сайта: ждёт строителя' : 'Нужна правка текста: делает владелец или Контент-мейкер', p.needsBuilder ? ['builder'] : []);
        return Promise.resolve();
      },
    });
    // An approved audit text goes to its contact; without a known chat the owner gets plain text to send by hand.
    d.hq.registerKind(AUDIT_KIND, {
      initialLevel: 0, locked: true,
      execute: (payload) => this.deliverAudit(payload as unknown as AuditPayload),
    }, { urgent: true }); // a visitor is waiting: the card goes out at once, not with the 10:00 batch
    // The owner rejected an item: the worker's own table follows.
    d.hq.onApprovalDecision((link, state) => {
      if (link.kind === PACK_KIND && (state === 'rejected' || state === 'failed')) this.packDeclined(link.payload, link.approvalId, state);
      if (link.kind === AUDIT_KIND && state === 'rejected') this.audits().setStatus(Number(link.payload.auditId), 'rejected');
      if (link.kind === KIND && state === 'rejected') storeFor({ db: d.hq.db, now: d.hq.now }).setStatus(Number(link.payload.itemId), 'rejected');
      if (link.kind === ARTICLE_KIND && state === 'rejected') {
        const store = storeFor({ db: d.hq.db, now: d.hq.now });
        // a rework (the owner sent it back with a remark) keeps the row alive: only a plain rejection closes it
        if (store.article(Number(link.payload.articleId))?.status === 'proposed') store.setArticle(Number(link.payload.articleId), { status: 'rejected' });
      }
    });
  }

  private get hq(): Hq {
    return this.d.hq;
  }

  private audits(): AuditStore {
    return new AuditStore(this.hq.db, this.hq.now);
  }

  /**
   * A free audit asked for (`POST /audit`, the client bot's `/audit`): a row in `mk_audits` and a Marketing task
   * `action: audit` the head picks up. Returns both ids.
   */
  requestAudit(a: AuditInput & { chatId?: number }): { id: number; taskId: number } {
    const id = this.audits().add(a);
    let host = 'site';
    try {
      host = new URL(a.url).hostname;
    } catch {
      /* the URL was validated before */
    }
    const t = this.hq.createTask({
      title: `Аудит: ${host}`.slice(0, 200), body: 'Бесплатный аудит сайта в течение рабочего дня: пять находок и одно закрывающее предложение.', dept: MARKETING, creator: 'head',
      meta: { action: 'audit', auditId: id, url: a.url, contact: a.contact, locale: a.locale },
    });
    this.hq.wake(HEAD_ID, 'task');
    return { id, taskId: t.id };
  }

  /**
   * The audit is promised «в течение рабочего дня»: 20 hours after /audit or the form, an audit that is still not
   * delivered (not approved, failed, stuck) becomes one alert to the owner. Once per audit.
   */
  async auditWatch(): Promise<number> {
    let n = 0;
    for (const a of this.audits().undelivered(AUDIT_ALERT_AFTER_MS)) {
      const key = `audit_alerted_${a.id}`;
      if (this.hq.setting(key)) continue;
      this.hq.setSetting(key, String(this.hq.now()));
      const hours = Math.floor((this.hq.now() - a.created) / 3_600_000);
      await this.hq.alert(`Аудит #${a.id} (${auditHostOf(a.url)}, ${a.contact}) не отправлен уже ${hours} ч, статус «${a.status}». Посетителю обещан ответ в течение рабочего дня: проверьте карточку одобрения или задачу.`);
      n++;
    }
    return n;
  }

  private async deliverAudit(p: AuditPayload): Promise<void> {
    const store = this.audits();
    const row = store.get(p.auditId);
    if (!row) return;
    const chatId = row.chatId ?? (row.contact.startsWith('@') ? this.d.audit?.findChat(row.contact) : undefined);
    if (chatId !== undefined && this.d.audit) {
      try {
        await this.d.audit.send(chatId, p.text);
        store.setStatus(p.auditId, 'delivered');
        return;
      } catch (e) {
        log('warn', 'audit delivery failed', { auditId: p.auditId, blocked: e instanceof ClientBlockedError });
      }
    }
    store.setStatus(p.auditId, 'handed_off');
    await this.d.messenger.send(
      this.d.ownerId,
      `Аудит ${p.host} утверждён. ${row.contact.startsWith('@') ? `${row.contact} ещё не писал в @firtech_bot` : `Контакт ${row.contact} не в боте`}, поэтому отправьте вручную. Текст ниже, его можно скопировать целиком.\n\n${p.text}`,
    );
  }

  /**
   * An approved clip script becomes a blocked `builder` task «Собрать клип»; the builder bridge turns it into an
   * issue. Once per item. The script, subtitles, CTA and captions travel in `meta`.
   */
  private requestClipBuild(itemId: number, parentId: number | null): Task | null {
    const item = storeFor({ db: this.hq.db, now: this.hq.now }).item(itemId);
    if (!item || item.type !== 'clip') return null;
    if (this.hq.tasks({ dept: MARKETING, open: true, limit: 500 }).some((t) => t.meta.action === 'build_clip' && t.meta.itemId === itemId)) return null;
    const { body, sections } = splitPlatforms(item.text);
    const subtitles = [...body.matchAll(/^\s+Субтитр: (.+)$/gm)].map((m) => m[1]!.trim());
    const cta = /^CTA: (.+)$/m.exec(body)?.[1]?.trim() ?? '';
    const title = item.title || titleOf(item.text);
    const t = this.hq.createTask({
      title: `Собрать клип: ${title}`.slice(0, 200),
      body: `Собрать готовый клип по одобренному сценарию. Материал #${itemId}, плановая дата публикации ${item.plannedDate}.`,
      dept: MARKETING, creator: 'head', ...(parentId ? { parentId } : {}),
      meta: {
        action: 'build_clip', itemId, script: body, subtitles, cta, captions: sections,
        target: '9:16, 20-40 с, mp4 h264, субтитры вшиты в кадр, синтезированный русский голос',
      },
    });
    this.hq.block(t.id, HEAD_ID, 'Нужен строитель: собрать клип (Remotion)', ['builder']);
    return t;
  }

  /**
   * An approved article becomes a blocked `builder` task «Статья в блог»; the builder bridge turns it into an issue with
   * the article JSON in a fenced block, the target file path and the instruction. Once per article.
   */
  private requestArticleBuild(articleId: number, parentId: number | null): Task | null {
    const store = this.store();
    const row = store.article(articleId);
    if (!row || row.taskId) return null;
    const article = articleSchema.parse(JSON.parse(row.json));
    const t = this.hq.createTask({
      title: `Статья в блог: ${article.ru.title}`.slice(0, 200),
      body: `Добавить одобренную владельцем статью (ниша «${nicheById(article.niche)?.name ?? article.niche}») в блог сайта firtech.pro.`,
      dept: MARKETING, creator: 'head', ...(parentId ? { parentId } : {}),
      meta: {
        action: 'publish_article', articleId, articleJson: JSON.stringify(article, null, 2), targetPath: articleTargetPath(article.slug),
        instruction: builderInstruction(article, this.today()),
      },
    });
    this.hq.block(t.id, HEAD_ID, 'Нужен строитель: добавить статью в блог сайта', ['builder']);
    store.setArticle(articleId, { status: 'approved', taskId: t.id });
    return t;
  }

  /** Copies the issue number of an article's builder task into `cm_articles` once the bridge has made the issue. */
  syncArticles(): void {
    const store = this.store();
    for (const a of store.articles().filter((x) => x.status === 'approved' && x.taskId && !x.issueNumber)) {
      const issue = this.hq.task(a.taskId!)?.meta.issue as { number?: number } | undefined;
      if (typeof issue?.number === 'number') store.setArticle(a.id, { issueNumber: issue.number });
    }
  }

  /** Queues the video of an approved reel for the renderer (once: an active job is kept). */
  private queueReel(itemId: number): RenderJob | null {
    const item = this.store().item(itemId);
    if (!item || item.type !== 'clip') return null;
    if (!parseReel(item.text)) {
      log('warn', 'reel not queued: script unreadable', { item: itemId });
      return null;
    }
    const job = this.renderQueue.enqueue(itemId);
    this.hq.log(HEAD_ID, 'render_queued', 'content_item', String(itemId));
    return job;
  }

  private reelPath(itemId: number): string | null {
    if (!this.d.renderReels || !this.d.rendersDir) return null;
    const file = join(this.d.rendersDir, String(itemId), 'reel.mp4');
    return existsSync(file) ? file : null;
  }

  /** Why a reel has no video yet, for the morning message. Null when renders are off (the old text stays). */
  private reelNote(itemId: number): string | null {
    if (!this.d.renderReels) return null;
    const job = this.renderQueue.latest(itemId);
    if (!job) return 'видео не собралось: задача не создана, поставлю в очередь';
    if (job.status === 'failed' || (job.status === 'queued' && job.error)) return `видео не собралось: ${shortReason(job.error)}`;
    if (job.status === 'done') return 'видео не собралось: файл не найден на сервере';
    return 'видео ещё собирается, пришлю в следующем напоминании';
  }

  /** After the morning message: a reel without a video and without an active job is queued again (new job, attempts from 0). */
  private retryReels(groups: { itemId: number; type: string }[][]): number {
    if (!this.d.renderReels) return 0;
    let n = 0;
    for (const g of groups) {
      const itemId = g[0]!.itemId;
      if (g[0]!.type !== 'clip' || this.reelPath(itemId)) continue;
      const job = this.renderQueue.latest(itemId);
      if (job && (job.status === 'queued' || job.status === 'running')) continue;
      if (this.queueReel(itemId)) n++;
    }
    return n;
  }

  /** The rendered file of a clip: the renderer's `reel.mp4`, else the builder's result path or URL once its task reached review. */
  private renderedClip(itemId: number): string | null {
    const own = this.reelPath(itemId);
    if (own) return own;
    const t = this.hq.tasks({ dept: MARKETING, status: ['review', 'done'], limit: 500 }).find((x) => x.meta.action === 'build_clip' && x.meta.itemId === itemId && typeof x.meta.result === 'string' && x.meta.result);
    return t ? (t.meta.result as string) : null;
  }

  private agent(): Agent {
    return this.hq.agent(HEAD_ID)!;
  }

  private llmFor(agentId: string, taskId: number | null): LlmClient {
    return meterLlm(this.d.llm, this.hq, { agentId, taskId });
  }

  private today(): string {
    const p = zonedParts(this.hq.now(), this.hq.tz);
    return ymd(Date.UTC(p.y, p.mo - 1, p.d));
  }

  /** Report: always into the task journal (the morning summary reads it), plus the department topic when configured. */
  private async report(taskId: number, text: string): Promise<void> {
    this.hq.addEvent(taskId, 'report', HEAD_ID, text);
    await this.d.reporter.post(MARKETING, text);
  }

  // ---- heartbeat ----
  async onHeartbeat(): Promise<void> {
    if (this.agent().status !== 'active') return;
    for (const t of [...this.hq.tasks({ dept: MARKETING, status: 'inbox' }), ...this.hq.tasks({ dept: MARKETING, status: 'assigned', assigneeId: HEAD_ID })]) {
      await this.handle(t).catch((e) => this.crash(t, e));
    }
    for (const t of this.hq.tasks({ dept: MARKETING, status: 'assigned', assigneeId: WORKER_ID })) {
      await this.runChild(t).catch((e) => this.crash(t, e));
    }
    await this.finalizeParents();
    this.syncArticles();
  }

  private async crash(task: Task, e: unknown): Promise<void> {
    log('error', 'marketing task crashed', { task: task.id, err: errMsg(e) });
    const cur = this.hq.task(task.id);
    if (cur && cur.status !== 'blocked' && cur.status !== 'done' && cur.status !== 'rejected') this.hq.block(task.id, HEAD_ID, `Сбой: ${errMsg(e)}`.slice(0, 300));
    if (!task.parentId) await this.hq.alert(`Маркетинг: задача #${task.id} заблокирована (сбой), подробности в журнале задачи.`);
  }

  private async decide(task: Task): Promise<{ action: Action; topic?: string; type?: 'clip' | 'carousel' | 'post' | 'story' }> {
    const metaAction = task.meta.action;
    if (typeof metaAction === 'string' && ACTIONS.includes(metaAction as Action)) {
      return { action: metaAction as Action, ...(typeof task.meta.topic === 'string' ? { topic: task.meta.topic } : {}) };
    }
    const res = await tryJson(
      this.llmFor(HEAD_ID, task.id),
      {
        tier: 'haiku', maxTokens: 400,
        system: `${this.agent().instructions}\n\nОпредели, что нужно сделать исполнителю по задаче. Ответ: только JSON {"action": "pack"|"topic"|"daily"|"trends"|"trends_weekly"|"seo"|"report"|"profile"|"article"|"none", "topic": "тема материала или ниша статьи", "type": "clip"|"carousel"|"post"|"story"}. pack: пакет недели; topic: один материал на тему (рилс, карусель, пост или история); daily: что публикуем сегодня; trends: хуки и форматы дня; trends_weekly: тренды недели; seo: проверка сайта; report: недельный отчёт; profile: оформление профиля Instagram; article: статья в блог сайта; none: задача не для отдела маркетинга.`,
        messages: [{ role: 'user', content: `Задача: ${task.title}\n${task.body}`.slice(0, 2000) }],
      },
      splitSchema,
    );
    if (res) return { action: res.action, ...(res.topic ? { topic: res.topic } : {}), ...(res.type ? { type: res.type } : {}) };
    return guessAction(task);
  }

  // ---- taking and splitting a task ----
  private async handle(task: Task): Promise<void> {
    if (!this.hq.claim(task.id, HEAD_ID)) return;
    if (this.hq.overBudget(MARKETING)) return void this.hq.block(task.id, HEAD_ID, 'Лимит расходов отдела исчерпан');
    const { action, topic, type } = await this.decide(task);
    if (action === 'none') {
      this.hq.block(task.id, HEAD_ID, 'Нет подходящего исполнителя в отделе маркетинга');
      await this.report(task.id, `Задача #${task.id} «${task.title}» не для маркетинга: нет исполнителя. Нужен строитель или другой отдел?`);
      return;
    }
    if (action === 'daily') return this.daily(task);
    if (action === 'audit') {
      this.hq.setMeta(task.id, { action: 'audit' });
      await this.runDirect(task.id, this.seo);
      const auditId = Number(this.hq.task(task.id)?.meta.auditId);
      const failed = this.hq.task(task.id)?.status === 'blocked';
      if (Number.isInteger(auditId)) this.audits().setStatus(auditId, failed ? 'failed' : 'proposed');
      if (failed && Number.isInteger(auditId)) {
        const a = this.audits().get(auditId);
        this.d.lost?.record('audit', 'аудит сайта не подготовлен (сайт не открылся или сбой)', { ...(a ? { contact: a.contact } : {}), ref: `аудит #${auditId}` });
      }
      return;
    }
    if (DIRECT.includes(action)) {
      this.hq.setMeta(task.id, { action });
      const worker = { trends: this.trendScout, trends_weekly: this.trendScout, seo: this.seo, report: this.analyst }[action as 'trends']!;
      return this.runDirect(task.id, worker);
    }
    if (action === 'topic') {
      this.hq.setMeta(task.id, { action: 'topic', topic: topic ?? (task.body.trim() || task.title), ...(type ? { type } : {}) });
      await this.runWorkerTask(task.id, HEAD_ID);
      return;
    }
    if (action === 'profile') {
      this.hq.setMeta(task.id, { action: 'profile' });
      await this.runWorkerTask(task.id, HEAD_ID);
      return;
    }
    if (action === 'article') {
      this.hq.setMeta(task.id, { action: 'article', ...(topic ? { niche: topic } : {}) });
      // no checklist review here: the article is checked by its own schema and the owner's card, and a second run would take another niche
      return this.runDirect(task.id, this.worker);
    }
    // pack: the worker splits it into items, each item is a subtask of the content-maker
    this.hq.setMeta(task.id, { action: 'pack' });
    const specs = await this.worker.plan!(this.hq.task(task.id)!, this.ctx(this.hq.task(task.id)!, [], WORKER_ID));
    if (!specs || specs.length === 0) {
      this.hq.complete(task.id, HEAD_ID, 'Пакет на эту неделю уже есть, новый не создаю.');
      return void (await this.report(task.id, 'Пакет недели уже создан раньше, повторно не делаю.'));
    }
    for (const s of specs) {
      this.hq.createTask({ title: s.title, body: s.body ?? '', dept: MARKETING, assigneeId: WORKER_ID, creator: 'head', parentId: task.id, priority: task.priority, meta: s.meta });
    }
    this.hq.comment(task.id, HEAD_ID, `Разбито на ${specs.length} подзадач для Контент-мейкера`);
    for (const child of this.hq.tasks({ parentId: task.id, status: 'assigned' })) await this.runChild(child).catch((e) => this.crash(child, e));
    await this.finalizeParents();
  }

  private async runChild(child: Task): Promise<void> {
    if (!this.hq.claim(child.id, WORKER_ID)) return;
    if (this.hq.overBudget(MARKETING)) return void this.hq.block(child.id, HEAD_ID, 'Лимит расходов отдела исчерпан');
    await this.runWorkerTask(child.id, WORKER_ID);
  }

  // ---- the weekly pack's card ----
  /** Item tasks of a pack (the pack parent's subtasks that carry a held proposal). */
  private heldOf(payload: Record<string, unknown>) {
    const ids = Array.isArray(payload.itemTaskIds) ? payload.itemTaskIds.filter((x): x is number => typeof x === 'number') : [];
    return this.hq.heldApprovals(ids);
  }

  /**
   * «Одобрить пакет» (or the pack inside «Одобрить все обычные»): every held item gets its approval row without a card and is
   * approved one by one through the queue, so renders, trust counters and the journal are as for a button press. In `split` mode
   * («Посмотреть по одному») the items go out as their own cards instead.
   */
  private async decidePack(payload: Record<string, unknown>, approvalId: number): Promise<void> {
    const held = this.heldOf(payload);
    if (this.hq.setting(`pack_split:${approvalId}`) === '1') {
      await this.hq.releaseHeld(held.map((l) => l.id));
      return;
    }
    for (const l of held) {
      const id = this.hq.openHeld(l.id);
      if (id === null) continue;
      await this.d.queue.handle('approve', id, this.d.ownerId);
    }
    this.hq.reconcileApprovals();
  }

  /** The pack was rejected (every held item is rejected with it) or its execution failed (the items go out as their own cards). */
  private packDeclined(payload: Record<string, unknown>, approvalId: number | null, state: 'rejected' | 'failed' | string): void {
    const held = this.heldOf(payload);
    if (approvalId !== null && this.hq.setting(`pack_split:${approvalId}`) === '1') return;
    if (state === 'failed') void this.hq.releaseHeld(held.map((l) => l.id));
    else for (const l of held) this.hq.rejectHeld(l.id);
  }

  /** Buttons of the pack's card: `pk:<id>:o` opens the items one by one, `pk:<id>:v` sends the previews that exist. */
  async onPackButton(op: 'o' | 'v', approvalId: number, at: { chatId: number; messageId: number }): Promise<string> {
    const row = this.d.queue.get(approvalId);
    if (!row || row.kind !== PACK_KIND || row.status !== 'pending') {
      await this.d.queue.settleCard(approvalId, at).catch(() => undefined);
      return 'Уже обработано';
    }
    if (op === 'v') {
      const files = this.packPreviewFiles(row.payload);
      if (!files.length || !this.d.messenger.sendPhotos) return 'Превью пока нет: картинки собираются после одобрения';
      await this.d.messenger.sendPhotos(this.d.ownerId, files.slice(0, 10), 'Превью пакета недели');
      return 'Превью ниже';
    }
    const n = this.heldOf(row.payload).length;
    this.hq.setSetting(`pack_split:${approvalId}`, '1');
    await this.d.queue.handle('approve', approvalId, this.d.ownerId);
    this.hq.reconcileApprovals();
    await this.d.messenger.edit(at.chatId, at.messageId, `👁 <b>Пакет открыт по одному</b>\n${escapeHtml(`Карточек ниже: ${n}. Каждую можно одобрить, исправить или отклонить отдельно.`)}`, { html: true }).catch(() => undefined);
    return 'Карточки ниже';
  }

  /** The first PNG of every item of the pack that has pictures (they exist only for items rendered earlier, e.g. a regenerated pack). */
  private packPreviewFiles(payload: Record<string, unknown>): string[] {
    const ids = Array.isArray(payload.itemIds) ? payload.itemIds.filter((x): x is number => typeof x === 'number') : [];
    const out: string[] = [];
    for (const itemId of ids) {
      const first = this.store().rowsOfItem(itemId).flatMap((r) => r.files).find((f) => existsSync(f));
      if (first) out.push(first);
    }
    return out;
  }

  /**
   * The pack parent is ready: its items' queued proposals leave the batch and ONE card stands for them (type, topic and one line each).
   * Returns the card to request (null: fewer than two proposals, the batch handles them as before).
   */
  private planPack(parent: Task, kids: Task[]): { payload: Record<string, unknown>; summary: string; covered: number } | null {
    const kidIds = new Set(kids.map((k) => k.id));
    const links = this.hq.queuedApprovals().filter((l) => kidIds.has(l.taskId) && l.kind === KIND);
    if (links.length < 2) return null;
    const store = this.store();
    const rows = links.map((l) => ({ link: l, item: store.item(Number(l.payload.itemId)) })).filter((r): r is { link: typeof r.link; item: NonNullable<typeof r.item> } => Boolean(r.item));
    if (rows.length < 2) return null;
    const one = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
    const lines = rows.map((r, i) => {
      const pics = store.rowsOfItem(r.item.id).some((x) => x.files.length > 0) || (r.item.type === 'clip' && this.reelPath(r.item.id) !== null);
      return `${i + 1}. ${TYPE_RU[r.item.type]}, ${dayLabel(r.item.plannedDate)}: ${one((r.item.title || r.item.topicText).replace(/\s+/g, ' '), 80)}${pics ? ' 🖼' : ''}`;
    });
    const previews = this.packPreviewFiles({ itemIds: rows.map((r) => r.item.id) }).length;
    this.hq.holdApprovals(rows.map((r) => r.link.id));
    const summary = [
      `Пакет недели, материалов: ${rows.length} (задача #${parent.id}).`,
      '«Одобрить пакет»: все материалы сразу. «Посмотреть по одному»: карточки по отдельности, в них можно править и отклонять любой. «Отклонить пакет»: все материалы отклонены.',
      '',
      ...lines,
    ].join('\n');
    return { payload: { itemTaskIds: rows.map((r) => r.link.taskId), itemIds: rows.map((r) => r.item.id), previews }, summary, covered: rows.length };
  }

  /** Parents whose subtasks all left the work stages are done: the pack is prepared, the items wait for the owner. */
  private async finalizeParents(): Promise<void> {
    for (const p of this.hq.tasks({ dept: MARKETING, status: 'running', assigneeId: HEAD_ID })) {
      const kids = this.hq.tasks({ parentId: p.id });
      if (kids.length === 0 || kids.some((k) => ['inbox', 'assigned', 'running', 'review'].includes(k.status))) continue;
      const n = (s: string) => kids.filter((k) => k.status === s).length;
      const blocked = n('blocked');
      const text = `${p.title}: материалов ${kids.length}, на одобрение ${n('approval') + n('done')}${blocked ? `, не получилось ${blocked}` : ''}.`;
      // the pack becomes one card for the owner; the parent is done as before (an undecided card must not stop next week's routine)
      let pack: ReturnType<MarketingHead['planPack']> = null;
      try {
        pack = this.planPack(p, kids);
      } catch (e) {
        log('error', 'pack card failed, the items go with the batch', { err: errMsg(e) });
      }
      this.hq.complete(p.id, HEAD_ID, text);
      if (pack) await this.hq.requestApproval(p.id, HEAD_ID, PACK_KIND, pack.payload, pack.summary);
      await this.report(p.id, pack ? `${text} Придёт одной карточкой: пакет на ${pack.covered} материалов.` : text);
      if (blocked) await this.hq.alert(`Маркетинг: в задаче #${p.id} не получилось материалов: ${blocked}. Подробности: /tasks marketing.`);
    }
  }

  // ---- worker run, review, one rework, approval ----
  private ctx(task: Task, staged: { kind: string; payload: Record<string, unknown>; summary: string }[], actor: string): WorkerCtx {
    return {
      llm: this.llmFor(actor, task.id), db: this.hq.db, tz: this.hq.tz, now: this.hq.now,
      requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
      log: (action, detail) => this.hq.log(actor, action, 'task', String(task.id), detail),
    };
  }

  private async review(task: Task, result: string): Promise<{ ok: boolean; issues: string[]; skipped?: boolean }> {
    const res = await tryJson(
      this.llmFor(HEAD_ID, task.id),
      {
        tier: 'haiku', maxTokens: 600,
        system: `${this.agent().instructions}\n\nПроверь материал по чек-листу выше. Ответ: только JSON {"ok": true|false, "issues": ["что исправить, коротко"]}. ok true, если нарушений нет. Не придумывай замечаний, которых нет.`,
        messages: [{ role: 'user', content: `Задача: ${task.title}\n\nМатериал:\n${result}`.slice(0, 8000) }],
      },
      reviewSchema,
    );
    if (res) return res;
    // LLM off or garbage: the check did NOT run. It is logged as skipped (never as passed); the owner's approval is the safety net.
    this.hq.comment(task.id, HEAD_ID, 'Ревью по чек-листу пропущено: модель не дала разборчивого ответа.');
    this.hq.log(HEAD_ID, 'review_skipped', 'task', String(task.id));
    return { ok: true, issues: [], skipped: true };
  }

  private async runOnce(taskId: number, actor: string, staged: { kind: string; payload: Record<string, unknown>; summary: string }[], worker: Worker = this.worker): Promise<WorkerResult> {
    staged.length = 0;
    const t = this.hq.task(taskId)!;
    try {
      return await worker.run(t, this.ctx(t, staged, actor));
    } catch (e) {
      return { ok: false, result: '', error: errMsg(e) };
    }
  }

  private async runWorkerTask(taskId: number, actor: string): Promise<void> {
    const staged: { kind: string; payload: Record<string, unknown>; summary: string }[] = [];
    let res = await this.runOnce(taskId, actor, staged);
    const fail = async (error: string | undefined) => {
      this.hq.block(taskId, actor, error ?? 'исполнитель не вернул результат');
      if (!this.hq.task(taskId)!.parentId) await this.hq.alert(`Маркетинг: задача #${taskId} не выполнена: ${(error ?? '').slice(0, 200)}`);
    };
    if (!res.ok) return fail(res.error);
    this.hq.setStatus(taskId, 'review', HEAD_ID, 'проверка по чек-листу');
    let verdict = await this.review(this.hq.task(taskId)!, res.result);
    if (!verdict.ok) {
      this.hq.comment(taskId, HEAD_ID, `Ревью, замечания: ${verdict.issues.join('; ')}`);
      this.hq.setStatus(taskId, 'running', HEAD_ID, 'доработка');
      this.hq.setMeta(taskId, { feedback: verdict.issues.join('; ') });
      res = await this.runOnce(taskId, actor, staged);
      if (!res.ok) return fail(res.error);
      this.hq.setStatus(taskId, 'review', HEAD_ID, 'повторная проверка');
      verdict = await this.review(this.hq.task(taskId)!, res.result);
    }
    const warn = verdict.skipped ? '\nРевью по чек-листу пропущено (модель не ответила): проверьте текст сами.' : verdict.ok ? '' : `\nРевью отдела после доработки: ${verdict.issues.join('; ')}.`;
    this.hq.complete(taskId, actor, res.result, staged.length > 0 ? 'review' : 'done');
    for (const s of staged) await this.hq.requestApproval(taskId, actor, s.kind, s.payload, s.summary + warn);
    const t = this.hq.task(taskId)!;
    if (!t.parentId) await this.report(taskId, staged.length > 0 ? `Задача #${taskId} «${t.title}»: ${staged.length} на одобрение (придёт в пачке).` : `Задача #${taskId} «${t.title}» выполнена.`);
  }

  /** The journal feeds the morning summary on one line: drop source links and notes, cap the length. */
  private brief(text: string): string {
    return text.split('\n').filter((l) => !/^\s+Источник:|^Заметки:/.test(l)).join('\n').slice(0, 1100);
  }

  /** Non-content workers: run, no content checklist (their checks are built in), proposals go to the approval queue. */
  private async runDirect(taskId: number, worker: Worker): Promise<void> {
    const staged: { kind: string; payload: Record<string, unknown>; summary: string }[] = [];
    const res = await this.runOnce(taskId, worker.id, staged, worker);
    if (!res.ok) {
      this.hq.block(taskId, worker.id, res.error ?? 'исполнитель не вернул результат');
      return void (await this.hq.alert(`Маркетинг: задача #${taskId} (${worker.id}) не выполнена: ${(res.error ?? '').slice(0, 200)}`));
    }
    this.hq.complete(taskId, worker.id, res.result, staged.length > 0 ? 'review' : 'done');
    for (const s of staged) await this.hq.requestApproval(taskId, worker.id, s.kind, s.payload, s.summary);
    await this.report(taskId, this.brief(res.result) + (staged.length ? `\nНа одобрение: ${staged.length} (придёт в пачке).` : ''));
  }

  /**
   * «Что публикуем сегодня»: the Publisher assembles per-platform packs for approved items whose date arrived. The
   * packs go to the owner as info items with an «Опубликовано» button per platform (this is the only private message a
   * head sends, and it needs no decision). Nothing is posted by itself: the owner posts, then presses the button.
   */
  private async daily(task: Task): Promise<void> {
    const staged: { kind: string; payload: Record<string, unknown>; summary: string }[] = [];
    const res = await this.runOnce(task.id, this.publisher.id, staged, this.publisher);
    if (!res.ok) return void this.hq.block(task.id, HEAD_ID, res.error ?? 'публикатор не вернул результат');
    const tctx = { db: this.hq.db, now: this.hq.now, tz: this.hq.tz };
    const groups = this.publisher.packsToSend(tctx);
    let sent = 0;
    if (groups.length) {
      try {
        await this.d.messenger.send(this.d.ownerId, dayHeader(groups));
      } catch (e) {
        log('warn', 'publish header not delivered', { err: errMsg(e) });
      }
    }
    for (const g of groups) {
      try {
        // the reel's video first (with its caption and buttons when they fit), pictures as one album (the owner forwards
        // them to Instagram), then the text with the «Опубликовано» buttons
        const files = imagesOf(g);
        const video = videoOf(g);
        let note = '';
        let videoSent = false;
        let textSent = false;
        if (video) {
          try {
            if (!this.d.messenger.sendVideo) throw new Error('messenger cannot send video');
            if (!existsSync(video)) throw new Error('file is not on this host');
            if (statSync(video).size > MAX_VIDEO_BYTES) throw new Error('video is over 49 MB');
            const vc = videoCaption(g, publishDay(tctx));
            await this.d.messenger.sendVideo(this.d.ownerId, video, vc.caption, vc.withButtons ? publishedButtons(g) : undefined);
            videoSent = true;
            textSent = vc.withButtons;
          } catch (e) {
            log('warn', 'publish video not delivered', { err: errMsg(e) });
            note = '\n\nВидео не отправилось в Telegram: публикуйте по тексту, файл лежит на сервере.';
          }
        }
        if (files.length) {
          try {
            if (!this.d.messenger.sendPhotos) throw new Error('messenger cannot send photos');
            await this.d.messenger.sendPhotos(this.d.ownerId, files, `${TYPE_RU[g[0]!.type]} «${g[0]!.title}»`.slice(0, 200));
          } catch (e) {
            log('warn', 'publish photos not delivered', { err: errMsg(e) });
            note = '\n\nАльбом с картинками не отправился: публикуйте по тексту, картинки лежат на сервере.';
          }
        }
        if (!textSent) await this.d.messenger.send(this.d.ownerId, `${renderItemMessage(g, publishDay(tctx), { videoSent })}${note}`.slice(0, 4000), publishedButtons(g));
        this.publisher.markSent(tctx, g);
        sent++;
      } catch (e) {
        log('warn', 'publish pack not delivered', { err: errMsg(e) });
      }
    }
    const retried = this.retryReels(groups);
    const text = `${res.result}${groups.length ? `\nПакетов отправлено владельцу: ${sent} из ${groups.length}.` : ''}${retried ? `\nВидео снова в очереди рендера: ${retried}.` : ''}`;
    this.hq.complete(task.id, HEAD_ID, text);
    await this.report(task.id, text);
  }

  /** «Опубликовано» pressed: records the publication. Returns the callback toast. */
  onPublished(readyId: number): string {
    const r = this.publisher.markPublished({ db: this.hq.db, now: this.hq.now }, readyId);
    if (r.ok) this.hq.log('owner', 'published', 'content_ready', String(readyId));
    return r.text;
  }

  // ---- part-by-part editing of items (ApprovalEditor) ----
  private store() {
    return storeFor({ db: this.hq.db, now: this.hq.now });
  }

  private editable(approvalId: number) {
    const row = this.d.queue.get(approvalId);
    if (!row || row.kind !== KIND || (row.status !== 'pending' && row.status !== 'editing')) return null;
    const item = this.store().item(Number(row.payload.itemId));
    return item ? { row, item } : null;
  }

  async press(approvalId: number): Promise<string> {
    const row = this.d.queue.get(approvalId);
    if (row?.kind === ARTICLE_KIND && (row.status === 'pending' || row.status === 'editing')) {
      this.store().setKv('await_article', String(approvalId));
      await this.d.messenger.send(this.d.ownerId, `Пришлите замечание к статье одним сообщением (что изменить), я переделаю её и пришлю снова. /skip отменяет.`);
      return 'Жду замечание';
    }
    const e = this.editable(approvalId);
    if (!e) return 'Уже обработано';
    const buttons = editableParts(e.item.type).map((p) => ({ text: partLabel(e.item.type, p), data: `ce:${approvalId}:${p}` }));
    await this.d.messenger.send(this.d.ownerId, `Что править в материале #${e.item.id}? Выберите часть, следующее сообщение заменит только её.`, [buttons]);
    return 'Что править?';
  }

  async pick(approvalId: number, part: string): Promise<string> {
    const e = this.editable(approvalId);
    if (!e) return 'Уже обработано';
    const id = editableParts(e.item.type).find((p) => p === part);
    if (!id) return 'Нет такой части';
    this.store().setKv('await_edit', `${approvalId}:${id}`);
    await this.d.messenger.send(this.d.ownerId, `Пришлите новый текст для части «${partLabel(e.item.type, id)}» (материал #${e.item.id}) одним сообщением. /skip отменяет.`);
    return `Жду: ${partLabel(e.item.type, id)}`;
  }

  /** The owner's remark on an article: the card is closed, the same article row is written again with the remark. */
  private async reworkArticle(approvalId: number, remark: string): Promise<void> {
    const row = this.d.queue.get(approvalId);
    const articleId = Number(row?.payload.articleId);
    if (!row || row.kind !== ARTICLE_KIND || (row.status !== 'pending' && row.status !== 'editing') || !articleId) {
      await this.d.messenger.send(this.d.ownerId, 'Эта статья уже обработана, замечание не применено.');
      return;
    }
    this.store().setArticle(articleId, { status: 'draft', comment: remark.slice(0, 1000) });
    await this.d.queue.handle('reject', approvalId, this.d.ownerId);
    await this.d.queue.settleCard(approvalId).catch(() => undefined);
    const t = this.hq.createTask({ title: `Переделать статью #${articleId} с замечанием`, body: remark.slice(0, 1000), dept: MARKETING, creator: 'owner', meta: { action: 'article', articleId, feedback: remark.slice(0, 1000) } });
    this.hq.wake(HEAD_ID, 'task');
    await this.d.messenger.send(this.d.ownerId, `Принял замечание, переделываю статью (задача #${t.id}). Новая версия придёт в одобрения.`);
  }

  async consume(text: string): Promise<boolean> {
    const awaitedArticle = this.store().getKv('await_article');
    if (awaitedArticle) {
      this.store().setKv('await_article', null);
      await this.reworkArticle(Number(awaitedArticle), text);
      return true;
    }
    const pending = this.store().getKv('await_edit');
    if (!pending) return false;
    this.store().setKv('await_edit', null);
    const [aid, part] = pending.split(':') as [string, PartId];
    const approvalId = Number(aid);
    const e = this.editable(approvalId);
    if (!e) {
      await this.d.messenger.send(this.d.ownerId, 'Этот материал уже обработан, правка не применена.');
      return true;
    }
    const next = replacePart(typeof e.row.payload.text === 'string' ? e.row.payload.text : e.item.text, part, text);
    if (!next) {
      this.store().setKv('await_edit', pending);
      await this.d.messenger.send(this.d.ownerId, 'Часть не изменена: текст пустой или такой части нет. Пришлите текст ещё раз или /skip.');
      return true;
    }
    this.store().setText(e.item.id, next, titleOf(next));
    await this.d.queue.applyEdit(approvalId, next);
    return true;
  }

  cancel(): void {
    this.store().setKv('await_edit', null);
    this.store().setKv('await_article', null);
  }

  /** Director commands `/profile` and `/article [ниша]`: a department task for the head, the answer is what happens next. */
  async command(name: string, arg: string): Promise<string> {
    if (name === 'profile') {
      const t = this.hq.createTask({ title: 'Оформление профиля Instagram: био, актуальное, закрепы, порядок недели', body: '', dept: MARKETING, creator: 'owner', meta: { action: 'profile' } });
      this.hq.wake(HEAD_ID, 'task');
      return `Взял (задача #${t.id}): Контент-мейкер соберёт пакет настройки профиля, он придёт в одобрения одной карточкой, обложки Актуального отрисую после одобрения.`;
    }
    if (name === 'render') return this.renderCommand(arg);
    const niche = arg.trim();
    const store = this.store();
    if (niche && !findNiche(niche)) return `Не нашёл нишу «${niche.slice(0, 60)}». Напишите как в конструкторе, например: /article барбершоп. Или /article без названия: возьму первую нишу без статьи.`;
    const covered = store.coveredNiches().size;
    const t = this.hq.createTask({ title: `Статья в блог${niche ? `: ${niche}` : ''}`, body: niche, dept: MARKETING, creator: 'owner', meta: { action: 'article', ...(niche ? { niche } : {}) } });
    this.hq.wake(HEAD_ID, 'task');
    return `Взял (задача #${t.id}): Контент-мейкер пишет статью${niche ? ` для ниши «${findNiche(niche)!.name}»` : ' для следующей ниши без статьи'} (ниш со статьями сейчас ${covered}). Карточка придёт в одобрения.`;
  }

  /** `/render <id>`: queues the video of an approved reel again (a new job, attempts from 0). */
  private renderCommand(arg: string): string {
    if (!this.d.renderReels) return 'Рендер видео выключен (REELS_RENDER=off).';
    const id = Number(arg.trim().replace(/^#/, ''));
    if (!Number.isInteger(id) || id <= 0) return 'Напишите номер материала: /render 12 (он в карточке и в сообщении «Публикуем»).';
    const item = this.store().item(id);
    if (!item) return `Материал #${id} не найден.`;
    if (item.type !== 'clip') return `Материал #${id}: это не рилс (${TYPE_RU[item.type]}), видео собирается только для рилсов.`;
    if (item.status !== 'ready') return `Материал #${id} ещё не одобрен, видео соберу после одобрения.`;
    if (!parseReel(item.text)) return `В сценарии #${id} не нашёл сцен (формат «1. Голос: … Субтитр: …»), поправьте текст.`;
    const job = this.renderQueue.latest(id);
    if (job && (job.status === 'queued' || job.status === 'running')) return `Материал #${id}: рендер уже ${job.status === 'running' ? 'идёт' : 'в очереди'} (задача ${job.id}).`;
    const next = this.renderQueue.requeue(id);
    this.hq.log('owner', 'render_requeued', 'content_item', String(id));
    return `Поставил в очередь рендера (задача ${next.id}, материал #${id}). Видео придёт в утреннем сообщении «Публикуем».`;
  }

  parts(approvalId: number): { id: string; label: string }[] | null {
    const e = this.editable(approvalId);
    return e ? editableParts(e.item.type).map((p) => ({ id: p, label: partLabel(e.item.type, p) })) : null;
  }

  /** The admin API's edit: one part, or (no part) the whole text, kept in step with the item. */
  async applyEdit(approvalId: number, text: string, part?: string): Promise<boolean> {
    const e = this.editable(approvalId);
    if (!e) return false;
    let next: string | null | undefined = text.trim();
    if (part !== undefined) {
      const id = editableParts(e.item.type).find((p) => p === part);
      if (!id) return false;
      next = replacePart(typeof e.row.payload.text === 'string' ? e.row.payload.text : e.item.text, id, text);
    }
    if (!next) return false;
    this.store().setText(e.item.id, next, titleOf(next));
    return this.d.queue.applyEdit(approvalId, next);
  }
}
