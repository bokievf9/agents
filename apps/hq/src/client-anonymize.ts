import { existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { errMsg, log, type Db } from '@fir/core';

/**
 * `POST /admin/clients/:id/anonymize` (P2-14, security review 2026-11-23): the client deleted his account on the site; the personal data in HQ goes too.
 * The card becomes «удалённый клиент» (email `deleted-<id>@deleted.invalid`, no phone, Telegram, company, legal details), his messages and documents are
 * marked (text and body emptied, kind, number, amount and state stay for the books), the signature record and the files under `renders/cabinet/c<id>` and
 * `uploads/<id>` are deleted, his agents are closed and their conversations dropped, the site knowledge of the client is forgotten, leads and tickets lose
 * the name and contact. One audit-log line (ids and counts only). Idempotent: a second call changes nothing. ADMIN_TOKEN only (the cabinet token is refused
 * in `cabinetRouteAllowed`). Backups made before the call still hold the old data until they rotate out (7 copies).
 */
export const DELETED_NAME = 'удалённый клиент';
export const deletedEmail = (id: number): string => `deleted-${id}@deleted.invalid`;
const MARK = '[удалено по запросу клиента]';

export interface AnonymizeDeps {
  db: Db;
  now: () => number;
  /** `DATA_DIR/renders` (PDFs under `cabinet/c<id>`) and `DATA_DIR` (uploads under `uploads/<id>`). */
  rendersDir?: string | undefined;
  dataDir?: string | undefined;
  /** Drops the client's website knowledge from memory and the database (`ClientKnowledge.forget`). */
  forgetKnowledge?: ((clientId: number) => Promise<void> | void) | undefined;
  /** The audit log (`hq.log`). */
  audit: (action: string, id: number, detail: string) => void;
}

export interface AnonymizeResult {
  status: 200 | 404;
  body: Record<string, unknown>;
}

const hasTable = (db: Db, t: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
const columns = (db: Db, t: string): Set<string> => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));

/** Removes a folder only when it really lies under `base`. */
function removeUnder(base: string | undefined, rel: string): number {
  if (!base) return 0;
  const root = resolve(base);
  const dir = resolve(root, rel);
  if (!dir.startsWith(root + sep) || !existsSync(dir)) return 0;
  rmSync(dir, { recursive: true, force: true });
  return 1;
}

