/**
 * A small, dependency-free HTML reader for `web.readable`: a tolerant tokenizer builds a tree, page chrome (scripts, styles,
 * navigation, header, footer, asides, forms, ads, cookie banners) is dropped, and the element with the most paragraph text
 * (links discounted) is the article. Good enough for blogs and news; it is not a browser and never runs anything.
 */

const ENT: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', laquo: '«', raquo: '»', hellip: '…', copy: '©',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bdquo: '„', middot: '·', bull: '•', reg: '®', trade: '™', times: '×', deg: '°', euro: '€', shy: '',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

export interface HNode {
  tag: string;
  attrs: Record<string, string>;
  children: (HNode | string)[];
  parent: HNode | null;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'noscript', 'textarea', 'template', 'svg', 'iframe', 'title']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figure', 'figcaption', 'header', 'footer', 'nav', 'aside', 'form', 'dl', 'dt', 'dd', 'br', 'hr']);
/** Opening one of these closes an open `<p>`. */
const CLOSES_P = new Set(['p', 'div', 'section', 'article', 'main', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figure', 'header', 'footer', 'nav', 'aside', 'form', 'dl', 'hr']);

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** Tolerant parse: unknown closing tags are ignored, a closing tag closes everything opened after its match. */
/** The tree never goes deeper than this: a page of 50k unclosed `<div>` stays a flat list of siblings from here on. */
export const MAX_HTML_DEPTH = 512;

export function parseHtml(input: string): HNode {
  // markup that opens after the last `>` / `-->` / `]]>` can never close: it is text, and it must not make every `<` scan to the end of the page
  let html = input;
  const lt = html.lastIndexOf('>');
  if (lt < html.length - 1 || lt < 0) html = `${html.slice(0, lt + 1)}${html.slice(lt + 1).replace(/</g, '&lt;')}`;
  const lc = html.lastIndexOf('-->');
  if (html.indexOf('<!--', lc < 0 ? 0 : lc) >= 0) html = `${html.slice(0, lc + 1)}${html.slice(lc + 1).replace(/<!--/g, '&lt;!--')}`;
  const ld = html.lastIndexOf(']]>');
  if (html.indexOf('<![CDATA[', ld < 0 ? 0 : ld) >= 0) html = `${html.slice(0, ld + 1)}${html.slice(ld + 1).replace(/<!\[CDATA\[/g, '&lt;![CDATA[')}`;
  const root: HNode = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root;
  let depth = 0;
  // how many elements of each tag are open on the path to `cur`: a closing tag with no open partner walks nothing
  const open = new Map<string, number>();
  const up = (): void => {
    open.set(cur.tag, (open.get(cur.tag) ?? 1) - 1);
    cur = cur.parent ?? root;
    depth--;
  };
  const noClose = new Set<string>();
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const [all, slash, rawName, rest] = m;
    if (rawName === undefined) {
      if (all[0] !== '<' || all === '<') cur.children.push(decodeEntities(all));
      continue;
    }
    const tag = rawName.toLowerCase();
    if (slash) {
      if ((open.get(tag) ?? 0) > 0) {
        while (cur !== root && cur.tag !== tag) up();
        if (cur !== root) up();
      }
      continue;
    }
    if (CLOSES_P.has(tag) && cur.tag === 'p') up();
    if (tag === 'li' && cur.tag === 'li') up();
    const node: HNode = { tag, attrs: parseAttrs(rest ?? ''), children: [], parent: cur };
    cur.children.push(node);
    if (RAW.has(tag)) {
      // raw text up to the matching close tag (a tag that never closes is looked for once)
      let text = html.slice(re.lastIndex);
      let next = html.length;
      if (!noClose.has(tag)) {
        const close = new RegExp(`</${tag}\\s*>`, 'ig');
        close.lastIndex = re.lastIndex;
        const c = close.exec(html);
        if (c) {
          text = html.slice(re.lastIndex, c.index);
          next = close.lastIndex;
        } else noClose.add(tag);
      }
      node.children.push(tag === 'title' ? decodeEntities(text) : text);
      re.lastIndex = next;
      continue;
    }
    if (VOID.has(tag) || /\/\s*$/.test(rest ?? '') || depth >= MAX_HTML_DEPTH) continue;
    cur = node;
    depth++;
    open.set(tag, (open.get(tag) ?? 0) + 1);
  }
  return root;
}

export function* walk(n: HNode): Generator<HNode> {
  yield n;
  for (const c of n.children) if (typeof c !== 'string') yield* walk(c);
}

const find = (n: HNode, pred: (x: HNode) => boolean): HNode | undefined => {
  for (const x of walk(n)) if (pred(x)) return x;
  return undefined;
};

/** Chrome that is never article text. */
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'textarea', 'input', 'canvas', 'video', 'audio', 'object', 'title', 'head']);
const DROP_HINT = /(^|[\s_-])(nav|navbar|menu|breadcrumbs?|sidebar|footer|header|cookie|consent|banner|promo|advert|ads?|ad-slot|adv|sponsor|subscribe|newsletter|share|social|related|recommend|comments?|popup|modal)([\s_-]|$)/i;

