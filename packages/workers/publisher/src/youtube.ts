import { readFileSync } from 'node:fs';
import { YT_QUOTA_LIMIT, YT_UPLOAD_COST, safePost, youtubeResumableUpload, type PostFn } from '@fir/core';
import type { PublishPack } from './pack.js';
import { isVideo } from './pack.js';
import type { PlatformPoster } from './poster.js';
import { PublishStore } from './store.js';

/** One upload costs 1600 of the 10 000 daily units; we stop at 9 000 and leave the rest for the manual flow. */
export const UPLOAD_COST = YT_UPLOAD_COST;
export const QUOTA_LIMIT = YT_QUOTA_LIMIT;
export const SITE_URL = 'https://firtech.pro/';

export type Privacy = 'public' | 'unlisted' | 'private';
export const parsePrivacy = (v: string | undefined): Privacy => (v === 'unlisted' || v === 'private' ? v : 'public');

export interface VideoMeta {
  snippet: { title: string; description: string; tags: string[]; categoryId: string; defaultLanguage: string };
  status: { privacyStatus: Privacy; selfDeclaredMadeForKids: false; publishAt?: string };
}

/** Thrown when today's quota is spent: the caller falls back to the manual flow and says so in the day header. */
export class QuotaExceeded extends Error {
  constructor(message = 'квота YouTube на сегодня исчерпана (лимит 9000 из 10 000)') {
    super(message);
  }
}

const TAG_BUDGET = 500;

/**
 * Title ≤ 100 chars (the Shorts title line, else the item title, + « #Shorts»); description = the caption text, the site
 * link with UTM and the hashtags; tags ≤ 500 chars in total. With a future `publishAt` the video must be `private` (the API
 * publishes it on time); a past or missing one is ignored.
 */
export function buildVideoMeta(pack: PublishPack, o: { privacy?: Privacy; publishAt?: number | null; now: number }): VideoMeta {
  const lines = pack.caption.split('\n').map((l) => l.trim()).filter(Boolean);
  const base = (lines[0] ?? pack.title).replace(/#Shorts/gi, '').trim() || pack.title || 'Fir Tech';
  const title = `${base.slice(0, 100 - ' #Shorts'.length).trim()} #Shorts`;
  const body = lines.slice(1).join('\n');
  const tags = [...new Set(['Shorts', ...pack.hashtags.map((h) => h.replace(/^#+/, ''))])].filter(Boolean);
  const hashtags = tags.map((t) => `#${t}`).join(' ');
  const link = `${SITE_URL}?utm_source=youtube&utm_medium=shorts&utm_campaign=${pack.itemId}`;
  const description = [body, link, hashtags].filter(Boolean).join('\n\n').slice(0, 4900);
  const kept: string[] = [];
  let total = 0;
  for (const t of tags) {
    total += t.length + (kept.length ? 1 : 0);
    if (total > TAG_BUDGET) break;
    kept.push(t);
  }
  const future = o.publishAt != null && o.publishAt > o.now;
  return {
    snippet: { title, description, tags: kept, categoryId: '28', defaultLanguage: 'ru' },
    status: future
      ? { privacyStatus: 'private', selfDeclaredMadeForKids: false, publishAt: new Date(o.publishAt!).toISOString() }
      : { privacyStatus: o.privacy ?? 'public', selfDeclaredMadeForKids: false },
  };
}

export interface YouTubePosterOptions {
  auth: { accessToken(): Promise<string> };
  store: PublishStore;
  /** The HQ day (YYYY-MM-DD), the key of the quota counter. */
  day: () => string;
  now: () => number;
  privacy?: Privacy;
  /** Planned publication time of a pack, if the plan has one (then the video is uploaded private and goes public at that time). */
  publishAt?: (pack: PublishPack) => number | null;
  /** Tests. */
  post?: PostFn;
  readFile?: (path: string) => Uint8Array;
}

/**
 * Stage 2 poster for `shorts`: resumable upload through YouTube Data API v3 (init POST, then the whole MP4 in one PUT).
 * It never retries: a failed session is dropped and the error goes up (the item stays `ready`, the manual flow shows the reason).
 * The 1600 units are booked before the upload starts, a failed upload counts too.
 */
export class YouTubePoster implements PlatformPoster {
  readonly platform = 'shorts' as const;
  private readonly post_: PostFn;

  constructor(private readonly o: YouTubePosterOptions) {
    this.post_ = o.post ?? safePost;
  }

  canPost(pack: PublishPack): boolean {
    return pack.files.some(isVideo);
  }

  async post(pack: PublishPack): Promise<{ url: string }> {
    const file = pack.files.find(isVideo);
    if (!file) throw new Error('нет MP4 для загрузки');
    const day = this.o.day();
    if (this.o.store.quotaUsed(day) + UPLOAD_COST > QUOTA_LIMIT) throw new QuotaExceeded();
    const bytes = (this.o.readFile ?? readFileSync)(file);
    const meta = buildVideoMeta(pack, { ...(this.o.privacy ? { privacy: this.o.privacy } : {}), publishAt: this.o.publishAt?.(pack) ?? null, now: this.o.now() });
    const token = await this.o.auth.accessToken();
    this.o.store.addQuota(day, UPLOAD_COST);

    // the two HTTP steps live in core (`youtubeResumableUpload`), shared with `tools.google.youtube.upload`
    const r = await youtubeResumableUpload(this.post_, token, meta, bytes);
    if (r.ok) return { url: `https://youtube.com/shorts/${r.id}` };
    if (r.stage === 'session') throw new Error(`YouTube: сессия загрузки не открыта (${r.transport ?? `HTTP ${r.status}${r.reason}`})`);
    throw new Error(`YouTube: загрузка не удалась (${r.transport ?? `HTTP ${r.status}${r.reason}`}), сессия сброшена`);
  }
}
