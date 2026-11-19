import { describe, expect, it } from 'vitest';
import type { HqDay, HqItem } from '../src/hq.js';
import { captionFor, filesFor, formatPlan, selectItems } from '../src/select.js';
import { addDays, isoWeek, localDate, weeksFor } from '../src/week.js';

const png = (p: string, w = 1080, h = 1350) => ({ path: p, type: 'png' as const, w, h });
const mp4 = (p: string) => ({ path: p, type: 'mp4' as const, w: 1080, h: 1920 });
function item(id: number, kind: HqItem['kind'], over: Partial<HqItem> = {}): HqItem {
  return {
    id, kind, platform: 'instagram', status: 'ready', title: `t${id}`, caption: { instagram: `Тело\n\nInstagram:\nПодпись ${id}\n#a #b` }, files: [png(`${id}/1.png`)],
    publishedUrl: null, error: null, publishedOn: [], ...over,
  };
}

describe('weeks', () => {
  it('ISO weeks around year ends and the HQ test week', () => {
    expect(isoWeek('2026-11-23')).toBe('2026-W48');
    expect(isoWeek('2026-11-29')).toBe('2026-W48');
    expect(isoWeek('2026-11-30')).toBe('2026-W49');
    expect(isoWeek('2021-01-03')).toBe('2020-W53');
    expect(isoWeek('2024-12-30')).toBe('2025-W01');
    expect(isoWeek('2026-01-01')).toBe('2026-W01');
    expect(() => isoWeek('2026-02-30')).toThrow();
  });
  it('a run fetches the previous week too; localDate is the local calendar day', () => {
    expect(weeksFor('2026-11-23')).toEqual(['2026-W47', '2026-W48']);
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    const d = new Date(2026, 10, 20, 23, 30);
    expect(localDate(d.getTime())).toBe('2026-11-20');
  });
});

describe('selection', () => {
  const days: HqDay[] = [
    { date: '2026-11-22', items: [item(1, 'story', { files: [png('1/1.png', 1080, 1920), png('1/2.png', 1080, 1920)] }), item(2, 'post')] },
    {
      date: '2026-11-23', items: [
        item(3, 'post'),
        item(4, 'clip', { files: [png('4/cover.png'), mp4('4/reel.mp4')] }),
        item(5, 'carousel', { files: [png('5/1.png'), png('5/2.png'), png('5/3.png')] }),
        item(6, 'clip', { status: 'rendering', files: [png('6/cover.png')] }),
        item(7, 'post', { status: 'pending' }),
        item(8, 'post', { publishedOn: ['instagram'] }),
        item(9, 'post', { status: 'published' }),
        { ...item(10, 'article'), platform: 'blog' },
        item(11, 'clip', { files: [png('11/cover.png')] }),
        item(12, 'post', { files: [] }),
      ],
    },
    { date: '2026-11-24', items: [item(13, 'post')] },
  ];

  it('approved, due, unpublished, with files; reels, carousels, posts, stories; overdue first inside a kind', () => {
    const plan = selectItems(days, '2026-11-23');
    expect(plan.map((p) => [p.id, p.kind])).toEqual([[4, 'clip'], [5, 'carousel'], [2, 'post'], [3, 'post'], [1, 'story']]);
    expect(plan[0]!.files).toEqual([mp4('4/reel.mp4')]);
    expect(plan[1]!.files).toHaveLength(3);
    expect(plan.find((p) => p.id === 1)!.files).toHaveLength(2);
  });

  it('skip (tried today / stuck) and the older HQ without publishedOn', () => {
    expect(selectItems(days, '2026-11-23', { skip: (id) => id === 4 }).map((p) => p.id)).not.toContain(4);
    const old = [{ date: '2026-11-23', items: [{ ...item(20, 'post'), publishedOn: undefined, publishedUrl: 'https://www.instagram.com/p/X/' }, { ...item(21, 'post'), publishedOn: undefined, publishedUrl: 'https://youtube.com/shorts/x' }] }];
    expect(selectItems(old, '2026-11-23').map((p) => p.id)).toEqual([21]);
  });

  it('captions: igCaption wins, else the Instagram part of the row text; tags after a blank line', () => {
    expect(captionFor({ caption: { instagram: 'Сценарий\n\nInstagram:\nСтрока 1\nСтрока 2\n#бот #бизнес' } })).toBe('Строка 1\nСтрока 2\n\n#бот #бизнес');
    expect(captionFor({ caption: { instagram: 'Просто текст' } })).toBe('Просто текст');
    expect(captionFor({ caption: { instagram: 'x' }, igCaption: 'готово\n\n#a' })).toBe('готово\n\n#a');
    expect(captionFor({ caption: { instagram: 'a'.repeat(3000) } })).toHaveLength(2200);
  });

  it('files per kind: one carousel picture becomes a post; at most 10', () => {
    expect(filesFor('carousel', Array.from({ length: 12 }, (_, i) => png(`${i}.png`)))).toHaveLength(10);
    expect(filesFor('clip', [png('c.png')])).toBeNull();
    expect(selectItems([{ date: '2026-11-23', items: [item(30, 'carousel')] }], '2026-11-23')[0]!.kind).toBe('post');
  });

  it('dry-run plan names every item and marks the ones beyond the limits', () => {
    const plan = selectItems(days, '2026-11-23');
    const text = formatPlan(plan, { date: '2026-11-23', limit: 6, leftToday: 2 });
    expect(text.split('\n')[0]).toBe('Instagram на 2026-11-23: к публикации 5, в этот запуск 2 (лимит запуска 6, осталось на сегодня 2).');
    expect(text).toContain('1. #4 рилс (2026-11-23) «t4», файлов: 1');
    expect(text).toContain('2. #5 карусель');
    expect(text).toContain(' - #2 пост (2026-11-22) «t2», файлов: 1, подпись: 16 симв. [не в этот запуск]');
  });
});
