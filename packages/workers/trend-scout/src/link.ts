import { SOCIAL_HOSTS, decodeEntities, migrate, reachChannels, tryJson, withPlaybook, type Db, type LlmClient, type ReachOutcome, type Tools, type ToolResult } from '@fir/core';
import { z } from 'zod';

/**
 * Links the owner drops for the Trendwatcher (`/trend <url> [note]`, `POST /admin/trends`): one public Instagram, TikTok or YouTube post.
 * The worker reads what the platform shows an anonymous visitor (oEmbed, og tags; never a login), writes an analysis (format, hook, structure,
 * why it works) and the Fir Tech analogue; the head turns the analogue into a content item for the review center.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ts_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  analysis TEXT,
  error TEXT,
  task_id INTEGER,
  item_task_id INTEGER,
  item_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** queued: waiting for the Trendwatcher. analysing: running. waiting: the transcript is being read on the owner's Mac (Agent Reach), the task is parked. analysed: the analysis is stored, the analogue is being made. failed: `error` says why. */
export type LinkState = 'queued' | 'analysing' | 'waiting' | 'analysed' | 'failed';
export type LinkPlatform = 'youtube' | 'instagram' | 'tiktok';

export const analysisSchema = z.object({
  format: z.string().trim().min(3).max(200),
  hook: z.string().trim().min(3).max(300),
  structure: z.array(z.string().trim().min(2).max(300)).min(1).max(8),
  whyItWorks: z.string().trim().min(5).max(600),
  numbers: z.string().trim().max(300).nullable().optional(),
  analogue: z.object({
    type: z.enum(['clip', 'carousel', 'post']),
    topic: z.string().trim().min(5).max(300),
    angle: z.string().trim().min(5).max(500),
  }),
});
export type LinkAnalysis = z.output<typeof analysisSchema>;

export interface LinkRow {
  id: number;
  url: string;
  host: string;
  note: string;
  status: LinkState;
  analysis: LinkAnalysis | null;
  error: string | null;
  taskId: number | null;
  itemTaskId: number | null;
  itemId: number | null;
  createdAt: number;
  updatedAt: number;
}

