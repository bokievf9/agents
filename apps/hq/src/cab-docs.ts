import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { errMsg, log, markdownToPdfDoc, parseStages, zonedParts, type Db, type PaymentStage, type Tools } from '@fir/core';
import { planStageDates, PmStore, type Product } from '@fir/worker-project-manager';
import type { Hq } from '@fir/hq';
import type { BillingWorker } from '@fir/worker-billing';
import { fillTemplate, loadTemplate } from '@fir/worker-documents';
import { legalLabel, legalMeta, legalPartyOfClient } from '@fir/worker-lead-intake';
import { z } from 'zod';
import { addCabMessage, addThreadMessage, ensureCabinetTables, postFromFirTech } from './cabinet.js';
import type { Playground } from './playground.js';
import { parseBuilderPlan, wantsPlayground } from './builder-plan.js';
import { EmailFailures, type EmailKind } from './email-failures.js';
import type { ClientMail } from './client-mail.js';
import { ensureRefSlug, hasReview } from './reviews.js';

/**
 * Cabinet v3 documents (2026-11-22): what the client sees of the papers and what he does with them. The owner's approval of a quote, a contract or an
 * invoice IS the sending: it writes a `cab_documents` row, emails the client a link to the cabinet (never the PDF) and posts a line into his thread.
 * The client accepts the quote and signs the contract in the cabinet; each step proposes the next paper to the owner. Contract: `docs/admin-crm-api.md`,
 * «Кабинет v3 (2026-11-22)».
 */
