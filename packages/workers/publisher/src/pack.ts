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
  /** Video or image files to upload. Stage 1: always empty (the owner makes the video by hand). Stage 2 fills it from the renderer. */
  files: string[];
}

/** Stage 2 hook: where the rendered file of an item for a platform lives (null: nothing rendered yet). */
export type RenderLookup = (itemId: number, platform: Platform) => string | null;

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
export function assemblePacks(ctx: { db: Db; now: () => number }, today: string, render: RenderLookup = () => null): PublishPack[] {
  const content = storeFor(ctx);
  return content
    .readyRows()
    .filter((r: ReadyRow) => r.plannedDate <= today)
    .map((r) => {
      const { caption, hashtags } = captionOf(r.text, r.platform);
      const file = render(r.itemId, r.platform);
      return {
        readyId: r.id, itemId: r.itemId, platform: r.platform, type: r.type, plannedDate: r.plannedDate,
        title: content.item(r.itemId)?.title ?? '', caption, hashtags, files: file ? [file] : [],
      };
    });
}

/** Packs grouped per item, in planned order. */
export function groupByItem(packs: PublishPack[]): PublishPack[][] {
  const m = new Map<number, PublishPack[]>();
  for (const p of packs) m.set(p.itemId, [...(m.get(p.itemId) ?? []), p]);
  return [...m.values()];
}

/** The owner-facing message for one item: a block per platform plus the title. Telegram caps at 4096 characters. */
export function renderItemMessage(group: PublishPack[], today: string): string {
  const first = group[0]!;
  const late = first.plannedDate < today ? ` (план был ${first.plannedDate.slice(8, 10)}.${first.plannedDate.slice(5, 7)}, не отмечено)` : '';
  const blocks = group.map((p) => {
    const files = p.files.length ? `Файл: ${p.files.join(', ')}` : 'Файл: пока готовит человек по сценарию (рендер видео этап 2)';
    return [`== ${PLATFORM_LABEL[p.platform]} ==`, p.caption, p.hashtags.join(' '), files].filter(Boolean).join('\n');
  });
  return `Публикуем: ${TYPE_RU[first.type]} «${first.title}»${late}\n\n${blocks.join('\n\n')}\n\nПосле публикации нажмите кнопку платформы.`.slice(0, 4000);
}

export const BUTTON_PREFIX = 'pb:';
export const publishedButtons = (group: PublishPack[]) => [group.map((p) => ({ text: `Опубликовано: ${PLATFORM_LABEL[p.platform]}`, data: `${BUTTON_PREFIX}${p.readyId}` }))];
