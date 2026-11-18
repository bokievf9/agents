import { allowedPrices } from './directions.js';

/**
 * Brand-voice checks from the content plan (section 6). Returns human-readable problems; the generator asks
 * the model to fix them once, and anything left goes to the owner as a warning above the item.
 */
export function lintText(text: string): string[] {
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
  const allowed = allowedPrices();
  const bad = [...text.matchAll(/\$\s?(\d[\d ]*)|(\d[\d ]*)\s?(?:\$|usd|долл)/gi)]
    .map((m) => Number((m[1] ?? m[2] ?? '').replace(/\s/g, '')))
    .filter((n) => n > 0 && !allowed.has(n));
  if (bad.length) issues.push(`цена не из справки: $${[...new Set(bad)].join(', $')}`);
  if (!/firtech\.pro/i.test(text)) issues.push('нет firtech.pro в призыве');
  return issues;
}

/** Rough voice-over length: about 2.5 words a second. */
export function estimateSeconds(voice: string[]): number {
  const words = voice.join(' ').split(/\s+/).filter(Boolean).length;
  return Math.round(words / 2.5);
}
