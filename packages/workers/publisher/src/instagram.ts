import { META_HOSTS, safeGetJson, safePost, type SafeGetOptions, type SafeGetResult, type SafePostOptions, type SafePostResult } from '@fir/core';
import { isVideo, type PublishPack } from './pack.js';
import { mediaUrl, relUnder } from './media.js';
import { PostPending, type PlatformPoster } from './poster.js';
import { QuotaExceeded } from './youtube.js';

export const GRAPH_VERSION = 'v23.0';
/** The API allows 50 published posts per 24 h and account; we stop at 45 and leave the rest for the manual flow. */
export const IG_POST_LIMIT = 50;
export const IG_POST_CEILING = 45;
const CAPTION_MAX = 2200;

export type IgGetFn = (url: string, o: SafeGetOptions) => Promise<SafeGetResult>;
export type IgPostFn = (url: string, o: SafePostOptions) => Promise<SafePostResult>;

/** A Graph API failure. `status` is the HTTP status (0: transport), `code` the Graph error code when the body had one (190: expired token). */
export class IgError extends Error {
  constructor(message: string, readonly status = 0, readonly code?: number) {
    super(message);
  }
}

export interface IgApiOptions {
  /** The long-lived user token. It goes only into the `authorization` header: never into a URL, a log line or an error text. */
  token: string;
  host?: (typeof META_HOSTS)[number];
  /** Tests. */
  get?: IgGetFn;
  post?: IgPostFn;
}

/** Minimal Graph API client over core `safeGetJson` / `safePost` (hosts graph.facebook.com and graph.instagram.com only). */
export class IgApi {
  private readonly host: string;
  private readonly g: IgGetFn;
  private readonly p: IgPostFn;

