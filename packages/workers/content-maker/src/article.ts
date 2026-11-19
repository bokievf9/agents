import { z } from 'zod';
import { lintText } from './lint.js';

/**
 * Blog article in the format of the site (firtech/src/content/blog/types.ts): one object per article, RU and EN side by
 * side, blocks `p`, `h2`, `list`, `callout`, `cta`. The rules mirror firtech/tests/blog.test.mjs and the «Blog» section
 * of firtech/CLAUDE.md: no long dashes, no dollar amounts (prices only through the site's `price.*` tokens, and an
 * article says «цену назовёт конструктор»), no percentages, 600-1300 words per language (RU is asked for 700-1200).
 */
const listItem = z.union([z.string().min(1), z.object({ title: z.string().min(1), text: z.string().min(1) })]);
export const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('p'), text: z.string().min(1) }),
  z.object({ type: z.literal('h2'), text: z.string().min(1).max(120) }),
  z.object({ type: z.literal('list'), ordered: z.boolean().optional(), items: z.array(listItem).min(2).max(12) }),
  z.object({ type: z.literal('callout'), title: z.string().optional(), text: z.string().min(1) }),
  z.object({ type: z.literal('cta'), title: z.string().optional(), text: z.string().optional() }),
]);
export type Block = z.infer<typeof blockSchema>;

export const contentSchema = z.object({
  title: z.string().min(10).max(110),
  description: z.string().min(120).max(160),
  blocks: z.array(blockSchema).min(8),
});
export type ArticleContent = z.infer<typeof contentSchema>;

const FAQ_RE = /частые вопросы|faq|frequently asked/i;

function blockText(b: Block): string {
  switch (b.type) {
    case 'list': return b.items.map((i) => (typeof i === 'string' ? i : `${i.title} ${i.text}`)).join(' ');
    case 'callout': return `${b.title ?? ''} ${b.text}`;
    case 'cta': return '';
    default: return b.text;
  }
}

