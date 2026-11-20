import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { knowledgeDir } from '../playbooks.js';
import type { Kit } from './kit.js';
import { fail, okv, type ToolResult } from './result.js';
import { EN_INVISIBLE, EN_PHRASES, EN_STRUCTURES, EN_WORDS } from './text-lexicon-en.js';
import { RU_PHRASES, RU_STRUCTURES, RU_WORDS } from './text-lexicon-ru.js';
import type { LexEntry, StructureRule } from './text-types.js';

/**
 * Text tools for marketing, sales and support (`text.*`): five local heuristics ported from instagram-agent-skill (MIT, 2026, Jake Schincariol),
 * made bilingual (RU and EN). They measure properties that weak copy shares; they are not a view predictor and not a detector's verdict.
 * Everything is a pure function (exported with a plain name) and a `ToolResult` wrapper (`ctx.tools.text.*`).
 */
export type Lang = 'ru' | 'en';

const clamp = (n: number): number => Math.max(0, Math.min(100, n));
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pstdev = (a: number[]): number => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};
const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const scale = (value: number, human: number, machine: number): number => (human === machine ? 50 : clamp(((value - machine) / (human - machine)) * 100));
const round1 = (n: number): number => Math.round(n * 10) / 10;
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Russian when a third of the letters are Cyrillic, else English. */
export function detectLang(text: string): Lang {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const cyr = text.match(/[Ѐ-ӿ]/g)?.length ?? 0;
  return letters > 0 && cyr / letters > 0.3 ? 'ru' : 'en';
}
const langOf = (lang: string | undefined, text: string): Lang => (lang === 'ru' || lang === 'en' ? lang : detectLang(text));
const tr = (lang: Lang, ru: string, en: string): string => (lang === 'ru' ? ru : en);

