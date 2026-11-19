import { allowedPrices } from './directions.js';
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
