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
  niche: z.string().min(2).max(30),
  ru: contentSchema,
  en: contentSchema,
});
export type ArticleJson = z.infer<typeof articleSchema>;

/** The RU content alone, to ask for it first (the English one is a translation of the approved shape). */
export const ruPartSchema = z.object({ slug: articleSchema.shape.slug, ru: contentSchema });

/** The owner's preview: title, description, headings, first characters. */
export function articleSummary(a: ArticleJson, nicheName: string): string {
  const heads = a.ru.blocks.filter((b): b is Extract<Block, { type: 'h2' }> => b.type === 'h2').map((b) => `- ${b.text}`);
  return `Статья для блога, ниша «${nicheName}», ${wordCount(a.ru)} слов RU и ${wordCount(a.en)} EN.\n${a.ru.title}\nОписание: ${a.ru.description}\nРазделы:\n${heads.join('\n')}`;
}

/** What the card shows as the proposed text: the first 600 characters of the RU body. */
export function articlePreview(a: ArticleJson): string {
  const body = a.ru.blocks.filter((b) => b.type === 'p' || b.type === 'h2').map((b) => blockText(b)).join('\n\n');
  return body.length > 600 ? `${body.slice(0, 600).trimEnd()}…\n\n(полный текст RU и EN уйдёт строителю в issue)` : body;
}

export const articleTargetPath = (slug: string): string => `src/content/blog/${slug}.ts`;

/**
 * Instruction for the builder (the main window): turn the JSON into the site's typed article file, register it,
 * run the site checks. Written once here so the issue text is the same every time.
 */
export function builderInstruction(a: ArticleJson, today: string): string {
  return [
    `Одобренная владельцем статья блога firtech.pro. Сделайте в репозитории сайта (firtech, ветка и проверки по его CLAUDE.md):`,
    `1. Создайте файл \`${articleTargetPath(a.slug)}\`: \`export const <camelCase slug>: Article\` с полями из JSON ниже, \`published: true\`, \`date: '${today}'\`. Тексты без правок смысла; одну ссылку на \`/ru/solutions/${a.niche}\` (в EN \`/en/solutions/${a.niche}\`) добавьте в блок callout или cta, если блоки блога поддерживают ссылку, иначе упомяните в комментарии к issue.`,
    `2. Добавьте статью в массив \`articles\` в \`src/content/blog/index.ts\`. Проверьте, что slug уникален.`,
    `3. Прогоните тесты сайта (tests/blog.test.mjs: без длинных тире, цены только через \`price.*\`, 600-1300 слов), typecheck, lint, build. Не публикуйте в прод без решения владельца.`,
    `4. Закройте issue комментарием с веткой или коммитом.`,
  ].join('\n');
}
