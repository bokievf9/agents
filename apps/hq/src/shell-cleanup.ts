import Database from 'better-sqlite3';
import { existsSync, fsyncSync, lstatSync, closeSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * One-off ops script (owner, 2026-11-26): finds test data in hq.db for the Shell cleanup and removes it on the owner's word.
 * Dry-run by default (writes nothing). Table A = clearly test (the only rows `--apply` can delete), table B = doubtful (never deleted).
 * `--apply --ids <file>` deletes A ∩ ids in one transaction after writing a full JSON backup next to the DB; `--restore <backup>` puts it back.
 * Run notes: docs/ops-shell-cleanup.md.
 */

type Row = Record<string, unknown>;
export type CleanupType = 'task' | 'lead' | 'client' | 'cs_client' | 'project' | 'document' | 'bo_document';
export interface Verdict { type: CleanupType; id: number; label: string; reason: string }
export interface Doubtful { type: CleanupType; id: number; label: string; why: string }
/** table -> rows (with `__rowid`), every row of the entity itself and of its children. */
type Bundle = Record<string, Row[]>;
interface Candidate extends Verdict { rows: Bundle; files: string[] }
export interface Report {
  kind: 'shell-cleanup-report';
  createdAt: string;
  db: string;
  A: (Verdict & { rows: Bundle; files: string[] })[];
  B: Doubtful[];
}

// ---- what counts as test ----
const TEST_TLDS = /@[^@\s]+\.(test|example|invalid|localhost)\b/i;
const TEST_DOMAINS = /@(example\.(com|org|net)|test\.com|tests\.com|[a-z]\.[a-z]{1,3})$/i; // anyone@example.com, a@b.co, x@y.z
const EMAIL = /[^\s<>(),;:"']+@[^\s<>(),;:"']+\.[a-z]{2,}|[^\s<>(),;:"']+@[a-z]\.[a-z]{1,3}/gi;
const WORD = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}])(${w})(?![\\p{L}\\p{N}])`, 'iu');
const CLEAR_E2E = WORD('e2e');
const CLEAR_TESTY = /(^|[^\p{L}\p{N}])(тестов(ый|ая|ое|ые|ого)|тест учения|\[test\]|\(test\))/iu;
const CLEAR_START = /^\s*(test|тест|e2e|учения)\s*([:\-–—_ ]|$)/iu;
const WEAK = /test|тест|demo|демо|e2e/i;
/** Names the firtech e2e and dev mocks use for people (tests/e2e, src/lib/*mock*.ts, apps/hq tests). */
const FIXTURE_NAMES = new Set(['алиса', 'alice', 'боб', 'bob', 'тестовый клиент', 'тест учения', 'e2e']);
/** Business names of the firtech dev mocks: could be a real client, so only doubtful. */
const MOCK_BUSINESSES = ['pulse gym', 'sadaf clinic', 'zebo beauty', 'old cafe', 'bro barber', 'dilovar auto', 'нигина', 'фаррух'];

export const isTestEmail = (e: string): boolean => {
  const s = e.trim().toLowerCase();
  return /^e2e/.test(s) || TEST_TLDS.test(s) || TEST_DOMAINS.test(s);
};
const emailsIn = (s: string): string[] => s.match(EMAIL) ?? [];
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

interface Fields { names?: unknown[]; texts?: unknown[]; contacts?: unknown[]; tags?: unknown }
type Judge = { level: 'A'; reason: string } | { level: 'B'; why: string } | null;

/**
 * A only on clear patterns: a test email domain, a whole-word `e2e`, «тестовый», a title opening with Тест:/Test:/Demo:/Учения:, a fixture name without a
 * real contact, the drill tag. A clear marker next to a real contact stays doubtful, so does any weak substring (`test`, `demo` inside a word).
 */
export function judge(f: Fields): Judge {
  const names = (f.names ?? []).map(str).filter(Boolean);
  const texts = (f.texts ?? []).map(str).filter(Boolean);
  const contacts = (f.contacts ?? []).map(str).filter(Boolean);
  const mails = [...contacts, ...names, ...texts].flatMap(emailsIn);
  const testMail = mails.find(isTestEmail);
  if (testMail) return { level: 'A', reason: `test email (${testMail})` };
  if (str(f.tags).split(',').map((s) => s.trim()).includes('drill')) return { level: 'A', reason: 'tag drill' };
  const real = contacts.some((c) => { const m = emailsIn(c); return !(m.length > 0 && m.every(isTestEmail)); }) || mails.some((m) => !isTestEmail(m));
  const heads = [...names, ...texts];
  for (const t of heads) {
    if (CLEAR_E2E.test(t) || CLEAR_TESTY.test(t) || CLEAR_START.test(t)) {
      return real ? { level: 'B', why: `test marker in «${t.slice(0, 60)}» but a real-looking contact is attached` } : { level: 'A', reason: `test marker in «${t.slice(0, 60)}»` };
    }
  }
  for (const n of names) {
    if (FIXTURE_NAMES.has(n.trim().toLowerCase())) {
      return real ? { level: 'B', why: `name «${n}» is a fixture name but has a real-looking contact` } : { level: 'A', reason: `fixture name «${n}» with no real contact` };
    }
    if (MOCK_BUSINESSES.includes(n.trim().toLowerCase())) return { level: 'B', why: `name «${n}» is a dev-mock business name (could be real)` };
  }
  for (const t of heads) if (WEAK.test(t)) return { level: 'B', why: `weak marker (test/demo as part of «${t.slice(0, 60)}»)` };
  return null;
}

// ---- reading ----
class Reader {
  private tables: Set<string>;
  constructor(readonly db: Database.Database) {
    this.tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
  }
  has(t: string): boolean { return this.tables.has(t); }
  all(t: string, where = '1', args: unknown[] = []): Row[] {
    return this.has(t) ? (this.db.prepare(`SELECT rowid AS __rowid, * FROM ${t} WHERE ${where}`).all(...args) as Row[]) : [];
  }
}

function build(rd: Reader, rendersDir: string | undefined): { A: Candidate[]; B: Doubtful[] } {
  const A = new Map<string, Candidate>();
  const B = new Map<string, Doubtful>();
  const key = (t: CleanupType, id: number) => `${t}:${id}`;
  const doubt = (t: CleanupType, id: number, label: string, why: string) => { if (!A.has(key(t, id)) && !B.has(key(t, id))) B.set(key(t, id), { type: t, id, label, why }); };
  const accept = (c: Candidate) => { A.set(key(c.type, c.id), c); B.delete(key(c.type, c.id)); };
  const mark = (t: CleanupType, id: number, label: string, j: Judge, make: () => Pick<Candidate, 'rows' | 'files'>, guard?: string | null) => {
    if (!j) return;
    if (j.level === 'B') return doubt(t, id, label, j.why);
    if (guard) return doubt(t, id, label, `looks like test (${j.reason}) but ${guard}`);
    accept({ type: t, id, label, reason: j.reason, ...make() });
  };
  const merge = (...bs: Bundle[]): Bundle => {
    const out: Bundle = {};
    for (const b of bs) for (const [t, rows] of Object.entries(b)) out[t] = [...(out[t] ?? []), ...rows.filter((r) => !(out[t] ?? []).some((x) => x.__rowid === r.__rowid))];
    return out;
  };

  // tasks with their events, approvals, review versions and sub-tasks
  const taskBundle = (id: number): Bundle => {
    const ids: number[] = [];
    const walk = (n: number) => { if (ids.includes(n)) return; ids.push(n); for (const c of rd.all('tasks', 'parent_id = ?', [n])) walk(Number(c.id)); };
    walk(id);
    const b: Bundle = { tasks: [], task_events: [], task_approvals: [], approvals: [], approval_cards: [], review_versions: [] };
    for (const t of ids) {
      b.tasks!.push(...rd.all('tasks', 'id = ?', [t]));
      b.task_events!.push(...rd.all('task_events', 'task_id = ?', [t]));
      for (const ta of rd.all('task_approvals', 'task_id = ?', [t])) {
        b.task_approvals!.push(ta);
        if (ta.approval_id !== null && ta.approval_id !== undefined) {
          b.approvals!.push(...rd.all('approvals', 'id = ?', [ta.approval_id]));
          b.approval_cards!.push(...rd.all('approval_cards', 'approval_id = ?', [ta.approval_id]));
        }
        b.review_versions!.push(...rd.all('review_versions', 'approval_id = ?', [`ap_${String(ta.id)}`]));
      }
    }
    return b;
  };
  const taskOf = (id: unknown): Bundle => (id === null || id === undefined ? {} : taskBundle(Number(id)));
  const taskRunning = (id: unknown): boolean => rd.all('tasks', "id = ? AND status = 'running'", [id]).length > 0;

  for (const t of rd.all('tasks')) {
    const meta = str(t.meta);
    const drill = /"drill"\s*:\s*\{/.test(meta) ? 'drill' : '';
    const j = judge({ names: [t.title], texts: [], tags: `${str(t.tags)},${drill}` });
    const weakBody = !j && WEAK.test(str(t.body).slice(0, 400)) ? ({ level: 'B', why: 'weak marker in the task body' } as const) : null;
    mark('task', Number(t.id), str(t.title), j ?? weakBody, () => ({ rows: taskBundle(Number(t.id)), files: [] }), t.status === 'running' ? 'it is running now' : null);
  }

  // clients (cabinet accounts)
  const clientBundle = (id: number): Bundle => ({
    cab_clients: rd.all('cab_clients', 'id = ?', [id]),
    cab_messages: rd.all('cab_messages', 'client_id = ?', [id]),
    cab_tmsgs: rd.all('cab_tmsgs', 'client_id = ?', [id]),
    cab_uploads: rd.all('cab_uploads', 'client_id = ?', [id]),
    cab_reads: rd.all('cab_reads', 'client_id = ?', [id]),
  });
  const aClientIds = new Set<number>();
  const aClientNames = new Set<string>();
  for (const c of rd.all('cab_clients')) {
    const label = `${str(c.name)} <${str(c.email)}>`;
    const j = judge({ names: [c.name], contacts: [c.email, c.telegram] });
    mark('client', Number(c.id), label, j, () => ({ rows: clientBundle(Number(c.id)), files: [] }));
    if (A.has(key('client', Number(c.id)))) { aClientIds.add(Number(c.id)); if (str(c.name).trim()) aClientNames.add(str(c.name).trim().toLowerCase()); }
  }
  for (const c of rd.all('cs_clients')) {
    const j = judge({ names: [c.name], contacts: [c.contact] });
    const tickets = rd.all('cs_tickets', 'client_id = ?', [c.id]);
    mark('cs_client', Number(c.id), str(c.name), j, () => ({ rows: { cs_clients: [c], cs_tickets: tickets }, files: [] }));
    if (A.has(key('cs_client', Number(c.id)))) aClientNames.add(str(c.name).trim().toLowerCase());
  }

  // leads
  const aLeadIds = new Set<number>();
  for (const l of rd.all('li_leads')) {
    const j = judge({ names: [l.name], texts: [l.task], contacts: [l.contact] });
    const origin = str(l.origin) === 'drill' ? ({ level: 'A', reason: 'origin drill' } as const) : null;
    const viaClient = l.client_id != null && aClientIds.has(Number(l.client_id)) ? ({ level: 'A', reason: `belongs to test cabinet client #${String(l.client_id)}` } as const) : null;
    const v = j?.level === 'A' ? j : (origin ?? viaClient ?? j);
    const make = () => ({ rows: merge({ li_leads: [l] }, { cab_messages: rd.all('cab_messages', 'lead_id = ?', [l.id]) }, taskOf(l.task_id)), files: [] as string[] });
    mark('lead', Number(l.id), `${str(l.name)} / ${str(l.contact)}`, v, make, l.task_id != null && taskRunning(l.task_id) ? 'its task is running' : null);
    if (A.has(key('lead', Number(l.id)))) aLeadIds.add(Number(l.id));
  }

  // projects
  const aProjectIds = new Set<number>();
  for (const p of rd.all('pm_projects')) {
    const ms = rd.all('pm_milestones', 'project_id = ?', [p.id]);
    const paid = ms.some((m) => m.paid_at != null) || rd.all('bl_invoices', "project_id = ? AND status = 'paid'", [p.id]).length > 0;
    const j = judge({ names: [p.client], texts: [p.what] });
    const origin = str(p.source) === 'drill' ? ({ level: 'A', reason: 'source drill' } as const) : null;
    const viaClient = aClientNames.has(str(p.client).trim().toLowerCase()) ? ({ level: 'A', reason: `client «${str(p.client)}» is a test client` } as const) : null;
    const viaLead = p.lead_id != null && aLeadIds.has(Number(p.lead_id)) ? ({ level: 'A', reason: `reserved by test lead #${String(p.lead_id)}` } as const) : null;
    const v = j?.level === 'A' ? j : (origin ?? viaClient ?? viaLead ?? j);
    const make = () => ({
      rows: merge({ pm_projects: [p], pm_milestones: ms }, { cab_tmsgs: rd.all('cab_tmsgs', 'thread = ?', [`project-${String(p.id)}`]) }, taskOf(p.task_id)),
      files: [] as string[],
    });
    mark('project', Number(p.id), `${str(p.client)}: ${str(p.what)}`, v, make, paid ? 'a stage of it is paid' : null);
    if (A.has(key('project', Number(p.id)))) aProjectIds.add(Number(p.id));
  }

  // documents
  const inRenders = (rel: unknown): string | null => {
    const r = str(rel);
    if (!rendersDir || !r || r.includes('\0')) return null;
    const rr = isAbsolute(r) ? relative(rendersDir, r) : r;
    return rr && !rr.startsWith('..') && !isAbsolute(rr) && !rr.split(/[\\/]/).some((s) => s === '..' || s === '') ? join(rendersDir, rr) : null;
  };
  for (const d of rd.all('cab_documents')) {
    const j = judge({ names: [], texts: [d.title] });
    const viaClient = aClientIds.has(Number(d.client_id)) ? ({ level: 'A', reason: `test cabinet client #${String(d.client_id)}` } as const) : null;
    const viaProject = d.project_id != null && aProjectIds.has(Number(d.project_id)) ? ({ level: 'A', reason: `test project #${String(d.project_id)}` } as const) : null;
    const viaLead = d.lead_id != null && aLeadIds.has(Number(d.lead_id)) ? ({ level: 'A', reason: `test lead #${String(d.lead_id)}` } as const) : null;
    const v = viaClient ?? viaProject ?? viaLead ?? j;
    const direct = v === j;
    const files = [d.pdf_rel, d.signed_pdf_rel].map(inRenders).filter((f): f is string => f !== null && existsSync(f) && lstatSync(f).isFile());
    const guard = direct && (d.state === 'signed' || d.accepted_at != null || d.signed_at != null) ? 'it is signed or accepted' : null;
    mark('document', Number(d.id), `${str(d.kind)} ${str(d.number)} ${str(d.title)}`.trim(), v, () => ({ rows: { cab_documents: [d], bo_signatures: rd.all('bo_signatures', 'doc_id = ?', [d.id]) }, files }), guard);
  }
  for (const d of rd.all('bo_documents')) {
    const j = judge({ names: [d.client] });
    const viaClient = aClientNames.has(str(d.client).trim().toLowerCase()) ? ({ level: 'A', reason: `client «${str(d.client)}» is a test client` } as const) : null;
    const viaProject = d.project_id != null && aProjectIds.has(Number(d.project_id)) ? ({ level: 'A', reason: `test project #${String(d.project_id)}` } as const) : null;
    mark('bo_document', Number(d.id), `${str(d.type)} v${str(d.version)} ${str(d.client)}`, viaClient ?? viaProject ?? j, () => ({ rows: { bo_documents: [d] }, files: [] }));
  }
  return { A: [...A.values()], B: [...B.values()] };
}

