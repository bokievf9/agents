import { detectText, lintCaption, type DetectResult } from '@fir/core';
import { allowedPrices } from './directions.js';
import { splitPlatforms } from './format.js';
import { parseReel } from './reel.js';

/**
 * Brand-voice checks from the content plan (section 6). Returns human-readable problems; the generator asks
 * the model to fix them once, and anything left goes to the owner as a warning above the item.
 */
export function lintText(text: string, opts: { noPrices?: boolean; cta?: boolean } = {}): string[] {
  const issues: string[] = [];
  const rules: [RegExp, string][] = [
    [/(?<!\p{L})не(?!\p{L})[^.\n!?]{1,50}[,;]\s*а(?!\p{L})/iu, 'оборот «не X, а Y»'],
    [/(?<!\p{L})это\s+не(?!\p{L})/iu, 'оборот «это не X»'],
    [/(?<!\p{L})дело\s+не\s+в(?!\p{L})/iu, 'оборот «дело не в X»'],
    [/без [^,.\n]{1,40},\s*без [^,.\n]{1,40}/i, 'перечисление «без A, без B»'],
    [/никаких [^,.\n]{1,40},\s*никаких/i, 'перечисление «никаких A, никаких B»'],
    [/откройте для себя|революци|следующий уровень|погрузитесь|вот в чём дело|в современном мире/i, 'стоковая фраза'],
    [/—|–/, 'длинное тире'],
    [/[\u{1F300}-\u{1FAFF}☀-➿]/u, 'эмодзи'],
    [/[+]?\d+\s?%|в\s+\d+\s+раза?\s+(больше|быстрее|меньше)|окупится/i, 'обещание цифры результата'],
    [/наши клиенты|наш опыт внедрения/i, 'выдуманные клиенты'],
  ];
  for (const [re, label] of rules) if (re.test(text)) issues.push(label);
  if (opts.noPrices) {
    if (/\$\s?\d|\d\s?(?:\$|usd|долл)|(?<!\p{L})(?:стоит|стоимость|цена|цену|цены)(?!\p{L})\s+(?:от\s+)?\d/iu.test(text)) issues.push('цена в тексте: в этом материале цен нет');
    if (/цифра дня/i.test(text)) issues.push('«цифра дня» не используем');
  }
  const allowed = allowedPrices();
  const bad = opts.noPrices ? [] : [...text.matchAll(/\$\s?(\d[\d ]*)|(\d[\d ]*)\s?(?:\$|usd|долл)/gi)]
    .map((m) => Number((m[1] ?? m[2] ?? '').replace(/\s/g, '')))
    .filter((n) => n > 0 && !allowed.has(n));
  if (bad.length) issues.push(`цена не из справки: $${[...new Set(bad)].join(', $')}`);
  if (opts.cta !== false && !(opts.noPrices ? /firtech\.pro|@firtech_bot/i : /firtech\.pro/i).test(text)) issues.push(opts.noPrices ? 'нет @firtech_bot или firtech.pro в призыве' : 'нет firtech.pro в призыве');
  return issues;
}

/** Rough voice-over length: about 2.5 words a second. */
export function estimateSeconds(voice: string[]): number {
  const words = voice.join(' ').split(/\s+/).filter(Boolean).length;
  return Math.round(words / 2.5);
}

/** AI tells that are not in `lintText`: a self-answered question («Результат? Быстрее.») and a colon reveal («Главное: он учится»). */
const SELF_ANSWER = /(?<![\p{L}\p{N}])\p{Lu}\p{L}*(?:[ \t]+\p{L}+){0,2}\?[ \t]+\p{Lu}/u;
const COLON_REVEAL = /(?:^|\n|[.!?:]\s)(?:главное|итог|результат|секрет|плюс|бонус)\s*:/iu;
/** Calls to action: a verb that asks the viewer to do something. */
const CTA_VERB = /(?<![\p{L}])(?:напишите|пишите|перейдите|переходите|подпишитесь|сохраните|жмите|нажмите|оставьте|закажите|заходите|звоните|скачайте)(?![\p{L}])/giu;

/**
 * Hard rules of a reel script, checked by the marketing head before the item goes to approval (the Content maker's checklist):
 * a hook sentence in the first 2 seconds, one call to action, no AI tells, prices only from the price list. Works on the
 * text `renderClip` produces (the head passes the worker's whole result: the line before the «Клип» header is ignored).
 * Returns [] for texts that are not a reel script.
 */
