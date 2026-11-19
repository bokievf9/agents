import { errMsg, log } from '@fir/core';
import type { IgApi } from './instagram.js';
import type { PublishStore } from './store.js';

const DAY = 86_400_000;

/** One metric of an insights answer: `total_value.value`, else the sum of `values[].value`. */
function metric(data: unknown, name: string): number | null {
  const m = (data as { name?: unknown; total_value?: { value?: unknown }; values?: { value?: unknown }[] }[] | undefined)?.find((x) => x.name === name);
  if (!m) return null;
  if (typeof m.total_value?.value === 'number') return m.total_value.value;
  return m.values ? m.values.reduce((n, v) => n + (typeof v.value === 'number' ? v.value : 0), 0) : null;
}

export interface IgWeek {
  /** The window of the report (epoch ms). */
  fromMs: number;
  toMs: number;
  day: string;
}

/**
 * «Instagram за неделю: N публикаций, охват X, подписчиков Y (+Z), лучший ролик: <url> (V просмотров)». Account insights for the
 * window (reach, profile views, engaged accounts as totals), followers and media count (a snapshot is stored for the delta), and
 * per-media insights of the items published in the window. Each call may fail on its own: the line then says «н/д» for it.
 * Per-media `plays` was replaced by `views` in the API (2025), so `views` is read.
 */
export async function instagramWeekLine(o: { api: IgApi; userId: string; store: PublishStore }, w: IgWeek): Promise<string> {
  const { api, userId, store } = o;
  let reach: number | null = null;
  let followers: number | null = null;
  let mediaCount: number | null = null;
  try {
    const r = await api.get(`${userId}/insights`, { metric: 'reach,profile_views,accounts_engaged', period: 'day', metric_type: 'total_value', since: Math.floor(w.fromMs / 1000), until: Math.floor(w.toMs / 1000) });
    reach = metric(r.data, 'reach');
  } catch (e) {
    log('warn', 'instagram: account insights failed', { err: errMsg(e) });
  }
  try {
    const r = await api.get(userId, { fields: 'followers_count,media_count' });
    followers = typeof r.followers_count === 'number' ? r.followers_count : null;
    mediaCount = typeof r.media_count === 'number' ? r.media_count : null;
  } catch (e) {
    log('warn', 'instagram: account info failed', { err: errMsg(e) });
  }
  const prior = store.followersUpTo(new Date(Date.parse(`${w.day}T00:00:00Z`) - 6 * DAY).toISOString().slice(0, 10));
  if (followers !== null) store.saveIgStats(w.day, followers, mediaCount);

  let best: { url: string; views: number } | null = null;
  const posts = store.instagramPublished(w.fromMs, w.toMs);
  for (const p of posts) {
    try {
      const r = await api.get(`${p.mediaId}/insights`, { metric: 'views,reach,likes,comments,shares,saved' });
      const views = metric(r.data, 'views') ?? 0;
      if (p.url && (!best || views > best.views)) best = { url: p.url, views };
    } catch (e) {
      log('warn', 'instagram: media insights failed', { mediaId: p.mediaId, err: errMsg(e) });
    }
  }
  const delta = followers !== null && prior !== null ? followers - prior : null;
  return `Instagram за неделю: ${posts.length} публикаций, охват ${reach ?? 'н/д'}, подписчиков ${followers ?? 'н/д'}${delta === null ? '' : ` (${delta >= 0 ? '+' : ''}${delta})`}${best ? `, лучший ролик: ${best.url} (${best.views} просмотров)` : ''}`;
}