interface Db3 {
  id: number; url: string; host: string; note: string; status: LinkState; analysis: string | null; error: string | null;
  task_id: number | null; item_task_id: number | null; item_id: number | null; created_at: number; updated_at: number;
}
const toRow = (r: Db3): LinkRow => ({
  id: r.id, url: r.url, host: r.host, note: r.note, status: r.status, analysis: r.analysis ? (JSON.parse(r.analysis) as LinkAnalysis) : null, error: r.error,
  taskId: r.task_id, itemTaskId: r.item_task_id, itemId: r.item_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

export class LinkStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    migrate(db, SCHEMA);
  }

  add(url: string, host: string, note: string): number {
    const t = this.now();
    return Number(this.db.prepare('INSERT INTO ts_links (url, host, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(url, host, note, t, t).lastInsertRowid);
  }

  get(id: number): LinkRow | undefined {
    const r = this.db.prepare('SELECT * FROM ts_links WHERE id = ?').get(id) as Db3 | undefined;
    return r ? toRow(r) : undefined;
  }

  list(limit = 50, beforeId?: number): LinkRow[] {
    const rows = beforeId
      ? (this.db.prepare('SELECT * FROM ts_links WHERE id < ? ORDER BY id DESC LIMIT ?').all(beforeId, limit) as Db3[])
      : (this.db.prepare('SELECT * FROM ts_links ORDER BY id DESC LIMIT ?').all(limit) as Db3[]);
    return rows.map(toRow);
  }

  /** The same link dropped again while it is still being worked on (or was done in the last day) is not queued twice. */
  recent(url: string, sinceMs: number): LinkRow | undefined {
    const r = this.db.prepare("SELECT * FROM ts_links WHERE url = ? AND created_at >= ? AND status != 'failed' ORDER BY id DESC LIMIT 1").get(url, sinceMs) as Db3 | undefined;
    return r ? toRow(r) : undefined;
  }

  setTask(id: number, taskId: number): void {
    this.db.prepare('UPDATE ts_links SET task_id = ?, updated_at = ? WHERE id = ?').run(taskId, this.now(), id);
  }

  setState(id: number, status: LinkState, error: string | null = null): void {
    this.db.prepare('UPDATE ts_links SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, error ? error.slice(0, 300) : null, this.now(), id);
  }

  setAnalysis(id: number, a: LinkAnalysis): void {
    this.db.prepare("UPDATE ts_links SET analysis = ?, status = 'analysed', error = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(a), this.now(), id);
  }

  setItem(id: number, itemTaskId: number, itemId: number | null): void {
    this.db.prepare('UPDATE ts_links SET item_task_id = ?, item_id = ?, updated_at = ? WHERE id = ?').run(itemTaskId, itemId, this.now(), id);
  }

  /** The link behind a content item (the review center shows its analysis as `versions[0].note`). */
  byItem(itemId: number): LinkRow | undefined {
    const r = this.db.prepare('SELECT * FROM ts_links WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(itemId) as Db3 | undefined;
    return r ? toRow(r) : undefined;
  }
}

const HOST_KIND: Record<string, LinkPlatform> = {
  'www.youtube.com': 'youtube', 'm.youtube.com': 'youtube', 'youtube.com': 'youtube', 'youtu.be': 'youtube',
  'www.instagram.com': 'instagram', 'instagram.com': 'instagram',
  'www.tiktok.com': 'tiktok', 'vm.tiktok.com': 'tiktok', 'vt.tiktok.com': 'tiktok',
};

export type ParsedLink = { ok: true; url: string; host: string; platform: LinkPlatform } | { ok: false; reason: string };

/** The owner's text is a URL of one public post on a supported platform: https, no login in the URL, host from `SOCIAL_HOSTS`. */
export function parseLink(raw: string): ParsedLink {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'это не ссылка' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'нужна ссылка https' };
  if (u.username || u.password) return { ok: false, reason: 'в ссылке не должно быть логина' };
  const host = u.hostname.toLowerCase();
  const platform = HOST_KIND[host];
  if (!platform || !(SOCIAL_HOSTS as readonly string[]).includes(host)) return { ok: false, reason: 'беру ссылки Instagram, TikTok и YouTube' };
  u.hash = '';
  return { ok: true, url: u.toString().slice(0, 500), host, platform };
}

export interface LinkMeta {
  platform: LinkPlatform;
  title: string;
  description: string;
  author: string;
  image: string;
  /** What was readable: `oembed`, `og`, `reach` (the Mac), or several. */
  sources: string[];
  /** The words of the video from the owner's Mac (YouTube subtitles through Agent Reach). */
  transcript?: Transcript;
  views?: number;
  likes?: number;
}

export interface Transcript {
  /** Cleaned text, at most 6000 characters. */
  text: string;
  words: number;
  /** Video length in seconds (`youtube read` of the same video), when known. */
  durationS: number | null;
  /** Words per second over the whole video: a number, not a feeling; null without the length. */
  wps: number | null;
  /** The first words: the hook as it is spoken. */
  opening: string;
  /** Lines that came with a time (`m:ss text`): the Agent Reach subtitle text has none today, so this is usually empty. */
  timed: { t: number; text: string }[];
}

const TIMED = /^\s*\[?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,]\d+)?\]?\s+(\S.*)$/;

/** Subtitle text to what the analysis uses: cleaned lines, word count, pace per second, the opening, and times when the lines carry them. */
export function parseTranscript(raw: string, durationS: number | null): Transcript | null {
  const lines = raw.replace(/\r/g, '').split('\n').map((l) => l.replace(/[♪♫]/g, '').trim()).filter((l) => l && !/^\[[^\]]{1,30}\]$/.test(l));
  const timed: { t: number; text: string }[] = [];
  const texts: string[] = [];
  for (const l of lines) {
    const m = TIMED.exec(l);
    if (m) {
      timed.push({ t: Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]), text: m[4]! });
      texts.push(m[4]!);
    } else texts.push(l);
  }
  const text = texts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
  const words = text ? text.split(' ').length : 0;
  if (words < 3) return null;
  const dur = durationS && durationS > 0 ? durationS : null;
  return { text, words, durationS: dur, wps: dur ? Math.round((words / dur) * 10) / 10 : null, opening: text.split(' ').slice(0, 25).join(' '), timed: timed.slice(0, 400) };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** What Agent Reach gave for a link, or the job the worker has to wait for. */
export type ReachGather = { waiting: number } | { transcript?: Transcript; title?: string; author?: string; views?: number; likes?: number };

