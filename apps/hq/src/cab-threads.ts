import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mediaUrl, UPLOAD_TYPES, type Db } from '@fir/core';
import { CsStore } from '@fir/worker-customer-support';
import { z } from 'zod';
import { addCabMessage, addThreadMessage, ensureCabinetTables, MESSAGE_CAP } from './cabinet.js';

/**
 * Cabinet v3 chat (2026-11-22): the client's messages sorted into threads, one per lead, one per project, one for support and one per agent of the
 * playground. Lead threads are the old `cab_messages` (nothing is moved, the old rows are the lead thread); the other threads live in `cab_tmsgs`.
 * Client messages in lead, project and support threads become Support tickets (the draft answer goes through the owner's approval and comes back
 * into the same thread) and show up in the owner's `/admin/chats`; the agent thread is answered by the client's own agent (`playground.ts`).
 * Files: `POST /admin/clients/:id/uploads`, stored under `DATA_DIR/uploads/<client>/`, downloaded through signed `/media/` links. Contract: `docs/admin-crm-api.md`.
 */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
const MSGS_PER_HOUR = 20;
const UPLOADS_PER_HOUR = 30;
const LINK_TTL_MS = 7 * 86_400_000;

export type ThreadKind = 'lead' | 'project' | 'agent' | 'support';
export type ThreadReply = { status: number; body: Record<string, unknown> };
const okR = (body: Record<string, unknown> = {}): ThreadReply => ({ status: 200, body: { ok: true, ...body } });
const failR = (status: number, error: string, extra: Record<string, unknown> = {}): ThreadReply => ({ status, body: { ok: false, error, ...extra } });
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export interface ThreadsDeps {
  db: Db;
  now: () => number;
  /** `DATA_DIR`: uploads live in `<dataDir>/uploads/<client>/`. */
  dataDir: string;
  /** Signed download links (`MEDIA_SECRET`, public base): without them an attachment has no `url` (null). */
  mediaSecret?: string | undefined;
  mediaBase?: string | undefined;
  /** A Support task drafts the answer to a stored ticket (fire and forget). */
  cabinetTicket?: ((t: { id: number; name: string; text: string; telegram: string; leadId?: number }) => void) | undefined;
  /** A line for the Sales head's journal of the lead's task. */
  leadJournal?: ((taskId: number, text: string) => void) | undefined;
  /** A short inbox line for the owner. */
  notifyOwner?: ((text: string) => void) | undefined;
  /** The client's own agent answers in its thread (set by the playground). */
  agentReply?: ((clientId: number, agentId: number, text: string, attachmentIds: string[]) => Promise<{ reply: string } | { error: string }>) | undefined;
  /** Titles and ids of the client's agents (set by the playground). */
  agents?: ((clientId: number) => { id: number; name: string }[]) | undefined;
}

interface CabRow { id: number; email: string; name: string; telegram: string; locale: string }
interface Msg { id: number; at: number; from: 'client' | 'firtech' | 'agent'; text: string; attachments: string[] }

/** `lead-12`, `project-3`, `support`, `agent-5` to its parts, or null. */
export function parseThreadId(id: string): { kind: ThreadKind; refId: number | null } | null {
  if (id === 'support') return { kind: 'support', refId: null };
  const m = /^(lead|project|agent)-(\d{1,9})$/.exec(id);
  return m ? { kind: m[1] as ThreadKind, refId: Number(m[2]) } : null;
}

const postBody = z.object({
  text: z.string().trim().max(MESSAGE_CAP).default(''),
  attachments: z.array(z.union([z.string().min(8).max(64), z.object({ uploadId: z.string().min(8).max(64) })])).max(MAX_ATTACHMENTS).default([]),
});
const uploadBody = z.object({ name: z.string().trim().min(1).max(200), dataBase64: z.string().min(1).max(15 * 1024 * 1024) });