export function lintReelScript(text: string): string[] {
  const at = text.search(/^Клип(?:,\s*\d+\s*с)?:/m);
  if (at < 0) return [];
  const script = text.slice(at);
  const reel = parseReel(script);
  if (!reel) return [];
  const issues: string[] = [];
  const body = script.split(/^== (?:Instagram|TikTok|Shorts) ==\s*$/m)[0]!;
  const words = reel.hook.trim().split(/\s+/).filter(Boolean).length;
  if (!/^Хук[^:\n]*:\s*\S/m.test(body) || words < 3) issues.push('нет предложения-хука в первых секундах');
  else if (reel.hook.length > 90) issues.push('хук длиннее 90 знаков, его не произнести за 2 секунды');
  const targets = new Set([...body.matchAll(/firtech\.pro|@firtech_bot/gi)].map((m) => m[0].toLowerCase()));
  const verbs = (reel.cta.match(CTA_VERB) ?? []).length;
  if (targets.size > 1 || verbs > 1) issues.push('больше одного призыва');
  if (!reel.cta) issues.push('нет призыва CTA');
  for (const i of lintText(script)) if (!issues.includes(i)) issues.push(i);
  if (SELF_ANSWER.test(body)) issues.push('самоответный вопрос («Результат? Быстрее.»)');
  if (COLON_REVEAL.test(body)) issues.push('разоблачение через двоеточие («Главное: ...»)');
  return issues;
}

const SHAPE = /^(?:Клип(?:,\s*\d+\s*с)?|Карусель[^:\n]*|Пост|История[^:\n]*):/m;

export interface CopyLint {
  /** Remarks that send the text back to the Content maker once (empty: the text passes). */
  issues: string[];
  /** `text.detect` score of the script and of the caption, the lower one; null when there was nothing to score. */
  human: number | null;
  /** `text.captionLint` verdict of the Instagram caption; null when the item has none (stories). */
  caption: 'ready' | 'review' | 'fix' | null;
  /** One line for the approval card: «Проверка текста: человечность 81, подпись ок». */
  line: string;
}

/** Script lines of an item without labels and numbering, one per line: what a person would hear or read on the slides. */
function scriptLines(body: string): string {
  const reel = parseReel(body);
  if (reel) return [reel.hook, ...reel.scenes.map((s) => s.voice), reel.cta].filter(Boolean).join('\n');
  return body
    .split('\n')
    .slice(1)
    .map((l) => l.trim().replace(/^\d+[.)]\s*/, '').replace(/^(?:CTA|Куда ведёт|На картинке):?\s*/, ''))
    .filter(Boolean)
    .join('\n');
}

const CAPTION_VERDICT_RU = { ready: 'ок', review: 'есть замечания', fix: 'исправить' } as const;

function slopIssue(where: string, d: DetectResult): string | null {
  const stock = d.slop.slice(0, 4).map((s) => `«${s.find.replace(/\*$/, '')}»`).join(', ');
  const shapes = d.structures.filter((x) => x.id !== 'uniform-length').slice(0, 2).map((x) => x.name).join('; ');
  // a rework is for clearly machine-written text: stock words, a visible fingerprint or a very low score; a bland script only shows its number on the card
  if (d.checks.slop_density.score >= 40 && d.checks.fingerprint.score >= 40 && d.score >= 35) return null;
  return `${where}: человечность ${Math.round(d.score)}${stock ? `, штампы ${stock}` : ''}${shapes ? `, переписать обороты: ${shapes}` : ''}`;
}

/**
 * The text checks of the marketing head, run before a content item reaches the owner: `text.detect` on the script and on the caption,
 * `text.captionLint` on the Instagram caption (the 125-character window, 2200, hashtags up to 5, search terms none here). A failing
 * result is `issues`: the head sends it back for one rework. Returns null for a text that is not a content item (profile kits, reports).
 */
export function lintCopy(result: string): CopyLint | null {
  const at = result.search(SHAPE);
  if (at < 0) return null;
  const { body, sections } = splitPlatforms(result.slice(at));
  const issues: string[] = [];
  const scores: number[] = [];
  const script = scriptLines(body);
  if (script.trim()) {
    const d = detectText(script, 'ru');
    scores.push(d.score);
    const issue = slopIssue('сценарий', d);
    if (issue) issues.push(issue);
  }
  let caption: CopyLint['caption'] = null;
  const ig = sections.instagram;
  if (ig) {
    const plain = ig.replace(/(?:^|\s)#[\p{L}\p{N}_]+/gu, ' ').trim();
    if (plain) {
      const d = detectText(plain, 'ru');
      scores.push(d.score);
      const issue = slopIssue('подпись', d);
      if (issue) issues.push(issue);
    }
    const c = lintCaption(ig, { lang: 'ru' });
    caption = c.verdict;
    if (c.verdict === 'fix') issues.push(`подпись Instagram: ${c.checks.filter((x) => x.status === 'fail').map((x) => x.detail).join('; ')}`);
  }
  const human = scores.length ? Math.round(Math.min(...scores)) : null;
  const parts = [human === null ? '' : `человечность ${human}`, caption ? `подпись ${CAPTION_VERDICT_RU[caption]}` : ''].filter(Boolean);
  return { issues, human, caption, line: parts.length ? `Проверка текста: ${parts.join(', ')}.` : '' };
}
