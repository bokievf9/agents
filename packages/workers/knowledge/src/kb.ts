import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zonedParts } from '@fir/core';
import type { Lesson } from './store.js';

export interface PlaybookTitle {
  file: string;
  title: string;
}

/** Playbook titles: the first `# ` heading of each `playbooks/*.md` (the file name when there is none). */
export function playbookTitles(dir: string | undefined): PlaybookTitle[] {
  if (!dir) return [];
  const pb = join(dir, 'playbooks');
  if (!existsSync(pb)) return [];
  return readdirSync(pb)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      const head = /^#\s+(.+)$/m.exec(readFileSync(join(pb, file), 'utf8'))?.[1]?.trim();
      return { file, title: head ?? file.replace(/\.md$/, '') };
    });
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
const words = (q: string) => norm(q).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);

/** A word matches by its stem (one letter dropped), so «деплоя» finds «деплой». */
const hit = (text: string, w: string) => text.includes(w.slice(0, Math.max(3, w.length - 1)));

/** Search in lessons and playbook titles: every query word has to appear. */
export function searchKb(query: string, lessons: Lesson[], titles: PlaybookTitle[]): { lessons: Lesson[]; playbooks: PlaybookTitle[] } {
  const ws = words(query);
  if (!ws.length) return { lessons: [], playbooks: [] };
  return {
    lessons: lessons.filter((l) => { const t = norm(`${l.project} ${l.text}`); return ws.every((w) => hit(t, w)); }),
    playbooks: titles.filter((p) => { const t = norm(`${p.title} ${p.file}`); return ws.every((w) => hit(t, w)); }),
  };
}

export function searchText(query: string, r: ReturnType<typeof searchKb>): string {
  const out: string[] = [];
  if (r.playbooks.length) out.push(`Плейбуки:\n${r.playbooks.map((p) => `- ${p.title} (knowledge/playbooks/${p.file})`).join('\n')}`);
  if (r.lessons.length) out.push(`Уроки:\n${r.lessons.slice(-10).map((l) => `- [${l.project}] ${l.text.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')}`);
  return out.length ? out.join('\n\n') : `По запросу «${query}» в базе знаний пусто.`;
}

/** The text of `knowledge/lessons/<YYYY-MM>.md` additions for a builder to commit. Newest lessons last. */
export function renderLessons(lessons: Lesson[], tz: string, nowMs: number): string {
  const p = zonedParts(nowMs, tz);
  const month = `${p.y}-${String(p.mo).padStart(2, '0')}`;
  const byProject = new Map<string, Lesson[]>();
  for (const l of lessons) byProject.set(l.project, [...(byProject.get(l.project) ?? []), l]);
  const out = [`Файл: knowledge/lessons/${month}.md (создать или дополнить, существующие записи не менять).`, ''];
  for (const [project, ls] of byProject) {
    out.push(`## ${project}`);
    for (const l of ls) {
      const d = zonedParts(l.createdAt, tz);
      out.push(`- ${d.y}-${String(d.mo).padStart(2, '0')}-${String(d.d).padStart(2, '0')}: ${l.text.replace(/\s+/g, ' ').trim()}`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

/** `/lesson` arguments: "<project>: <text>". */
export function parseLesson(arg: string): { project: string; text: string } | null {
  const m = /^([^:\n]{1,80}):\s*([\s\S]+)$/.exec(arg.trim());
  if (!m || !m[1]!.trim() || !m[2]!.trim()) return null;
  return { project: m[1]!.trim(), text: m[2]!.trim().slice(0, 1000) };
}
