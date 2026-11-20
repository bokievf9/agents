import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { z } from 'zod';
import { tryComplete, tryJson, type LlmRequest } from '../llm.js';
import { isPlaybookRole, isPlaybookTopic, knowledgeDir, playbookExcerpt, topicExcerpt } from '../playbooks.js';
import { getPrices, type Prices } from '../prices.js';
import type { Kit } from './kit.js';
import { policyOf } from './policy.js';
import { dayIn, fail, okv, type ToolResult } from './result.js';

export interface LlmTools {
  /** Structured answer checked by the schema (up to 3 calls); `not_configured` in «LLM off», `upstream` when the model gave nothing valid. */
  json<S extends z.ZodType>(req: LlmRequest, schema: S): Promise<ToolResult<z.output<S>>>;
  text(req: LlmRequest): Promise<ToolResult<string>>;
}

export function createLlmTools(k: Kit): LlmTools {
  const valid = (req: LlmRequest) => req && (req.tier === 'haiku' || req.tier === 'sonnet') && typeof req.system === 'string' && Array.isArray(req.messages) && req.messages.length > 0;
  return {
    json: (req, schema) =>
      k.call('llm.json', async () => {
        if (!valid(req)) return fail('invalid', 'request: tier, system and at least one message');
        const r = await tryJson(k.deps.llm!, req, schema);
        return r === null ? fail('upstream', 'the model gave no valid answer', { retryable: false }) : okv(r);
      }),
    text: (req) =>
      k.call('llm.text', async () => {
        if (!valid(req)) return fail('invalid', 'request: tier, system and at least one message');
        const r = await tryComplete(k.deps.llm!, req);
        return r === null ? fail('upstream', 'the model gave no answer', { retryable: false }) : okv(r);
      }),
  };
}

// ---- knowledge ----
const LESSONS = `
CREATE TABLE IF NOT EXISTS kb_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  exported_task INTEGER
);
`;

export interface KnowledgeHit {
  kind: 'file' | 'lesson';
  /** `playbooks/sales.md` or `lesson:12`. */
  ref: string;
  title: string;
  /** The lines around the match, at most ~400 characters. */
  excerpt: string;
  score: number;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
const words = (q: string) => [...new Set(norm(q).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))];
/** A word matches by its stem (the last letter dropped), as the knowledge worker's `/kb` does. */
const stem = (w: string) => w.slice(0, Math.max(3, w.length - 1));

function mdFiles(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...mdFiles(p, depth + 1));
    else if (e.isFile() && e.name.endsWith('.md') && statSync(p).size < 500_000) out.push(p);
  }
  return out;
}

/** Full-text search: every query word (by stem) must occur; score = occurrences, title hits count triple. */
export function searchKnowledge(query: string, files: { ref: string; text: string }[], lessons: { id: number; project: string; text: string }[], limit: number): KnowledgeHit[] {
  const ws = words(query).map(stem);
  if (!ws.length) return [];
  const hits: KnowledgeHit[] = [];
  const count = (t: string, w: string) => t.split(w).length - 1;
  for (const f of files) {
    const t = norm(f.text);
    if (!ws.every((w) => t.includes(w))) continue;
    const title = /^#\s+(.+)$/m.exec(f.text)?.[1]?.trim() ?? f.ref;
    const lines = f.text.split('\n');
    const at = lines.findIndex((l) => ws.some((w) => norm(l).includes(w)));
    const excerpt = lines.slice(Math.max(0, at - 1), at + 3).join('\n').trim().slice(0, 400);
    hits.push({ kind: 'file', ref: f.ref, title, excerpt, score: ws.reduce((s, w) => s + count(t, w) + count(norm(title), w) * 3, 0) });
  }
  for (const l of lessons) {
    const t = norm(`${l.project} ${l.text}`);
    if (!ws.every((w) => t.includes(w))) continue;
    hits.push({ kind: 'lesson', ref: `lesson:${l.id}`, title: l.project, excerpt: l.text.replace(/\s+/g, ' ').slice(0, 400), score: ws.reduce((s, w) => s + count(t, w), 0) + 1 });
  }
  return hits.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref)).slice(0, limit);
}

export interface DataTools {
  prices: { get(): Promise<ToolResult<Prices>> };
  playbook: { excerpt(role: string, max?: number): Promise<ToolResult<string>> };
  knowledge: {
    search(q: string, o?: { limit?: number }): Promise<ToolResult<KnowledgeHit[]>>;
    /** A lesson from a project (`/kb` and the weekly export to `knowledge/lessons/` pick it up). */
    add(lesson: { project: string; text: string }): Promise<ToolResult<{ id: number }>>;
  };
  events: { week(): Promise<ToolResult<WeekEvents>> };
  crm: {
    leads(o?: CrmQuery): Promise<ToolResult<Record<string, unknown>[]>>;
    clients(o?: CrmQuery): Promise<ToolResult<Record<string, unknown>[]>>;
    projects(o?: CrmQuery): Promise<ToolResult<Record<string, unknown>[]>>;
    invoices(o?: CrmQuery): Promise<ToolResult<Record<string, unknown>[]>>;
    tickets(o?: CrmQuery): Promise<ToolResult<Record<string, unknown>[]>>;
  };
}

/** Site event counters of the last seven days (company clock); `available: false` when the site never sent any. */
export interface WeekEvents {
  from: string;
  to: string;
  available: boolean;
  totals: Record<string, number>;
  byDay: { day: string; count: number }[];
}

export interface CrmQuery {
  q?: string;
  limit?: number;
  status?: string;
}