/** Same count as the site's `wordCount` (title plus block text). */
export function wordCount(c: ArticleContent): number {
  return [c.title, ...c.blocks.map(blockText)].join(' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export const articleText = (c: ArticleContent): string => [c.title, c.description, ...c.blocks.map(blockText)].join(' ');

/** The FAQ is an h2 «Частые вопросы» followed by a list of exactly three question-and-answer items. */
export function faqItems(c: ArticleContent): number {
  const at = c.blocks.findIndex((b) => b.type === 'h2' && FAQ_RE.test(b.text));
  const list = at >= 0 ? c.blocks.slice(at + 1).find((b) => b.type === 'list') : undefined;
  return list && list.type === 'list' ? list.items.filter((i) => typeof i !== 'string').length : 0;
}

/** Problems of one language of the article; empty means it can go to the owner. */
export function contentIssues(c: ArticleContent, lang: 'ru' | 'en'): string[] {
  const out: string[] = [];
  const words = wordCount(c);
  const [min, max] = lang === 'ru' ? [700, 1200] : [600, 1300];
  if (words < min || words > max) out.push(`${lang}: ${words} слов, нужно ${min}-${max}`);
  if (c.blocks.filter((b) => b.type === 'h2').length < 4) out.push(`${lang}: меньше четырёх заголовков h2`);
  if (!c.blocks.some((b) => b.type === 'cta')) out.push(`${lang}: нет блока cta со ссылкой на конструктор`);
  if (faqItems(c) !== 3) out.push(`${lang}: в разделе частых вопросов должно быть ровно 3 вопроса (список из элементов title и text)`);
  const text = articleText(c);
  if (/[–—]/.test(text)) out.push(`${lang}: длинное тире`);
  if (/\$\s?\d|\d\s?(?:\$|usd|долл)/i.test(text)) out.push(`${lang}: сумма в долларах (цен в статье нет, только «цену назовёт конструктор»)`);
  if (/\d+\s?%/.test(text)) out.push(`${lang}: процент (на сайте процент разрешён только для скидки пакета, статья его не пишет)`);
  if (lang === 'ru') for (const i of lintText(text, { noPrices: true, cta: false })) if (!['цена в тексте: в этом материале цен нет'].includes(i)) out.push(`ru: ${i}`);
  return out;
}

export const articleSchema = z.object({
  slug: z.string().min(3).max(60).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug: latin letters, digits, hyphens'),
  /** A niche id, or `ai` for the «ИИ для бизнеса» line. */
  niche: z.string().min(2).max(30),
  ru: contentSchema,
  en: contentSchema,
});
export type ArticleJson = z.infer<typeof articleSchema>;

/** The RU content alone, to ask for it first (the English one is a translation of the approved shape). */
export const ruPartSchema = z.object({ slug: articleSchema.shape.slug, ru: contentSchema });

/** The line of the day by weekday (1 = Monday ... 7 = Sunday): Mon, Wed, Fri, Sun «ИИ для бизнеса», Tue, Thu, Sat a niche. */
export const articleLineOn = (dow: number): 'ai' | 'niche' => (dow % 2 === 1 ? 'ai' : 'niche');

/** «ai», «ии», «ИИ для бизнеса»: the owner asks for the AI line instead of a niche. */
export const isAiAsk = (s: string): boolean => /^(ai|ии|и-и)(?![\p{L}])/iu.test(s.trim());

/** ASCII kebab-case slug from the English title, 3-60 characters. */
export function slugFromTitle(title: string): string {
  const base = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const cut = base.length > 60 ? base.slice(0, 60).replace(/-[^-]*$/, '') || base.slice(0, 60) : base;
  return cut.length >= 3 ? cut.replace(/-+$/, '') : 'ai-article';
}

/** `base`, then `base-2`, `base-3`... until `taken` says the slug is free; always within 60 characters. */
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  let slug = base;
  for (let n = 2; taken(slug); n++) {
    const suffix = `-${n}`;
    slug = `${base.slice(0, 60 - suffix.length).replace(/-+$/, '')}${suffix}`;
  }
  return slug;
}

/** An article exactly as the site's `Article` type (firtech/src/content/blog/types.ts). */
export interface PublicArticle {
  slug: string;
  published: true;
  date: string;
  ru: ArticleContent;
  en: ArticleContent;
}

/** What `/blog` serves for an approved row; null for a row that cannot be served (not published, unreadable JSON). */
export function toPublicArticle(row: { slug: string; json: string; date: string | null; published: boolean }): PublicArticle | null {
  if (!row.published || !row.date) return null;
  try {
    const a = articleSchema.parse(JSON.parse(row.json));
    return { slug: row.slug, published: true, date: row.date, ru: a.ru, en: a.en };
  } catch {
    return null;
  }
}

const firstParagraph = (c: ArticleContent): string => {
  const p = c.blocks.find((b) => b.type === 'p');
  return p && p.type === 'p' ? p.text : '';
};

/** The «Статья дня» card: line, title, description, the h2 outline. */
export function articleSummary(a: ArticleJson, nicheName: string): string {
  const heads = a.ru.blocks.filter((b): b is Extract<Block, { type: 'h2' }> => b.type === 'h2').map((b) => `- ${b.text}`);
  const line = a.niche === 'ai' ? 'ИИ для бизнеса' : `ниша «${nicheName}»`;
  return `Статья дня, ${line}, ${wordCount(a.ru)} слов RU и ${wordCount(a.en)} EN.\n${a.ru.title}\nОписание: ${a.ru.description}\nРазделы:\n${heads.join('\n')}`;
}

/** What the card shows as the proposed text: the first paragraph of the RU body. */
export function articlePreview(a: ArticleJson): string {
  const body = firstParagraph(a.ru);
  return body.length > 600 ? `${body.slice(0, 600).trimEnd()}…` : body;
}

/** The article as a source for a carousel and a reel script: title, h2 outline, first paragraph, link. */
export function articleSource(a: ArticleJson): string {
  const heads = a.ru.blocks.filter((b): b is Extract<Block, { type: 'h2' }> => b.type === 'h2').map((b) => b.text).filter((t) => !FAQ_RE.test(t));
  return [
    `Материал сделан из статьи блога «${a.ru.title}» (firtech.pro/ru/blog/${a.slug}). Опирайся на её содержание, не выдумывай новых фактов.`,
    `Разделы статьи (h2): ${heads.join('; ')}.`,
    `Первый абзац: ${firstParagraph(a.ru).slice(0, 500)}`,
  ].join('\n');
}