const instagramUser = (url: string): string | null => {
  try {
    const first = new URL(url).pathname.split('/').filter(Boolean)[0];
    return first && !['p', 'reel', 'reels', 'tv', 'stories', 'explore'].includes(first) && /^[A-Za-z0-9._]{1,60}$/.test(first) ? first : null;
  } catch {
    return null;
  }
};

/**
 * The owner's Mac through `tools.reach` (Agent Reach), asked before the page is read. YouTube: `subtitle` and `read` of the video (both jobs are queued in one go
 * so one Mac run answers both). A job not answered yet gives `{ waiting }`: the worker parks its task and runs again when the answer is in (it is then in the
 * 24-hour cache). Any failure (no rights, the Mac failed, no subtitles) is skipped: the page path goes on alone. Instagram: the og path stays, and only when the
 * Mac reported the channel as set up (`settings.reach.channels`) the author's `profile` and `posts` are queued for later (nobody waits for them).
 */
export async function gatherReach(tools: Tools, db: Db, link: { url: string; platform: LinkPlatform }): Promise<ReachGather> {
  if (link.platform === 'instagram') {
    const user = instagramUser(link.url);
    if (user && reachChannels(db).includes('instagram')) {
      await tools.reach.instagram.profile({ username: user });
      await tools.reach.instagram.posts({ username: user, limit: 5 });
    }
    return {};
  }
  if (link.platform !== 'youtube') return {};
  const [sub, info] = await Promise.all([
    tools.reach.youtube.subtitle({ target: link.url, lang: 'ru,en,en-orig,uz,tg,uk' }),
    tools.reach.youtube.read({ target: link.url }),
  ]);
  const queued = (r: ToolResult<ReachOutcome>): number | null => (r.ok && r.value.state === 'queued' ? r.value.jobId : null);
  const waiting = queued(sub) ?? queued(info);
  if (waiting !== null) return { waiting };
  const out: { transcript?: Transcript; title?: string; author?: string; views?: number; likes?: number } = {};
  let durationS: number | null = null;
  if (info.ok && info.value.state === 'done' && info.value.result.ok) {
    const it = info.value.result.items[0];
    const raw = (it?.raw ?? {}) as Record<string, unknown>;
    durationS = num(raw.duration) ?? null;
    if (typeof it?.title === 'string') out.title = it.title;
    if (typeof it?.author === 'string') out.author = it.author;
    const views = num(raw.view_count);
    const likes = num(raw.like_count);
    if (views !== undefined) out.views = views;
    if (likes !== undefined) out.likes = likes;
  }
  if (sub.ok && sub.value.state === 'done' && sub.value.result.ok) {
    const text = sub.value.result.items[0]?.text;
    const t = typeof text === 'string' ? parseTranscript(text, durationS) : null;
    if (t) out.transcript = t;
  }
  return out;
}

/** `og:*` and `twitter:*` meta tags of a page, attribute order free, entities decoded. */
export function ogTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.slice(0, 400_000).matchAll(/<meta\b([^>]*)>/gi)) {
    const a = m[1]!;
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(a)?.[1]?.toLowerCase();
    const val = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(a);
    const v = val ? (val[1] ?? val[2] ?? '') : '';
    if (key && v && (key.startsWith('og:') || key.startsWith('twitter:') || key === 'description') && !(key in out)) out[key] = decodeEntities(v).trim();
  }
  return out;
}

const OEMBED: Partial<Record<LinkPlatform, string>> = { youtube: 'https://www.youtube.com/oembed', tiktok: 'https://www.tiktok.com/oembed' };
const clip = (s: unknown, n: number): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/**
 * What the platform shows without a login: the oEmbed answer (YouTube, TikTok; Instagram has none without an app token) and the page's og tags.
 * Hosts are fixed to `SOCIAL_HOSTS`; any failure of one source is skipped, `null` only when nothing at all could be read.
 */
