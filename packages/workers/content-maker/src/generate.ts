import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryJson, type Db, type LlmClient } from '@fir/core';
import { DIRECTIONS, priceLine } from './directions.js';
import { carouselSchema, clipSchema, postSchema, profileSchema, renderCarousel, renderClip, renderPost, renderProfile, renderStory, storySchema, titleOf, type ItemType } from './format.js';
import { estimateSeconds, lintText } from './lint.js';
import type { Topic } from './topics.js';

export interface Prompts {
  system: string;
  clip: string;
  carousel: string;
  post: string;
  story: string;
  profile: string;
  articleSystem: string;
  articleRu: string;
  articleEn: string;
  articleAiRu: string;
  articleAiEn: string;
}

export function loadPrompts(dir: string): Prompts {
  const read = (f: string) => readFileSync(join(dir, f), 'utf8').trim();
  return { system: read('system.md'), clip: read('clip.md'), carousel: read('carousel.md'), post: read('post.md'), story: read('story.md'), profile: read('profile.md'), articleSystem: read('article.md'), articleRu: read('article-ru.md'), articleEn: read('article-en.md'), articleAiRu: read('article-ai-ru.md'), articleAiEn: read('article-ai-en.md') };
}

export interface GenSpec {
  type: ItemType;
  topic: Topic;
  /** Label of the pack week, e.g. "с 23.11". */
  week: string;
  /** The owner's comment on a rejected earlier version. */
  comment?: string;
  /** Text of the rejected earlier version. */
  previous?: string;
  /** Latest niche trends (hooks and formats) as inspiration; empty or absent: none. */
  trends?: TrendHint[];
  /** The blog article a carousel or a reel is made from (title, h2 outline, first paragraph): the structure to follow. */
  source?: string;
}

/** One trend from the Trend scout, reduced to what a script needs. */
export interface TrendHint {
  hook: string;
  format: string;
  why: string;
  /** Direction id the scout suggested, if any. */
  direction?: string;
}

/** Where the content-maker gets fresh trends. The safe default is none. */
export type TrendsProvider = (ctx: { db: Db; now: () => number }) => TrendHint[];
export const noTrends: TrendsProvider = () => [];

export interface Generated {
  text: string;
  title: string;
  /** Brand-voice problems that remain after the one automatic repair. */
  issues: string[];
}

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

function userPrompt(p: Prompts, spec: GenSpec, fix?: { text: string; issues: string[] }): string {
  const dir = DIRECTIONS.find((d) => d.id === spec.topic.directionId);
  const extra: string[] = [];
  if (spec.comment) extra.push(`Прошлый вариант отклонён. Комментарий владельца: ${spec.comment}\nУчти его и напиши заново.`);
  if (spec.trends && spec.trends.length > 0) {
    extra.push(
      `Свежие тренды ниши (только вдохновение для темы и формы; не копируй чужие тексты и названия, не упоминай источники):\n${spec.trends
        .map((t) => `- хук: ${t.hook}; формат: ${t.format}; почему растёт: ${t.why}`)
        .join('\n')}`,
    );
  }
  if (spec.source) extra.push(spec.source);
  if (spec.previous) extra.push(`Отклонённый вариант (не повторяй его):\n${spec.previous}`);
  if (fix) extra.push(`В черновике найдены нарушения правил: ${fix.issues.join('; ')}. Исправь их и верни полный JSON.\nЧерновик:\n${fix.text}`);
  return fill(p[spec.type], {
    week: spec.week,
    topic: spec.topic.text,
    direction: dir ? `${dir.name}: ${dir.summary}` : 'свободная тема, выбери направление по смыслу',
    price: dir ? priceLine(dir) : DIRECTIONS.map((d) => `${d.name} ${priceLine(d)}`).join('; '),
    extra: extra.join('\n\n'),
  });
}

async function once(llm: LlmClient, p: Prompts, spec: GenSpec, fix?: { text: string; issues: string[] }): Promise<Generated | null> {
  const req = { tier: 'sonnet' as const, system: p.system, messages: [{ role: 'user' as const, content: userPrompt(p, spec, fix) }], maxTokens: 3000 };
  const withCta = <T extends { cta: string }>(c: T): T => (/firtech\.pro/i.test(c.cta) ? c : { ...c, cta: `${c.cta.replace(/[.\s]+$/, '')}. Ссылка: firtech.pro` });
  if (spec.type === 'clip') {
    const parsed = await tryJson(llm, req, clipSchema);
    if (!parsed) return null;
    const clip = withCta(parsed);
    const text = renderClip(clip);
    const issues = lintText(text);
    const sec = estimateSeconds(clip.scenes.map((s) => s.voice));
    if (sec < 15 || sec > 46) issues.push(`озвучка занимает около ${sec} с, нужно 20-40`);
    return { text, title: titleOf(text), issues };
  }
  if (spec.type === 'post') {
    const parsed = await tryJson(llm, req, postSchema);
    if (!parsed) return null;
    // the caption must end with a call to action; the model sometimes forgets it
    const post = /@firtech_bot|firtech\.pro/i.test(parsed.caption) ? parsed : { ...parsed, caption: `${parsed.caption.trimEnd()}\n\nНапишите нам: @firtech_bot` };
    const text = renderPost(post);
    return { text, title: titleOf(text), issues: lintText(text, { noPrices: true }) };
  }
  if (spec.type === 'story') {
    const parsed = await tryJson(llm, req, storySchema);
    if (!parsed) return null;
    const text = renderStory(parsed);
    return { text, title: titleOf(text), issues: lintText(text, { noPrices: true }) };
  }
  if (spec.type === 'profile') {
    const parsed = await tryJson(llm, req, profileSchema);
    if (!parsed) return null;
    const text = renderProfile(parsed);
    return { text, title: titleOf(text), issues: lintText(text, { noPrices: true, cta: false }) };
  }
  const parsed = await tryJson(llm, req, carouselSchema);
  if (!parsed) return null;
  const text = renderCarousel(withCta(parsed));
  return { text, title: titleOf(text), issues: lintText(text) };
}

/**
 * One content item through the gateway: strict JSON, validated; the brand-voice lint runs on the result and,
 * if it finds problems, the model gets one repair pass. null when the model is off or keeps failing.
 */
export async function generateItem(llm: LlmClient, p: Prompts, spec: GenSpec): Promise<Generated | null> {
  const first = await once(llm, p, spec);
  if (!first || first.issues.length === 0) return first;
  const second = await once(llm, p, spec, { text: first.text, issues: first.issues });
  return second && second.issues.length < first.issues.length ? second : first;
}