  constructor(private readonly o: IgApiOptions) {
    this.host = o.host ?? 'graph.facebook.com';
    this.g = o.get ?? safeGetJson;
    this.p = o.post ?? safePost;
  }

  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const q = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
    return `https://${this.host}/${GRAPH_VERSION}/${path.replace(/^\//, '')}${q ? `?${q}` : ''}`;
  }

  private get headers(): Record<string, string> {
    return { authorization: `Bearer ${this.o.token}` };
  }

  /** GET; throws `IgError` on a transport problem or a non-2xx answer (core drops error bodies of GETs, so only the status is known). */
  async get(path: string, params?: Record<string, string | number | undefined>): Promise<Record<string, unknown>> {
    const r = await this.g(this.url(path, params), { allowHosts: META_HOSTS, headers: this.headers, timeoutMs: 15_000 });
    if (!r.ok) throw new IgError(`Instagram: ${r.error}`, 0);
    if (r.status !== 200) throw new IgError(`Instagram: HTTP ${r.status}`, r.status);
    return (r.body ?? {}) as Record<string, unknown>;
  }

  /** POST with a JSON body; throws `IgError` with the Graph message and code on a non-2xx answer. */
  async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await this.p(this.url(path), { allowHosts: META_HOSTS, headers: { ...this.headers, 'content-type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 30_000 });
    if (!r.ok) throw new IgError(`Instagram: ${r.error}`, 0);
    if (r.status < 200 || r.status >= 300) {
      const e = (r.body as { error?: { message?: unknown; code?: unknown } } | null)?.error;
      const msg = typeof e?.message === 'string' ? ` ${e.message.slice(0, 160)}` : '';
      throw new IgError(`Instagram: HTTP ${r.status}${typeof e?.code === 'number' ? ` code ${e.code}` : ''}${msg}`, r.status, typeof e?.code === 'number' ? e.code : undefined);
    }
    return (r.body ?? {}) as Record<string, unknown>;
  }
}

const idOf = (b: Record<string, unknown>, what: string): string => {
  if (typeof b.id !== 'string' || !b.id) throw new IgError(`Instagram: нет id в ответе (${what})`);
  return b.id;
};

export interface InstagramPosterOptions {
  api: IgApi;
  userId: string;
  store: import('./store.js').PublishStore;
  /** The HQ day, the key of the one-attempt-a-day rule. */
  day: () => string;
  /** `IG_PUBLIC_BASE`, e.g. https://firtech.pro/media. Without it posting is impossible (the Graph API fetches files by URL). */
  publicBase?: string | undefined;
  /** The secret the media URLs are signed with (`MEDIA_SECRET` or `WEB_CHAT_TOKEN`). */
  mediaSecret?: string | undefined;
  /** DATA_DIR/renders: only files under it have public URLs. */
  rendersDir: string;
  /** Polling of a container: every `intervalMs` up to `maxWaitMs` (defaults 10 s and 5 min). */
  intervalMs?: number;
  maxWaitMs?: number;
  /** Tests. */
  sleep?: (ms: number) => Promise<void>;
}

type Kind = 'reel' | 'post' | 'carousel' | 'story';
const kindOf = (pack: PublishPack): Kind | null =>
  pack.type === 'clip' ? (pack.files.some(isVideo) ? 'reel' : null)
  : pack.type === 'post' ? (pack.files.some((f) => !isVideo(f)) ? 'post' : null)
  : pack.type === 'carousel' ? (pack.files.filter((f) => !isVideo(f)).length >= 1 ? 'carousel' : null)
  : pack.type === 'story' ? (pack.files.some((f) => !isVideo(f)) ? 'story' : null)
  : null;

/**
 * Stage 2 poster for `instagram` through the Instagram Graph API (container, wait for FINISHED, media_publish). Reels, single posts,
 * carousels (2-10 pictures, one picture is a plain post) and stories. A Reel that is still processing after the wait keeps its
 * container id in `pb_posts.container_id` and finishes on the next run (`PostPending`). Never retries blindly: errors go up.
 */
export class InstagramPoster implements PlatformPoster {
  readonly platform = 'instagram' as const;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: InstagramPosterOptions) {
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  canPost(pack: PublishPack): boolean {
    return kindOf(pack) !== null;
  }

  private url(file: string): string {
    if (!this.o.publicBase) throw new Error('нет публичного URL файлов');
    if (!this.o.mediaSecret) throw new Error('нет секрета для ссылок на файлы (MEDIA_SECRET)');
    const rel = relUnder(this.o.rendersDir, file);
    if (!rel) throw new Error('файл вне папки рендеров');
    return mediaUrl(this.o.publicBase, this.o.mediaSecret, rel);
  }

  /** `true` when the container is FINISHED, `false` when it is still processing after the wait; throws on ERROR or EXPIRED. */
  private async finished(container: string): Promise<boolean> {
    const interval = this.o.intervalMs ?? 10_000;
    const tries = Math.floor((this.o.maxWaitMs ?? 300_000) / interval) + 1;
    for (let i = 0; i < tries; i++) {
      const st = (await this.o.api.get(container, { fields: 'status_code' })).status_code;
      if (st === 'FINISHED') return true;
      if (st === 'ERROR' || st === 'EXPIRED') throw new Error(`Instagram: обработка файла не удалась (${String(st)})`);
      if (i < tries - 1) await this.sleep(interval);
    }
    return false;
  }

  private async checkLimit(): Promise<void> {
    const r = await this.o.api.get(`${this.o.userId}/content_publishing_limit`, { fields: 'quota_usage,config' });
    const used = Number((r.data as { quota_usage?: unknown }[] | undefined)?.[0]?.quota_usage ?? 0);
    if (used >= IG_POST_CEILING) throw new QuotaExceeded(`лимит Instagram: ${used} из ${IG_POST_LIMIT} публикаций за 24 часа (стоп на ${IG_POST_CEILING}), остальное вручную`);
  }

  private async publish(container: string): Promise<{ id: string; url: string }> {
    const id = idOf(await this.o.api.post(`${this.o.userId}/media_publish`, { creation_id: container }), 'media_publish');
    let url = 'https://www.instagram.com/';
    try {
      const link = (await this.o.api.get(id, { fields: 'permalink' })).permalink;
      if (typeof link === 'string' && link.startsWith('https://www.instagram.com/')) url = link;
    } catch {
      /* published already: the link is a convenience, a lost one must not turn a success into a failure */
    }
    return { id, url };
  }

  private caption(pack: PublishPack): string {
    return [pack.caption, pack.hashtags.join(' ')].filter(Boolean).join('\n\n').slice(0, CAPTION_MAX);
  }

  async post(pack: PublishPack): Promise<{ url: string }> {
    const kind = kindOf(pack);
    if (!kind) throw new Error('нет файлов для публикации');
    const { store, api, userId } = this.o;
    const resume = store.container(pack.readyId);
    try {
      let container = resume;
      const images = pack.files.filter((f) => !isVideo(f));
      if (!container) {
        const urls = kind === 'reel' ? [this.url(pack.files.find(isVideo)!)] : images.map((f) => this.url(f)); // fails early on a missing base or secret
        if (kind === 'carousel' && images.length > 10) throw new Error('в карусели больше 10 картинок');
        await this.checkLimit();
        if (kind === 'reel') {
          container = idOf(await api.post(`${userId}/media`, { media_type: 'REELS', video_url: urls[0], caption: this.caption(pack), share_to_feed: true }), 'reel');
          store.setContainer(pack.readyId, container); // before waiting: a crash or a slow render never creates a second container
        } else if (kind === 'post') {
          container = idOf(await api.post(`${userId}/media`, { image_url: urls[0], caption: this.caption(pack) }), 'post');
        } else if (kind === 'story') {
          return await this.stories(pack, urls);
        } else if (urls.length === 1) {
          container = idOf(await api.post(`${userId}/media`, { image_url: urls[0], caption: this.caption(pack) }), 'post');
        } else {
          const children: string[] = [];
          for (const u of urls) {
            const child = idOf(await api.post(`${userId}/media`, { image_url: u, is_carousel_item: true }), 'carousel item');
            if (!(await this.finished(child))) throw new Error('Instagram: картинка карусели не обработалась вовремя');
            children.push(child);
          }
          container = idOf(await api.post(`${userId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: this.caption(pack) }), 'carousel');
        }
      }
      if (!(await this.finished(container))) {
        if (kind === 'reel') throw new PostPending('Instagram');
        throw new Error('Instagram: файл не обработался вовремя');
      }
      const done = await this.publish(container);
      store.setMedia(pack.readyId, done.id);
      store.setContainer(pack.readyId, null);
      return { url: done.url };
    } catch (e) {
      if (!(e instanceof PostPending)) store.setContainer(pack.readyId, null); // a failed attempt does not block the next day's new one
      throw e;
    }
  }

  /** Every frame is its own story; the row keeps the first frame's id and link. */
  private async stories(pack: PublishPack, urls: string[]): Promise<{ url: string }> {
    let first: { id: string; url: string } | null = null;
    for (const u of urls) {
      const c = idOf(await this.o.api.post(`${this.o.userId}/media`, { media_type: 'STORIES', image_url: u }), 'story');
      if (!(await this.finished(c))) throw new Error('Instagram: история не обработалась вовремя');
      const done = await this.publish(c);
      first ??= done;
    }
    if (!first) throw new Error('нет файлов для публикации');
    this.o.store.setMedia(pack.readyId, first.id);
    return { url: first.url };
  }
}