const WORD_RE = /[\p{L}\p{N}$%'’-]+/gu;
/** "$18,000" and "18 000" are one word when spoken. */
const joinNumbers = (t: string): string => t.replace(/(?<=\d)[,\u00A0\u202F ](?=\d{3}(?!\d))/g, '');
const words = (t: string): string[] => joinNumbers(t).match(WORD_RE) ?? [];
const bare = (w: string): string => w.toLowerCase().replace(/^['’-]+|['’-]+$/g, '');

const NUMBER_RE = /\$\s?\d+(?:\.\d+)?|\d+(?:\.\d+)?/g;
const PROPER_RE = /(?<!^)(?<![.!?]\s)(?<![\p{L}\p{N}])\p{Lu}\p{Ll}{2,}(?![\p{L}])/gu;
const HASHTAG_RE = /(?:^|\s)(#[\p{L}\p{N}_]+)/gu;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2190-\u21FF]|\uFE0F/gu;

const SPOKEN: Record<Lang, ReadonlySet<string>> = {
  en: new Set(['zero', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'fifteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'million', 'billion', 'dozen', 'half', 'twice', 'triple']),
  // "один" is filler more often than a quantity, as "one" in English
  ru: new Set(['ноль', 'нуля', 'нулю', 'нулём', 'ноля', 'два', 'две', 'двух', 'двое', 'три', 'трёх', 'трех', 'трое', 'четыре', 'четырёх', 'четырех', 'пять', 'пяти', 'шесть', 'шести', 'семь', 'семи', 'восемь', 'восьми', 'девять', 'девяти', 'десять', 'десяти', 'одиннадцать', 'двенадцать', 'пятнадцать', 'двадцать', 'двадцати', 'тридцать', 'тридцати', 'сорок', 'пятьдесят', 'пятидесяти', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто', 'сто', 'сотня', 'сотни', 'двести', 'триста', 'пятьсот', 'тысяча', 'тысячи', 'тысяч', 'тысячу', 'миллион', 'миллиона', 'миллионов', 'миллиард', 'полтора', 'полторы', 'вдвое', 'втрое', 'пополам', 'дважды', 'трижды']),
};
const MONEY: Record<Lang, ReadonlySet<string>> = {
  en: new Set(['dollars', 'dollar', 'bucks', 'grand', 'percent', 'cents', 'millionaire', 'billionaire', 'revenue', 'profit', 'salary', 'rent']),
  ru: new Set(['доллар', 'доллара', 'долларов', 'долларах', 'рубль', 'рубля', 'рублей', 'сомони', 'сум', 'сумов', 'тенге', 'процент', 'процента', 'процентов', 'зарплата', 'зарплату', 'выручка', 'выручку', 'прибыль', 'прибыли', 'аренда', 'аренду', 'штраф', 'штрафа', 'миллионер', 'копейки', 'копеек']),
};
const STAKES: Record<Lang, ReadonlySet<string>> = {
  en: new Set(['stop', 'never', 'wrong', 'mistake', 'mistakes', 'lost', 'lose', 'losing', 'cost', 'costs', 'broke', 'broken', 'failed', 'failure', 'fail', 'nobody', 'no', 'not', "don't", 'dont', "doesn't", "didn't", "can't", "won't", 'quit', 'quitting', 'fired', 'deleted', 'delete', 'killed', 'kills', 'kill', 'replaced', 'replaces', 'cut', 'beat', 'free', 'paid', 'charged', 'hired', 'saved', 'first', 'banned', 'illegal', 'worst', 'hate', 'hated', 'wasted', 'waste', 'scam', 'lie', 'lied', 'lying', 'truth', 'secret', 'hidden', 'stole', 'stolen', 'before', 'until', 'instead', 'but', 'except', 'unless', 'problem', 'risk', 'danger', 'warning', 'regret', 'wish', 'should', "shouldn't", 'still', 'already', 'only', 'without', 'versus', 'vs', 'actually']),
  ru: new Set(['стоп', 'хватит', 'никогда', 'не', 'нет', 'ни', 'никто', 'ошибка', 'ошибки', 'ошибку', 'ошибок', 'неправильно', 'потерял', 'потеряла', 'потеряли', 'теряете', 'теряешь', 'теряем', 'потеря', 'стоила', 'стоил', 'стоило', 'стоят', 'сломал', 'сломалось', 'провал', 'провалился', 'провалятся', 'бесплатно', 'платите', 'заплатил', 'заплатила', 'уволили', 'удалил', 'убил', 'убивает', 'заменил', 'заменила', 'заменит', 'запрет', 'запретили', 'худший', 'ненавижу', 'зря', 'напрасно', 'обман', 'ложь', 'врут', 'правда', 'секрет', 'скрытый', 'скрывают', 'украл', 'пока', 'вместо', 'но', 'кроме', 'проблема', 'проблему', 'проблемы', 'риск', 'опасно', 'опасность', 'предупреждение', 'жалею', 'пожалел', 'нельзя', 'только', 'уже', 'без', 'против', 'больше', 'слив', 'слили', 'сгорели', 'сгорел', 'штраф', 'долг', 'должны']),
};
const WEAK_OPENERS: Record<Lang, readonly string[]> = {
  en: ['so', 'ok', 'okay', 'hey', 'hi', 'hello', 'guys', 'yo', 'alright', 'welcome', 'today', 'basically', 'honestly', 'look', 'listen', 'um', 'just', 'let', 'lets', "let's", 'i wanted', 'i want', 'one of', 'have you', 'did you', 'do you', 'are you', 'in this', 'in today', 'the thing', 'a lot', 'there is', 'there are', 'this is', 'it is', 'as a', 'when it', "if you've", 'you know'],
  ru: ['ну', 'так', 'вот', 'привет', 'здравствуйте', 'всем', 'друзья', 'ребята', 'сегодня', 'итак', 'короче', 'честно', 'слушайте', 'хочу', 'давайте', 'знаете', 'а вы', 'в этом', 'это', 'есть', 'бывает', 'многие', 'как вы', 'вы знаете', 'вы когда'],
};
const IMPERATIVES: Record<Lang, ReadonlySet<string>> = {
  en: new Set(['stop', 'steal', 'copy', 'delete', 'try', 'watch', 'read', 'save', 'use', 'build', 'make', 'write', 'send', 'take', 'start', 'quit', 'never', 'always', "don't", 'dont', 'do', 'put', 'run', 'check']),
  ru: new Set(['стоп', 'хватит', 'не', 'перестаньте', 'перестань', 'украдите', 'своруйте', 'копируйте', 'удалите', 'удали', 'попробуйте', 'смотрите', 'прочитайте', 'сохраните', 'используйте', 'создайте', 'сделайте', 'напишите', 'отправьте', 'возьмите', 'начните', 'бросьте', 'никогда', 'всегда', 'проверьте', 'запомните']),
};
const STOP_WORDS: Record<Lang, ReadonlySet<string>> = {
  en: new Set(['the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'for', 'with', 'that', 'this', 'it', 'is', 'are', 'was', 'were', 'be', 'been', 'you', 'your', 'i', 'my', 'me', 'we', 'our', 'they', 'them', 'he', 'she', 'so', 'just', 'not', 'no', 'do', 'did', 'does', 'have', 'has', 'had', 'will', 'can', 'at', 'as', 'by', 'from', 'out', 'up', 'off', 'one', 'all']),
  ru: new Set(['и', 'в', 'во', 'на', 'с', 'со', 'к', 'о', 'об', 'от', 'до', 'по', 'за', 'из', 'у', 'а', 'но', 'или', 'что', 'это', 'как', 'не', 'ни', 'же', 'ли', 'бы', 'то', 'так', 'вот', 'я', 'мы', 'ты', 'вы', 'он', 'она', 'они', 'мне', 'нам', 'вам', 'мой', 'наш', 'ваш', 'вас', 'нас', 'был', 'была', 'было', 'были', 'есть', 'для', 'при', 'уже', 'ещё', 'еще', 'все', 'всё', 'весь', 'можно', 'нужно']),
};
const YOU: Record<Lang, RegExp> = {
  en: /\b(you|your|you're|youre|yourself)\b/i,
  ru: /(?<![\p{L}])(ты|тебя|тебе|тобой|твой|твоя|твоё|твои|вы|вас|вам|вами|ваш|ваша|ваше|ваши|вашего|вашу)(?![\p{L}])/iu,
};
const ME: Record<Lang, RegExp> = {
  en: /\b(i|my|me|we|our)\b/i,
  ru: /(?<![\p{L}])(я|мне|меня|мой|моя|моё|мои|мы|нас|наш|наша|наше|наши)(?![\p{L}])/iu,
};

const concreteRe = (): RegExp => /\$\s?\d|(?<![\p{L}\p{N}])\d[\d,.]*|(?<!^)(?<![.!?]\s)(?<![\p{L}])\p{Lu}\p{Ll}{2,}/gmu;
/** Numbers, names and spoken numbers: something checkable. */
export function concreteCount(text: string, lang: Lang): number {
  const spoken = words(text).filter((w) => SPOKEN[lang].has(bare(w)) || MONEY[lang].has(bare(w))).length;
  return (text.match(concreteRe())?.length ?? 0) + spoken;
}

// ---------------------------------------------------------------- hook score

/** The five scored properties of a hook; dealbreakers (greeting, «stop scrolling», preamble, hashtag, emoji) are listed apart and cost 15 points each. */
export const HOOK_PROPERTIES = ['length', 'specificity', 'stakes', 'frontload', 'address'] as const;
export type HookProperty = (typeof HOOK_PROPERTIES)[number];
export interface HookCheck {
  score: number;
  detail: string;
}
export interface HookResult {
  hook: string;
  score: number;
  verdict: 'strong' | 'ok' | 'weak';
  /** The weakest scored property. */
  weakest: HookProperty;
  checks: Record<HookProperty, HookCheck>;
  /** Dealbreakers found: greeting, «stop scrolling», preamble, hashtag, emoji. */
  dealbreakers: string[];
}

const DEALBREAKERS: Record<Lang, readonly [RegExp, string][]> = {
  en: [
    [/^\s*(?:stop scrolling|don'?t scroll)/i, 'Opens with "stop scrolling". Asking for attention proves you have not earned it.'],
    [/\b(?:in (?:this|today'?s) (?:video|reel)|i'?m going to show you|i'?ll show you how)\b/i, 'Video preamble. Delete it and open on the payoff.'],
    [/^\s*(?:hey |hi |what'?s up |welcome )/i, 'Greeting. Nobody came to the feed to be greeted.'],
    [/(?:^|\s)#\w+/, 'Hashtag in the hook. Hashtags belong at the bottom of the caption, if anywhere.'],
    [EMOJI_RE, 'Emoji in the hook. On-screen text at hook size has room for words or for an emoji, not both.'],
  ],
  ru: [
    [/^\s*(?:стоп[ -]скролл|не\s+листайте|не\s+пролистывайте|остановитесь)/iu, 'Начинается с «стоп-скролл». Просить внимание значит не заслужить его.'],
    [/(?<!\p{L})(?:в\s+этом\s+(?:видео|ролике|рилсе)|сегодня\s+я\s+(?:расскажу|покажу)|сегодня\s+мы\s+(?:поговорим|разберём|разберем)|я\s+покажу\s+вам\s+как)(?!\p{L})/iu, 'Предисловие к видео. Удалите и начните с главного.'],
    [/^\s*(?:всем\s+привет|привет(?:\s|,|!)|здравствуйте|добрый\s+(?:день|вечер)|дорогие\s+друзья|друзья,)/iu, 'Приветствие. В ленту не приходят за приветствием.'],
    [/(?:^|\s)#[\p{L}\p{N}_]+/u, 'Хэштег в хуке. Хэштеги живут внизу подписи, если нужны вообще.'],
    [EMOJI_RE, 'Эмодзи в хуке. В тексте на экране хватает места словам или эмодзи, но не обоим.'],
  ],
};

function hookFront(text: string, lang: Lang): HookCheck {
  const w = words(text);
  if (!w.length) return { score: 0, detail: tr(lang, 'пусто', 'empty') };
  const low = w.map(bare);
  const opener = low.slice(0, 2).join(' ');
  let penalty = 0;
  let hitOpener: string | null = null;
  for (const weak of WEAK_OPENERS[lang]) {
    if (opener.startsWith(weak) || low[0] === weak) {
      penalty = 30;
      hitOpener = weak;
      break;
    }
  }
  let payload: number | null = null;
  const propers = new Set<string>(text.match(PROPER_RE) ?? []);
  for (let i = 0; i < low.length; i++) {
    const t = low[i]!;
    if (STAKES[lang].has(t) || SPOKEN[lang].has(t) || MONEY[lang].has(t) || /^\$?\d/.test(w[i]!) || (i > 0 && propers.has(w[i]!))) {
      payload = i;
      break;
    }
  }
  let base: number;
  let where: string;
  if (payload === null) {
    base = 30;
    where = tr(lang, 'в строке нет ни одного слова с содержанием', 'no payload word anywhere in the line');
  } else if (payload <= 3) {
    base = 100;
    where = tr(lang, `содержание на слове ${payload + 1}`, `payload at word ${payload + 1}`);
  } else if (payload <= 6) {
    base = 70;
    where = tr(lang, `содержание на слове ${payload + 1}, можно ближе к началу`, `payload at word ${payload + 1}, could move forward`);
  } else {
    base = 40;
    where = tr(lang, `содержание на слове ${payload + 1}, слишком поздно`, `payload at word ${payload + 1}, too late`);
  }
  return { score: clamp(base - penalty), detail: where + (hitOpener ? tr(lang, `; слабое начало «${hitOpener}»`, `; weak opener "${hitOpener}"`) : '') };
}

function hookSpecific(text: string, lang: Lang): HookCheck {
  const nums = (joinNumbers(text).match(NUMBER_RE) ?? []).map((n) => n.trim());
  const propers = new Set<string>(text.match(PROPER_RE) ?? []);
  const spoken = words(text).map(bare).filter((w) => SPOKEN[lang].has(w) || MONEY[lang].has(w));
  const hits = nums.length + propers.size + spoken.length;
  const score = hits === 0 ? 15 : clamp(45 + hits * 30);
  const found = [...nums.slice(0, 2), ...[...propers].sort().slice(0, 2), ...spoken.slice(0, 2)].join(', ');
  return { score, detail: tr(lang, `конкретных примет: ${hits}`, `${hits} concrete marker(s)`) + (found ? `: ${found}` : tr(lang, ' - ни числа, ни имени, нечего проверить', ' - no number, no name, nothing checkable')) };
}

function hookStakes(text: string, lang: Lang): HookCheck {
  const markers = [...new Set(words(text).map(bare).filter((x) => STAKES[lang].has(x)))].sort();
  if (/\$\s?\d/.test(text)) markers.push(tr(lang, 'цена', 'a price'));
  const n = markers.length;
  const score = n === 0 ? 20 : n === 1 ? 70 : 100;
  return { score, detail: tr(lang, `маркеров напряжения: ${n}`, `${n} tension marker(s)`) + (n ? `: ${markers.slice(0, 4).join(', ')}` : tr(lang, ' - в этой строке ничего не поставлено на кон', ' - nothing is at stake in this line')) };
}

function hookAddress(text: string, lang: Lang): HookCheck {
  const w = words(text).map(bare);
  if (YOU[lang].test(text)) return { score: 100, detail: tr(lang, 'обращено к зрителю', 'speaks to the viewer') };
  if (w[0] && IMPERATIVES[lang].has(w[0])) return { score: 90, detail: tr(lang, `приказ в начале («${w[0]}»)`, `imperative opener ("${w[0]}")`) };
  if (ME[lang].test(text)) return { score: 70, detail: tr(lang, 'от первого лица, зритель не назван', 'first person, no viewer named') };
  return { score: 35, detail: tr(lang, 'в третьем лице, в комнате никого нет', 'third person, nobody in the room') };
}

function hookLength(text: string, lang: Lang): HookCheck {
  // a hook has to land before the thumb moves: about two seconds spoken (RU 150 wpm, EN 165)
  const n = words(text).length;
  const hi = lang === 'ru' ? 11 : 12;
  const lo = lang === 'ru' ? 4 : 5;
  const secs = n / (lang === 'ru' ? 2.5 : 2.75);
  const chars = text.trim().length;
  let score = n >= lo && n <= hi ? 100 : n < lo ? clamp(100 - (lo - n) * 20) : clamp(100 - (n - hi) * 11);
  if (chars > (lang === 'ru' ? 70 : 60)) score -= 12;
  return { score: clamp(score), detail: tr(lang, `${n} слов, ${chars} знаков, около ${secs.toFixed(1)} с вслух (нужно ${lo}-${hi} слов)`, `${n} words, ${chars} chars, ~${secs.toFixed(1)}s spoken (want ${lo}-${hi} words)`) };
}

/** One hook, scored on the five properties (length, specificity, stakes, front-load, address) and checked for dealbreakers. */
export function scoreHook(hook: string, lang?: string): HookResult {
  const l = langOf(lang, hook);
  const checks: Record<HookProperty, HookCheck> = { length: hookLength(hook, l), specificity: hookSpecific(hook, l), stakes: hookStakes(hook, l), frontload: hookFront(hook, l), address: hookAddress(hook, l) };
  const dealbreakers = DEALBREAKERS[l].filter(([re]) => re.test(hook)).map(([, msg]) => msg);
  const scores = HOOK_PROPERTIES.map((p) => checks[p].score);
  // the weakest property caps the hook: one bad property is enough for the thumb to keep moving
  const overall = clamp(mean(scores) * 0.6 + Math.min(...scores) * 0.4 - dealbreakers.length * 15);
  const weakest = HOOK_PROPERTIES.reduce((a, b) => (checks[b].score < checks[a].score ? b : a));
  const verdict = overall >= 70 && Math.min(...scores) >= 55 && dealbreakers.length === 0 ? 'strong' : overall >= 50 ? 'ok' : 'weak';
  for (const p of HOOK_PROPERTIES) checks[p] = { ...checks[p], score: round1(checks[p].score) };
  return { hook, score: round1(overall), verdict, weakest, checks, dealbreakers };
}

export interface HookRanking {
  ranked: HookResult[];
  best: HookResult | null;
  /** True when no hook reaches 50: none of them is the hook. */
  noneGoodEnough: boolean;
}
/** Hooks ranked best first. */
export function scoreHooks(hooks: string[], lang?: string): HookRanking {
  const ranked = hooks.map((h) => scoreHook(h, lang)).sort((a, b) => b.score - a.score);
  return { ranked, best: ranked[0] ?? null, noneGoodEnough: !ranked.some((r) => r.score >= 50) };
}

// ---------------------------------------------------------------- beats

export interface Beat {
  n: number;
  start: number;
  dur: number;
  words: number;
  text: string;
  concrete: number;
  label: '' | 'HOOK' | 'MID' | 'CTA' | 'HOOK/CTA';
  flags: string[];
}
export interface BeatSheet {
  lang: Lang;
  wpm: number;
  targetS: number | null;
  totalSeconds: number;
  totalWords: number;
  beats: Beat[];
  /** Machine codes: `hook_long`, `beat_long`, `abstract_run`, `no_loop`, `over_target`, `under_target`. */
  flags: string[];
  notes: string[];
}

const HOOK_WINDOW = 3;
const MAX_BEAT = 4;
const ABSTRACT_RUN = 3;

/** Times a script: one line is one beat (a line too long is split at sentence ends). RU about 150 wpm, EN 165. */
export function beatSheet(script: string, o: { targetS?: number; wpm?: number; lang?: string } = {}): BeatSheet | null {
  const lang = langOf(o.lang, script);
  const wpm = o.wpm && o.wpm > 0 ? o.wpm : lang === 'ru' ? 150 : 165;
  const wps = wpm / 60;
  const lines: string[] = [];
  for (const raw of script.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (words(raw).length / wps <= MAX_BEAT * 1.5) {
      lines.push(raw);
      continue;
    }
    let buf = '';
    for (const part of (raw.match(/[^.!?]+[.!?]*/g) ?? [raw]).map((x) => x.trim()).filter(Boolean)) {
      const cand = `${buf} ${part}`.trim();
      if (buf && words(cand).length / wps > MAX_BEAT) {
        lines.push(buf);
        buf = part;
      } else buf = cand;
    }
    if (buf) lines.push(buf);
  }
  if (!lines.length) return null;
  const beats: Beat[] = [];
  let clock = 0;
  lines.forEach((text, i) => {
    const n = words(text).length;
    const dur = n / wps;
    beats.push({ n: i + 1, start: round1(clock * 100) / 100, dur: Math.round(dur * 100) / 100, words: n, text, concrete: concreteCount(text, lang), label: '', flags: [] });
    clock += dur;
  });
  const total = clock;
  for (const b of beats) if (b.n === 1 || b.start + b.dur <= HOOK_WINDOW) b.label = 'HOOK';
  const last = beats[beats.length - 1]!;
  last.label = last.label === 'HOOK' ? 'HOOK/CTA' : 'CTA';
  for (const b of beats) if (!b.label && b.start <= total / 2 && total / 2 < b.start + b.dur) b.label = 'MID';

  const notes: string[] = [];
  const flags: string[] = [];
  const first = beats[0]!;
  if (first.dur > HOOK_WINDOW) {
    flags.push('hook_long');
    first.flags.push(tr(lang, `хук идёт ${first.dur.toFixed(1)} с, дольше ${HOOK_WINDOW} с`, `hook runs ${first.dur.toFixed(1)}s, past the ${HOOK_WINDOW}s mark`));
    notes.push(tr(lang, `Первая строка произносится ${first.dur.toFixed(1)} с. Сократите до ${Math.floor(HOOK_WINDOW * wps)} слов, иначе хук прозвучит, когда решение уже принято.`, `Beat 1 takes ${first.dur.toFixed(1)}s to say. Cut it to ${Math.floor(HOOK_WINDOW * wps)} words or fewer.`));
  }
  if (first.concrete === 0) notes.push(tr(lang, 'В первой строке нет числа и имени. Хуки без проверяемого факта пролистывают.', 'Beat 1 has no number and no name in it. Hooks without something checkable get scrolled.'));
  const longBeats = beats.filter((b) => b.dur > MAX_BEAT);
  for (const b of longBeats) b.flags.push(tr(lang, `${b.dur.toFixed(1)} с на одну строку`, `${b.dur.toFixed(1)}s on one beat`));
  if (longBeats.length) {
    flags.push('beat_long');
    notes.push(tr(lang, `Строки ${longBeats.map((b) => b.n).join(', ')} длиннее ${MAX_BEAT} с. Разбейте строку или меняйте картинку внутри неё: на статичном кадре уходят.`, `Beat(s) ${longBeats.map((b) => b.n).join(', ')} run past ${MAX_BEAT}s. Split the line or change what is on screen inside it.`));
  }
  let run = 0;
  let startAt = 0;
  for (const b of beats) {
    if (b.concrete === 0) {
      run++;
      if (run === 1) startAt = b.n;
      if (run === ABSTRACT_RUN) {
        flags.push('abstract_run');
        notes.push(tr(lang, `В строках ${startAt}-${b.n} нет ничего конкретного. Поставьте в одну из них число, имя или цену.`, `Beats ${startAt}-${b.n} have nothing concrete in them. Put a number, a name or a price in one of them.`));
      }
    } else run = 0;
  }
  const content = (t: string) => new Set(words(t).map(bare).filter((x) => x.length > 1 && !STOP_WORDS[lang].has(x)));
  const a = content(first.text);
  const loop = [...content(last.text)].filter((x) => a.has(x)).sort();
  if (loop.length) notes.push(tr(lang, `Петля: последняя строка повторяет «${loop.slice(0, 3).join(', ')}» из хука. Повторный просмотр это бесплатный охват.`, `Loops: the last beat repeats "${loop.slice(0, 3).join(', ')}" from the hook.`));
  else {
    flags.push('no_loop');
    notes.push(tr(lang, 'Петли нет: последняя строка не делит ни одного слова с хуком, ролик заканчивается ровно. Одно слово из первой строки в последней самый дешёвый повторный просмотр.', 'No loop. The last beat shares no word with the hook. Echoing one word from beat 1 is the cheapest replay you get.'));
  }
  const target = o.targetS && o.targetS > 0 ? o.targetS : null;
  if (target) {
    const delta = total - target;
    if (Math.abs(delta) <= target * 0.1) notes.push(tr(lang, `Длина в цель: ${total.toFixed(1)} с при цели ${target} с.`, `Length is on target (${total.toFixed(1)}s against ${target}s).`));
    else if (delta > 0) {
      flags.push('over_target');
      notes.push(tr(lang, `На ${delta.toFixed(1)} с больше цели. Уберите около ${Math.floor(delta * wps)} слов.`, `${delta.toFixed(1)}s over target. Cut about ${Math.floor(delta * wps)} words.`));
    } else {
      flags.push('under_target');
      notes.push(tr(lang, `На ${(-delta).toFixed(1)} с короче цели. Добавьте ${Math.floor(-delta * wps)} слов или снимайте короче: короче обычно верно.`, `${(-delta).toFixed(1)}s under target. Add ${Math.floor(-delta * wps)} words or shoot it short.`));
    }
  }
  return { lang, wpm, targetS: target, totalSeconds: Math.round(total * 100) / 100, totalWords: beats.reduce((s, b) => s + b.words, 0), beats, flags, notes };
}

// ---------------------------------------------------------------- caption lint

const CAPTION_LIMIT = 2200;
const FEED_WINDOW = 125;
const HASHTAG_LIMIT = 5;
const ASKS: Record<Lang, readonly [RegExp, string][]> = {
  en: [
    [/\bcomment (?:the word |")?[A-Z0-9]{2,}\b/i, 'comment a keyword'], [/\b(?:dm|message) me\b/i, 'DM me'], [/\bsave (?:this|it)\b/i, 'save this'], [/\bshare (?:this|it)\b/i, 'share this'],
    [/\bfollow (?:me|for)\b/i, 'follow'], [/\blink in (?:my )?bio\b/i, 'link in bio'], [/\b(?:swipe|tap) (?:through|left|right|for|to)\b/i, 'swipe or tap'], [/\btell me\b|\bwhat would you\b|\bwhich one\b/i, 'answer a question'],
  ],
  ru: [
    [/(?<!\p{L})(?:напишите|пишите|отправьте)\s+(?:слово\s+)?[«"]?[\p{Lu}0-9]{2,}(?![\p{Ll}])/u, 'комментарий-слово'],
    [/(?<!\p{L})(?:напишите|пишите)\s+(?:нам|мне)(?!\p{L})|(?<!\p{L})в\s+(?:директ|личку|лс)(?!\p{L})/iu, 'написать нам'],
    [/(?<!\p{L})сохрани(?:те)?\s+(?:это|пост|себе|ролик)/iu, 'сохранить'], [/(?<!\p{L})(?:поделитесь|отправьте\s+(?:это|другу|коллеге))/iu, 'переслать'],
    [/(?<!\p{L})(?:подпишитесь|подписывайтесь)/iu, 'подписаться'], [/(?<!\p{L})ссылка\s+в\s+(?:шапке|профиле|био)/iu, 'ссылка в профиле'],
    [/(?<!\p{L})листайте(?!\p{L})/iu, 'листать'], [/(?<!\p{L})(?:как\s+вы\s+думаете|что\s+выберете|расскажите|напишите\s+в\s+комментариях)/iu, 'ответить на вопрос'],
  ],
};
const FILLER_TAGS: ReadonlySet<string> = new Set(['#viral', '#fyp', '#explore', '#explorepage', '#foryou', '#foryoupage', '#trending', '#instagood', '#love', '#follow', '#like4like', '#reels', '#reelsinstagram', '#viralreels', '#instadaily', '#рилс', '#рилсы', '#реелс', '#рекомендации', '#врек', '#хочуврек', '#хочуврекомендации', '#топ', '#тренды', '#лайк', '#подписка', '#инстаграм', '#вирусное']);
const LINK_RE = /https?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|co|io|net|org|ai|app)\/\S*/gi;

export interface CaptionCheck {
  check: 'length' | 'first_line' | 'hook_concrete' | 'hashtags' | 'tag_placement' | 'links' | 'one_ask' | 'emoji' | 'search_terms';
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}
export interface CaptionLint {
  lang: Lang;
  characters: number;
  limit: number;
  /** What the feed shows before «... more». */
  visible: string;
  truncated: boolean;
  hashtags: string[];
  asks: string[];
  checks: CaptionCheck[];
  verdict: 'ready' | 'review' | 'fix';
}

/** Lints a caption the way the feed shows it: the 125-character window, the 2200 limit, hashtags up to 5, one ask, search terms. */
export function lintCaption(caption: string, o: { keywords?: string[]; lang?: string; window?: number } = {}): CaptionLint {
  const lang = langOf(o.lang, caption);
  const cut = o.window && o.window > 0 ? o.window : FEED_WINDOW;
  const text = caption.trim();
  const chars = [...text].length;
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  const tags = [...text.matchAll(HASHTAG_RE)].map((m) => m[1]!);
  const links = text.match(LINK_RE) ?? [];
  const emoji = text.match(EMOJI_RE) ?? [];
  const visible = chars <= cut ? text : [...text].slice(0, cut).join('');
  const asks = ASKS[lang].filter(([re]) => re.test(text)).map(([, name]) => name);
  const filler = tags.filter((t) => FILLER_TAGS.has(t.toLowerCase()));
  const keywords = (o.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  const checks: CaptionCheck[] = [];
  const add = (check: CaptionCheck['check'], status: CaptionCheck['status'], detail: string) => checks.push({ check, status, detail });

  add('length', chars > CAPTION_LIMIT ? 'fail' : 'pass', `${chars} / ${CAPTION_LIMIT}${chars > CAPTION_LIMIT ? tr(lang, `, лишних ${chars - CAPTION_LIMIT}`, `, ${chars - CAPTION_LIMIT} over the limit`) : ''}`);
  if (!firstLine) add('first_line', 'fail', tr(lang, 'подпись начинается с пустой строки', 'the caption opens on a blank line'));
  else if (/^[#@]/.test(firstLine)) add('first_line', 'fail', tr(lang, 'подпись начинается с хэштега или упоминания: единственное место, достойное предложения', 'opens on a hashtag or a mention, the one position worth a sentence'));
  else if ([...firstLine].length > cut) add('first_line', 'warn', tr(lang, `${[...firstLine].length} знаков, обрежется на ${cut} посреди мысли`, `${[...firstLine].length} characters, so it gets cut at ${cut} mid-thought`));
  else add('first_line', 'pass', tr(lang, `${[...firstLine].length} знаков, влезает целиком`, `${[...firstLine].length} characters, lands whole`));
  const concrete = concreteCount(visible, lang);
  add('hook_concrete', concrete > 0 ? 'pass' : 'warn', tr(lang, `чисел и имён в видимой части: ${concrete}`, `${concrete} number(s) or name(s) in the visible window`) + (concrete > 0 ? '' : tr(lang, ' - до нажатия «ещё» нечего проверить', ' - nothing checkable before the tap')));
  if (tags.length > HASHTAG_LIMIT) add('hashtags', 'fail', tr(lang, `${tags.length} хэштегов, лимит Instagram ${HASHTAG_LIMIT}`, `${tags.length} tags, over Instagram's cap of ${HASHTAG_LIMIT}`));
  else if (filler.length) add('hashtags', 'warn', tr(lang, `${tags.length} хэштегов, общих: ${filler.length} (${filler.slice(0, 3).join(', ')}). Они ничего не описывают`, `${tags.length} tags, ${filler.length} generic (${filler.slice(0, 3).join(', ')})`));
  else add('hashtags', 'pass', `${tags.length}${tags.length ? `: ${tags.join(' ')}` : ''}`);
  const inWindow = chars > cut && tags.some((t) => visible.includes(t));
  add('tag_placement', !tags.length || !inWindow ? 'pass' : 'warn', !tags.length ? tr(lang, 'хэштегов нет', 'no tags to place') : inWindow ? tr(lang, 'хэштег в видимой части тратит место ленты на ярлык', 'a hashtag is inside the visible window') : tr(lang, 'хэштеги ниже обреза', 'tags are below the fold'));
  add('links', links.length ? 'warn' : 'pass', links.length ? tr(lang, `ссылок в подписи: ${links.length}, а подписи не кликаются. Перенесите в шапку профиля или в директ`, `${links.length} link(s), captions are not clickable. Move it to the bio or the DM`) : tr(lang, 'мёртвых ссылок нет', 'no dead links in the body'));
  if (asks.length === 1) add('one_ask', 'pass', tr(lang, `один призыв: ${asks[0]}`, `one call to action: ${asks[0]}`));
  else if (!asks.length) add('one_ask', 'warn', tr(lang, 'призыва нет, решите, зачем этот пост', 'no call to action, decide what this post is for'));
  else add('one_ask', 'warn', tr(lang, `призывов ${asks.length} (${asks.join(', ')}). Два призыва это ни одного`, `${asks.length} asks (${asks.join(', ')}). Two asks is the same as none`));
  const density = (emoji.length * 100) / Math.max(chars, 1);
  add('emoji', density > 4 ? 'warn' : 'pass', tr(lang, `эмодзи ${emoji.length}, ${density.toFixed(1)} на 100 знаков`, `${emoji.length} emoji, ${density.toFixed(1)} per 100 characters`) + (density > 4 ? tr(lang, ' - читается как украшение', ' - reads as decoration') : ''));
  if (keywords.length) {
    const low = text.toLowerCase();
    const found = keywords.filter((k) => low.includes(k.toLowerCase()));
    const missing = keywords.filter((k) => !low.includes(k.toLowerCase()));
    const inVisible = found.filter((k) => visible.toLowerCase().includes(k.toLowerCase()));
    add('search_terms', !missing.length ? 'pass' : found.length ? 'warn' : 'fail', tr(lang, `есть ${found.length} из ${keywords.length}`, `${found.length}/${keywords.length} present`) + (found.length ? tr(lang, `, в видимой части ${inVisible.length}`, `, ${inVisible.length} in the visible window`) : '') + (missing.length ? tr(lang, `. Нет: ${missing.join(', ')}`, `. Missing: ${missing.join(', ')}`) : ''));
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  return { lang, characters: chars, limit: CAPTION_LIMIT, visible, truncated: chars > cut, hashtags: tags, asks, checks, verdict: fails ? 'fix' : warns ? 'review' : 'ready' };
}

// ---------------------------------------------------------------- humanize and detect

const mk = (e: LexEntry): { e: LexEntry; re: RegExp } => {
  const wild = e.find.endsWith('*');
  const stem = esc(wild ? e.find.slice(0, -1) : e.find).replace(/\\? /g, '\\s+');
  return { e, re: new RegExp(`(?<![\\p{L}\\p{N}])${stem}${wild ? '(\\p{L}*)' : ''}(?![\\p{L}\\p{N}])`, 'giu') };
};
const compiled: Partial<Record<Lang, { e: LexEntry; re: RegExp }[]>> = {};
/** Phrases first and the longest wins, so «не секрет, что» goes before «секрет». */
function lexicon(lang: Lang): { e: LexEntry; re: RegExp }[] {
  const hit = compiled[lang];
  if (hit) return hit;
  const all = lang === 'ru' ? [...RU_PHRASES, ...RU_WORDS] : [...EN_PHRASES, ...EN_WORDS];
  const out = all.sort((a, b) => b.find.length - a.find.length).map(mk);
  compiled[lang] = out;
  return out;
}
/** Number of entries per language (the Russian lexicon must stay above 80). */
export const lexiconSize = (lang: Lang): number => (lang === 'ru' ? RU_PHRASES.length + RU_WORDS.length : EN_PHRASES.length + EN_WORDS.length);

const structuresOf = (lang: Lang): readonly StructureRule[] => (lang === 'ru' ? RU_STRUCTURES : EN_STRUCTURES);
const flagsOf = (f: string): string => (f.includes('g') ? f : `${f}g`);

const URL_RE = /https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+/g;
const protect = (text: string): { text: string; found: string[] } => {
  const found: string[] = [];
  return { text: text.replace(URL_RE, (m) => `\u0000URL${found.push(m) - 1}\u0000`), found };
};
const restore = (text: string, found: string[]): string => found.reduce((t, u, i) => t.split(`\u0000URL${i}\u0000`).join(u), text);

const cpOf = (spec: string): [number, number] => {
  const [a, b] = spec.split('-');
  const lo = parseInt(a!.slice(2), 16);
  return [lo, b ? parseInt(b.slice(2), 16) : lo];
};

const TYPO: readonly { from: string; name: string }[] = [
  { from: '—', name: 'EM DASH' }, { from: '–', name: 'EN DASH' }, { from: '‘', name: 'LEFT SINGLE QUOTE' }, { from: '’', name: 'RIGHT SINGLE QUOTE' },
  { from: '“', name: 'LEFT DOUBLE QUOTE' }, { from: '”', name: 'RIGHT DOUBLE QUOTE' }, { from: '…', name: 'HORIZONTAL ELLIPSIS' }, { from: '′', name: 'PRIME' },
  { from: '·', name: 'MIDDLE DOT' }, { from: '•', name: 'BULLET' }, { from: '→', name: 'RIGHTWARDS ARROW' },
];

const matchCase = (src: string, repl: string): string => {
  if (!repl) return repl;
  const letters = src.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toUpperCase()) return repl.toUpperCase();
  return /^\p{Lu}/u.test(src) ? repl.charAt(0).toUpperCase() + repl.slice(1) : repl;
};

export interface HumanizeReport {
  invisible: { name: string; count: number; action: string }[];
  typographic: { name: string; count: number; to: string }[];
  lexical: { find: string; replace: string; count: number; family: string }[];
  /** Stock words found that have no safe replacement: rewrite these sentences. */
  flagged: { find: string; count: number }[];
  /** Structures that need a rewrite (never changed automatically). */
  structures: { id: string; name: string; count: number; fix: string }[];
}
export interface HumanizeResult {
  lang: Lang;
  text: string;
  report: HumanizeReport;
  /** Characters, dashes and words removed or replaced. */
  artefacts: number;
}

function scanStructures(text: string, lang: Lang): HumanizeReport['structures'] {
  const out: HumanizeReport['structures'] = [];
  for (const s of structuresOf(lang)) {
    let n: number;
    try {
      n = text.match(new RegExp(s.regex, flagsOf(s.flags)))?.length ?? 0;
    } catch {
      continue;
    }
    if (n) out.push({ id: s.id, name: s.name, count: n, fix: s.fix });
  }
  const lens = sentencesOf(text).map((s) => s.split(/\s+/).length);
  if (lens.length >= 4) {
    const cv = pstdev(lens) / mean(lens);
    if (cv < 0.35) out.push({ id: 'uniform-length', name: tr(lang, `Одинаковая длина предложений (разброс ${cv.toFixed(2)})`, `Uniform sentence length (variation ${cv.toFixed(2)})`), count: lens.length, fix: tr(lang, 'Разрежьте одно предложение пополам, другое оставьте длинным. Модель пишет ровно.', 'Break one sentence in half. Let another run long. Machines write even.') });
  }
  return out;
}

/** Removes invisible characters, normalises dashes and quotes, swaps stock words for plain ones; structures are reported, never rewritten. */
export function humanizeText(input: string, lang?: string): HumanizeResult {
  const l = langOf(lang, input);
  const original = input;
  const { text: prot, found } = protect(input);
  let text = prot;
  const report: HumanizeReport = { invisible: [], typographic: [], lexical: [], flagged: [], structures: [] };

  for (const r of EN_INVISIBLE) {
    const [lo, hi] = cpOf(r.cp);
    const re = new RegExp(lo === hi ? `\\u{${lo.toString(16)}}` : `[\\u{${lo.toString(16)}}-\\u{${hi.toString(16)}}]`, 'gu');
    const n = text.match(re)?.length ?? 0;
    if (n) {
      report.invisible.push({ name: `${r.cp} ${r.name}`, count: n, action: r.action });
      text = text.replace(re, r.action === 'delete' ? '' : ' ');
    }
  }
  const stray = text.match(/\p{Cf}/gu)?.length ?? 0;
  if (stray) {
    report.invisible.push({ name: 'other invisible format chars', count: stray, action: 'delete' });
    text = text.replace(/\p{Cf}/gu, '');
  }

  for (const t of TYPO) {
    const n = text.split(t.from).length - 1;
    if (!n) continue;
    let to: string;
    if (t.from === '—' || t.from === '–') {
      to = '-';
      // a dash with spaces stays a spaced hyphen, a bare one joins its words
      text = t.from === '—' ? text.replace(/\s*—\s*/g, (m) => (/\s/.test(m) ? ' - ' : '-')) : text.replace(/\s*–\s*/g, (m) => (/\s/.test(m) ? ' - ' : '-'));
    } else {
      to = t.from === '‘' || t.from === '’' || t.from === '′' ? "'" : t.from === '“' || t.from === '”' ? '"' : t.from === '…' ? '...' : t.from === '→' ? '->' : '-';
      text = text.split(t.from).join(to);
    }
    report.typographic.push({ name: `${t.from} ${t.name}`, count: n, to });
  }

  const flaggedCount = new Map<string, number>();
  for (const { e, re } of lexicon(l)) {
    re.lastIndex = 0;
    const n = text.match(re)?.length ?? 0;
    if (!n) continue;
    if (e.replace === null) {
      flaggedCount.set(e.find, (flaggedCount.get(e.find) ?? 0) + n);
      continue;
    }
    const keep = e.find.endsWith('*') && e.replace.endsWith('*');
    report.lexical.push({ find: e.find, replace: e.replace || '(deleted)', count: n, family: e.family });
    text = text.replace(re, (m: string, ending?: string) => matchCase(m, keep ? e.replace!.slice(0, -1) + (ending ?? '') : e.replace!));
  }
  report.flagged = [...flaggedCount].map(([find, count]) => ({ find, count }));

  // clean up after deletions: orphaned punctuation, doubled spaces, commas after a one-word opener, lost capitals
  text = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]*(?:[,.;:]+[ \t]*)+/gm, '')
    .replace(/^[ \t](?=\S)/gm, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,\s*([,.;:!?])/g, '$1')
    .replace(/\.\.\./g, '\uE000')
    .replace(/\.\s*\.+/g, '.')
    .replace(/([!?])\s*\./g, '$1')
    .replace(/\uE000/g, '...')
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(^|[.!?]\s+|\n)(Сейчас|Обычно|Сначала|Поэтому|Now|Still|So),\s+/g, '$1$2 ');
  const starts = [...original.matchAll(/(?:^|[.!?]\s+|\n)\s*(\p{L})/gu)].map((m) => m[1]!);
  if (starts.length && starts.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length * 2 >= starts.length) {
    text = text.replace(/(^|[.!?]\s+|\n)(\p{Ll})/gu, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
  }
  text = restore(text, found).trim();
  report.structures = scanStructures(text, l);
  const artefacts = report.invisible.reduce((s, h) => s + h.count, 0) + report.typographic.reduce((s, h) => s + h.count, 0) + report.lexical.reduce((s, h) => s + h.count, 0);
  return { lang: l, text, report, artefacts };
}

const sentencesOf = (text: string): string[] => (text.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter((s) => s.split(/\s+/).length > 2);

export const DETECT_CHECKS = ['burstiness', 'specificity', 'slop_density', 'fingerprint', 'voice'] as const;
export type DetectCheck = (typeof DETECT_CHECKS)[number];
export interface DetectResult {
  lang: Lang;
  /** 0-100, higher is more human. */
  score: number;
  verdict: 'pass' | 'review' | 'flagged';
  weakest: DetectCheck;
  checks: Record<DetectCheck, { score: number; detail: string }>;
  /** Stock terms found (each with its count). */
  slop: { find: string; count: number }[];
  /** Structures that need a rewrite. */
  structures: { id: string; name: string; count: number; fix: string }[];
}

const COLLOQUIAL_RU = /(?<![\p{L}])(?:ну|вот|же|ведь|короче|кстати|честно|слушайте|знаете|правда|вообще|просто|прям|типа|ладно|блин|кстати)(?![\p{L}])/giu;
const CONTRACTIONS = /\b\w+['’](?:s|t|re|ve|ll|d|m)\b/gi;

/** Five checks on how machine-written a draft looks: burstiness, specificity, slop density, fingerprint, voice. Local heuristics, not a detector's verdict. */
export function detectText(input: string, lang?: string): DetectResult {
  const l = langOf(lang, input);
  const text = input;
  const w = words(text);
  const norm = text.replace(/[‘’′]/g, "'");

  const lens = sentencesOf(text).map((s) => s.split(/\s+/).length);
  const burst = lens.length < 4 ? { score: 50, detail: tr(l, 'слишком коротко для оценки', 'too short to judge') } : (() => {
    const cv = pstdev(lens) / mean(lens);
    return { score: scale(cv, 0.7, 0.22), detail: tr(l, `разброс ${cv.toFixed(2)} на ${lens.length} предложениях (нужно 0,55 и больше)`, `variation ${cv.toFixed(2)} across ${lens.length} sentences (want 0.55+)`) };
  })();

  const spec = w.length < 25 ? { score: 50, detail: tr(l, 'слишком коротко для оценки', 'too short to judge') } : (() => {
    const hits = (joinNumbers(text).match(/\b\d[\d,.]*%?|\$\d/g)?.length ?? 0) + new Set(text.match(PROPER_RE) ?? []).size;
    const density = (hits * 100) / w.length;
    return { score: scale(density, 6, 0.5), detail: tr(l, `конкретных примет ${hits}, ${density.toFixed(1)} на 100 слов (нужно 4 и больше)`, `${hits} concrete markers, ${density.toFixed(1)} per 100 words (want 4+)`) };
  })();

  // slop density: matched spans are masked so a word is counted once
  let masked = norm;
  let hits = 0;
  const slop: { find: string; count: number }[] = [];
  for (const { e, re } of lexicon(l)) {
    re.lastIndex = 0;
    const n = masked.match(re)?.length ?? 0;
    if (!n) continue;
    hits += n;
    slop.push({ find: e.find, count: n });
    masked = masked.replace(re, (m) => ' '.repeat(m.length));
  }
  const slopCheck = !w.length ? { score: 50, detail: tr(l, 'пусто', 'empty') } : (() => {
    const density = (hits * 100) / w.length;
    const shown = slop.map((s) => s.find).sort().slice(0, 4);
    return { score: scale(density, 0, 4), detail: tr(l, `штампов ${hits}, ${density.toFixed(1)} на 100 слов`, `${hits} stock terms, ${density.toFixed(1)} per 100 words`) + (shown.length ? ` (${shown.join(', ')}${slop.length > 4 ? ', ...' : ''})` : '') };
  })();

  const invisible = text.match(/\p{Cf}/gu)?.length ?? 0;
  const em = text.split('—').length - 1;
  const curly = (text.match(/[‘’“”]/g) ?? []).length;
  const ellip = text.split('…').length - 1;
  const nbsp = (text.match(/[\u00A0\u202F\u2009]/g) ?? []).length;
  const total = invisible * 4 + em * 2 + curly + ellip + nbsp;
  const fp = { score: scale((total * 1000) / Math.max(text.length, 1), 0, 12), detail: tr(l, `невидимых ${invisible}, длинных тире ${em}, кривых кавычек ${curly}, многоточий-символов ${ellip}, жёстких пробелов ${nbsp}`, `${invisible} invisible, ${em} em dash, ${curly} curly quote, ${ellip} ellipsis, ${nbsp} hard space`) };

  const structures = scanStructures(text, l);
  const tells = structures.filter((s) => s.id !== 'uniform-length').reduce((s, x) => s + x.count, 0);
  const voice = w.length < 25 ? { score: 50, detail: tr(l, 'слишком коротко для оценки', 'too short to judge') } : (() => {
    const per100 = 100 / w.length;
    const person = (text.match(new RegExp(ME[l].source + '|' + YOU[l].source, `g${ME[l].flags.replace('g', '')}`)) ?? []).length * per100;
    const casual = l === 'ru' ? (text.match(COLLOQUIAL_RU)?.length ?? 0) * per100 : (text.match(CONTRACTIONS)?.length ?? 0) * per100;
    const bullets = [...text.matchAll(/^\s*[-*•]\s+(.+)$/gm)].map((m) => m[1]!.split(/\s+/).length);
    const uniform = bullets.length >= 3 && pstdev(bullets) < 1.6;
    let score = scale(casual, l === 'ru' ? 2 : 3, 0) * 0.35 + scale(person, 8, 1) * 0.35 + clamp(100 - tells * 22) * 0.3;
    if (uniform) score -= 12;
    return { score: clamp(score), detail: tr(l, `разговорных слов ${casual.toFixed(1)}, личных местоимений ${person.toFixed(1)} на 100 слов, структурных примет ${tells}`, `${casual.toFixed(1)} contractions, ${person.toFixed(1)} personal pronouns per 100 words, ${tells} structural tell(s)`) + (uniform ? tr(l, ' [одинаковые пункты списка]', ' [uniform bullets]') : '') };
  })();

  const checks = { burstiness: burst, specificity: spec, slop_density: slopCheck, fingerprint: fp, voice };
  const scores = DETECT_CHECKS.map((c) => checks[c].score);
  const overall = mean(scores) * 0.6 + Math.min(...scores) * 0.4;
  const verdict = overall >= 70 && Math.min(...scores) >= 55 ? 'pass' : overall >= 50 ? 'review' : 'flagged';
  const weakest = DETECT_CHECKS.reduce((a, b) => (checks[b].score < checks[a].score ? b : a));
  for (const c of DETECT_CHECKS) checks[c].score = round1(checks[c].score);
  return { lang: l, score: round1(overall), verdict, weakest, checks, slop, structures };
}

// ---------------------------------------------------------------- swipe rank

export interface SwipeRow {
  account?: string;
  followers?: number | null;
  /** The account's typical recent views: the better baseline. */
  median?: number | null;
  views: number;
  hook: string;
}
export interface SwipeRanked extends SwipeRow {
  baseline: number;
  outlier: number | null;
  formulaId: number | null;
  formula: string;
  hookScore: number;
  hookVerdict: string;
  words: number;
}
export interface SwipeReport {
  /** `account median` (own median of the rows when no `median` given), `follower count` or `none`. */
  baseline: 'account median' | 'follower count' | 'none';
  n: number;
  accounts: number;
  reels: SwipeRanked[];
  topFormulas: { formula: string; id: number | null; count: number }[];
  topHookScore: number | null;
  bottomHookScore: number | null;
  topWords: number | null;
  bottomWords: number | null;
  unclassified: number;
  /** Words on how far to trust the batch: 40 reels over six accounts supports a claim, 12 does not. */
  confidence: 'low' | 'medium' | 'enough';
  confidenceNote: string;
  formulasLoaded: boolean;
}

export interface HookFormula {
  id: number;
  en: { name: string; template: string; example: string; on_screen: string; best_for: string; trap: string };
  ru: { name: string; template: string; example: string; on_screen: string; best_for: string; trap: string };
  match: { en: string; ru: string };
}
export interface HooksData {
  classify_order: number[];
  hooks: HookFormula[];
  rules: { ru: string[]; en: string[] };
}
const hooksCache = new Map<string, HooksData | null>();
/** `knowledge/hooks.json`: the 26 formulas. null when the file is not there. */
export function loadHooks(dir?: string): HooksData | null {
  const root = knowledgeDir(dir);
  const key = root ?? '';
  if (hooksCache.has(key)) return hooksCache.get(key)!;
  let data: HooksData | null = null;
  try {
    if (root) data = JSON.parse(readFileSync(join(root, 'hooks.json'), 'utf8')) as HooksData;
  } catch {
    data = null;
  }
  hooksCache.set(key, data);
  return data;
}

/** The formula a hook line follows (the first match in `classify_order`), or null. */
export function classifyHook(hook: string, data: HooksData | null, lang?: string): { id: number; name: string } | null {
  if (!data) return null;
  const l = langOf(lang, hook);
  const byId = new Map(data.hooks.map((h) => [h.id, h]));
  for (const id of data.classify_order) {
    const h = byId.get(id);
    if (!h) continue;
    try {
      if (new RegExp(h.match[l], 'iu').test(hook)) return { id: h.id, name: h[l].name };
    } catch {
      /* a bad pattern never matches */
    }
  }
  return null;
}

/** Ranks reels by the outlier multiple (views over the account's own median), names each hook's formula and scores the hook. */
export function rankSwipe(rows: SwipeRow[], o: { hooks?: HooksData | null; lang?: string } = {}): SwipeReport {
  const data = o.hooks === undefined ? loadHooks() : o.hooks;
  const usable = rows.filter((r) => Number.isFinite(r.views) && r.views > 0 && typeof r.hook === 'string' && r.hook.trim());
  // an account with several rows but no stated median gets the median of its own rows
  const own = new Map<string, number[]>();
  for (const r of usable) own.set(r.account ?? '', [...(own.get(r.account ?? '') ?? []), r.views]);
  const anyMedian = usable.some((r) => r.median);
  const anyFollowers = usable.some((r) => r.followers);
  const reels: SwipeRanked[] = usable.map((r) => {
    const base = r.median || r.followers || 0;
    const f = classifyHook(r.hook, data, o.lang);
    const hs = scoreHook(r.hook, o.lang);
    return { ...r, baseline: base, outlier: base ? Math.round((r.views / base) * 100) / 100 : null, formulaId: f?.id ?? null, formula: f?.name ?? 'unclassified', hookScore: hs.score, hookVerdict: hs.verdict, words: words(r.hook).length };
  });
  reels.sort((a, b) => (b.outlier ?? 0) - (a.outlier ?? 0));
  const third = Math.max(1, Math.floor(reels.length / 3));
  const top = reels.slice(0, third);
  const bottom = reels.slice(-third);
  const counts = new Map<string, { id: number | null; count: number }>();
  for (const r of top) counts.set(r.formula, { id: r.formulaId, count: (counts.get(r.formula)?.count ?? 0) + 1 });
  const med = (items: SwipeRanked[], pick: (r: SwipeRanked) => number): number | null => (items.length ? Math.round(median(items.map(pick)) * 10) / 10 : null);
  const accounts = new Set(reels.map((r) => r.account ?? '')).size;
  const confidence = reels.length >= 40 && accounts >= 5 ? 'enough' : reels.length >= 20 ? 'medium' : 'low';
  return {
    baseline: anyMedian ? 'account median' : anyFollowers ? 'follower count' : 'none',
    n: reels.length, accounts, reels,
    topFormulas: [...counts].map(([formula, v]) => ({ formula, id: v.id, count: v.count })).sort((a, b) => b.count - a.count),
    topHookScore: med(top, (r) => r.hookScore), bottomHookScore: med(bottom, (r) => r.hookScore), topWords: med(top, (r) => r.words), bottomWords: med(bottom, (r) => r.words),
    unclassified: reels.filter((r) => r.formula === 'unclassified').length,
    confidence,
    confidenceNote: confidence === 'enough' ? 'Forty reels over five or more accounts supports a claim.' : confidence === 'medium' ? 'Twenty to forty reels: a lead, collect more before believing it.' : 'Under twenty reels shows nothing: collect more before you believe it.',
    formulasLoaded: data !== null,
  };
}

// ---------------------------------------------------------------- the tool wrappers

export interface TextTools {
  hookScore(hooks: string[], lang?: string): Promise<ToolResult<HookRanking>>;
  beats(script: string, o?: { targetS?: number; wpm?: number; lang?: string }): Promise<ToolResult<BeatSheet>>;
  captionLint(caption: string, o?: { keywords?: string[]; lang?: string }): Promise<ToolResult<CaptionLint>>;
  humanize(text: string, lang?: string): Promise<ToolResult<HumanizeResult>>;
  detect(text: string, lang?: string): Promise<ToolResult<DetectResult>>;
  swipeRank(rows: SwipeRow[], o?: { lang?: string }): Promise<ToolResult<SwipeReport>>;
}

const MAX_TEXT = 20_000;
const okText = (t: unknown, what: string): ToolResult<never> | null => (typeof t !== 'string' || !t.trim() || t.length > MAX_TEXT ? fail('invalid', `${what}: text of 1..${MAX_TEXT} characters`) : null);

export function createText(k: Kit): TextTools {
  const run = <T>(name: string, fn: () => ToolResult<T>): Promise<ToolResult<T>> => k.call(name, () => Promise.resolve(fn()));
  return {
    hookScore: (hooks, lang) =>
      run('text.hookScore', () => {
        if (!Array.isArray(hooks) || hooks.length === 0 || hooks.length > 50 || hooks.some((h) => typeof h !== 'string' || !h.trim() || h.length > 400)) return fail('invalid', 'hooks: 1..50 lines of up to 400 characters');
        return okv(scoreHooks(hooks.map((h) => h.trim()), lang));
      }),
    beats: (script, o) =>
      run('text.beats', () => {
        const bad = okText(script, 'script');
        if (bad) return bad;
        const sheet = beatSheet(script, o ?? {});
        return sheet ? okv(sheet) : fail('invalid', 'script: empty');
      }),
    captionLint: (caption, o) =>
      run('text.captionLint', () => {
        const bad = okText(caption, 'caption');
        return bad ?? okv(lintCaption(caption, o ?? {}));
      }),
    humanize: (text, lang) =>
      run('text.humanize', () => {
        const bad = okText(text, 'text');
        return bad ?? okv(humanizeText(text, lang));
      }),
    detect: (text, lang) =>
      run('text.detect', () => {
        const bad = okText(text, 'text');
        return bad ?? okv(detectText(text, lang));
      }),
    swipeRank: (rows, o) =>
      run('text.swipeRank', () => {
        if (!Array.isArray(rows) || rows.length === 0 || rows.length > 500) return fail('invalid', 'rows: 1..500 reels');
        const r = rankSwipe(rows, o ?? {});
        return r.n === 0 ? fail('invalid', 'rows: nothing usable, each reel needs views and a hook') : okv(r);
      }),
  };
}
