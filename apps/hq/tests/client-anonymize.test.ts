import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureDocTables } from '../src/cab-docs.js';
import { addCabMessage, addThreadMessage, ensureCabinetTables } from '../src/cabinet.js';
import { deletedEmail } from '../src/client-anonymize.js';
import { shellWorld } from './shell-helpers.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'anon-'));
  const renders = join(dir, 'renders');
  mkdirSync(join(renders, 'cabinet', 'c1'), { recursive: true });
  mkdirSync(join(renders, 'cabinet', 'c2'), { recursive: true });
  writeFileSync(join(renders, 'cabinet', 'c1', 'contract-1.pdf'), '%PDF mine');
  writeFileSync(join(renders, 'cabinet', 'c2', 'contract-2.pdf'), '%PDF other');
  mkdirSync(join(dir, 'uploads', '1'), { recursive: true });
  mkdirSync(join(dir, 'uploads', '2'), { recursive: true });
  writeFileSync(join(dir, 'uploads', '1', 'a.pdf'), 'x');
  writeFileSync(join(dir, 'uploads', '2', 'b.pdf'), 'y');
  const w = shellWorld({ rendersDir: renders, admin: { rendersDir: renders, dataDir: dir } });
  const db = w.w.hq.db;
  ensureCabinetTables(db);
  ensureDocTables(db);
  db.prepare("INSERT INTO cab_clients (id, email, name, telegram, supabase_id, phone, company, created_at, updated_at) VALUES (1, 'liza@example.com', 'Лиза Иванова', '@liza', 'sb-1', '+992 900', 'Салон', 1, 1), (2, 'other@example.com', 'Другой', '', 'sb-2', '', '', 1, 1)").run();
  addCabMessage(db, 1, { clientId: 1, leadId: 5, from: 'client', text: 'Мой секретный вопрос' });
  addCabMessage(db, 1, { clientId: 2, leadId: 6, from: 'client', text: 'Чужое сообщение' });
  addThreadMessage(db, 1, { clientId: 1, thread: 'support', from: 'client', text: 'Моя поддержка' });
  db.prepare("INSERT INTO cab_documents (client_id, kind, title, number, state, amount_usd, body, pdf_rel, meta, created_at) VALUES (1, 'contract', 'Договор Лиза Иванова', 'D-1', 'signed', 300, 'Договор с Лиза Иванова', 'cabinet/c1/contract-1.pdf', '{}', 1), (2, 'contract', 'Договор Другой', 'D-2', 'signed', 100, 'тело', 'cabinet/c2/contract-2.pdf', '{}', 1)").run();
  db.prepare("INSERT INTO bo_signatures (doc_id, signature_png, name, at, ip, ua, sha256) VALUES (1, x'89504e47', 'Лиза Иванова', 1, '1.2.3.4', 'UA', 'h')").run();
  db.prepare("INSERT INTO cab_uploads (id, client_id, name, type, size, rel, at) VALUES ('u1', 1, 'a.pdf', 'application/pdf', 1, 'uploads/1/u1.pdf', 1)").run();
  return { dir, renders, w, db };
}

describe('POST /admin/clients/:id/anonymize', () => {
  it('blanks the card, marks messages and documents, deletes the signature and the files of this client only, writes one audit line', async () => {
    const { dir, renders, w, db } = setup();
    const r = await w.call('POST', '/admin/clients/1/anonymize');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, already: false });
    expect(db.prepare('SELECT email, name, telegram, phone, company, supabase_id FROM cab_clients WHERE id = 1').get()).toEqual({ email: deletedEmail(1), name: 'удалённый клиент', telegram: '', phone: '', company: '', supabase_id: '' });
    expect(JSON.stringify(db.prepare('SELECT * FROM cab_messages WHERE client_id = 1').all())).not.toContain('секретный');
    expect(JSON.stringify(db.prepare('SELECT * FROM cab_tmsgs WHERE client_id = 1').all())).not.toContain('поддержка');
    expect(db.prepare('SELECT title, body, pdf_rel, number, amount_usd, state FROM cab_documents WHERE client_id = 1').get()).toEqual({ title: 'contract (клиент удалён)', body: '', pdf_rel: null, number: 'D-1', amount_usd: 300, state: 'signed' });
    expect(db.prepare('SELECT name, ip, ua, length(signature_png) AS n FROM bo_signatures').get()).toEqual({ name: 'удалённый клиент', ip: '', ua: '', n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM cab_uploads WHERE client_id = 1').get()).toEqual({ n: 0 });
    expect(existsSync(join(renders, 'cabinet', 'c1'))).toBe(false);
    expect(existsSync(join(dir, 'uploads', '1'))).toBe(false);
    // the neighbour is untouched
    expect(existsSync(join(renders, 'cabinet', 'c2', 'contract-2.pdf'))).toBe(true);
    expect(existsSync(join(dir, 'uploads', '2', 'b.pdf'))).toBe(true);
    expect(db.prepare('SELECT email, name FROM cab_clients WHERE id = 2').get()).toEqual({ email: 'other@example.com', name: 'Другой' });
    expect(db.prepare('SELECT text FROM cab_messages WHERE client_id = 2').get()).toEqual({ text: 'Чужое сообщение' });
    expect(db.prepare('SELECT title FROM cab_documents WHERE client_id = 2').get()).toEqual({ title: 'Договор Другой' });
    const audit = w.w.hq.activity(20).filter((a) => a.action === 'client_anonymized');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ objectType: 'client', objectId: '1' });
    expect(audit[0]!.detail).not.toContain('liza');
  });
  it('is idempotent and 404 for an unknown client; a bad id is not a route', async () => {
    const { w, db } = setup();
    expect((await w.call('POST', '/admin/clients/1/anonymize')).json.already).toBe(false);
    const again = await w.call('POST', '/admin/clients/1/anonymize');
    expect(again).toMatchObject({ status: 200, json: { ok: true, already: true } });
    expect(w.w.hq.activity(20).filter((a) => a.action === 'client_anonymized')).toHaveLength(1);
    expect(db.prepare('SELECT email FROM cab_clients WHERE id = 1').get()).toEqual({ email: deletedEmail(1) });
    expect((await w.call('POST', '/admin/clients/99/anonymize')).status).toBe(404);
    expect((await w.call('POST', '/admin/clients/abc/anonymize')).status).toBe(404);
    expect((await w.call('GET', '/admin/clients/2/anonymize')).status).toBe(404);
  });
});
