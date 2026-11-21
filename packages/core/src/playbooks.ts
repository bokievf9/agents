import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleTitle } from './role-titles.js';

/**
 * Role playbooks: `knowledge/playbooks/<role>.md`, condensed craft rules written for the agents (and reviewed by the owner
 * through `/playbook <role>`). A worker appends a bounded excerpt (the Правила and Чеклист sections) to its system prompt.
 */
export const PLAYBOOK_ROLES = ['content-maker', 'publisher', 'trend-scout', 'seo', 'analyst', 'sales', 'renderer-builder'] as const;
export type PlaybookRole = (typeof PLAYBOOK_ROLES)[number];

export const PLAYBOOK_ROLE_RU: Record<PlaybookRole, string> = {
  'content-maker': roleTitle('content-maker'),
  publisher: roleTitle('publisher'),
  'trend-scout': roleTitle('trend-scout'),
  seo: roleTitle('seo'),
  analyst: roleTitle('analyst'),
  sales: 'Sales',
  'renderer-builder': 'Render Builder',
};

export const isPlaybookRole = (s: string): s is PlaybookRole => (PLAYBOOK_ROLES as readonly string[]).includes(s);

/** The cap of a prompt excerpt, in characters (about 700 tokens of Russian text). */
export const EXCERPT_MAX = 2500;

const cache = new Map<string, string>();

/** Test hook: forget what was read. */
export function clearPlaybookCache(): void {
  cache.clear();
  rubricCache.clear();
}

/**
 * The folder with `playbooks/`: the given one, else `KNOWLEDGE_DIR` (the image sets it), else the repo `knowledge/` found by walking up
 * from the working directory and from this file (dev, tests). undefined when there is none.
 */
export function knowledgeDir(dir?: string): string | undefined {
  const given = dir ?? process.env.KNOWLEDGE_DIR;
  if (given) return existsSync(join(given, 'playbooks')) ? given : undefined;
  for (const start of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    let cur = resolve(start);
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(cur, 'knowledge', 'playbooks'))) return join(cur, 'knowledge');
      const up = dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  return undefined;
}