// ---- JSON with blobs ----
/** `Buffer.toJSON` runs before the replacer, so the blob arrives as `{type:'Buffer',data:[...]}`. */
const enc = (_k: string, v: unknown): unknown => {
  const b = v as { type?: string; data?: number[] } | null;
  return b && typeof b === 'object' && b.type === 'Buffer' && Array.isArray(b.data) ? { $blob: Buffer.from(b.data).toString('base64') } : v;
};
const dec = (v: unknown): unknown => (v && typeof v === 'object' && '$blob' in (v as Row) ? Buffer.from(String((v as Row).$blob), 'base64') : v);
const rowToJson = (r: Row): Row => JSON.parse(JSON.stringify(r, enc)) as Row;

/** Delete order: children before parents. */
const ORDER = ['task_events', 'review_versions', 'approval_cards', 'approvals', 'task_approvals', 'tasks', 'bo_signatures', 'cab_documents', 'bo_documents', 'cab_messages', 'cab_tmsgs', 'cab_uploads', 'cab_reads', 'cs_tickets', 'pm_milestones', 'pm_projects', 'li_leads', 'cs_clients', 'cab_clients'];

export function dryRun(dbPath: string, now = Date.now): Report {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rd = new Reader(db);
    const dataDir = dirname(resolve(dbPath));
    const { A, B } = build(rd, join(dataDir, 'renders'));
    return {
      kind: 'shell-cleanup-report', createdAt: new Date(now()).toISOString(), db: resolve(dbPath),
      A: A.map((c) => ({ type: c.type, id: c.id, label: c.label, reason: c.reason, files: c.files, rows: Object.fromEntries(Object.entries(c.rows).filter(([, v]) => v.length).map(([t, v]) => [t, v.map(rowToJson)])) })),
      B,
    };
  } finally {
    db.close();
  }
}