/** Fields that identify or reach a person: hidden from departments that do not talk to clients. */
const CONTACT_KEYS = /^(contact|phone|email|telegram|instagram|whatsapp|username|chatId|chat_id|address|website)$/i;

export function redactContacts(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactContacts);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([key]) => !CONTACT_KEYS.test(key)).map(([key, x]) => [key, redactContacts(x)]));
  }
  return v;
}

const DAY = 86_400_000;

export function createDataTools(k: Kit): DataTools {
  const db = k.deps.db;
  const kdir = () => knowledgeDir(k.cfg.knowledgeDir);
  const has = (t: string) => Boolean(db && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));

  const crmCall = (name: string, panel: 'leads' | 'clients' | 'projects' | 'documents' | 'tickets', o: CrmQuery = {}, extra: Record<string, string> = {}) =>
    k.call(name, async () => {
      const max = policyOf(name)!.limits.maxResults!;
      const query: Record<string, string> = { limit: String(Math.min(Math.max(1, Math.floor(o.limit ?? 50)), max)), ...extra };
      if (o.q) query.q = String(o.q).slice(0, 100);
      if (o.status) query.status = String(o.status).slice(0, 40);
      const body = k.deps.crm!(panel, query) as { ok?: boolean; error?: string; items?: unknown } | null;
      if (!body || body.ok === false) return fail(body?.error === 'not_found' ? 'not_found' : 'invalid', `crm ${panel}: ${body?.error ?? 'no answer'}`);
      const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
      return okv(k.cx.dept === 'marketing' ? (redactContacts(items) as Record<string, unknown>[]) : items);
    });

  return {
    prices: { get: () => k.call('prices.get', () => Promise.resolve(okv(getPrices()))) },
    playbook: {
      excerpt: (role, max) =>
        k.call('playbook.excerpt', async () => {
          // a role (the whole craft excerpt) or a topic (`ig-reels`, `ig-engage`...: the Instagram craft conspects)
          const name = String(role);
          if (!isPlaybookRole(name) && !isPlaybookTopic(name)) return fail('invalid', `unknown role or topic ${name.slice(0, 40)}`);
          const text = isPlaybookRole(name) ? playbookExcerpt(name, Math.min(max ?? 2500, 2500), k.cfg.knowledgeDir) : topicExcerpt(name, Math.min(max ?? 1500, 1500), k.cfg.knowledgeDir);
          return text ? okv(text) : fail('not_found', `no playbook for ${role}`);
        }),
    },
    knowledge: {
      search: (q, o = {}) =>
        k.call('knowledge.search', async () => {
          if (typeof q !== 'string' || !words(q).length) return fail('invalid', 'query: at least one word of 3+ letters');
          const dir = kdir();
          const files = dir ? mdFiles(dir).map((p) => ({ ref: relative(dir, p).split(sep).join('/'), text: readFileSync(p, 'utf8') })) : [];
          const lessons = db && has('kb_lessons') ? (db.prepare('SELECT id, project, text FROM kb_lessons ORDER BY id DESC LIMIT 2000').all() as { id: number; project: string; text: string }[]) : [];
          return okv(searchKnowledge(q, files, lessons, Math.min(Math.max(1, o.limit ?? 10), policyOf('knowledge.search')!.limits.maxResults!)));
        }),
      add: (lesson) =>
        k.call('knowledge.add', async () => {
          const project = typeof lesson?.project === 'string' ? lesson.project.trim().slice(0, 60) : '';
          const text = typeof lesson?.text === 'string' ? lesson.text.trim() : '';
          if (!project || text.length < 10) return fail('invalid', 'project and a text of at least 10 characters');
          if (text.length > policyOf('knowledge.add')!.limits.maxBytes!) return fail('too_large', 'lesson over 2000 characters');
          db!.exec(LESSONS);
          const r = db!.prepare('INSERT INTO kb_lessons (project, text, created_at) VALUES (?, ?, ?)').run(project, text, k.now());
          return okv({ id: Number(r.lastInsertRowid) });
        }),
    },
    events: {
      week: () =>
        k.call<WeekEvents>('events.week', async () => {
          const to = dayIn(k.now(), k.tz);
          const from = new Date(Date.parse(`${to}T00:00:00Z`) - 6 * DAY).toISOString().slice(0, 10);
          if (!has('site_events')) return okv({ from, to, available: false, totals: {}, byDay: [] });
          const totals: Record<string, number> = {};
          for (const r of db!.prepare('SELECT name, SUM(count) n FROM site_events WHERE day >= ? AND day <= ? GROUP BY name ORDER BY name').all(from, to) as { name: string; n: number }[]) totals[r.name] = r.n;
          const days = new Map((db!.prepare('SELECT day, SUM(count) n FROM site_events WHERE day >= ? AND day <= ? GROUP BY day').all(from, to) as { day: string; n: number }[]).map((r) => [r.day, r.n]));
          const byDay = Array.from({ length: 7 }, (_, i) => {
            const day = new Date(Date.parse(`${from}T00:00:00Z`) + i * DAY).toISOString().slice(0, 10);
            return { day, count: days.get(day) ?? 0 };
          });
          return okv({ from, to, available: true, totals, byDay });
        }),
    },
    crm: {
      leads: (o) => crmCall('crm.leads', 'leads', o),
      clients: (o) => crmCall('crm.clients', 'clients', o),
      projects: (o) => crmCall('crm.projects', 'projects', o),
      invoices: (o) => crmCall('crm.invoices', 'documents', o, { kind: 'invoice' }),
      tickets: (o) => crmCall('crm.tickets', 'tickets', o),
    },
  };
}

