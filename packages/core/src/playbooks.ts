import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Role playbooks: `knowledge/playbooks/<role>.md`, condensed craft rules written for the agents (and reviewed by the owner
 * through `/playbook <role>`). A worker appends a bounded excerpt (the Правила and Чеклист sections) to its system prompt.
 */
export const PLAYBOOK_ROLES = ['content-maker', 'publisher', 'trend-scout', 'seo', 'analyst', 'sales', 'renderer-builder'] as const;
export type PlaybookRole = (typeof PLAYBOOK_ROLES)[number];

export const PLAYBOOK_ROLE_RU: Record<PlaybookRole, string> = {
  'content-maker': 'Контент-мейкер',
  publisher: 'Публикатор',
  'trend-scout': 'Трендвотчер',
  seo: 'SEO',
  analyst: 'Аналитик',
  sales: 'Продажи',
  'renderer-builder': 'Строитель рендера',
};

export const isPlaybookRole = (s: string): s is PlaybookRole => (PLAYBOOK_ROLES as readonly string[]).includes(s);

/** The cap of a prompt excerpt, in characters (about 700 tokens of Russian text). */
export const EXCERPT_MAX = 2500;

const cache = new Map<string, string>();

/** Test hook: forget what was read. */
export function clearPlaybookCache(): void {
  cache.clear();
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

/** The whole playbook text, read once per folder and role (cached, also when the file is missing: then an empty string). */
export function loadPlaybook(role: PlaybookRole, dir?: string): string {
  const root = knowledgeDir(dir);
  const key = `${root ?? ''}|${role}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let text = '';
  try {
    if (root) text = readFileSync(join(root, 'playbooks', `${role}.md`), 'utf8').trim();
  } catch {
    text = '';
  }
  cache.set(key, text);
  return text;
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

/**
 * Prompt excerpt: the Правила and the Чеклист sections, at most `max` characters. The checklist is kept whole when it fits; the rules
 * fill the rest bullet by bullet (the most important rules come first in every playbook). Empty when there is no playbook.
 */
export function playbookExcerpt(role: PlaybookRole, max: number = EXCERPT_MAX, dir?: string): string {
  const text = loadPlaybook(role, dir);
  if (!text) return '';
  const rules = playbookSection(text, 'Правила');
  const check = playbookSection(text, 'Чеклист');
  const head = `Плейбук роли «${PLAYBOOK_ROLE_RU[role]}». Если он расходится с правилами выше, действуют правила выше; формат ответа задан выше и не меняется.`;
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

/** `system` plus the role excerpt; `system` as it was when there is no playbook. */
export function withPlaybook(system: string, role: PlaybookRole, dir?: string): string {
  const ex = playbookExcerpt(role, EXCERPT_MAX, dir);
  return ex ? `${system}\n\n${ex}` : system;
}
