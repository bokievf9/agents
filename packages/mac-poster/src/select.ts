import type { HqDay, HqFile, HqItem } from './hq.js';

export type IgKind = 'clip' | 'post' | 'carousel' | 'story';
const KINDS: IgKind[] = ['clip', 'carousel', 'post', 'story']; // the order of a run: reels, carousels, posts, stories

/** One thing to publish on Instagram. */
export interface PlanItem {
  id: HqItem['id'];
  kind: IgKind;
  date: string;
  title: string;
  caption: string;
  /** The files to upload, in order (one MP4 for a reel, 1..10 PNG otherwise; each story frame is its own story). */
  files: HqFile[];
}

const isTagLine = (line: string) => /^(#[^\s#]+\s*)+$/.test(line.trim());

/**
 * The Instagram caption of an item: HQ's `igCaption` when it has one, else the Instagram part of `caption.instagram`
 * («<body>\n\nInstagram:\n<caption>\n<#tags>»), caption then a blank line then the hashtags. Capped at Instagram's 2200.
 */
export function captionFor(item: Pick<HqItem, 'caption' | 'igCaption'>): string {
  if (item.igCaption) return item.igCaption.slice(0, 2200);
  const text = item.caption.instagram ?? '';
  const at = text.lastIndexOf('\n\nInstagram:\n');
  const own = (at >= 0 ? text.slice(at + '\n\nInstagram:\n'.length) : text).trim();
  const lines = own.split('\n');
  const last = lines.at(-1) ?? '';
  const tags = isTagLine(last) ? last.trim() : '';
  const body = (tags ? lines.slice(0, -1) : lines).join('\n').trim();
  return [body, tags].filter(Boolean).join('\n\n').slice(0, 2200);
}

/** The files a kind uploads; null when the item has nothing usable yet. */
export function filesFor(kind: IgKind, files: HqFile[]): HqFile[] | null {
  const png = files.filter((f) => f.type === 'png');
  if (kind === 'clip') {
    const mp4 = files.find((f) => f.type === 'mp4');
    return mp4 ? [mp4] : null;
  }
  if (kind === 'carousel') return png.length >= 2 ? png.slice(0, 10) : png.length === 1 ? png : null;
  if (kind === 'post') return png.length ? png.slice(0, 10) : null;
  return png.length ? png : null;
}

export const isPublishedOnInstagram = (item: HqItem): boolean =>
  item.status === 'published' || (item.publishedOn ? item.publishedOn.includes('instagram') : item.publishedUrl !== null && item.publishedUrl.includes('instagram.com'));

export interface SelectOpts {
  /** Items to leave out (attempted today, or stuck after «Поделиться»). */
  skip?: (id: HqItem['id']) => boolean;
}

/** Approved Instagram items planned on or before `date`, not yet published, with files: reels, carousels, posts, stories. */
export function selectItems(days: HqDay[], date: string, opts: SelectOpts = {}): PlanItem[] {
  const seen = new Set<string>();
  const out: PlanItem[] = [];
  for (const day of days) {
    if (day.date > date) continue;
    for (const item of day.items) {
      if (seen.has(String(item.id))) continue;
      seen.add(String(item.id));
      if (item.platform !== 'instagram' || !(KINDS as string[]).includes(item.kind)) continue;
      if (item.status !== 'approved' && item.status !== 'ready') continue;
      if (isPublishedOnInstagram(item) || opts.skip?.(item.id)) continue;
      const kind = item.kind as IgKind;
      const files = filesFor(kind, item.files);
      if (!files) continue;
      out.push({ id: item.id, kind: kind === 'carousel' && files.length === 1 ? 'post' : kind, date: day.date, title: item.title, caption: captionFor(item), files });
    }
  }
  return out.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
}

const KIND_RU: Record<IgKind, string> = { clip: 'рилс', carousel: 'карусель', post: 'пост', story: 'история' };

/** The dry-run report: what would be posted, in order, within the limits. */
export function formatPlan(plan: PlanItem[], o: { date: string; limit: number; leftToday: number }): string {
  const take = Math.min(o.limit, o.leftToday);
  const lines = plan.map((p, i) => `${i < take ? `${i + 1}.` : ' -'} #${p.id} ${KIND_RU[p.kind]} (${p.date}) «${p.title}», файлов: ${p.files.length}, подпись: ${p.caption.length} симв.${i < take ? '' : ' [не в этот запуск]'}`);
  const head = `Instagram на ${o.date}: к публикации ${plan.length}, в этот запуск ${Math.min(take, plan.length)} (лимит запуска ${o.limit}, осталось на сегодня ${o.leftToday}).`;
  return [head, ...lines].join('\n');
}