export const DOC_KINDS = ['quote', 'contract', 'invoice', 'act', 'other'] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const DOC_STATES = ['awaiting_client', 'accepted', 'declined', 'expired', 'awaiting_signature', 'signed', 'issued', 'paid', 'void'] as const;
export type DocState = (typeof DOC_STATES)[number];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cab_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  number TEXT NOT NULL DEFAULT '',
  lead_id INTEGER,
  project_id INTEGER,
  pack_id INTEGER,
  state TEXT NOT NULL,
  src TEXT NOT NULL DEFAULT '',
  src_id INTEGER,
  amount_usd REAL,
  stage_no INTEGER,
  body TEXT NOT NULL DEFAULT '',
  pdf_rel TEXT,
  pdf_sha256 TEXT,
  signed_pdf_rel TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  accepted_at INTEGER,
  signed_at INTEGER
);
CREATE INDEX IF NOT EXISTS cab_documents_client ON cab_documents (client_id, id);
CREATE INDEX IF NOT EXISTS cab_documents_lead ON cab_documents (lead_id);
CREATE INDEX IF NOT EXISTS cab_documents_project ON cab_documents (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS cab_documents_src ON cab_documents (src, src_id) WHERE src_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS bo_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  signature_png BLOB NOT NULL,
  name TEXT NOT NULL,
  at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bo_signatures_doc ON bo_signatures (doc_id);
`;

/** Columns added after the first release (P-07, P-09, P-12): the email outcome of the row and the retry counters. Added once per database. */
const LATER_COLUMNS: [string, string][] = [
  ['mail_state', 'TEXT'], ['mail_error', 'TEXT'], ['mail_attempts', 'INTEGER NOT NULL DEFAULT 0'],
];

const ready = new WeakSet<object>();
export function ensureDocTables(db: Db): void {
  if (ready.has(db)) return;
  ensureCabinetTables(db);
  db.exec(SCHEMA);
  const cols = new Set((db.prepare('PRAGMA table_info(cab_documents)').all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of LATER_COLUMNS) if (!cols.has(name)) db.exec(`ALTER TABLE cab_documents ADD COLUMN ${name} ${type}`);
  ready.add(db);
}

export interface DocRow {
  id: number; client_id: number; kind: DocKind; title: string; number: string; lead_id: number | null; project_id: number | null; pack_id: number | null; state: DocState;
  src: string; src_id: number | null; amount_usd: number | null; stage_no: number | null; body: string; pdf_rel: string | null; pdf_sha256: string | null; signed_pdf_rel: string | null;
  meta: string; created_at: number; delivered_at: number | null; accepted_at: number | null; signed_at: number | null;
  /** The email of the notice: `sent`, `failed`, `off` (no Resend: the thread line is the delivery), null before the first try. */
  mail_state?: string | null; mail_error?: string | null; mail_attempts?: number;
}

type Notice = { ru: string; en: string; ruMail: string; enMail: string };

/** The notice of a delivered row (the thread line and the email), the same words on the first sending and on «Отправить снова». Null: the row has no notice of its own (the estimate rides with the КП). */
export function noticeOf(row: Pick<DocRow, 'kind' | 'number' | 'stage_no' | 'amount_usd'>): Notice | null {
  if (row.kind === 'quote') {
    return {
      ru: 'Коммерческое предложение готово. Откройте раздел «Документы», прочитайте его и нажмите «Принять КП» или задайте вопрос в сообщениях.',
      en: 'Your commercial proposal is ready. Open Documents, read it and press «Accept», or ask a question in Messages.',
      ruMail: 'Ваше коммерческое предложение Fir Tech', enMail: 'Your Fir Tech commercial proposal',
    };
  }
  if (row.kind === 'contract') {
    return {
      ru: 'Договор готов. Откройте раздел «Документы», прочитайте его и подпишите, нарисовав подпись мышью.',
      en: 'The contract is ready. Open Documents, read it and sign it by drawing your signature with the mouse.',
      ruMail: 'Договор Fir Tech готов к подписанию', enMail: 'Your Fir Tech contract is ready to sign',
    };
  }
  if (row.kind === 'act') return { ru: 'Акт сдачи работ готов, он в разделе «Документы».', en: 'The completion certificate is ready in Documents.', ruMail: 'Акт сдачи работ Fir Tech', enMail: 'Your Fir Tech completion certificate' };
  if (row.kind === 'invoice') {
    const stage = row.stage_no ? ` (этап ${row.stage_no})` : '';
    const stageEn = row.stage_no ? ` (stage ${row.stage_no})` : '';
    return {
      ru: `Счёт ${row.number}${stage} на $${row.amount_usd} выставлен. Оплатить можно кнопкой «Оплатить» в разделе «Документы» или в проекте.`,
      en: `Invoice ${row.number}${stageEn} for $${row.amount_usd} has been issued. Pay with the «Pay» button in Documents or in your project.`,
      ruMail: `Счёт ${row.number} от Fir Tech`, enMail: `Invoice ${row.number} from Fir Tech`,
    };
  }
  return null;
}

/** What the client does next (the same words for a lead and for a project). `wait`: nothing, we are working. */
export interface NextAction {
  kind: 'accept_quote' | 'sign_contract' | 'pay_stage' | 'accept_stage' | 'wait';
  docId?: number;
  stageNo?: number;
  payUrl?: string;
}

/** The stage fields `clientNextAction` reads (the cabinet's milestone view). */
export interface StageLike {
  stageNo: number | null;
  state: 'awaiting_payment' | 'in_progress' | 'awaiting_acceptance' | 'accepted' | null;
  payUrl: string | null;
  invoiceNumber: string | null;
}

const hasTable = (db: Db, t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;

/** The documents of one lead and/or project, oldest first; empty when the cabinet documents were never used. */
export function docsOf(db: Db, o: { leadId?: number | null; projectId?: number | null }): DocRow[] {
  if (!hasTable(db, 'cab_documents')) return [];
  const where: string[] = [];
  const params: number[] = [];
  if (o.leadId) { where.push('lead_id = ?'); params.push(o.leadId); }
  if (o.projectId) { where.push('project_id = ?'); params.push(o.projectId); }
  if (!where.length) return [];
  return db.prepare(`SELECT * FROM cab_documents WHERE ${where.join(' OR ')} ORDER BY id`).all(...params) as DocRow[];
}

/**
 * The one thing the client does next. Order: a quote to accept, a contract to sign, the stage to pay (the pay link of the issued invoice), the
 * finished stage to accept; otherwise `wait`. Documents win over stages: a client never pays before he signed.
 */
export function clientNextAction(docs: DocRow[], stages: StageLike[]): NextAction {
  const quote = docs.find((d) => d.kind === 'quote' && d.state === 'awaiting_client');
  if (quote) return { kind: 'accept_quote', docId: quote.id };
  const contract = docs.find((d) => d.kind === 'contract' && d.state === 'awaiting_signature');
  if (contract) return { kind: 'sign_contract', docId: contract.id };
  for (const s of stages) {
    if (s.stageNo === null || s.state === 'accepted') continue;
    if (s.state === 'awaiting_acceptance') return { kind: 'accept_stage', stageNo: s.stageNo };
    if (s.state === 'awaiting_payment' && s.payUrl) {
      const inv = docs.find((d) => d.kind === 'invoice' && d.number === s.invoiceNumber);
      return { kind: 'pay_stage', stageNo: s.stageNo, payUrl: s.payUrl, ...(inv ? { docId: inv.id } : {}) };
    }
    break; // the stage runs, or its invoice is not issued yet
  }
  return { kind: 'wait' };
}

/** The project state the client sees: preparing until the first stage is paid, then in progress, paused, done. */
export function projectStateOf(status: string, stages: Pick<StageLike, 'state'>[]): 'preparing' | 'in_progress' | 'paused' | 'done' {
  if (status === 'done') return 'done';
  if (status === 'paused') return 'paused';
  if (status === 'active') return 'in_progress';
  return stages.some((s) => s.state !== null && s.state !== 'awaiting_payment') ? 'in_progress' : 'preparing';
}

/** One sentence for the lead's `nextStep` when the documents flow is on for the lead (`null`: the old stage sentence stays). */
export function docNextStep(docs: DocRow[], action: NextAction, lang: string | null | undefined): string | null {
  if (!docs.some((d) => d.kind === 'quote')) return null;
  const en = lang === 'en';
  if (action.kind === 'accept_quote') return en ? 'Read the proposal in Documents and press «Accept»' : 'Прочитайте КП в разделе «Документы» и нажмите «Принять КП»';
  if (action.kind === 'sign_contract') return en ? 'Sign the contract in Documents' : 'Подпишите договор в разделе «Документы»';
  const quote = docs.find((d) => d.kind === 'quote')!;
  const contract = docs.find((d) => d.kind === 'contract');
  const last = [...docs].reverse().find((d) => d.kind === 'quote')!;
  if (last.state === 'declined') return en ? 'You sent your answer on the proposal: the manager replies in Messages' : 'Ваш ответ по КП у менеджера: он ответит в сообщениях';
  if (last.state === 'expired') return en ? 'The proposal has expired: write in Messages and we will update it' : 'Срок КП истёк: напишите в сообщениях, обновим предложение';
  if (quote.state === 'accepted' && !contract) return en ? 'Proposal accepted, we are preparing the contract' : 'КП принято, готовим договор';
  if (contract?.state === 'signed' && !docs.some((d) => d.kind === 'invoice')) return en ? 'Contract signed, we are preparing the invoice for the first stage' : 'Договор подписан, готовим счёт на первый этап';
  return null;
}

/** A drawn signature as the cabinet sends it: `data:image/png;base64,...`, a real PNG of a sensible size with something drawn on it. */
export const SIGNATURE_MAX_CHARS = 200 * 1024;

/** Concatenated, inflated IDAT of a PNG, or null when the file is not a well-formed PNG. */
function pngPixels(buf: Buffer): { width: number; height: number; raw: Buffer } | null {
  if (buf.length < 45 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > buf.length) return null;
    if (type === 'IHDR') {
      width = buf.readUInt32BE(off + 8);
      height = buf.readUInt32BE(off + 12);
    } else if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!width || !height || !idat.length) return null;
  try {
    return { width, height, raw: inflateSync(Buffer.concat(idat), { maxOutputLength: 64 * 1024 * 1024 }) };
  } catch {
    return null;
  }
}

/**
 * The PNG bytes of a signature data URL, or the reason it is refused. Refused: not a PNG data URL, over 200 KB, not a decodable PNG, a tiny or huge
 * picture, a blank canvas (all pixels transparent, or one flat colour: nothing was drawn).
 */
export function parseSignature(dataUrl: string): { ok: true; png: Buffer } | { ok: false; reason: string } {
  if (dataUrl.length > SIGNATURE_MAX_CHARS) return { ok: false, reason: 'too_large' };
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) return { ok: false, reason: 'not_png' };
  const png = Buffer.from(m[1]!, 'base64');
  const px = pngPixels(png);
  if (!px) return { ok: false, reason: 'not_png' };
  if (px.width < 20 || px.height < 10 || px.width > 4000 || px.height > 2000) return { ok: false, reason: 'bad_size' };
  // a filter byte starts each row: what is left is the pixel data; a drawn stroke makes at least two distinct values beyond the filter bytes
  const seen = new Set<number>();
  for (let i = 0; i < px.raw.length && seen.size < 3; i++) seen.add(px.raw[i]!);
  const zeros = px.raw.reduce((n, b) => n + (b === 0 ? 1 : 0), 0);
  if (seen.size === 1 || (seen.size === 2 && seen.has(0) && seen.has(255) && zeros <= px.height)) return { ok: false, reason: 'blank' };
  return { ok: true, png };
}

const rejectBody = z.object({
  reason: z.string().trim().min(1).max(1000),
  /** `decline`: the client says no; `discuss`: he wants to change something first. Both close this КП; the owner answers in the thread. */
  mode: z.enum(['decline', 'discuss']).default('decline'),
});
const DAY = 86_400_000;

const signBody = z.object({
  signaturePng: z.string().min(1).max(400_000),
  name: z.string().trim().min(2).max(120),
  consent: z.literal(true),
  ip: z.string().trim().max(64).default(''),
  userAgent: z.string().trim().max(300).default(''),
});

export interface CabDocsDeps {
  hq: Hq;
  now: () => number;
  /** The Back Office toolbox (`media.pdf`, `files.put`, `files.url`, `email.send`): one per call, `docs/tools.md`. */
  tools: () => Tools;
  billing: BillingWorker;
  siteUrl: string;
  /** A line for the owner's inbox (no approval). */
  notifyOwner: (text: string) => void;
  /** How long a КП stands (`KP_VALID_DAYS`, the same number the КП text names); default 14. */
  kpValidDays?: number | (() => number);
  /** Emails outside the document notices (payment received, P-13; the review request, P-16). Absent: the thread line only. */
  mail?: ClientMail | undefined;
}

/** What the Sales head hands over when the owner approved a КП whose lead has a cabinet. */
export interface QuoteApproval {
  clientId: number;
  leadId: number;
  /** The reserved project; null when it is reserved on the client's acceptance (P-10: `reservation`). */
  projectId: number | null;
  packId: number;
  client: string;
  totalUsd: number;
  kpText: string;
  estimateText: string;
  /** The task metas of the next two steps (the contract, the invoice of stage 1): made after the client accepts and signs. */
  contractMeta: Record<string, unknown>;
  invoiceMeta: Record<string, unknown>;
  /** P-10: what `PmStore.reserve` needs when the client accepts (the stage dates are planned from that day). */
  reservation?: { client: string; what: string; product: Product; leadId: number | null; packId: number; stages: PaymentStage[]; dueProduct?: Product };
}

interface ClientRow { id: number; email: string; name: string; locale: string }
const SEVEN_DAYS = 7 * 86_400_000;
/** Emails per document in all (the first sending and the retries on start; the owner's «Отправить снова» is not limited). */
export const MAX_MAIL_ATTEMPTS = 3;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export type DocReply = { status: number; body: Record<string, unknown> };
const okR = (body: Record<string, unknown> = {}): DocReply => ({ status: 200, body: { ok: true, ...body } });
const failR = (status: number, error: string, extra: Record<string, unknown> = {}): DocReply => ({ status, body: { ok: false, error, ...extra } });

export class CabDocs {
  private readonly pending = new Set<Promise<unknown>>();
  /** The playground of agents (set by `buildCabinet`): a КП with the playground in it makes the client's demo agent, the first payment turns it live. */
  private playground: Playground | null = null;

  attachPlayground(pg: Playground): void {
    this.playground = pg;
  }

  constructor(private readonly d: CabDocsDeps) {
    ensureDocTables(d.hq.db);
  }

  get db(): Db {
    return this.d.hq.db;
  }

  now(): number {
    return this.d.now();
  }

  /** A line in the owner's inbox (the cabinet's hook). */
  readonly ownerLine = (text: string): void => this.d.notifyOwner(text);

  /** Waits for the background work started by the owner's decisions (the PDF and the email of a quote); tests and shutdown. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track(p: Promise<unknown>): void {
    const q = p.catch((e) => log('warn', 'cabinet document step failed', { err: errMsg(e) })).finally(() => this.pending.delete(q));
    this.pending.add(q);
  }

  private client(id: number): ClientRow | undefined {
    return this.db.prepare('SELECT id, email, name, locale FROM cab_clients WHERE id = ?').get(id) as ClientRow | undefined;
  }

  /** The cabinet account of a lead, or null (a lead from the Telegram bot has none: its papers go the old way, through the owner). */
  clientOfLead(leadId: number | null | undefined): number | null {
    if (!leadId || !hasTable(this.db, 'li_leads')) return null;
    const r = this.db.prepare('SELECT client_id FROM li_leads WHERE id = ?').get(leadId) as { client_id: number | null } | undefined;
    return r?.client_id ?? null;
  }

  private row(id: number): DocRow | undefined {
    return this.db.prepare('SELECT * FROM cab_documents WHERE id = ?').get(id) as DocRow | undefined;
  }

  /** A new row; `delivered_at` stays null until the client got the notice (`notifyClient`), unless the caller says it is already with him. */
  private insert(r: Partial<DocRow> & Pick<DocRow, 'client_id' | 'kind' | 'title' | 'state'>): DocRow {
    const t = this.d.now();
    const id = Number(
      this.db.prepare(
        `INSERT INTO cab_documents (client_id, kind, title, number, lead_id, project_id, pack_id, state, src, src_id, amount_usd, stage_no, body, meta, created_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        r.client_id, r.kind, r.title, r.number ?? '', r.lead_id ?? null, r.project_id ?? null, r.pack_id ?? null, r.state, r.src ?? '', r.src_id ?? null, r.amount_usd ?? null,
        r.stage_no ?? null, r.body ?? '', r.meta ?? '{}', t, r.delivered_at === undefined ? null : r.delivered_at,
      ).lastInsertRowid,
    );
    return this.row(id)!;
  }

  private cabinetUrl(c: ClientRow): string {
    return `${this.d.siteUrl}/${c.locale === 'en' ? 'en' : 'ru'}/cabinet`;
  }

  // ---- rendering ----
  private stamp(ms: number): string {
    const p = zonedParts(ms, this.d.hq.tz);
    const two = (n: number) => String(n).padStart(2, '0');
    return `${two(p.d)}.${two(p.mo)}.${p.y} ${two(p.h)}:${two(p.mi)}`;
  }

  /** The PDF of a row; `sign` makes the signed contract. Returns the stored path and the file's sha256, or null when it could not be made (no fonts or folder). */
  private async render(row: DocRow, sign?: { png: Buffer; name: string; at: number }): Promise<{ rel: string; sha256: string } | null> {
    const tools = this.d.tools();
    if (!tools.can('media.pdf') || !tools.can('files.put')) return null;
    let body = row.body;
    const parties: { role: string; name: string; details?: string[]; date?: string; signature?: Uint8Array }[] = [];
    if (row.kind === 'contract') {
      const cut = body.search(/^##\s+Подписи сторон/m);
      if (cut >= 0) body = body.slice(0, cut);
      const c = this.client(row.client_id);
      const when = this.stamp(sign?.at ?? row.created_at);
      parties.push(
        { role: 'Исполнитель', name: 'Fir Tech', details: ['hello@firtech.pro'], date: when },
        sign
          ? { role: 'Заказчик', name: sign.name, details: ['Простая электронная подпись в кабинете firtech.pro'], date: when, signature: sign.png }
          : { role: 'Заказчик', name: (c ? legalPartyOfClient(this.db, c.id)?.name : '') || c?.name || c?.email || '____________', details: ['Подпись ставится в кабинете firtech.pro'] },
      );
    }
    const doc = { ...markdownToPdfDoc(body, { title: row.title, footer: 'Fir Tech · firtech.pro' }), ...(parties.length ? { parties } : {}) };
    if (row.kind !== 'contract') doc.title = row.number ? `${row.title} ${row.number}` : row.title;
    const pdf = await tools.media.pdf(doc);
    if (!pdf.ok) {
      log('warn', 'cabinet pdf not rendered', { doc: row.id, err: pdf.error });
      return null;
    }
    const name = `${row.kind}-${row.id}${sign ? '-signed' : ''}.pdf`;
    const file = await tools.files.put(`cabinet/c${row.client_id}`, name, pdf.value.bytes);
    if (!file.ok) {
      log('warn', 'cabinet pdf not saved', { doc: row.id, err: file.error });
      return null;
    }
    return { rel: file.value.path, sha256: sha(pdf.value.bytes) };
  }

  /** The PDF link: a signed `/media/` URL valid for 7 days, made fresh on every read; null without a stored file or without the public base. */
  private async pdfUrl(row: DocRow): Promise<string | null> {
    const rel = row.signed_pdf_rel ?? row.pdf_rel;
    if (!rel) return null;
    const u = await this.d.tools().files.url(rel, { ttlMs: SEVEN_DAYS });
    return u.ok ? u.value : null;
  }

  /** Renders the unsigned PDF of a freshly delivered row and keeps the path and the hash on it (best effort). */
  private async attachPdf(row: DocRow): Promise<void> {
    const r = await this.render(row);
    if (r) this.db.prepare('UPDATE cab_documents SET pdf_rel = ?, pdf_sha256 = ? WHERE id = ?').run(r.rel, r.sha256, row.id);
  }

  /** When the PDF of a row was last tried on a read (P-09): a missing one is built again at most every 10 minutes, so a broken font folder does not render on every poll. */
  private readonly pdfTriedAt = new Map<number, number>();

  /**
   * P-09: a row whose PDF never got made (a restart in the middle of the background work, missing fonts at that moment) gets it on the next read. Returns the
   * row as it is now. Never throws: the list must answer even when the PDF still cannot be made.
   */
  private async ensurePdf(r: DocRow): Promise<DocRow> {
    if (r.state === 'signed' && !r.signed_pdf_rel) return this.ensureSignedPdf(r);
    if (r.pdf_rel || r.signed_pdf_rel) return r;
    const last = this.pdfTriedAt.get(r.id);
    if (last !== undefined && this.d.now() - last < 10 * 60_000) return r;
    this.pdfTriedAt.set(r.id, this.d.now());
    try {
      await this.attachPdf(r);
      const now = this.row(r.id) ?? r;
      if (now.pdf_rel) this.d.hq.log('documents', 'pdf_rebuilt', 'document', String(r.id), r.kind);
      return now;
    } catch (e) {
      log('warn', 'cabinet pdf rebuild failed', { doc: r.id, err: errMsg(e) });
      return r;
    }
  }

  /** The signed copy of a contract, rendered from the stored signature (`bo_signatures`); null when it could not be made. */
  private async renderSigned(r: DocRow): Promise<{ rel: string; sha256: string } | null> {
    const sig = this.db.prepare('SELECT signature_png, name, at FROM bo_signatures WHERE doc_id = ? ORDER BY id DESC LIMIT 1').get(r.id) as { signature_png: Buffer; name: string; at: number } | undefined;
    if (!sig) return null;
    try {
      return await this.render(r, { png: Buffer.from(sig.signature_png), name: sig.name, at: sig.at });
    } catch (e) {
      log('warn', 'signed pdf failed', { doc: r.id, err: errMsg(e) });
      return null;
    }
  }

  /** P-12: a signed contract without its signed PDF (the render failed at signing) gets it on the next read, at most every 10 minutes. */
  private async ensureSignedPdf(r: DocRow): Promise<DocRow> {
    const last = this.pdfTriedAt.get(r.id);
    if (last !== undefined && this.d.now() - last < 10 * 60_000) return r;
    this.pdfTriedAt.set(r.id, this.d.now());
    const rendered = await this.renderSigned(r);
    if (!rendered) return r;
    this.db.prepare('UPDATE cab_documents SET signed_pdf_rel = ? WHERE id = ?').run(rendered.rel, r.id);
    this.d.hq.log('documents', 'signed_pdf_rebuilt', 'document', String(r.id));
    this.d.notifyOwner(`Подписанный PDF договора ${r.number} собран со второй попытки, он у клиента в «Документах».`);
    return this.row(r.id) ?? r;
  }

  /**
   * P-09, on the start of HQ: the notices the background work never finished (a restart between the owner's approval and the client's line, `delivered_at IS NULL`)
   * are sent now, with the PDF made first; an email that failed is tried again. At most `MAX_MAIL_ATTEMPTS` emails per row in all. Returns what it did.
   */
  async recoverDeliveries(): Promise<{ delivered: number; remailed: number }> {
    let delivered = 0;
    let remailed = 0;
    const rows = this.db.prepare(
      `SELECT * FROM cab_documents WHERE kind IN ('quote', 'contract', 'invoice', 'act') AND mail_attempts < ? AND (delivered_at IS NULL OR mail_state = 'failed') ORDER BY id`,
    ).all(MAX_MAIL_ATTEMPTS) as DocRow[];
    for (const r of rows) {
      const what = noticeOf(r);
      const c = this.client(r.client_id);
      if (!what || !c) continue;
      try {
        if (r.delivered_at === null) {
          if (!r.pdf_rel) await this.attachPdf(r);
          if (r.kind === 'quote' && r.pack_id !== null) {
            const est = this.db.prepare("SELECT * FROM cab_documents WHERE kind = 'other' AND pack_id = ? AND client_id = ?").get(r.pack_id, r.client_id) as DocRow | undefined;
            if (est && !est.pdf_rel) await this.attachPdf(est);
          }
          await this.notifyClient(this.row(r.id)!, what);
          delivered++;
        } else {
          await this.mailRow(r, c, what);
          remailed++;
        }
      } catch (e) {
        log('warn', 'cabinet delivery recovery failed', { doc: r.id, err: errMsg(e) });
      }
    }
    if (delivered || remailed) this.d.hq.log('documents', 'deliveries_recovered', 'document', '', `delivered ${delivered}, remailed ${remailed}`);
    return { delivered, remailed };
  }

  // ---- delivery: the owner's approval is the sending ----
  /** The email half of a notice (a link to the cabinet, never a PDF); returns what happened for the journal: `email`, `email_failed:<why>` or `journal` (no Resend). */
  private async mail(c: ClientRow, what: Notice): Promise<string> {
    const en = c.locale === 'en';
    const tools = this.d.tools();
    if (!tools.can('email.send')) return 'journal';
    const hello = en ? `Hello${c.name ? `, ${c.name}` : ''}!` : `Здравствуйте${c.name ? `, ${c.name}` : ''}!`;
    try {
      const sent = await tools.email.send({
        to: c.email, subject: en ? what.enMail : what.ruMail,
        text: `${hello}\n\n${en ? what.en : what.ru}\n\n${en ? 'Open your cabinet' : 'Откройте личный кабинет'}: ${this.cabinetUrl(c)}\n\nFir Tech\nhello@firtech.pro`,
      });
      return sent.ok ? 'email' : `email_failed:${String(sent.error)}`;
    } catch (e) {
      return `email_failed:${errMsg(e).slice(0, 60)}`;
    }
  }

  /** What did not go: one row for the owner's hourly alert (P-07). */
  private get failures(): EmailFailures {
    return new EmailFailures(this.d.hq);
  }

  /** The email of a row's notice and its outcome on the row (`mail_state`, P-07): a failure is recorded for the owner's hourly alert. Returns the journal word. */
  private async mailRow(row: DocRow, c: ClientRow, what: Notice): Promise<string> {
    const how = await this.mail(c, what);
    const state = how === 'email' ? 'sent' : how === 'journal' ? 'off' : 'failed';
    const why = state === 'failed' ? how.slice('email_failed:'.length) || 'unknown' : null;
    this.db.prepare('UPDATE cab_documents SET mail_state = ?, mail_error = ?, mail_attempts = mail_attempts + 1 WHERE id = ?').run(state, why, row.id);
    if (state === 'failed') this.failures.record(row.kind as EmailKind, row.number || `документ #${row.id}`, why ?? 'unknown');
    return how;
  }

  /** The email (a link to the cabinet, never the PDF) and the line in the thread; the outcome goes to the journal without any text. */
  private async notifyClient(row: DocRow, what: Notice): Promise<void> {
    const c = this.client(row.client_id);
    if (!c) return;
    postFromFirTech(this.db, this.d.now(), c.id, row.lead_id, c.locale === 'en' ? what.en : what.ru);
    // the client has the line: the row counts as delivered (P-09: a restart before this point is picked up by `recoverDeliveries`)
    this.db.prepare('UPDATE cab_documents SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL').run(this.d.now(), row.id);
    const how = await this.mailRow(row, c, what);
    this.d.hq.log('documents', 'doc_delivered', 'document', String(row.id), `${row.kind} ${how}`);
  }

  /**
   * «Отправить снова» (the owner, Пульт): the email of a delivered row is sent again (no second line in the thread: the client has it). 404 unknown row,
   * 409 `not_sendable` for a row without its own notice (the estimate), 409 `no_email` when Resend is not configured.
   */
  async resend(docId: number): Promise<DocReply> {
    const r = this.row(docId);
    if (!r) return failR(404, 'not_found');
    const what = noticeOf(r);
    const c = this.client(r.client_id);
    if (!what || !c) return failR(409, 'not_sendable');
    if (!this.d.tools().can('email.send')) return failR(409, 'no_email');
    const how = await this.mailRow(r, c, what);
    this.d.hq.log('owner', 'doc_resent', 'document', String(r.id), `${r.kind} ${how}`);
    const now = this.row(r.id)!;
    return how === 'email' ? okR({ mail: this.mailView(now) }) : failR(502, 'email_failed', { mail: this.mailView(now) });
  }

  private mailView(r: DocRow): { state: string | null; error: string | null; attempts: number } {
    return { state: r.mail_state ?? null, error: r.mail_error ?? null, attempts: r.mail_attempts ?? 0 };
  }

  /**
   * The owner's list of cabinet documents (`GET /admin/crm/cabinet-docs`): newest first, with the email outcome and whether the PDF exists. `problem`: only rows
   * whose email failed or whose PDF is missing (the Пульт's mark «письмо не ушло» / «нет PDF»).
   */
  ownerList(o: { problem?: boolean; clientId?: number | null; limit?: number } = {}): Record<string, unknown>[] {
    const where: string[] = [];
    const params: number[] = [];
    if (o.clientId) { where.push('d.client_id = ?'); params.push(o.clientId); }
    if (o.problem) where.push("(d.mail_state = 'failed' OR (d.kind != 'invoice' AND d.pdf_rel IS NULL AND d.signed_pdf_rel IS NULL) OR (d.state = 'signed' AND d.signed_pdf_rel IS NULL))");
    const rows = this.db.prepare(
      `SELECT d.*, c.name AS client_name, c.email AS client_email FROM cab_documents d JOIN cab_clients c ON c.id = d.client_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.id DESC LIMIT ?`,
    ).all(...params, Math.min(Math.max(o.limit ?? 100, 1), 500)) as (DocRow & { client_name: string; client_email: string })[];
    return rows.map((r) => {
      const problems = [
        ...(r.mail_state === 'failed' ? ['email_failed'] : []),
        ...(r.kind !== 'invoice' && !r.pdf_rel && !r.signed_pdf_rel ? ['no_pdf'] : []),
        ...(r.state === 'signed' && !r.signed_pdf_rel ? ['no_signed_pdf'] : []),
      ];
      return {
        id: r.id, clientId: r.client_id, client: r.client_name || r.client_email, kind: r.kind, title: r.title, number: r.number || null, leadId: r.lead_id, projectId: r.project_id,
        state: this.liveState(r), createdAt: iso(r.created_at), deliveredAt: iso(r.delivered_at), mail: this.mailView(r), pdf: Boolean(r.pdf_rel), signedPdf: Boolean(r.signed_pdf_rel),
        problems, actions: noticeOf(r) ? ['resend'] : [],
      };
    });
  }

  /**
   * The owner approved a КП of a cabinet lead: the quote and its estimate go to the client (`awaiting_client`), nothing else is made yet. The rows and the
   * thread line are written here (sync part of the owner's decision); the PDF and the email follow in the background (`idle()`).
   */
  onQuoteApproved(q: QuoteApproval): { quoteId: number } {
    const dup = this.db.prepare("SELECT * FROM cab_documents WHERE kind = 'quote' AND pack_id = ?").get(q.packId) as DocRow | undefined;
    if (dup) return { quoteId: dup.id };
    const quote = this.insert({
      client_id: q.clientId, kind: 'quote', title: 'Коммерческое предложение', number: `КП-${q.packId}`, lead_id: q.leadId, project_id: q.projectId, pack_id: q.packId, state: 'awaiting_client',
      src: 'ps_quote', src_id: q.packId, amount_usd: q.totalUsd, body: q.kpText,
      meta: JSON.stringify({ contract: q.contractMeta, invoice: q.invoiceMeta, client: q.client, ...(q.reservation ? { reservation: q.reservation } : {}) }),
    });
    const est = this.insert({
      client_id: q.clientId, kind: 'other', title: 'Смета', number: `КП-${q.packId}`, lead_id: q.leadId, project_id: q.projectId, pack_id: q.packId, state: 'issued', src: 'ps_estimate', src_id: q.packId,
      amount_usd: q.totalUsd, body: q.estimateText, delivered_at: this.d.now(),
    });
    this.track((async () => {
      await this.attachPdf(this.row(quote.id)!);
      await this.attachPdf(this.row(est.id)!);
      await this.notifyClient(quote, noticeOf(quote)!);
    })());
    return { quoteId: quote.id };
  }

  /**
   * An approved Back Office document: a contract (or an act) of a cabinet lead goes to the client. Returns true when it did (the owner then needs no
   * «send it yourself» text), false for a document without a cabinet client (a manual /doc, a Telegram lead).
   */
  async onDocApproved(doc: { id: number; type: string; client: string; version: number; text: string; taskId: number | null }): Promise<boolean> {
    if (doc.type !== 'contract' && doc.type !== 'act') return false;
    const task = doc.taskId !== null ? this.d.hq.task(doc.taskId) : undefined;
    const leadId = Number(task?.meta.leadId) || null;
    const clientId = this.clientOfLead(leadId);
    if (clientId === null) return false;
    const exists = this.db.prepare("SELECT id FROM cab_documents WHERE src = 'bo' AND src_id = ?").get(doc.id) as { id: number } | undefined;
    if (exists) return true;
    // the act of a closed project is made by HQ itself on the last acceptance: a manual one for the same project is not made twice
    const projectId = Number(task?.meta.projectId) || null;
    if (doc.type === 'act' && projectId !== null && this.db.prepare("SELECT 1 FROM cab_documents WHERE kind = 'act' AND project_id = ?").get(projectId)) return true;
    const isContract = doc.type === 'contract';
    const number = /№\s*(\S+)/.exec(doc.text)?.[1] ?? `${doc.id}`;
    const row = this.insert({
      client_id: clientId, kind: isContract ? 'contract' : 'act', title: isContract ? 'Договор оказания услуг' : 'Акт сдачи', number, lead_id: leadId, project_id: Number(task?.meta.projectId) || null,
      pack_id: Number(task?.meta.packId) || null, state: isContract ? 'awaiting_signature' : 'issued', src: 'bo', src_id: doc.id, body: doc.text,
    });
    await this.attachPdf(row);
    await this.notifyClient(row, noticeOf(row)!);
    return true;
  }

  /** An approved invoice of a cabinet lead: the row, the email and the line with the pay button. Returns true when delivered through the cabinet. */
  async onInvoiceApproved(invoiceId: number, text: string): Promise<boolean> {
    if (!hasTable(this.db, 'bl_invoices')) return false;
    const inv = this.db.prepare('SELECT id, number, lead_id, project_id, pack_id, amount_usd, stage_no, what FROM bl_invoices WHERE id = ?').get(invoiceId) as
      | { id: number; number: string; lead_id: number | null; project_id: number | null; pack_id: number | null; amount_usd: number; stage_no: number | null; what: string } | undefined;
    const clientId = this.clientOfLead(inv?.lead_id);
    if (!inv || clientId === null) return false;
    if (this.db.prepare("SELECT 1 FROM cab_documents WHERE src = 'bl' AND src_id = ?").get(inv.id)) return true;
    const row = this.insert({
      client_id: clientId, kind: 'invoice', title: inv.stage_no ? `Счёт, этап ${inv.stage_no}` : 'Счёт', number: inv.number, lead_id: inv.lead_id, project_id: inv.project_id, pack_id: inv.pack_id,
      state: 'issued', src: 'bl', src_id: inv.id, amount_usd: inv.amount_usd, stage_no: inv.stage_no, body: text,
    });
    await this.attachPdf(row);
    await this.notifyClient(row, noticeOf(row)!);
    return true;
  }

  /** An invoice was paid (`/paid`, the watcher, the Пульт): one line in the client's thread. The document state follows the invoice on every read. */
  onPaid(inv: { id: number; number: string; leadId: number | null; stageNo: number | null }): void {
    const doc = this.db.prepare("SELECT client_id, lead_id FROM cab_documents WHERE src = 'bl' AND src_id = ?").get(inv.id) as { client_id: number; lead_id: number | null } | undefined;
    if (!doc) return;
    const c = this.client(doc.client_id);
    const en = c?.locale === 'en';
    const ru = `Оплата по счёту ${inv.number}${inv.stageNo ? ` (этап ${inv.stageNo})` : ''} получена. Спасибо!`;
    const enText = `Payment received for invoice ${inv.number}${inv.stageNo ? ` (stage ${inv.stageNo})` : ''}. Thank you!`;
    postFromFirTech(this.db, this.d.now(), doc.client_id, doc.lead_id, en ? enText : ru);
    // P-13: the payment is confirmed by email at once (not the hourly «new message»): the client paid and waits for this word
    const mail = this.d.mail;
    if (mail) {
      this.track(mail.send(doc.client_id, { subject: { ru: `Оплата по счёту ${inv.number} получена`, en: `Payment received for invoice ${inv.number}` }, text: { ru, en: enText } }, 'payment', inv.number)
        .then((how) => this.d.hq.log('documents', 'payment_mail', 'invoice', inv.number, how)));
    }
    // the first payment of the sale makes the client's playground agent live (an invoice outside the stage plan counts as the first one)
    if ((inv.stageNo === null || inv.stageNo === 1) && doc.lead_id !== null) {
      try {
        this.playground?.goLiveForLead(doc.client_id, doc.lead_id, en);
      } catch (e) {
        log('warn', 'agent go live failed', { err: errMsg(e) });
      }
    }
  }

  /** The accepted КП lists the playground (or is an agent without a site): the client's demo agent is made now, so the «Ваш агент» tab is there at once. */
  private autoAgent(c: ClientRow, quote: DocRow): void {
    try {
      if (!this.playground || quote.lead_id === null || !hasTable(this.db, 'li_leads')) return;
      const lead = this.db.prepare('SELECT estimate, task FROM li_leads WHERE id = ?').get(quote.lead_id) as { estimate: string | null; task: string } | undefined;
      if (!lead) return;
      const direction = quote.pack_id !== null && hasTable(this.db, 'ps_documents')
        ? (this.db.prepare('SELECT direction FROM ps_documents WHERE pack_id = ? ORDER BY id LIMIT 1').get(quote.pack_id) as { direction: string } | undefined)?.direction
        : undefined;
      if (!wantsPlayground(parseBuilderPlan(lead.estimate ?? '', lead.task), direction)) return;
      this.playground.autoCreateForLead(c.id, quote.lead_id, c.locale === 'en');
    } catch (e) {
      log('warn', 'auto agent failed', { err: errMsg(e) });
    }
  }

  // ---- the stages of the project: the client sees every step (2026-11-22) ----
  /** The cabinet client of a project (through its lead), or null (a project without a cabinet account: the owner tells the client himself). */
  private projectClient(p: { leadId: number | null }): ClientRow | null {
    const id = this.clientOfLead(p.leadId);
    return id === null ? null : this.client(id) ?? null;
  }

  /** A line from Fir Tech in the project thread (`project-<id>`: the unread flag of the tab follows) and the email; the email runs in the background (`idle()`). */
  private tellProject(c: ClientRow, projectId: number, what: Notice, journal: string): void {
    try {
      addThreadMessage(this.db, this.d.now(), { clientId: c.id, thread: `project-${projectId}`, from: 'manager', text: c.locale === 'en' ? what.en : what.ru });
    } catch (e) {
      log('warn', 'project thread line failed', { err: errMsg(e) });
    }
    this.track(this.mail(c, what).then((how) => {
      this.d.hq.log('documents', journal, 'project', String(projectId), how);
      if (how.startsWith('email_failed:')) this.failures.record('stage', `проект #${projectId}`, how.slice('email_failed:'.length) || 'unknown');
    }));
  }

  /** A stage is finished and waits for the client: a line in the project thread and an email. */
  onStageReady(p: { id: number; leadId: number | null }, m: { stageNo: number; title: string; titleEn?: string | null }): void {
    const c = this.projectClient(p);
    if (!c) return;
    const en = m.titleEn || m.title;
    this.tellProject(c, p.id, {
      ru: `Этап ${m.stageNo} «${m.title}» готов к приёмке: откройте вкладку «Проекты» и нажмите «Принять этап».`,
      en: `Stage ${m.stageNo} «${en}» is ready for your acceptance: open the Projects tab and press «Accept stage».`,
      ruMail: `Этап ${m.stageNo} готов к приёмке`, enMail: `Stage ${m.stageNo} is ready for acceptance`,
    }, 'stage_ready_notified');
  }

  /**
   * A stage was accepted (by the client or the owner): a line with the next stage, or, for the last one, the project close with the act. The invoice of the next
   * stage is only PROPOSED here: it reaches the client when the owner approves it (`onInvoiceApproved`: its own line and email), so the line promises it, not claims it.
   */
  onStageAccepted(p: { id: number; leadId: number | null; client: string; what: string; packId: number | null }, m: { stageNo: number; title: string; titleEn?: string | null },
    next: { stageNo: number; title: string; titleEn?: string | null } | null, stages: { stageNo: number; title: string; amountUsd: number | null }[]): void {
    const c = this.projectClient(p);
    if (!c) return;
    const t = (x: { title: string; titleEn?: string | null }) => x.titleEn || x.title;
    if (next) {
      this.tellProject(c, p.id, {
        ru: `Этап ${m.stageNo} принят. Следующий этап: ${next.stageNo} «${next.title}». Счёт на него готовим, он придёт в раздел «Документы» и на почту.`,
        en: `Stage ${m.stageNo} accepted. Next stage: ${next.stageNo} «${t(next)}». We are preparing its invoice, it will arrive in Documents and by email.`,
        ruMail: `Этап ${m.stageNo} принят`, enMail: `Stage ${m.stageNo} accepted`,
      }, 'stage_accepted_notified');
      return;
    }
    const act = this.makeAct(c, p, stages);
    const ruAct = act ? ' Акт сдачи-приёмки в разделе «Документы».' : '';
    const enAct = act ? ' The completion certificate is in Documents.' : '';
    this.tellProject(c, p.id, {
      ru: `Этап ${m.stageNo} принят. Проект завершён, спасибо!${ruAct}`,
      en: `Stage ${m.stageNo} accepted. The project is complete, thank you!${enAct}`,
      ruMail: 'Проект завершён', enMail: 'Your project is complete',
    }, 'project_closed_notified');    this.askReview(c, p.id);
  }

  /**
   * P-16: the project is closed: once per project, a line in the project thread and an email ask for a review (the cabinet's form, else an answer in the thread)
   * and give the client his referral link (10% of every paid stage of the client he brings). A week later without a review the owner gets one inbox line.
   */
  private askReview(c: ClientRow, projectId: number): void {
    const mail = this.d.mail;
    if (!mail || !mail.markOnce(`review:ask:${projectId}`)) return;
    try {
      const lang = c.locale === 'en' ? 'en' : 'ru';
      const site = this.d.siteUrl.replace(/\/$/, '');
      const form = `${site}/${lang}/cabinet?review=${projectId}`;
      const ref = `${site}/${lang}/?ref=${ensureRefSlug(this.db, c.id)}`;
      const text = {
        ru: `Как вам работа с Fir Tech? Оставьте, пожалуйста, короткий отзыв: ${form} (или просто ответьте здесь). А если знаете, кому ещё нужен сайт, агент или автоматизация, поделитесь вашей ссылкой: ${ref}. За каждого приведённого клиента вы получаете 10% каждого оплаченного им этапа.`,
        en: `How was working with Fir Tech? Please leave a short review: ${form} (or just answer here). And if you know someone who needs a website, an agent or automation, share your link: ${ref}. For every client you bring you get 10% of each stage they pay.`,
      };
      addThreadMessage(this.db, this.d.now(), { clientId: c.id, thread: `project-${projectId}`, from: 'manager', text: lang === 'en' ? text.en : text.ru });
      this.track(mail.send(c.id, { subject: { ru: 'Как вам работа с Fir Tech?', en: 'How was working with Fir Tech?' }, text }, 'review', `проект #${projectId}`, `project-${projectId}`)
        .then((how) => this.d.hq.log('documents', 'review_asked', 'project', String(projectId), how)));
    } catch (e) {
      log('warn', 'review request failed', { project: projectId, err: errMsg(e) });
    }
  }

  /** P-16, from the due ticker: a review asked 7 days ago and not given (no form, no client message in the project thread after the ask): one inbox line for the owner. */
  reviewTick(): number {
    const mail = this.d.mail;
    if (!mail) return 0;
    let n = 0;
    const asked = this.db.prepare("SELECT key, at FROM client_marks WHERE key LIKE 'review:ask:%' AND at <= ?").all(this.d.now() - SEVEN_DAYS) as { key: string; at: number }[];
    for (const a of asked) {
      const projectId = Number(a.key.slice('review:ask:'.length));
      if (mail.markedAt(`review:nudge:${projectId}`) !== null) continue;
      const answered = hasReview(this.db, projectId)
        || this.db.prepare("SELECT 1 FROM cab_tmsgs WHERE thread = ? AND \"from\" = 'client' AND at > ?").get(`project-${projectId}`, a.at) !== undefined;
      mail.markOnce(`review:nudge:${projectId}`);
      if (answered) continue;
      this.d.notifyOwner(`Отзыва по проекту #${projectId} нет неделю после закрытия. Можно напомнить клиенту в треде проекта (Пульт, чаты).`);
      n++;
    }
    return n;
  }

  /** The act of the closed project (a simple completion certificate): made from the template, accepted by the client's own last acceptance, once per project; the PDF follows in the background. */
  private makeAct(c: ClientRow, p: { id: number; leadId: number | null; client: string; what: string; packId: number | null }, stages: { stageNo: number; title: string; amountUsd: number | null }[]): DocRow | null {
    try {
      const have = this.db.prepare("SELECT * FROM cab_documents WHERE kind = 'act' AND project_id = ? ORDER BY id LIMIT 1").get(p.id) as DocRow | undefined;
      if (have) return have;
      const t = this.d.now();
      const parts = zonedParts(t, this.d.hq.tz);
      const two = (n: number) => String(n).padStart(2, '0');
      const date = `${two(parts.d)}.${two(parts.mo)}.${parts.y}`;
      const total = stages.reduce((a, x) => a + (x.amountUsd ?? 0), 0);
      const number = `АКТ-${p.id}`;
      const text = fillTemplate(loadTemplate('act'), {
        client: (legalPartyOfClient(this.db, c.id) ? legalLabel(legalPartyOfClient(this.db, c.id)!) : '') || p.client || c.name || c.email, what: p.what, date, number, price: total > 0 ? `$${total}` : '',
        milestones: stages.map((x) => `- Этап ${x.stageNo}: ${x.title}${x.amountUsd !== null ? `, $${x.amountUsd}` : ''}`),
      })
        .replace(/\[заполнить: замечания или «нет»\]/, 'нет')
        .replace(/Заказчик: ____________/, `Заказчик: принято в кабинете firtech.pro, ${date}`);
      const row = this.insert({
        client_id: c.id, kind: 'act', title: 'Акт сдачи-приёмки', number, lead_id: p.leadId, project_id: p.id, pack_id: p.packId, state: 'issued', src: 'auto_act', src_id: p.id, body: text,
        amount_usd: total > 0 ? total : null, delivered_at: t,
      });
      this.db.prepare('UPDATE cab_documents SET accepted_at = ? WHERE id = ?').run(t, row.id);
      this.track(this.attachPdf(this.row(row.id)!));
      this.d.hq.log('documents', 'act_issued', 'document', String(row.id), 'auto');
      return row;
    } catch (e) {
      log('warn', 'act failed', { err: errMsg(e) });
      return null;
    }
  }

  // ---- leads without a cabinet at first (the Telegram bot, the old chain) ----
  /** The line for the owner to put under a document he sends by hand to a lead with no cabinet account: where to sign up, with the same email. Empty for a lead that has one. */
  inviteLine(leadId: number | null | undefined, lang: 'ru' | 'en' = 'ru'): string {
    if (!leadId || !hasTable(this.db, 'li_leads') || this.clientOfLead(leadId) !== null) return '';
    const lead = this.db.prepare('SELECT contact FROM li_leads WHERE id = ?').get(leadId) as { contact: string } | undefined;
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(lead?.contact.trim() ?? '') ? lead!.contact.trim().toLowerCase() : '';
    const url = `${this.d.siteUrl}/${lang}/cabinet/login${email ? `?email=${encodeURIComponent(email)}` : ''}`;
    return lang === 'en'
      ? `Your personal cabinet (documents, invoices, project stages, chat with the manager): ${url}${email ? `\nSign up with the same email, ${email}: your papers will be there at once.` : '\nSign up with the email you gave us: your papers will be there at once.'}`
      : `Личный кабинет (документы, счета, этапы проекта, чат с менеджером): ${url}${email ? `\nЗарегистрируйтесь с той же почтой, ${email}: документы появятся там сразу.` : '\nЗарегистрируйтесь с почтой, которую вы нам называли: документы появятся там сразу.'}`;
  }

  /**
   * A client's leads came without a cabinet (the old chain: the papers went by hand) and the account is linked now (sign-up with the same email): the papers
   * the owner already approved or issued are attached to the account as cabinet documents so the «Документы» tab is not empty (`issued`: the paper is
   * already with the client, nothing to accept or sign here). Idempotent by source row; a lead whose quote went through the cabinet is left alone.
   */
  attachLegacy(clientId: number): number {
    if (!hasTable(this.db, 'li_leads')) return 0;
    let made = 0;
    const leads = this.db.prepare('SELECT id, name FROM li_leads WHERE client_id = ?').all(clientId) as { id: number; name: string }[];
    for (const l of leads) {
      if (this.db.prepare("SELECT 1 FROM cab_documents WHERE lead_id = ? AND src = 'ps_quote'").get(l.id)) continue;
      const projectId = hasTable(this.db, 'pm_projects')
        ? (this.db.prepare('SELECT id FROM pm_projects WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(l.id) as { id: number } | undefined)?.id ?? null
        : null;
      const add = (r: Parameters<CabDocs['insert']>[0]): void => {
        if (this.db.prepare('SELECT 1 FROM cab_documents WHERE src = ? AND src_id = ?').get(r.src, r.src_id)) return;
        const row = this.insert({ ...r, client_id: clientId, lead_id: l.id, project_id: projectId, delivered_at: this.d.now() });
        this.track(this.attachPdf(this.row(row.id)!));
        made++;
      };
      if (hasTable(this.db, 'ps_documents')) {
        for (const d of this.db.prepare("SELECT id, pack_id, kind, body FROM ps_documents WHERE lead_id = ? AND status = 'approved' AND kind IN ('kp', 'estimate') ORDER BY id").all(l.id) as { id: number; pack_id: number; kind: string; body: string }[]) {
          add({ client_id: clientId, kind: d.kind === 'kp' ? 'quote' : 'other', title: d.kind === 'kp' ? 'Коммерческое предложение' : 'Смета', number: `КП-${d.pack_id}`, pack_id: d.pack_id, state: 'issued', src: 'ps', src_id: d.id, body: d.body });
        }
      }
      if (hasTable(this.db, 'bo_documents')) {
        const mine = (this.db.prepare("SELECT id, type, client, version, text, task_id FROM bo_documents WHERE status = 'approved' AND type IN ('contract', 'act') ORDER BY id").all() as { id: number; type: string; client: string; version: number; text: string; task_id: number | null }[])
          .filter((d) => {
            const taskLead = d.task_id !== null ? Number(this.d.hq.task(d.task_id)?.meta.leadId) || null : null;
            return taskLead !== null ? taskLead === l.id : d.client.trim().toLowerCase() === l.name.trim().toLowerCase();
          });
        for (const d of mine) {
          add({ client_id: clientId, kind: d.type === 'contract' ? 'contract' : 'act', title: d.type === 'contract' ? 'Договор оказания услуг' : 'Акт сдачи', number: /№\s*(\S+)/.exec(d.text)?.[1] ?? `${d.id}`, state: 'issued', src: 'bo', src_id: d.id, body: d.text });
        }
      }
      if (hasTable(this.db, 'bl_invoices')) {
        for (const i of this.db.prepare("SELECT id, number, amount_usd, stage_no, project_id, pack_id, what FROM bl_invoices WHERE lead_id = ? AND status IN ('issued', 'paid') ORDER BY id").all(l.id) as { id: number; number: string; amount_usd: number; stage_no: number | null; project_id: number | null; pack_id: number | null; what: string }[]) {
          add({
            client_id: clientId, kind: 'invoice', title: i.stage_no ? `Счёт, этап ${i.stage_no}` : 'Счёт', number: i.number, project_id: i.project_id ?? projectId, pack_id: i.pack_id, state: 'issued', src: 'bl', src_id: i.id,
            amount_usd: i.amount_usd, stage_no: i.stage_no, body: i.what,
          });
        }
      }
    }
    return made;
  }

  /** True while a delivered document can still be revised by the owner (no cabinet row at all counts as open: only the text is replaced). */
  revisable(src: 'ps_quote' | 'ps_estimate' | 'bo', srcId: number): boolean {
    const row = this.db.prepare('SELECT kind, state FROM cab_documents WHERE src = ? AND src_id = ?').get(src, srcId) as { kind: string; state: string } | undefined;
    return !row || row.state === (row.kind === 'quote' ? 'awaiting_client' : row.kind === 'contract' ? 'awaiting_signature' : 'issued') || (row.kind === 'quote' && row.state === 'expired');
  }

  /**
   * The owner revised a delivered document (review center, «Правка»): the text of the row is replaced, its PDF is rendered again (the old link stops being
   * the latest at once) and the client gets a line in his thread. Allowed only until the client acted: a quote while it awaits him, a contract while it
   * awaits the signature; a signed or accepted one is refused (`locked`). `none`: the lead has no cabinet row (the owner sends the text himself).
   * `newSrcId`: the row now stands for the new version of a Back Office document.
   */
  async reviseDelivered(src: 'ps_quote' | 'ps_estimate' | 'bo', srcId: number, body: string, newSrcId?: number): Promise<'revised' | 'none' | 'locked'> {
    const row = this.db.prepare('SELECT * FROM cab_documents WHERE src = ? AND src_id = ?').get(src, srcId) as DocRow | undefined;
    if (!row) return 'none';
    const open = row.kind === 'quote' ? 'awaiting_client' : row.kind === 'contract' ? 'awaiting_signature' : 'issued';
    // an expired КП revised by the owner stands again from now (P-11): it waits for the client with a fresh term
    const revive = row.kind === 'quote' && row.state === 'expired';
    if (row.state !== open && !revive) return 'locked';
    this.db.prepare('UPDATE cab_documents SET body = ?, src_id = ?, pdf_rel = NULL, pdf_sha256 = NULL WHERE id = ?').run(body, newSrcId ?? row.src_id, row.id);
    if (revive) {
      const meta = JSON.parse(row.meta || '{}') as Record<string, unknown>;
      delete meta.expiryWarned;
      this.db.prepare("UPDATE cab_documents SET state = 'awaiting_client', delivered_at = ?, meta = ? WHERE id = ?").run(this.d.now(), JSON.stringify(meta), row.id);
    }
    await this.attachPdf(this.row(row.id)!);
    const c = this.client(row.client_id);
    postFromFirTech(this.db, this.d.now(), row.client_id, row.lead_id,
      c?.locale === 'en' ? `The document «${row.title}» was updated. Please open Documents to see the latest version.` : `Документ «${row.title}» обновлён. Откройте раздел «Документы», там актуальная версия.`);
    this.d.hq.log('documents', 'doc_revised', 'document', String(row.id), row.kind);
    return 'revised';
  }

  // ---- the API ----
  /** The invoice state follows `bl_invoices` (paid, voided); the other states are the row's own. */
  private liveState(r: DocRow): DocState {
    if (r.kind !== 'invoice' || r.src !== 'bl' || r.src_id === null) return r.state;
    const s = (this.db.prepare('SELECT status FROM bl_invoices WHERE id = ?').get(r.src_id) as { status: string } | undefined)?.status;
    return s === 'paid' ? 'paid' : s === 'void' ? 'void' : 'issued';
  }

  private payUrlOf(r: DocRow): string | null {
    if (r.kind !== 'invoice' || r.src_id === null || this.liveState(r) !== 'issued') return null;
    const inv = this.db.prepare('SELECT number, pay_key, locale FROM bl_invoices WHERE id = ?').get(r.src_id) as { number: string; pay_key: string | null; locale: string | null } | undefined;
    return inv ? this.d.billing.payUrl({ number: inv.number, payKey: inv.pay_key, locale: inv.locale === 'en' ? 'en' : 'ru' }) : null;
  }

  private async view(row: DocRow): Promise<Record<string, unknown>> {
    const r = await this.ensurePdf(row);
    const pay = this.payUrlOf(r);
    return {
      id: r.id, kind: r.kind, title: r.title, number: r.number || null, leadId: r.lead_id, projectId: r.project_id, state: this.liveState(r),
      createdAt: iso(r.created_at), deliveredAt: iso(r.delivered_at), acceptedAt: iso(r.accepted_at), signedAt: iso(r.signed_at), pdfUrl: await this.pdfUrl(r),
      ...(r.amount_usd !== null ? { amountUsd: r.amount_usd } : {}), ...(r.stage_no !== null ? { stageNo: r.stage_no } : {}), ...(pay ? { payUrl: pay } : {}),
    };
  }

  /** `GET /admin/clients/:id/documents`: the client's papers, newest first. */
  async list(clientId: number): Promise<DocReply> {
    if (!this.client(clientId)) return failR(404, 'not_found');
    this.attachLegacy(clientId);
    const rows = this.db.prepare('SELECT * FROM cab_documents WHERE client_id = ? ORDER BY id DESC').all(clientId) as DocRow[];
    return okR({ items: await Promise.all(rows.map((r) => this.view(r))) });
  }

  /** `POST /admin/clients/:id/documents/:docId/accept`: the client accepts the quote; HQ drafts the contract for the owner. */
  accept(clientId: number, docId: number): DocReply {
    const c = this.client(clientId);
    const r = this.row(docId);
    if (!c || !r || r.client_id !== clientId) return failR(404, 'not_found');
    if (r.kind !== 'quote' || r.state !== 'awaiting_client') return failR(409, 'not_awaiting', { state: this.liveState(r) });
    const t = this.d.now();
    if (this.db.prepare("UPDATE cab_documents SET state = 'accepted', accepted_at = ? WHERE id = ? AND state = 'awaiting_client'").run(t, r.id).changes !== 1) return failR(409, 'not_awaiting');
    const meta = JSON.parse(r.meta || '{}') as { contract?: Record<string, unknown>; invoice?: Record<string, unknown>; client?: string; reservation?: QuoteApproval['reservation'] };
    const hq = this.d.hq;
    // P-10: the project is reserved now that the client said yes (stage dates from today); the contract and the invoice to come carry its id
    if (meta.reservation && r.project_id === null) {
      try {
        const res = meta.reservation;
        const stages = parseStages(res.stages) ?? [];
        const project = new PmStore(this.db, this.d.now).reserve({ ...res, stages, dueAts: planStageDates(res.dueProduct ?? res.product, stages.map((x) => x.share), t, hq.tz) });
        const fill = (m: Record<string, unknown> | undefined) => (m ? { ...m, projectId: project.id, ...(typeof m.chain === 'string' ? { chain: m.chain.replace('{project}', `#${project.id}`) } : {}) } : m);
        meta.contract = fill(meta.contract);
        meta.invoice = fill(meta.invoice);
        this.db.prepare('UPDATE cab_documents SET meta = ? WHERE id = ?').run(JSON.stringify(meta), r.id);
        this.db.prepare('UPDATE cab_documents SET project_id = ? WHERE client_id = ? AND pack_id IS ? AND project_id IS NULL').run(project.id, c.id, r.pack_id);
        hq.log('documents', 'project_reserved', 'project', String(project.id), `pack ${res.packId}`);
      } catch (e) {
        log('warn', 'project reservation failed', { doc: r.id, err: errMsg(e) });
      }
    }
    if (meta.contract) {
      // the legal name may have been filled in after the owner approved the КП: read it again now
      hq.createTask({ title: `Договор: ${meta.client ?? c.name ?? c.email}`, dept: 'backoffice', creator: 'head', priority: 1, meta: { ...meta.contract, ...legalMeta(legalPartyOfClient(this.db, c.id)) } });
      hq.wake('backoffice-head', 'task');
    }
    hq.log('client', 'quote_accepted', 'document', String(r.id));
    postFromFirTech(this.db, t, c.id, r.lead_id, c.locale === 'en' ? 'Proposal accepted, thank you! We are preparing the contract.' : 'КП принято, спасибо! Готовим договор.');
    this.d.notifyOwner(`${c.name || c.email} принял КП ${r.number}: договор готовится, придёт карточкой на одобрение.`);
    this.autoAgent(c, r);
    return okR({ next: 'contract' });
  }

  /**
   * P-11 `POST /admin/clients/:id/documents/:docId/reject` `{ reason, mode? }`: the client declines the КП or wants to discuss it. The quote is `declined` (no contract
   * is drafted), his words go into the lead thread, the owner gets a Sales task and an inbox line. 404, 400 `invalid`, 409 `not_awaiting` like `accept`.
   */
  reject(clientId: number, docId: number, body: unknown): DocReply {
    const c = this.client(clientId);
    const r = this.row(docId);
    if (!c || !r || r.client_id !== clientId) return failR(404, 'not_found');
    const parsed = rejectBody.safeParse(body ?? {});
    if (!parsed.success) return failR(400, 'invalid');
    if (r.kind !== 'quote' || r.state !== 'awaiting_client') return failR(409, 'not_awaiting', { state: this.liveState(r) });
    const t = this.d.now();
    const { reason, mode } = parsed.data;
    const meta = { ...(JSON.parse(r.meta || '{}') as Record<string, unknown>), declined: { at: t, mode } };
    if (this.db.prepare("UPDATE cab_documents SET state = 'declined', meta = ? WHERE id = ? AND state = 'awaiting_client'").run(JSON.stringify(meta), r.id).changes !== 1) return failR(409, 'not_awaiting');
    const en = c.locale === 'en';
    const discuss = mode === 'discuss';
    if (r.lead_id !== null) {
      try {
        addCabMessage(this.db, t, { clientId: c.id, leadId: r.lead_id, from: 'client', text: `${discuss ? (en ? 'I would like to discuss the proposal' : 'Хочу обсудить КП') : (en ? 'I decline the proposal' : 'Отклоняю КП')} ${r.number}: ${reason}` });
      } catch (e) {
        log('warn', 'quote reject thread line failed', { doc: r.id, err: errMsg(e) });
      }
    }
    postFromFirTech(this.db, t, c.id, r.lead_id, en ? 'Thank you, your answer is with the manager: he replies here in Messages.' : 'Спасибо, ваш ответ у менеджера: он ответит здесь, в сообщениях.');
    const hq = this.d.hq;
    const who = c.name || c.email;
    hq.createTask({
      title: `КП ${r.number}: ${who} ${discuss ? 'хочет обсудить' : 'отклонил'}`, body: reason, dept: 'sales', creator: 'head', priority: 1,
      meta: { action: 'kp_declined', leadId: r.lead_id, docId: r.id, packId: r.pack_id, mode, number: r.number, client: who },
    });
    hq.wake('sales-head', 'task');
    hq.log('client', 'quote_declined', 'document', String(r.id), mode);
    this.d.notifyOwner(`${who} ${discuss ? 'хочет обсудить' : 'отклонил'} КП ${r.number}: причина в задаче продаж и в треде заявки.`);
    return okR({ state: 'declined' });
  }

  /**
   * P-11, from the due ticker: a КП that waits for the client longer than it stands (`kpValidDays` from its delivery) is `expired`; the owner hears a day before
   * and when it happens, the client gets one line. Returns how many quotes expired now.
   */
  async expiryTick(): Promise<number> {
    const days = typeof this.d.kpValidDays === 'function' ? this.d.kpValidDays() : (this.d.kpValidDays ?? 14);
    const now = this.d.now();
    let expired = 0;
    const rows = this.db.prepare("SELECT d.*, c.name AS client_name, c.email AS client_email, c.locale AS client_locale FROM cab_documents d JOIN cab_clients c ON c.id = d.client_id WHERE d.kind = 'quote' AND d.state = 'awaiting_client'").all() as (DocRow & { client_name: string; client_email: string; client_locale: string })[];
    for (const r of rows) {
      const until = (r.delivered_at ?? r.created_at) + days * DAY;
      const who = r.client_name || r.client_email;
      const meta = JSON.parse(r.meta || '{}') as Record<string, unknown>;
      if (now >= until) {
        if (this.db.prepare("UPDATE cab_documents SET state = 'expired' WHERE id = ? AND state = 'awaiting_client'").run(r.id).changes !== 1) continue;
        expired++;
        postFromFirTech(this.db, now, r.client_id, r.lead_id, r.client_locale === 'en'
          ? `The proposal ${r.number} has expired. If it is still relevant, write here and we will update it.`
          : `Срок КП ${r.number} истёк. Если предложение ещё актуально, напишите здесь, мы его обновим.`);
        this.d.hq.log('documents', 'quote_expired', 'document', String(r.id));
        await this.d.hq.alert(`КП ${r.number} (${who}) истекло: клиент не ответил за ${days} дн. Продлить: правка КП в ревью-центре (уйдёт клиенту заново) или новое КП.`);
      } else if (now >= until - DAY && meta.expiryWarned !== true) {
        this.db.prepare('UPDATE cab_documents SET meta = ? WHERE id = ?').run(JSON.stringify({ ...meta, expiryWarned: true }), r.id);
        await this.d.hq.alert(`КП ${r.number} (${who}) истекает завтра, клиент его не принял. Напомнить можно в треде заявки (Пульт, чаты).`);
      }
    }
    return expired;
  }

  /** `POST /admin/clients/:id/documents/:docId/sign`: the simple electronic signature; the signed PDF is rendered and the stage-1 invoice is proposed. */
  async sign(clientId: number, docId: number, body: unknown): Promise<DocReply> {
    const c = this.client(clientId);
    const r = this.row(docId);
    if (!c || !r || r.client_id !== clientId) return failR(404, 'not_found');
    const parsed = signBody.safeParse(body ?? {});
    if (!parsed.success) return failR(400, 'invalid');
    if (r.kind !== 'contract' || r.state !== 'awaiting_signature') return failR(409, 'not_awaiting', { state: this.liveState(r) });
    const sig = parseSignature(parsed.data.signaturePng);
    if (!sig.ok) return failR(422, 'bad_signature', { reason: sig.reason });
    const t = this.d.now();
    // a second request in flight signs nothing: the state flips first, once
    if (this.db.prepare("UPDATE cab_documents SET state = 'signed', signed_at = ? WHERE id = ? AND state = 'awaiting_signature'").run(t, r.id).changes !== 1) return failR(409, 'not_awaiting');
    const unsignedSha = r.pdf_sha256 ?? sha(r.body);
    this.db.prepare('INSERT INTO bo_signatures (doc_id, signature_png, name, at, ip, ua, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.id, sig.png, parsed.data.name, t, parsed.data.ip, parsed.data.userAgent, unsignedSha);
    const rendered = await this.renderSigned(this.row(r.id)!);
    if (rendered) this.db.prepare('UPDATE cab_documents SET signed_pdf_rel = ? WHERE id = ?').run(rendered.rel, r.id);
    else this.pdfTriedAt.set(r.id, t);
    const hq = this.d.hq;
    hq.log('client', 'contract_signed', 'document', String(r.id), rendered ? 'pdf' : 'no_pdf');
    // P-12: the signature is stored, the signed copy is not: the owner hears it now, the next read of the documents tries again
    if (!rendered) void hq.alert(`Договор ${r.number} подписан клиентом, но подписанный PDF не собрался (подпись сохранена). Повторю при следующем открытии документов; если не выйдет, проверьте шрифты и папку файлов HQ.`);
    // the owner's next card: the invoice of stage 1 (what the old chain made together with the contract)
    const quote = this.db.prepare("SELECT meta FROM cab_documents WHERE kind = 'quote' AND pack_id IS ? AND client_id = ? ORDER BY id DESC LIMIT 1").get(r.pack_id, clientId) as { meta: string } | undefined;
    const invoice = (JSON.parse(quote?.meta || '{}') as { invoice?: Record<string, unknown>; client?: string });
    if (invoice.invoice && !this.db.prepare("SELECT 1 FROM tasks WHERE json_extract(meta, '$.action') = 'kp_invoice' AND json_extract(meta, '$.packId') IS ? AND json_extract(meta, '$.stageNo') = 1").get(r.pack_id)) {
      hq.createTask({ title: `Счёт этапа 1: ${invoice.client ?? c.name ?? c.email}`, dept: 'support', creator: 'head', priority: 1, meta: { ...invoice.invoice, ...legalMeta(legalPartyOfClient(this.db, c.id)) } });
      hq.wake('support-head', 'task');
    }
    postFromFirTech(this.db, t, c.id, r.lead_id,
      c.locale === 'en' ? 'Contract signed, thank you! The signed copy is in Documents. We are preparing the invoice for the first stage.' : 'Договор подписан, спасибо! Подписанный экземпляр в разделе «Документы». Готовим счёт на первый этап.');
    this.d.notifyOwner(`${c.name || c.email} подписал договор ${r.number}: счёт этапа 1 придёт карточкой на одобрение.`);
    return okR({ pdfUrl: rendered ? await this.pdfUrl(this.row(r.id)!) : null });
  }
}