function dropChrome(n: HNode): void {
  n.children = n.children.filter((c) => {
    if (typeof c === 'string') return true;
    if (DROP_TAGS.has(c.tag)) return false;
    const hint = `${c.attrs.class ?? ''} ${c.attrs.id ?? ''} ${c.attrs.role ?? ''}`;
    if (c.tag !== 'article' && c.tag !== 'main' && c.tag !== 'body' && DROP_HINT.test(hint)) return false;
    if (c.attrs.hidden !== undefined || c.attrs['aria-hidden'] === 'true' || /display\s*:\s*none/i.test(c.attrs.style ?? '')) return false;
    dropChrome(c);
    return true;
  });
}

/** Plain text of a node: blocks become line breaks, whitespace collapsed inside lines. */
export function textOf(n: HNode): string {
  const parts: string[] = [];
  const rec = (x: HNode) => {
    const block = BLOCK.has(x.tag);
    if (block) parts.push('\n');
    if (x.tag === 'li') parts.push('- ');
    for (const c of x.children) {
      if (typeof c === 'string') parts.push(c);
      else rec(c);
    }
    if (block) parts.push('\n');
  };
  rec(n);
  return parts
    .join('')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''))
    .join('\n')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
}

const linkTextLen = (n: HNode): number => {
  let s = 0;
  for (const x of walk(n)) if (x.tag === 'a') s += textOf(x).length;
  return s;
};

/** Paragraph text directly under a node (p, li, h2-h4, blockquote, pre children). */
function score(n: HNode): number {
  let s = 0;
  let paras = 0;
  for (const c of n.children) {
    if (typeof c === 'string') {
      s += c.trim().length * 0.5;
      continue;
    }
    if (['p', 'blockquote', 'pre', 'h2', 'h3', 'h4', 'ul', 'ol', 'figure', 'table'].includes(c.tag)) {
      const t = textOf(c).length;
      s += t - linkTextLen(c);
      if (c.tag === 'p' && t > 40) paras++;
    }
  }
  return s + paras * 30;
}

export interface Readable {
  title: string;
  text: string;
  published: string | null;
  links: { href: string; text: string }[];
  lang: string | null;
}

const meta = (root: HNode, ...names: string[]): string | null => {
  for (const name of names) {
    const m = find(root, (x) => x.tag === 'meta' && ((x.attrs.property ?? x.attrs.name ?? x.attrs.itemprop ?? '').toLowerCase() === name));
    const v = m?.attrs.content?.trim();
    if (v) return v;
  }
  return null;
};

function publishedOf(root: HNode, html: string): string | null {
  const m = meta(root, 'article:published_time', 'datepublished', 'og:published_time', 'date', 'pubdate', 'dc.date');
  const time = find(root, (x) => x.tag === 'time' && !!x.attrs.datetime)?.attrs.datetime ?? null;
  const ld = /"datePublished"\s*:\s*"([^"]{8,40})"/.exec(html)?.[1] ?? null;
  for (const v of [m, ld, time]) {
    if (v && Number.isFinite(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
  }
  return null;
}

/** The article of a page: title, main text (at most `maxChars`), publication date when the page states one, links of the article. */
export function extractReadable(html: string, baseUrl: string, maxChars = 20_000): Readable {
  const root = parseHtml(html);
  const titleNode = find(root, (x) => x.tag === 'title');
  const h1 = find(root, (x) => x.tag === 'h1');
  const title = (meta(root, 'og:title') ?? (titleNode ? textOf(titleNode) : '') ?? '').trim() || (h1 ? textOf(h1) : '');
  const lang = find(root, (x) => x.tag === 'html')?.attrs.lang ?? null;
  const published = publishedOf(root, html);
  const body = find(root, (x) => x.tag === 'body') ?? root;
  dropChrome(body);
  let best: HNode = body;
  let bestScore = -1;
  for (const n of walk(body)) {
    if (!['article', 'main', 'section', 'div', 'td', 'body'].includes(n.tag)) continue;
    // an explicit article or main wins ties; nested containers compete on their own paragraphs
    const s = score(n) * (n.tag === 'article' || n.tag === 'main' || /article|post|content|entry|story/i.test(`${n.attrs.class ?? ''} ${n.attrs.id ?? ''}`) ? 1.3 : 1);
    if (s > bestScore) {
      best = n;
      bestScore = s;
    }
  }
  if (bestScore < 80) best = body; // nothing article-like: the whole cleaned body
  let text = textOf(best);
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1).trimEnd()}…`;
  const links: Readable['links'] = [];
  const seen = new Set<string>();
  for (const a of walk(best)) {
    if (a.tag !== 'a' || !a.attrs.href) continue;
    let href: string;
    try {
      href = new URL(a.attrs.href, baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/.test(href) || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, text: textOf(a).slice(0, 120) });
    if (links.length >= 50) break;
  }
  return { title: title.slice(0, 300), text, published, links, lang };
}