function loadFile(name: string, dir?: string): string {
  const root = knowledgeDir(dir);
  const key = `${root ?? ''}|${name}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let text = '';
  try {
    if (root) text = readFileSync(join(root, 'playbooks', `${name}.md`), 'utf8').trim();
  } catch {
    text = '';
  }
  cache.set(key, text);
  return text;
}

/** The whole playbook text, read once per folder and role (cached, also when the file is missing: then an empty string). */
export function loadPlaybook(role: PlaybookRole, dir?: string): string {
  return loadFile(role, dir);
}

/** The body of the `## <name...>` section (heading excluded), or an empty string. A name is matched by its start. */
export function playbookSection(text: string, name: string): string {
  const parts = text.split(/^## /m).slice(1);
  const hit = parts.find((p) => p.toLowerCase().startsWith(name.toLowerCase()));
  return hit ? hit.slice(hit.indexOf('\n') + 1).trim() : '';
}

/** The «Правила» section: what `/playbook` sends to the owner. */
export function playbookRules(role: PlaybookRole, dir?: string): string {
  return playbookSection(loadPlaybook(role, dir), 'Правила');
}

/** Rules and checklist of a playbook text under `max` characters: the checklist whole when it fits, the rules fill the rest bullet by bullet. */
function excerptOf(text: string, head: string, max: number): string {
  if (!text) return '';
  const rules = playbookSection(text, 'Правила');
  const check = playbookSection(text, 'Чеклист');
  const checkBlock = check ? `\nЧеклист перед сдачей:\n${check}` : '';
  const room = max - head.length - '\nПравила:\n'.length - Math.min(checkBlock.length, Math.floor(max / 2));
  const kept: string[] = [];
  let used = 0;
  for (const line of rules.split('\n').filter((l) => l.trim())) {
    if (used + line.length + 1 > room) break;
    kept.push(line);
    used += line.length + 1;
  }
  const rulesBlock = kept.length ? `\nПравила:\n${kept.join('\n')}` : '';
  let out = `${head}${rulesBlock}${checkBlock}`;
  if (out.length > max) out = `${out.slice(0, max - 1).trimEnd()}…`;
  return out;
}

/**
 * Prompt excerpt: the Правила and the Чеклист sections, at most `max` characters. The checklist is kept whole when it fits; the rules
 * fill the rest bullet by bullet (the most important rules come first in every playbook). Empty when there is no playbook.
 */
export function playbookExcerpt(role: PlaybookRole, max: number = EXCERPT_MAX, dir?: string): string {
  return excerptOf(loadPlaybook(role, dir), `Плейбук роли «${PLAYBOOK_ROLE_RU[role]}». Если он расходится с правилами выше, действуют правила выше; формат ответа задан выше и не меняется.`, max);
}

/**
 * Topic playbooks (`knowledge/playbooks/ig-*.md`): craft conspects of the owner's Instagram skills (reels, captions, carousels and stories,
 * human text, viral swipe, audit, profile, comments and DMs, plan). Not roles: a worker adds the topics of the task at hand to the request,
 * `playbook.excerpt(topic)` gives them to any agent. Each excerpt has its own cap.
 */
export const PLAYBOOK_TOPICS = ['ig-reels', 'ig-captions', 'ig-carousel-story', 'ig-human', 'ig-viral', 'ig-audit', 'ig-profile', 'ig-engage', 'ig-plan'] as const;
export type PlaybookTopic = (typeof PLAYBOOK_TOPICS)[number];

export const PLAYBOOK_TOPIC_RU: Record<PlaybookTopic, string> = {
  'ig-reels': 'Рилсы: хук, сценарий, тайминг',
  'ig-captions': 'Подписи и хэштеги',
  'ig-carousel-story': 'Карусели и истории',
  'ig-human': 'Человеческий текст',
  'ig-viral': 'Что работает в нише',
  'ig-audit': 'Разбор выложенного',
  'ig-profile': 'Профиль и рубрика на 100 баллов',
  'ig-engage': 'Комментарии, ответы, директ',
  'ig-plan': 'План недели и переупаковка',
};

export const isPlaybookTopic = (s: string): s is PlaybookTopic => (PLAYBOOK_TOPICS as readonly string[]).includes(s);

/** The cap of one topic excerpt, in characters. */
export const TOPIC_EXCERPT_MAX = 1500;

/** The whole text of a topic playbook (cached; an empty string when the file is missing). */
export function loadTopic(topic: PlaybookTopic, dir?: string): string {
  return loadFile(topic, dir);
}

/** Rules and checklist of a topic, at most `max` characters (default `TOPIC_EXCERPT_MAX`). Empty when the file is missing. */
export function topicExcerpt(topic: PlaybookTopic, max: number = TOPIC_EXCERPT_MAX, dir?: string): string {
  return excerptOf(loadTopic(topic, dir), `Приёмы ремесла: ${PLAYBOOK_TOPIC_RU[topic]}. Дополняют правила выше, не отменяют их.`, max);
}

/** Excerpts of several topics, one after another. */
export function topicsExcerpt(topics: readonly PlaybookTopic[], dir?: string): string {
  return topics.map((t) => topicExcerpt(t, TOPIC_EXCERPT_MAX, dir)).filter(Boolean).join('\n\n');
}

export interface ProfileRubricItem {
  id: string;
  points: number;
  ru: { name: string; full_marks: string; common_fail: string };
  en: { full_marks: string; common_fail: string };
}
export interface ProfileRubric {
  total: number;
  note_ru: string;
  items: ProfileRubricItem[];
}

const rubricCache = new Map<string, ProfileRubric | null>();
/** `knowledge/profile-rubric.json`: twelve items, 100 points (`/profile` scores a profile against it). null when the file is missing. */
export function loadProfileRubric(dir?: string): ProfileRubric | null {
  const root = knowledgeDir(dir);
  const key = root ?? '';
  if (rubricCache.has(key)) return rubricCache.get(key)!;
  let data: ProfileRubric | null = null;
  try {
    if (root) data = JSON.parse(readFileSync(join(root, 'profile-rubric.json'), 'utf8')) as ProfileRubric;
  } catch {
    data = null;
  }
  rubricCache.set(key, data);
  return data;
}

/** The rubric as prompt lines: «имя (баллы): полные баллы. Обычно проваливают: ...». */
export function profileRubricText(dir?: string): string {
  const r = loadProfileRubric(dir);
  if (!r) return '';
  return [`Рубрика профиля, ${r.total} баллов:`, ...r.items.map((i) => `- ${i.ru.name} (${i.points}): ${i.ru.full_marks} Обычно проваливают: ${i.ru.common_fail}`)].join('\n');
}

/** Sums the points per item (each capped at the item's maximum): the profile score out of 100, and what was lost, biggest first. */
export function scoreProfile(points: Record<string, number>, dir?: string): { total: number; max: number; lost: { id: string; name: string; lost: number }[] } | null {
  const r = loadProfileRubric(dir);
  if (!r) return null;
  let total = 0;
  const lost: { id: string; name: string; lost: number }[] = [];
  for (const i of r.items) {
    const got = Math.min(Math.max(Number(points[i.id]) || 0, 0), i.points);
    total += got;
    if (got < i.points) lost.push({ id: i.id, name: i.ru.name, lost: i.points - got });
  }
  return { total, max: r.total, lost: lost.sort((x, y) => y.lost - x.lost) };
}

/** `system` plus the role excerpt; `system` as it was when there is no playbook. */
export function withPlaybook(system: string, role: PlaybookRole, dir?: string): string {
  const ex = playbookExcerpt(role, EXCERPT_MAX, dir);
  return ex ? `${system}\n\n${ex}` : system;
}

/** The skills a playbook was condensed from: the names after «навыки» in its «Источники» line (parentheses dropped). */
export function playbookSources(text: string): string[] {
  const line = text.split('\n').find((l) => l.startsWith('Источники'));
  if (!line) return [];
  const at = line.indexOf('навыки');
  const after = at < 0 ? '' : line.slice(at + 'навыки'.length);
  return after
    .replace(/\([^)]*\)/g, ' ')
    .split(/[,.]|\s+и\s+/)
    .map((x) => x.trim())
    .filter((x) => /^[a-z][a-z0-9-]*$/.test(x));
}

export interface PlaybookInfo {
  role: PlaybookRole;
  /** The file's mtime, ISO. */
  updatedAt: string;
  lines: number;
  sourceSkills: string[];
}

/** One entry per playbook file that exists (role order); empty when there is no knowledge folder. Used by `GET /admin/company`. */
export function listPlaybooks(dir?: string): PlaybookInfo[] {
  const root = knowledgeDir(dir);
  if (!root) return [];
  const out: PlaybookInfo[] = [];
  for (const role of PLAYBOOK_ROLES) {
    const file = join(root, 'playbooks', `${role}.md`);
    try {
      const mtime = statSync(file).mtime;
      const text = readFileSync(file, 'utf8').trim();
      out.push({ role, updatedAt: mtime.toISOString(), lines: text ? text.split('\n').length : 0, sourceSkills: playbookSources(text) });
    } catch {
      /* a missing file is not listed */
    }
  }
  return out;
}
