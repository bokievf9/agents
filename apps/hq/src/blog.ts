import type { Db } from '@fir/core';
import { storeFor, toPublicArticle, type PublicArticle } from '@fir/worker-content-maker';

export interface BlogApi {
  /** `GET /blog?lang=all`: approved articles, newest first. */
  list: () => { ok: true; articles: PublicArticle[] };
  /** `GET /blog/:slug`: one article or null (404). */
  get: (slug: string) => { ok: true; article: PublicArticle } | null;
}

/**
 * The public blog the site reads (no token): approved articles of the content-maker in the site's `Article` shape.
 * The list is kept for 60 s like `/status`; every request is counted per day (`cm_kv` `blog_hits:<date>`) for the analyst.
 */
export function blogApi(db: Db, now: () => number = Date.now, tz: () => string = () => 'UTC', ttlMs = 60_000): BlogApi {
  const store = () => storeFor({ db, now });
  let at = 0;
  let cached: PublicArticle[] | null = null;
  const all = (): PublicArticle[] => {
    const t = now();
    if (!cached || t - at >= ttlMs) {
      cached = store().publishedArticles().map(toPublicArticle).filter((a): a is PublicArticle => a !== null);
      at = t;
    }
    return cached;
  };
  const hit = () => {
    try {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());
      store().bumpBlogHit(p);
    } catch {
      /* counting never breaks the endpoint */
    }
  };
  return {
    list: () => {
      hit();
      return { ok: true, articles: all() };
    },
    get: (slug) => {
      hit();
      const article = all().find((a) => a.slug === slug);
      return article ? { ok: true, article } : null;
    },
  };
}