export async function anonymizeClient(d: AnonymizeDeps, id: number): Promise<AnonymizeResult> {
  const { db } = d;
  if (!hasTable(db, 'cab_clients')) return { status: 404, body: { ok: false, error: 'not_found' } };
  const c = db.prepare('SELECT id, email, telegram FROM cab_clients WHERE id = ?').get(id) as { id: number; email: string; telegram: string } | undefined;
  if (!c) return { status: 404, body: { ok: false, error: 'not_found' } };
  const cleanup = async (): Promise<number> => {
    let folders = 0;
    try {
      folders += removeUnder(d.rendersDir, join('cabinet', `c${id}`));
      folders += removeUnder(d.dataDir, join('uploads', String(id)));
      await d.forgetKnowledge?.(id);
    } catch (e) {
      log('warn', 'client anonymize: cleanup failed', { client: id, err: errMsg(e) });
    }
    return folders;
  };
  // a second call changes no row, but still tries the files (a first call may have been cut after the database part)
  if (c.email === deletedEmail(id)) {
    await cleanup();
    return { status: 200, body: { ok: true, already: true } };
  }

  const counts: Record<string, number> = {};
  const oldEmail = c.email;
  const oldTelegram = c.telegram.replace(/^@/, '').toLowerCase();
  const agentIds = hasTable(db, 'pg_agents') ? (db.prepare('SELECT id FROM pg_agents WHERE client_id = ?').all(id) as { id: number }[]).map((a) => a.id) : [];
  const docIds = hasTable(db, 'cab_documents') ? (db.prepare('SELECT id FROM cab_documents WHERE client_id = ?').all(id) as { id: number }[]).map((x) => x.id) : [];
  const leadIds = hasTable(db, 'li_leads') && columns(db, 'li_leads').has('client_id') ? (db.prepare('SELECT id FROM li_leads WHERE client_id = ?').all(id) as { id: number }[]).map((x) => x.id) : [];

  const run = (key: string, sql: string, ...params: unknown[]): void => {
    counts[key] = (counts[key] ?? 0) + db.prepare(sql).run(...params).changes;
  };
  const inList = (xs: number[]): string => (xs.length ? xs.join(',') : 'NULL');

  const tx = db.transaction(() => {
    // the card: the profile columns that exist in this database, blanked; the row stays so ids in documents and invoices still point somewhere
    const cols = columns(db, 'cab_clients');
    const blank = ['telegram', 'phone', 'company', 'niche', 'website', 'city', 'legal_name', 'legal_address', 'refund_wallet', 'supabase_id'].filter((x) => cols.has(x));
    const sets = [`email = ?`, `name = ?`, ...blank.map((x) => `${x} = ''`), 'marketing_consent = 0', ...(cols.has('recommendations_consent') ? ['recommendations_consent = 0'] : []), 'ref_slug = NULL', ...(cols.has('tg_chat_id') ? ['tg_chat_id = NULL'] : []), 'updated_at = ?'];
    run('client', `UPDATE cab_clients SET ${sets.join(', ')} WHERE id = ?`, deletedEmail(id), DELETED_NAME, d.now(), id);
    if (hasTable(db, 'cab_messages')) run('messages', `UPDATE cab_messages SET text = ?, attachments = '[]' WHERE client_id = ?`, MARK, id);
    if (hasTable(db, 'cab_tmsgs')) run('threadMessages', `UPDATE cab_tmsgs SET text = ?, attachments = '[]' WHERE client_id = ?`, MARK, id);
    if (docIds.length) {
      run('documents', `UPDATE cab_documents SET title = kind || ' (клиент удалён)', body = '', pdf_rel = NULL, signed_pdf_rel = NULL, pdf_sha256 = NULL, meta = '{"anonymized":true}' WHERE client_id = ?`, id);
      if (hasTable(db, 'bo_signatures')) run('signatures', `UPDATE bo_signatures SET signature_png = x'', name = ?, ip = '', ua = '' WHERE doc_id IN (${inList(docIds)})`, DELETED_NAME);
    }
    if (hasTable(db, 'cab_uploads')) run('uploads', 'DELETE FROM cab_uploads WHERE client_id = ?', id);
    if (hasTable(db, 'cab_reads')) run('reads', 'DELETE FROM cab_reads WHERE client_id = ?', id);
    if (leadIds.length) {
      const lc = columns(db, 'li_leads');
      run('leads', `UPDATE li_leads SET name = ?, contact = ''${lc.has('task') ? ", task = ''" : ''}${lc.has('estimate') ? ", estimate = ''" : ''} WHERE client_id = ?`, DELETED_NAME, id);
    }
    if (hasTable(db, 'cs_tickets')) {
      const tc = columns(db, 'cs_tickets');
      const byContact = [oldEmail.toLowerCase(), ...(oldTelegram ? [oldTelegram, `@${oldTelegram}`] : [])];
      run('tickets', `UPDATE cs_tickets SET client_name = ?, contact = '', text = ? WHERE ${tc.has('client_id') ? 'client_id = ? OR ' : ''}lower(contact) IN (${byContact.map(() => '?').join(',')})`, DELETED_NAME, MARK, ...(tc.has('client_id') ? [id] : []), ...byContact);
    }
    if (agentIds.length) {
      // closed for the public (draft), the Telegram token and the widget origin gone, the visitors' talk and leads dropped
      run('agents', `UPDATE pg_agents SET state = 'draft', channels = '{}', token_hash = ?, name = ?, company = '' WHERE client_id = ?`, `anonymized-${id}`, DELETED_NAME, id);
      for (const t of ['pg_messages', 'pg_conversations', 'pg_leads', 'pg_knowledge']) if (hasTable(db, t)) run(t, `DELETE FROM ${t} WHERE agent_id IN (${inList(agentIds)})`);
    }
    for (const t of ['ck_sources', 'ck_pages', 'ck_pending', 'ck_jobs']) if (hasTable(db, t)) run(t, `DELETE FROM ${t} WHERE client_id = ?`, id);
  });
  tx();

  // files and memory after the database: a failure is logged and a repeated call tries again
  const files = await cleanup();
  d.audit('client_anonymized', id, Object.entries({ ...counts, folders: files }).map(([k, v]) => `${k}=${v}`).join(' '));
  return { status: 200, body: { ok: true, already: false, counts: { ...counts, folders: files } } };
}