export async function fetchLinkMeta(tools: Tools, link: { url: string; platform: LinkPlatform }): Promise<LinkMeta | null> {
  const meta: LinkMeta = { platform: link.platform, title: '', description: '', author: '', image: '', sources: [] };
  const hosts = SOCIAL_HOSTS;
  const oembed = OEMBED[link.platform];
  if (oembed) {
    const r = await tools.web.getJson<{ title?: unknown; author_name?: unknown; thumbnail_url?: unknown }>(`${oembed}?url=${encodeURIComponent(link.url)}&format=json`, { hosts });
    if (r.ok) {
      meta.title = clip(r.value.title, 300);
      meta.author = clip(r.value.author_name, 120);
      meta.image = clip(r.value.thumbnail_url, 500);
      if (meta.title || meta.author) meta.sources.push('oembed');
    }
  }
  const page = await tools.web.getText(link.url, { hosts });
  if (page.ok) {
    const og = ogTags(page.value.text);
    const title = clip(og['og:title'] ?? og['twitter:title'], 300);
    const desc = clip(og['og:description'] ?? og['twitter:description'] ?? og['description'], 1200);
    if (title || desc) {
      meta.title ||= title;
      meta.description = desc;
      meta.image ||= clip(og['og:image'], 500);
      meta.sources.push('og');
    }
  }
  return meta.sources.length > 0 ? meta : null;
}

const SYSTEM =
  'Ты трендвотчер студии Fir Tech: ИИ-агенты, Telegram-боты и сайты для малого бизнеса, короткие видео на русском для Instagram, TikTok и Shorts. ' +
  'Владелец прислал ссылку на чужой ролик или пост. Видео ты не смотрел: у тебя только название, описание и автор со страницы, а у YouTube иногда ещё и слова ролика (транскрипт). Разбери, что видно из них, и не выдумывай того, чего там нет. ' +
  'Если есть транскрипт: хук бери из первых слов, структуру из хода текста, темп из строки «Темп» (слов в секунду посчитаны из данных, не оценивай на глаз); кадра и голоса ты не видел, про картинку не пиши. ' +
  'Числа (просмотры, лайки, длительность) называй только если они есть в данных, иначе numbers = null. ' +
  'Разбор: format (формат подачи), hook (какой крючок в начале, одной фразой), structure (2-8 шагов, как построен ролик или пост), whyItWorks (почему это заходит). ' +
  'Затем аналог для Fir Tech: analogue.type clip (рилс), carousel или post; topic (тема материала студии, по смыслу про ботов и автоматизацию для малого бизнеса, своими словами, без чужих названий и текстов); angle (как перенести механику). ' +
  'Пиши по-русски, коротко, без эмодзи и без длинных тире, цен и сроков не называй. Ответ: только JSON {"format","hook","structure":[],"whyItWorks","numbers","analogue":{"type","topic","angle"}}.';

export async function analyseLink(llm: LlmClient, meta: LinkMeta, note: string): Promise<LinkAnalysis | null> {
  const lines = [
    `Платформа: ${meta.platform}`, meta.author ? `Автор: ${meta.author}` : '', meta.title ? `Название: ${meta.title}` : '', meta.description ? `Описание: ${meta.description}` : '',
    meta.views !== undefined ? `Просмотры: ${meta.views}${meta.likes !== undefined ? `, лайки: ${meta.likes}` : ''}` : '',
    meta.transcript ? `Транскрипт (${meta.transcript.words} слов${meta.transcript.durationS ? `, ролик ${meta.transcript.durationS} с` : ''}):` : '',
    meta.transcript ? meta.transcript.text.slice(0, 4500) : '',
    meta.transcript?.wps ? `Темп: ${meta.transcript.wps} слов в секунду` : '',
    meta.transcript && meta.transcript.timed.length > 1 ? `Время реплик: ${meta.transcript.timed.slice(0, 12).map((l) => `${l.t} с`).join(', ')}` : '',
    note ? `Заметка владельца: ${note}` : '',
  ].filter(Boolean);
  return tryJson(llm, { tier: 'sonnet', maxTokens: 1500, system: withPlaybook(SYSTEM, 'trend-scout'), messages: [{ role: 'user', content: lines.join('\n') }] }, analysisSchema);
}

/** The analysis as the text the owner reads (`versions[0].note` of the item, the task result). */
export function analysisText(a: LinkAnalysis, url: string): string {
  return [
    `Разбор ссылки ${url}`,
    `Формат: ${a.format}`,
    `Хук: ${a.hook}`,
    `Структура:\n${a.structure.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    `Почему работает: ${a.whyItWorks}`,
    ...(a.numbers ? [`Цифры из данных страницы: ${a.numbers}`] : []),
    `Аналог для Fir Tech (${a.analogue.type === 'clip' ? 'рилс' : a.analogue.type === 'carousel' ? 'карусель' : 'пост'}): ${a.analogue.topic}. ${a.analogue.angle}`,
  ].join('\n');
}