const hasTable = (db: Db, t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;

/** Does the content look like its extension says (a renamed executable is refused)? Text types must be UTF-8 without NUL bytes. */
function magicOk(ext: string, b: Buffer): boolean {
  const head = (n: number) => b.subarray(0, n);
  switch (ext) {
    case 'png': return head(4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    case 'jpg':
    case 'jpeg': return head(3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case 'webp': return b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
    case 'pdf': return b.toString('latin1', 0, 5) === '%PDF-';
    case 'docx':
    case 'zip': return head(4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    case 'txt':
    case 'md':
    case 'csv': return !b.includes(0) && Buffer.from(b.toString('utf8'), 'utf8').equals(b);
    default: return false;
  }
}

export class CabThreads {
  constructor(private readonly d: ThreadsDeps) {
    ensureCabinetTables(d.db);
  }

  private get db(): Db {
    return this.d.db;
  }

  private client(id: number): CabRow | undefined {
    return this.db.prepare('SELECT id, email, name, telegram, locale FROM cab_clients WHERE id = ?').get(id) as CabRow | undefined;
  }

  // ---- uploads ----
  /** `POST /admin/clients/:id/uploads { name, dataBase64 }` → `{ id, name, size, type, url }`. */
  upload(clientId: number, body: unknown): ThreadReply {
    const c = this.client(clientId);
    if (!c) return failR(404, 'not_found');
    const parsed = uploadBody.safeParse(body ?? {});
    if (!parsed.success) return failR(400, 'invalid');
    const since = this.d.now() - 3_600_000;
    if ((this.db.prepare('SELECT COUNT(*) n FROM cab_uploads WHERE client_id = ? AND at > ?').get(clientId, since) as { n: number }).n >= UPLOADS_PER_HOUR) return failR(429, 'rate_limited');
    const base = parsed.data.name.split(/[\\/]/).pop()!.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'file';
    const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(base)?.[1] ?? '').toLowerCase();
    if (!UPLOAD_TYPES[ext]) return failR(415, 'unsupported_type', { allowed: Object.keys(UPLOAD_TYPES) });
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(parsed.data.dataBase64)) return failR(400, 'invalid');
    const bytes = Buffer.from(parsed.data.dataBase64, 'base64');
    if (bytes.length === 0) return failR(400, 'invalid');
    if (bytes.length > UPLOAD_MAX_BYTES) return failR(413, 'too_large', { maxBytes: UPLOAD_MAX_BYTES });
    if (!magicOk(ext, bytes)) return failR(415, 'unsupported_type', { reason: 'content_mismatch' });
    const id = randomUUID().replace(/-/g, '');
    const rel = `uploads/${clientId}/${id}.${ext}`;
    const dir = join(this.d.dataDir, 'uploads', String(clientId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.${ext}`), bytes, { mode: 0o640 });
    this.db.prepare('INSERT INTO cab_uploads (id, client_id, name, type, size, rel, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, clientId, base, UPLOAD_TYPES[ext], bytes.length, rel, this.d.now());
    return okR({ item: this.fileView(this.upRow(id)!) });
  }

  private upRow(id: string) {
    return this.db.prepare('SELECT id, client_id, name, type, size, rel FROM cab_uploads WHERE id = ?').get(id) as { id: string; client_id: number; name: string; type: string; size: number; rel: string } | undefined;
  }

  private fileView(r: { id: string; name: string; type: string; size: number; rel: string }): { id: string; name: string; type: string; size: number; url: string | null } {
    const url = this.d.mediaSecret && this.d.mediaBase ? mediaUrl(this.d.mediaBase, this.d.mediaSecret, r.rel, { expiresAt: this.d.now() + LINK_TTL_MS }) : null;
    return { id: r.id, name: r.name, type: r.type, size: r.size, url };
  }

  /** The text of an uploaded text file of this client (the agent's knowledge), or null. */
  uploadText(clientId: number, uploadId: string): { name: string; text: string } | null {
    const r = this.upRow(uploadId);
    if (!r || r.client_id !== clientId || !/\.(txt|md|csv)$/.test(r.rel)) return null;
    try {
      return { name: r.name, text: readFileSync(join(this.d.dataDir, r.rel), 'utf8') };
    } catch {
      return null;
    }
  }

  private attachments(clientId: number, ids: string[]): { name: string; url: string | null; size: number }[] {
    return ids.flatMap((id) => {
      const r = this.upRow(id);
      return r && r.client_id === clientId ? [{ name: r.name, url: this.fileView(r).url, size: r.size }] : [];
    });
  }

  // ---- threads ----
  private leadsOf(clientId: number): { id: number; task: string; service: string; estimate: string; createdAt: number; taskId: number }[] {
    if (!hasTable(this.db, 'li_leads')) return [];
    return (this.db.prepare('SELECT id, task, service, estimate, created_at, task_id FROM li_leads WHERE client_id = ? ORDER BY id DESC LIMIT 50').all(clientId) as { id: number; task: string; service: string; estimate: string | null; created_at: number; task_id: number }[])
      .map((l) => ({ id: l.id, task: l.task, service: l.service, estimate: l.estimate ?? '', createdAt: l.created_at, taskId: l.task_id }));
  }

  private projectsOf(clientId: number): { id: number; what: string; createdAt: number }[] {
    if (!hasTable(this.db, 'pm_projects') || !hasTable(this.db, 'li_leads')) return [];
    return (this.db.prepare('SELECT p.id, p.what, p.created_at FROM pm_projects p JOIN li_leads l ON l.id = p.lead_id WHERE l.client_id = ? ORDER BY p.id DESC LIMIT 50').all(clientId) as { id: number; what: string; created_at: number }[])
      .map((p) => ({ id: p.id, what: p.what, createdAt: p.created_at }));
  }

  /** Messages of a thread, oldest first. Null for a thread that is not this client's. */
  private messages(c: CabRow, t: { kind: ThreadKind; refId: number | null }): Msg[] | null {
    if (t.kind === 'lead') {
      if (!this.leadsOf(c.id).some((l) => l.id === t.refId)) return null;
      return (this.db.prepare('SELECT id, "from", text, at, attachments FROM cab_messages WHERE client_id = ? AND lead_id = ? ORDER BY id').all(c.id, t.refId) as { id: number; from: string; text: string; at: number; attachments: string }[])
        .map((m) => ({ id: m.id, at: m.at, from: m.from === 'client' ? 'client' : 'firtech', text: m.text, attachments: JSON.parse(m.attachments || '[]') as string[] }));
    }
    if (t.kind === 'project' && !this.projectsOf(c.id).some((p) => p.id === t.refId)) return null;
    if (t.kind === 'agent' && !(this.d.agents?.(c.id) ?? []).some((a) => a.id === t.refId)) return null;
    const thread = t.kind === 'support' ? 'support' : `${t.kind}-${t.refId}`;
    return (this.db.prepare('SELECT id, "from", text, at, attachments FROM cab_tmsgs WHERE client_id = ? AND thread = ? ORDER BY id').all(c.id, thread) as { id: number; from: string; text: string; at: number; attachments: string }[])
      .map((m) => ({ id: m.id, at: m.at, from: m.from === 'client' ? 'client' : m.from === 'agent' ? 'agent' : 'firtech', text: m.text, attachments: JSON.parse(m.attachments || '[]') as string[] }));
  }

  private readMark(clientId: number, thread: string): number {
    return (this.db.prepare('SELECT at FROM cab_reads WHERE client_id = ? AND thread = ?').get(clientId, thread) as { at: number } | undefined)?.at ?? -1;
  }

  /** `GET /admin/clients/:id/threads`: every lead, project and agent of the client plus the support thread, newest activity first. */
  list(clientId: number): ThreadReply {
    const c = this.client(clientId);
    if (!c) return failR(404, 'not_found');
    const en = c.locale === 'en';
    const short = (s: string, n = 60) => s.replace(/\s+/g, ' ').trim().slice(0, n);
    const defs: { id: string; kind: ThreadKind; refId: number | null; title: string; created: number }[] = [
      ...this.leadsOf(c.id).map((l) => ({ id: `lead-${l.id}`, kind: 'lead' as const, refId: l.id, title: `${en ? 'Request' : 'Заявка'} #${l.id}${l.task ? `: ${short(l.task, 40)}` : ''}`, created: l.createdAt })),
      ...this.projectsOf(c.id).map((p) => ({ id: `project-${p.id}`, kind: 'project' as const, refId: p.id, title: `${en ? 'Project' : 'Проект'} #${p.id}: ${short(p.what, 40)}`, created: p.createdAt })),
      { id: 'support', kind: 'support', refId: null, title: en ? 'Support' : 'Поддержка', created: 0 },
      ...(this.d.agents?.(c.id) ?? []).map((a) => ({ id: `agent-${a.id}`, kind: 'agent' as const, refId: a.id, title: a.name, created: 0 })),
    ];
    const items = defs.map((def) => {
      const msgs = this.messages(c, def) ?? [];
      const mark = this.readMark(c.id, def.id);
      return {
        id: def.id, kind: def.kind, refId: def.refId, title: def.title, unread: msgs.filter((m) => m.from !== 'client' && m.at > mark).length,
        lastAt: iso(msgs.at(-1)?.at ?? (def.created || null)),
      };
    }).sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
    return okR({ items });
  }

  /** `GET /admin/clients/:id/threads/:tid/messages?after=<id>`. */
  messagesOf(clientId: number, threadId: string, after: number): ThreadReply {
    const c = this.client(clientId);
    const t = parseThreadId(threadId);
    if (!c || !t) return failR(404, 'not_found');
    const msgs = this.messages(c, t);
    if (!msgs) return failR(404, 'not_found');
    const mark = this.readMark(c.id, threadId);
    return okR({
      items: msgs.filter((m) => m.id > after).slice(0, 200).map((m) => ({
        id: m.id, at: iso(m.at), from: m.from, text: m.text, attachments: this.attachments(c.id, m.attachments), readAt: m.from !== 'client' && m.at <= mark ? iso(mark) : null,
      })),
    });
  }

  /** `POST /admin/clients/:id/threads/:tid/read`: everything up to now is read. */
  read(clientId: number, threadId: string): ThreadReply {
    const c = this.client(clientId);
    const t = parseThreadId(threadId);
    if (!c || !t || !this.messages(c, t)) return failR(404, 'not_found');
    this.db.prepare('INSERT INTO cab_reads (client_id, thread, at) VALUES (?, ?, ?) ON CONFLICT(client_id, thread) DO UPDATE SET at = excluded.at').run(clientId, threadId, this.d.now());
    return okR({ unread: 0 });
  }

  /** `POST /admin/clients/:id/threads/:tid/messages { text, attachments? }`: stored, then routed by the kind of the thread. */
  async post(clientId: number, threadId: string, body: unknown): Promise<ThreadReply> {
    const c = this.client(clientId);
    const t = parseThreadId(threadId);
    if (!c || !t || !this.messages(c, t)) return failR(404, 'not_found');
    const parsed = postBody.safeParse(body ?? {});
    if (!parsed.success) return failR(400, 'invalid');
    const text = parsed.data.text;
    const ids = parsed.data.attachments.map((a) => (typeof a === 'string' ? a : a.uploadId));
    if (!text && ids.length === 0) return failR(400, 'invalid');
    if (ids.some((id) => this.upRow(id)?.client_id !== clientId)) return failR(400, 'invalid', { reason: 'attachment' });
    const since = this.d.now() - 3_600_000;
    const sent = (this.db.prepare('SELECT COUNT(*) n FROM cab_messages WHERE client_id = ? AND "from" = \'client\' AND at > ?').get(clientId, since) as { n: number }).n
      + (this.db.prepare("SELECT COUNT(*) n FROM cab_tmsgs WHERE client_id = ? AND \"from\" = 'client' AND thread NOT LIKE 'agent-%' AND at > ?").get(clientId, since) as { n: number }).n;
    if (t.kind !== 'agent' && sent >= MSGS_PER_HOUR) return failR(429, 'rate_limited');
    const at = this.d.now();
    const shown = text || (c.locale === 'en' ? '(attachment)' : '(вложение)');
    if (t.kind === 'agent') return this.postAgent(c, t.refId!, threadId, text, ids, at);
    let id: number;
    let ticketId: number;
    if (t.kind === 'lead') {
      const lead = this.leadsOf(c.id).find((l) => l.id === t.refId)!;
      const tk = new CsStore(this.db, this.d.now).addCabinetTicket({ clientName: c.name || c.email, contact: c.email, text: shown, leadId: lead.id });
      ticketId = tk.id;
      id = addCabMessage(this.db, at, { clientId, leadId: lead.id, from: 'client', text: shown, ticketId: tk.id });
      this.db.prepare('UPDATE cab_messages SET attachments = ? WHERE id = ?').run(JSON.stringify(ids), id);
      this.d.leadJournal?.(lead.taskId, `Сообщение клиента из кабинета по лиду #${lead.id}: ${shown.slice(0, 300)}${ids.length ? ` (вложений: ${ids.length})` : ''}`);
      this.d.notifyOwner?.(`Сообщение по заявке #${lead.id} от ${c.name || c.email}`);
      this.d.cabinetTicket?.({ id: tk.id, name: tk.clientName, text: tk.text, telegram: c.telegram, leadId: lead.id });
    } else {
      const label = t.kind === 'project' ? `[по проекту #${t.refId}] ` : '';
      const tk = new CsStore(this.db, this.d.now).addCabinetTicket({ clientName: c.name || c.email, contact: c.email, text: `${label}${shown}`, thread: threadId });
      ticketId = tk.id;
      id = addThreadMessage(this.db, at, { clientId, thread: threadId, from: 'client', text: shown, attachments: ids, ticketId: tk.id });
      this.d.notifyOwner?.(`${t.kind === 'project' ? `Сообщение по проекту #${t.refId}` : 'Сообщение в поддержку'} от ${c.name || c.email}`);
      this.d.cabinetTicket?.({ id: tk.id, name: tk.clientName, text: tk.text, telegram: c.telegram });
    }
    return okR({ item: { id, at: iso(at), from: 'client', text: shown, attachments: this.attachments(clientId, ids), readAt: null }, ticketId });
  }

  private async postAgent(c: CabRow, agentId: number, threadId: string, text: string, ids: string[], at: number): Promise<ThreadReply> {
    if (!text) return failR(400, 'invalid');
    if (!this.d.agentReply) return failR(503, 'unavailable');
    const mine = addThreadMessage(this.db, at, { clientId: c.id, thread: threadId, from: 'client', text, attachments: ids });
    const r = await this.d.agentReply(c.id, agentId, text, ids);
    const item = { id: mine, at: iso(at), from: 'client', text, attachments: this.attachments(c.id, ids), readAt: null };
    if ('error' in r) return failR(r.error === 'limit_reached' ? 429 : 503, r.error, { item });
    const t2 = this.d.now();
    const rid = addThreadMessage(this.db, t2, { clientId: c.id, thread: threadId, from: 'agent', text: r.reply });
    return okR({ item, reply: { id: rid, at: iso(t2), from: 'agent', text: r.reply, attachments: [], readAt: null } });
  }
}
