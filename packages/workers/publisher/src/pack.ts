import { PLATFORM_LABEL, TYPE_RU, storeFor, type ItemType, type Platform, type ReadyRow } from '@fir/worker-content-maker';
import type { Db } from '@fir/core';

/** One platform's ready-to-paste copy for one approved item. */
export interface PublishPack {
  readyId: number;
  itemId: number;
  platform: Platform;
  type: ItemType;
  plannedDate: string;
  title: string;
  caption: string;
  hashtags: string[];
  /** Image files rendered on approval (posts, slides, story frames, covers); a reel's video comes from the render lookup, else empty. */
  files: string[];
  /** Why a reel has no video yet («видео не собралось: …», «видео ещё собирается»); empty when it has one or needs none. */
  note?: string;
}

/** Stage 2 hook: where the rendered file of an item for a platform lives (null: nothing rendered yet). */
export type RenderLookup = (itemId: number, platform: Platform) => string | null;
/** Stage 2 hook: the state of the item's video when there is no file yet (null: nothing to say). */
export type RenderNote = (itemId: number) => string | null;

export const isVideo = (file: string): boolean => /\.mp4$/i.test(file);

const isTagLine = (line: string) => /^(#[^\s#]+\s*)+$/.test(line.trim());

/** Splits an approved platform text ("<body>\n\nInstagram:\n<caption>\n<#tags>") into caption and hashtags. */
export function captionOf(text: string, platform: Platform): { caption: string; hashtags: string[] } {
  const marker = `${PLATFORM_LABEL[platform]}:\n`;
  const at = text.lastIndexOf(`\n\n${marker}`);
  const own = at >= 0 ? text.slice(at + 2 + marker.length) : text;
  const lines = own.trim().split('\n');
  const last = lines.at(-1) ?? '';
  const hashtags = isTagLine(last) ? last.trim().split(/\s+/) : [];
  const caption = (hashtags.length ? lines.slice(0, -1) : lines).join('\n').trim();
  return { caption, hashtags };
}

/** Approved, not yet published rows whose planned date has arrived (overdue ones included). */
export function assemblePacks(ctx: { db: Db; now: () => number }, today: string, render: RenderLookup = () => null, renderNote: RenderNote = () => null): PublishPack[] {
  const content = storeFor(ctx);
  return content
    .readyRows()
    .filter((r: ReadyRow) => r.plannedDate <= today)
    .map((r) => {
      const { caption, hashtags } = captionOf(r.text, r.platform);
      const file = render(r.itemId, r.platform);
      const note = file ? null : r.type === 'clip' ? renderNote(r.itemId) : null;
      return {
        readyId: r.id, itemId: r.itemId, platform: r.platform, type: r.type, plannedDate: r.plannedDate,
        title: content.item(r.itemId)?.title ?? '', caption, hashtags, files: r.files.length ? r.files : file ? [file] : [],
        ...(note ? { note } : {}),
      };
    });
}

const TYPE_ORDER: ItemType[] = ['clip', 'post', 'carousel', 'story', 'profile'];

/** Packs grouped per item, in planned order, and inside a day by type: reels, posts, carousels, stories. */
export function groupByItem(packs: PublishPack[]): PublishPack[][] {
  const m = new Map<number, PublishPack[]>();
  for (const p of packs) m.set(p.itemId, [...(m.get(p.itemId) ?? []), p]);
  return [...m.values()].sort((a, b) => a[0]!.plannedDate.localeCompare(b[0]!.plannedDate) || TYPE_ORDER.indexOf(a[0]!.type) - TYPE_ORDER.indexOf(b[0]!.type));
}

const COUNT_RU: Record<ItemType, [string, string, string]> = {
  clip: ['рилс', 'рилса', 'рилсов'], post: ['пост', 'поста', 'постов'], carousel: ['карусель', 'карусели', 'каруселей'],
  story: ['история', 'истории', 'историй'], profile: ['набор для профиля', 'набора для профиля', 'наборов для профиля'],
};
const plural = (n: number, f: [string, string, string]): string => (n % 10 === 1 && n % 100 !== 11 ? f[0] : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? f[1] : f[2]);

/** The line that opens the day's messages: «Сегодня публикуем: 1 рилс, 1 пост, 1 история (картинок: 9)». */
export function dayHeader(groups: PublishPack[][]): string {
  const counts = TYPE_ORDER.map((t) => [t, groups.filter((g) => g[0]!.type === t).length] as const).filter(([, n]) => n > 0);
  const images = groups.reduce((n, g) => n + imagesOf(g).length, 0);
  const videos = groups.filter((g) => videoOf(g)).length;
  return `Сегодня публикуем: ${counts.map(([t, n]) => `${n} ${plural(n, COUNT_RU[t])}`).join(', ')}${images ? `. Картинок к отправке: ${images}` : ''}${videos ? `. Видео к отправке: ${videos}` : ''}.`;
}

const IMAGE_TYPES: ItemType[] = ['post', 'carousel', 'story', 'profile'];

/** The image files of one item, in order (they go to Telegram as a media group before the text message). */
export const imagesOf = (group: PublishPack[]): string[] => [...new Set(group.flatMap((p) => p.files))].filter((f) => !isVideo(f));
/** @deprecated the old name of `imagesOf`; videos are never part of it. */
export const filesOf = imagesOf;
/** The rendered MP4 of a reel (sent with `sendVideo`), if there is one. */
export const videoOf = (group: PublishPack[]): string | undefined => group.flatMap((p) => p.files).find(isVideo);

/** The owner-facing message for one item: a block per platform plus the title. Telegram caps at 4096 characters. */
export function renderItemMessage(group: PublishPack[], today: string, opts: { videoSent?: boolean } = {}): string {
  const first = group[0]!;
  const late = first.plannedDate < today ? ` (план был ${first.plannedDate.slice(8, 10)}.${first.plannedDate.slice(5, 7)}, не отмечено)` : '';
  const blocks = group.map((p) => {
    const files = IMAGE_TYPES.includes(p.type)
      ? p.files.length ? `Картинок: ${p.files.length}, они пришли альбомом выше. Перешлите их в Instagram по порядку.` : 'Картинки не созданы (рендер недоступен): публикуйте по тексту, оформите карточку вручную.'
      : opts.videoSent && p.files.some(isVideo) ? 'Видео собрано, оно пришло выше: перешлите его в приложение платформы.'
      : p.note ? `Видео: ${p.note}. Сценарий выше, снимите по нему или подождите следующего утра.`
      : p.files.length ? `Файл: ${p.files.join(', ')}` : 'Файл: пока готовит человек по сценарию (рендер видео этап 2)';
    return [`== ${PLATFORM_LABEL[p.platform]} ==`, p.caption, p.hashtags.join(' '), files].filter(Boolean).join('\n');
  });
  return `Публикуем: ${TYPE_RU[first.type]} «${first.title}»${late}\n\n${blocks.join('\n\n')}\n\nПосле публикации нажмите кнопку платформы.`.slice(0, 4000);
}

/** Caption of the video message: the whole item message when it fits Telegram's 1024, else a short title (the full text follows). */
export function videoCaption(group: PublishPack[], today: string): { caption: string; withButtons: boolean } {
  const full = renderItemMessage(group, today, { videoSent: true });
  if (full.length <= 1024) return { caption: full, withButtons: true };
  return { caption: `${TYPE_RU[group[0]!.type]} «${group[0]!.title}»`.slice(0, 200), withButtons: false };
}

export const BUTTON_PREFIX = 'pb:';
export const publishedButtons = (group: PublishPack[]) => [group.map((p) => ({ text: `Опубликовано: ${PLATFORM_LABEL[p.platform]}`, data: `${BUTTON_PREFIX}${p.readyId}` }))];