/** The ids file: a JSON array of `{type,id}` or `"type:id"`, a dry-run report (`{A:[...]}`), or a text file of `type:id` lines. */
export function readIds(file: string): { type: string; id: number }[] {
  const raw = readFileSync(file, 'utf8');
  const out: { type: string; id: number }[] = [];
  const add = (type: unknown, id: unknown) => {
    const n = Number(id);
    if (typeof type !== 'string' || !Number.isInteger(n)) throw new Error(`bad id entry: ${JSON.stringify({ type, id })}`);
    out.push({ type, id: n });
  };
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const j = JSON.parse(trimmed) as unknown;
    const list = Array.isArray(j) ? j : Array.isArray((j as { ids?: unknown }).ids) ? (j as { ids: unknown[] }).ids : Array.isArray((j as { A?: unknown }).A) ? (j as { A: unknown[] }).A : null;
    if (!list) throw new Error('ids file: expected an array, {ids:[...]} or a dry-run report');
    for (const e of list) {
      if (typeof e === 'string') { const m = /^(\w+)[:\s]+(\d+)$/.exec(e.trim()); if (!m) throw new Error(`bad id entry: ${e}`); add(m[1], m[2]); } else add((e as Row).type, (e as Row).id);
    }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      const l = line.replace(/#.*/, '').trim();
      if (!l) continue;
      const m = /^(\w+)[:\s]+(\d+)$/.exec(l);
      if (!m) throw new Error(`bad line in ids file (want type:id): ${line}`);
      add(m[1], m[2]);
    }
  }
  return out;
}

