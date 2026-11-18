import { DIRECTIONS, type Direction } from '@fir/worker-content-maker';

export interface Finding {
  /** Stable key (check + page): the same problem is not proposed again for a month. */
  key: string;
  /** 3: blocks indexing or AI readability, 2: clear loss, 1: polish. */
  severity: 1 | 2 | 3;
  page: string;
  /** What is wrong. */
  problem: string;
  /** The concrete change, RU. */
  change: string;
  /** True when the fix is in the site's code (the builder), false for text or content only. */
  needsBuilder: boolean;
}

export interface PageFacts {
  url: string;
  title: string | null;
  description: string | null;
  h1: string[];
  canonical: string | null;
  hreflang: string[];
  jsonLd: number;
  ogTitle: boolean;
  /** Visible text, tags stripped. */
  text: string;
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const strip = (s: string) => decode(s.replace(/<[^>]*>/g, ' '));

/** Reads one attribute of a tag string, quoted either way. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decode(m[2] ?? m[3] ?? '') : null;
}

function tags(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
}

export function pageFacts(url: string, html: string): PageFacts {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const metas = tags(html, 'meta');
  const links = tags(html, 'link');
  const meta = (key: string, by: 'name' | 'property' = 'name') => metas.find((m) => attr(m, by)?.toLowerCase() === key);
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
  return {
    url,
    title: title ? strip(title) : null,
    description: (meta('description') && attr(meta('description')!, 'content')) || null,
    h1: [...body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => strip(m[1]!)),
    canonical: (() => {
      const l = links.find((x) => attr(x, 'rel')?.toLowerCase() === 'canonical');
      return l ? attr(l, 'href') : null;
    })(),
    hreflang: links.filter((x) => attr(x, 'rel')?.toLowerCase() === 'alternate' && attr(x, 'hreflang')).map((x) => attr(x, 'hreflang')!),
    jsonLd: [...html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>/gi)].length,
    ogTitle: Boolean(meta('og:title', 'property')),
    text: strip(body),
  };
}

const path = (url: string) => {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url;
  }
};

/** Per-page checks. `home` pages (/, /ru, /en) must also carry structured data and hreflang. */
export function checkPage(f: PageFacts, opts: { home: boolean }): Finding[] {
  const p = path(f.url);
  const out: Finding[] = [];
  const add = (check: string, severity: Finding['severity'], problem: string, change: string, needsBuilder = true) =>
    out.push({ key: `${check}:${p}`, severity, page: f.url, problem, change, needsBuilder });
  if (!f.title) add('title_missing', 3, 'нет тега title', `Добавить title на ${p}: 40-60 символов, услуга и город в начале.`);
  else if (f.title.length < 20 || f.title.length > 65) add('title_length', 1, `title ${f.title.length} символов («${f.title.slice(0, 60)}»)`, `Привести title на ${p} к 30-60 символам: услуга, рынок, бренд.`);
  if (!f.description) add('description_missing', 2, 'нет meta description', `Добавить meta description на ${p}: 120-160 символов, что делаем и для кого, один призыв.`);
  else if (f.description.length < 70 || f.description.length > 170) add('description_length', 1, `description ${f.description.length} символов`, `Довести meta description на ${p} до 120-160 символов.`);
  if (f.h1.length === 0) add('h1_missing', 2, 'нет h1', `Добавить один h1 на ${p} с названием услуги.`);
  else if (f.h1.length > 1) add('h1_many', 1, `h1 больше одного (${f.h1.length})`, `Оставить на ${p} один h1, остальные заголовки сделать h2.`);
  if (!f.canonical) add('canonical_missing', 2, 'нет canonical', `Добавить rel=canonical на ${p} с полным адресом страницы.`);
  if (opts.home) {
    if (f.hreflang.length === 0) add('hreflang_missing', 2, 'нет hreflang (RU и EN версии не связаны)', `Добавить rel=alternate hreflang ru, en и x-default на ${p}.`);
    if (f.jsonLd === 0) add('jsonld_missing', 2, 'нет структурированных данных JSON-LD', `Добавить JSON-LD Organization и Service (или ProfessionalService) на ${p}: название, услуги, цены от, языки, контакт.`);
    if (!f.ogTitle) add('og_missing', 1, 'нет Open Graph', `Добавить og:title, og:description, og:image на ${p} для превью в мессенджерах.`);
  }
  return out;
}

const DAY = 86_400_000;
export const LLMS_MAX_AGE_DAYS = 90;

/** llms.txt: present, non-trivial, not stale (Last-Modified header when the server sends one). */
export function checkLlms(res: { status: number; text: string; lastModified: string | null } | null, siteUrl: string, now: number): Finding[] {
  const page = `${siteUrl.replace(/\/$/, '')}/llms.txt`;
  if (!res || res.status !== 200) {
    return [{ key: 'llms_missing:/llms.txt', severity: 3, page, problem: 'llms.txt не отдаётся', change: 'Добавить /llms.txt: кто мы, 8 направлений с ценами от, как связаться, ссылки на страницы направлений (RU и EN).', needsBuilder: true }];
  }
  const out: Finding[] = [];
  if (res.text.trim().length < 200) out.push({ key: 'llms_thin:/llms.txt', severity: 2, page, problem: `llms.txt слишком короткий (${res.text.trim().length} символов)`, change: 'Дополнить llms.txt: описание студии, список направлений с ценами и ссылками.', needsBuilder: true });
  const lm = res.lastModified ? Date.parse(res.lastModified) : NaN;
  if (Number.isFinite(lm) && now - lm > LLMS_MAX_AGE_DAYS * DAY) {
    out.push({ key: 'llms_stale:/llms.txt', severity: 2, page, problem: `llms.txt не обновлялся ${Math.floor((now - lm) / DAY)} дней`, change: 'Обновить llms.txt по актуальному списку направлений и цен.', needsBuilder: true });
  }
  return out;
}

const hasPrice = (text: string, n: number) => new RegExp(`\\$\\s?${n}\\b|\\b${n}\\s?(\\$|USD|usd|долл)`).test(text);

/** The site (all fetched pages plus llms.txt) must mention every direction's price from the directions table. */
export function checkServices(allText: string, directions: Direction[] = DIRECTIONS): Finding[] {
  return directions
    .filter((d) => !hasPrice(allText, d.from))
    .map((d) => ({
      key: `service_missing:${d.id}`, severity: 2 as const, page: '/', problem: `направление «${d.name}» (от $${d.from}) не найдено в тексте сайта и llms.txt`,
      change: `Проверить карточку «${d.name}» на сайте и в llms.txt: название, цена от $${d.from}, ссылка на заявку.`, needsBuilder: true,
    }));
}
