import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DEFAULT_RETENTION, MODEL_TIERS, type CompanyPack, type NichePack, type QA, type RolePack } from './spec.js';

/**
 * Packs on disk. Role and niche packs are Markdown a person can read and edit (`role-packs/<id>.md`, `niche-packs/<id>.md`): a front matter
 * of `key: value` lines, then `## Раздел` headings with bullet lists. Company packs are JSON (`company-packs/<id>.json`): in production they come
 * from the `companies` table, the file is tenant 0 (Fir Tech) and the test fixture. Changes only by commit, like the playbooks.
 */

/** The package root (works from `src` under tsx/vitest and from `dist` after the build). */
export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface ParsedMd {
  meta: Record<string, string>;
  title: string;
  sections: Record<string, string[]>;
  /** Plain lines (not bullets) of each section, joined. */
  prose: Record<string, string>;
}

/** Front matter, the `# ` title and the `## ` sections (bullets as items; a bullet's indented continuation lines are joined to it). */
export function parseMd(md: string): ParsedMd {
  const meta: Record<string, string> = {};
  let body = md.replace(/\r/g, '');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (fm) {
    for (const line of fm[1]!.split('\n')) {
      const m = /^([\w-]+):\s*(.*)$/.exec(line.trim());
      if (m) meta[m[1]!] = m[2]!.trim();
    }
    body = body.slice(fm[0].length);
  }
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? '';
  const sections: Record<string, string[]> = {};
  const prose: Record<string, string> = {};
  let current: string | null = null;
  for (const line of body.split('\n')) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      current = h[1]!.trim().toLowerCase();
      sections[current] = [];
      prose[current] = '';
      continue;
    }
    if (!current) continue;
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet && !/^\s{2,}/.test(line)) sections[current]!.push(bullet[1]!.trim());
    else if (/^\s{2,}\S/.test(line) && sections[current]!.length) sections[current]![sections[current]!.length - 1] += ` ${line.trim()}`;
    else if (line.trim()) prose[current] = `${prose[current]} ${line.trim()}`.trim();
  }
  return { meta, title, sections, prose };
}

const list = (s: string | undefined): string[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const pick = (p: ParsedMd, ...names: string[]): string[] => names.flatMap((n) => p.sections[n] ?? []);

/** «вопрос :: ответ» bullets. */
function qa(items: string[]): QA[] {
  return items.flatMap((x) => {
    const i = x.indexOf('::');
    return i > 0 ? [{ q: x.slice(0, i).trim(), a: x.slice(i + 2).trim() }] : [];
  });
}

const RoleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(2),
  goal: z.string().min(10),
  duties: z.array(z.string()).min(1),
  boundaries: z.array(z.string()).min(1),
  handoff: z.array(z.string()),
  metrics: z.array(z.string()).min(1),
  style: z.array(z.string()),
  tools: z.array(z.string()),
  tier: z.enum(MODEL_TIERS),
});

const NicheSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(2),
  terms: z.array(z.string()),
  services: z.array(z.string()).min(1),
  faq: z.array(z.object({ q: z.string().min(2), a: z.string().min(2) })),
  objections: z.array(z.object({ q: z.string().min(2), a: z.string().min(2) })),
  boundaries: z.array(z.string()),
  tone: z.array(z.string()),
});

export const CompanySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  about: z.string(),
  facts: z.array(z.string()),
  style: z.object({
    address: z.enum(['vy', 'ty']),
    maxSentences: z.number().int().min(1).max(10),
    emoji: z.boolean(),
    languages: z.array(z.string()).min(1),
    voice: z.array(z.string()),
    forbiddenTopics: z.array(z.string()),
  }),
  rights: z.object({ allow: z.array(z.string()), deny: z.array(z.string()), locked: z.array(z.string()) }),
  retention: z.object({ liveDays: z.number().int().min(1).max(3650), anonHours: z.number().int().min(0).max(24 * 30) }).default(DEFAULT_RETENTION),
});

export function parseRolePack(md: string): RolePack {
  const p = parseMd(md);
  return RoleSchema.parse({
    id: p.meta.id,
    title: p.meta.title ?? p.title,
    goal: p.prose['цель'] ?? pick(p, 'цель').join(' '),
    duties: pick(p, 'обязанности'),
    boundaries: pick(p, 'границы'),
    handoff: pick(p, 'передача человеку'),
    metrics: pick(p, 'метрики'),
    style: pick(p, 'стиль'),
    tools: list(p.meta.tools),
    tier: p.meta.tier ?? 'sonnet',
  });
}

export function parseNichePack(md: string): NichePack {
  const p = parseMd(md);
  return NicheSchema.parse({
    id: p.meta.id,
    title: p.meta.title ?? p.title,
    terms: pick(p, 'термины'),
    services: pick(p, 'услуги'),
    faq: qa(pick(p, 'частые вопросы')),
    objections: qa(pick(p, 'возражения')),
    boundaries: pick(p, 'границы'),
    tone: pick(p, 'тон'),
  });
}

export function parseCompanyPack(json: unknown): CompanyPack {
  return CompanySchema.parse(json);
}

const safeId = (id: string): string => {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`fira: bad pack id ${JSON.stringify(id)}`);
  return id;
};

export const loadRolePack = (id: string, dir = join(PACKAGE_DIR, 'role-packs')): RolePack => parseRolePack(readFileSync(join(dir, `${safeId(id)}.md`), 'utf8'));
export const loadNichePack = (id: string, dir = join(PACKAGE_DIR, 'niche-packs')): NichePack => parseNichePack(readFileSync(join(dir, `${safeId(id)}.md`), 'utf8'));
export const loadCompanyPack = (id: string, dir = join(PACKAGE_DIR, 'company-packs')): CompanyPack =>
  parseCompanyPack(JSON.parse(readFileSync(join(dir, `${safeId(id)}.json`), 'utf8')) as unknown);