export interface ApplyResult { backup: string; counts: Record<string, number>; filesRemoved: number }

export function apply(dbPath: string, ids: { type: string; id: number }[], now = Date.now): ApplyResult {
  if (ids.length === 0) throw new Error('refused: the ids file is empty');
  const db = new Database(dbPath, { fileMustExist: true, timeout: 5000 });
  try {
    const rd = new Reader(db);
    const rendersDir = join(dirname(resolve(dbPath)), 'renders');
    const { A, B } = build(rd, rendersDir);
    const wanted = new Map<string, { type: string; id: number }>();
    for (const e of ids) wanted.set(`${e.type}:${e.id}`, e);
    const inA = new Map(A.map((c) => [`${c.type}:${c.id}`, c]));
    const inB = new Set(B.map((c) => `${c.type}:${c.id}`));
    const bad = [...wanted.keys()].filter((k) => !inA.has(k));
    if (bad.length) {
      throw new Error(`refused, nothing deleted. Not in table A now: ${bad.map((k) => `${k}${inB.has(k) ? ' (doubtful, B)' : ' (unknown)'}`).join(', ')}`);
    }
    const chosen = [...wanted.keys()].map((k) => inA.get(k)!);
    const tables: Bundle = {};
    const files: string[] = [];
    for (const c of chosen) {
      for (const [t, rows] of Object.entries(c.rows)) tables[t] = [...(tables[t] ?? []), ...rows.filter((r) => !(tables[t] ?? []).some((x) => x.__rowid === r.__rowid))];
      files.push(...c.files);
    }
    const ts = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const backup = `${resolve(dbPath)}.shell-cleanup-${ts}.json`;
    const payload = JSON.stringify({
      kind: 'shell-cleanup-backup', createdAt: new Date(now()).toISOString(), db: resolve(dbPath), ids: chosen.map((c) => ({ type: c.type, id: c.id, reason: c.reason })),
      files, tables: Object.fromEntries(Object.entries(tables).map(([t, v]) => [t, v.map(rowToJson)])),
    }, null, 2);
    try {
      const fd = openSync(backup, 'wx', 0o600);
      try { writeSync(fd, payload); fsyncSync(fd); } finally { closeSync(fd); }
      if (readFileSync(backup, 'utf8').length !== payload.length) throw new Error('backup readback differs');
    } catch (e) {
      throw new Error(`refused, nothing deleted: could not write the backup ${backup} (${e instanceof Error ? e.message : String(e)})`, { cause: e });
    }
    const counts: Record<string, number> = {};
    for (const c of chosen) counts[c.type] = (counts[c.type] ?? 0) + 1;
    db.transaction(() => {
      for (const t of ORDER) {
        const rows = tables[t] ?? [];
        if (!rows.length || !rd.has(t)) continue;
        const st = db.prepare(`DELETE FROM ${t} WHERE rowid = ?`);
        for (const r of rows) st.run(r.__rowid);
      }
      if (rd.has('activity')) {
        db.prepare('INSERT INTO activity (agent_id, action, object_type, object_id, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
          .run('owner', 'shell_cleanup', 'cleanup', '', JSON.stringify({ counts, rows: Object.fromEntries(Object.entries(tables).map(([t, v]) => [t, v.length])), backup }), now());
      }
    })();
    let filesRemoved = 0;
    for (const f of files) { rmSync(f, { force: true }); filesRemoved++; }
    return { backup, counts, filesRemoved };
  } finally {
    db.close();
  }
}

export function restore(dbPath: string, backupFile: string, now = Date.now): Record<string, number> {
  const b = JSON.parse(readFileSync(backupFile, 'utf8')) as { kind?: string; tables?: Record<string, Row[]> };
  if (b.kind !== 'shell-cleanup-backup' || !b.tables) throw new Error('not a shell-cleanup backup file');
  const db = new Database(dbPath, { fileMustExist: true, timeout: 5000 });
  try {
    const have = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    const counts: Record<string, number> = {};
    db.transaction(() => {
      for (const t of [...ORDER].reverse()) {
        const rows = b.tables![t];
        if (!rows?.length || !have.has(t)) continue;
        const cols = new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
        for (const r of rows) {
          const keys = Object.keys(r).filter((k) => k !== '__rowid' && cols.has(k));
          const res = db.prepare(`INSERT OR IGNORE INTO ${t} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => dec(r[k]) as never));
          counts[t] = (counts[t] ?? 0) + res.changes;
        }
      }
      if (have.has('activity')) {
        db.prepare('INSERT INTO activity (agent_id, action, object_type, object_id, detail, at) VALUES (?, ?, ?, ?, ?, ?)').run('owner', 'shell_cleanup_restored', 'cleanup', '', JSON.stringify({ counts, from: backupFile }), now());
      }
    })();
    return counts;
  } finally {
    db.close();
  }
}

const table = (title: string, lines: string[]) => { console.log(`\n${title}`); console.log(lines.length ? lines.join('\n') : '  (none)'); };

/** CLI: `node dist/shell-cleanup.js [--db <path>] [--out <file>]` | `--apply --ids <file>` | `--restore <backup.json>`. */
export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const dbPath = arg('--db') ?? `${env.DATA_DIR ?? '/app/data'}/hq.db`;
  try {
    if (!existsSync(dbPath)) throw new Error(`${dbPath} does not exist`);
    const restoreFrom = arg('--restore');
    if (restoreFrom) {
      const c = restore(dbPath, restoreFrom);
      console.log(`restored (INSERT OR IGNORE): ${JSON.stringify(c)}`);
      return 0;
    }
    if (argv.includes('--apply')) {
      const f = arg('--ids');
      if (!f) throw new Error('--apply needs --ids <file.json|txt>');
      const r = apply(dbPath, readIds(f));
      console.log(`backup: ${r.backup}\ndeleted: ${JSON.stringify(r.counts)}; render files removed: ${r.filesRemoved}`);
      return 0;
    }
    const rep = dryRun(dbPath);
    table('A: clearly test (candidates for --apply)', rep.A.map((a) => `  ${a.type}:${a.id}  ${a.label.slice(0, 70)}  [${a.reason}]`));
    table('B: doubtful (never deleted by this script)', rep.B.map((b) => `  ${b.type}:${b.id}  ${b.label.slice(0, 70)}  [${b.why}]`));
    // the container's root is read-only: the default is the data folder next to the DB, not the working directory
    const out = arg('--out') ?? join(dirname(resolve(dbPath)), `shell-cleanup-${rep.createdAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(out, JSON.stringify(rep, null, 2), { mode: 0o600 });
    console.log(`\nA ${rep.A.length}, B ${rep.B.length}. Full report (rows for rollback): ${out}. Dry run: nothing was changed.`);
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file://').href) process.exit(main(process.argv.slice(2)));
