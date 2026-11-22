import { errMsg, log, migrate } from '@fir/core';
import type { Hq } from '@fir/hq';
import { z } from 'zod';
import type { ClientMail, MailOutcome } from './client-mail.js';
import { ensureCabinetTables } from './cabinet.js';

/**
 * News and recommendation mailings to cabinet clients (2026-11-23). A mailing is ONLY sent through the approval queue: `POST /admin/campaigns` makes a
 * draft and a Marketing task with an approval of the kind `client_campaign` (`locked`: never promoted to level 1 by the counter, never in «Одобрить все обычные»,
 * the owner reads and approves every text). Only after «Одобрить» `execute` calls `ClientMail.sendCampaign` for each client with the matching consent
 * (`marketing_consent` for news, `recommendations_consent` for recommendations), each letter with the unsubscribe link and `List-Unsubscribe` headers.
 * One approval sends at most once (the row goes `pending` -> `sending` atomically), at most `maxRecipients` letters, and the journal (`cab_campaign_log`)
 * keeps client ids and outcomes only, never texts. Contract: `docs/admin-crm-api.md`, «Рассылки».
 */
export const CAMPAIGN_KIND = 'client_campaign';
export const DEFAULT_MAX_RECIPIENTS = 100;
const ACTOR = 'campaigns';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cab_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  subject_ru TEXT NOT NULL,
  subject_en TEXT NOT NULL,
  text_ru TEXT NOT NULL,
  text_en TEXT NOT NULL,
  segment TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  task_id INTEGER,
  approval_link_id INTEGER,
  counts TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE TABLE IF NOT EXISTS cab_campaign_log (
  campaign_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, client_id)
);
`;

export type CampaignStatus = 'pending' | 'sending' | 'sent' | 'rejected' | 'failed';
export type CampaignKind = 'news' | 'recommendation';

const line = (max: number) => z.string().trim().min(1).max(max).refine((v) => ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127), 'control');
const body = (max: number) => z.string().trim().min(1).max(max);
const bilingual = (schema: z.ZodString) => z.union([schema, z.object({ ru: schema, en: schema.optional() })]);

export const campaignSchema = z.object({
  kind: z.enum(['news', 'recommendation']),
  subject: bilingual(line(150)),
  text: bilingual(body(8000)),
  segment: z.object({ locale: z.enum(['ru', 'en']).optional(), niche: z.string().trim().max(40).optional(), city: z.string().trim().max(80).optional() }).strict().optional(),
}).strict();

export interface Segment { locale?: 'ru' | 'en' | undefined; niche?: string | undefined; city?: string | undefined }

interface Row {
  id: number; kind: CampaignKind; subject_ru: string; subject_en: string; text_ru: string; text_en: string; segment: string; status: CampaignStatus;
  task_id: number | null; approval_link_id: number | null; counts: string; created_at: number; sent_at: number | null;
}

export interface CampaignsDeps {
  hq: Hq;
  mail: ClientMail;
  /** At most this many letters per approval (default 100); the rest are counted as `capped` and not sent. */
  maxRecipients?: number;
}

const pair = (v: string | { ru: string; en?: string | undefined }): { ru: string; en: string } => (typeof v === 'string' ? { ru: v, en: v } : { ru: v.ru, en: v.en ?? v.ru });

export class Campaigns {
  private readonly max: number;

  constructor(private readonly d: CampaignsDeps) {
    ensureCabinetTables(d.hq.db);
    migrate(d.hq.db, SCHEMA);
    this.max = Math.max(1, d.maxRecipients ?? DEFAULT_MAX_RECIPIENTS);
    // `locked`: the owner decides every mailing himself. `urgent`: he made it by hand, so the card goes out at once.
    d.hq.registerKind(CAMPAIGN_KIND, { initialLevel: 0, locked: true, execute: (payload) => this.execute(payload) }, { urgent: true });
    // a rejected mailing is closed (nothing was sent)
    d.hq.onApprovalDecision((link, state) => {
      if (link.kind !== CAMPAIGN_KIND) return;
      if (state === 'rejected') this.setStatus(Number(link.payload.campaignId), 'rejected', 'pending');
    });
    this.recoverStuck();
  }

  /**
   * A mailing left in `sending` by a restart is closed as `failed` (the journal says whom it already reached) and the owner is told. It is not resumed on its own:
   * the owner may have edited the text in the approval card and that text lived only in the interrupted run; a fresh draft is sent to those not yet written to.
   */
  recoverStuck(): number {
    const rows = this.db.prepare("SELECT id FROM cab_campaigns WHERE status = 'sending'").all() as { id: number }[];
    for (const { id } of rows) {
      const counts: Record<string, number> = {};
      for (const l of this.db.prepare('SELECT outcome, COUNT(*) n FROM cab_campaign_log WHERE campaign_id = ? GROUP BY outcome').all(id) as { outcome: string; n: number }[]) counts[l.outcome] = l.n;
      this.db.prepare("UPDATE cab_campaigns SET status = 'failed', counts = ? WHERE id = ? AND status = 'sending'").run(JSON.stringify(counts), id);
      const done = Object.values(counts).reduce((a, b) => a + b, 0);
      this.d.hq.log(ACTOR, 'campaign_interrupted', 'campaign', String(id), `restart during sending, already written to: ${done}`);
      void this.d.hq.alert(`Рассылка #${id} прервалась на перезапуске и закрыта как неудавшаяся: письма получили ${done}. Остальным можно отправить новую рассылку, прежним она не уйдёт повторно.`).catch(() => undefined);
    }
    return rows.length;
  }

  private get db() {
    return this.d.hq.db;
  }

  private row(id: number): Row | undefined {
    return this.db.prepare('SELECT * FROM cab_campaigns WHERE id = ?').get(id) as Row | undefined;
  }

  private setStatus(id: number, to: CampaignStatus, from: CampaignStatus): boolean {
    return this.db.prepare('UPDATE cab_campaigns SET status = ? WHERE id = ? AND status = ?').run(to, id, from).changes === 1;
  }

  /** Client ids that may get this kind of letter now: the consent is on, the segment fits, a site account exists is checked by `sendCampaign`. */
  audience(kind: CampaignKind, seg: Segment): number[] {
    const where = [kind === 'news' ? 'marketing_consent = 1' : 'recommendations_consent = 1'];
    const args: string[] = [];
    if (seg.locale) { where.push('locale = ?'); args.push(seg.locale); }
    if (seg.niche) { where.push('niche = ?'); args.push(seg.niche); }
    if (seg.city) { where.push('lower(city) = lower(?)'); args.push(seg.city); }
    return (this.db.prepare(`SELECT id FROM cab_clients WHERE ${where.join(' AND ')} ORDER BY id`).all(...args) as { id: number }[]).map((r) => r.id);
  }

  /** The draft: validates, stores, makes the task and asks the owner for approval. Nothing is sent. */
  async create(input: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const p = campaignSchema.safeParse(input);
    if (!p.success) return { status: 400, body: { ok: false, error: 'invalid' } };
    const seg: Segment = p.data.segment ?? {};
    const audience = this.audience(p.data.kind, seg).length;
    if (audience === 0) return { status: 422, body: { ok: false, error: 'no_recipients' } };
    const subject = pair(p.data.subject);
    const text = pair(p.data.text);
    const id = Number(this.db.prepare(
      'INSERT INTO cab_campaigns (kind, subject_ru, subject_en, text_ru, text_en, segment, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(p.data.kind, subject.ru, subject.en, text.ru, text.en, JSON.stringify(seg), 'pending', this.d.hq.now()).lastInsertRowid);
    const task = this.d.hq.createTask({ title: `Рассылка #${id}: ${p.data.kind === 'news' ? 'новости' : 'рекомендации'}`, body: `Получателей по согласию: ${audience}`, dept: 'marketing', creator: 'owner', meta: { action: 'client_campaign', campaignId: id } });
    this.d.hq.setStatus(task.id, 'running', ACTOR);
    const summary = `Рассылка клиентам (${p.data.kind === 'news' ? 'новости' : 'рекомендации'}): «${subject.ru.slice(0, 80)}», получателей до ${Math.min(audience, this.max)} из ${audience}`;
    try {
      const linkId = await this.d.hq.requestApproval(task.id, ACTOR, CAMPAIGN_KIND, { text: text.ru, campaignId: id }, summary);
      this.db.prepare('UPDATE cab_campaigns SET task_id = ?, approval_link_id = ? WHERE id = ?').run(task.id, linkId, id);
    } catch (e) {
      this.setStatus(id, 'failed', 'pending');
      this.d.hq.block(task.id, ACTOR, `Не удалось отправить на одобрение: ${errMsg(e)}`.slice(0, 300));
      return { status: 500, body: { ok: false, error: 'approval_failed' } };
    }
    return { status: 200, body: { ok: true, campaign: this.view(this.row(id)!), audience } };
  }

  /** Runs only after the owner's «Одобрить». Claims the row first: a second run of the same approval does nothing. */
  async execute(payload: { text?: string; campaignId?: unknown }): Promise<void> {
    const id = Number(payload.campaignId);
    const c = Number.isInteger(id) ? this.row(id) : undefined;
    if (!c) throw new Error('campaign not found');
    if (!this.setStatus(id, 'sending', 'pending')) {
      log('warn', 'campaign already sent or closed', { campaignId: id, status: c.status });
      return;
    }
    // the owner may have edited the Russian text in the approval card
    const ru = typeof payload.text === 'string' && payload.text.trim() ? payload.text.trim() : c.text_ru;
    const en = ru === c.text_ru ? c.text_en : c.text_en === c.text_ru ? ru : c.text_en;
    const notice = { subject: { ru: c.subject_ru, en: c.subject_en }, text: { ru, en } };
    const ids = this.audience(c.kind, JSON.parse(c.segment) as Segment);
    const counts: Record<string, number> = {};
    const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
    const mark = this.db.prepare('INSERT OR IGNORE INTO cab_campaign_log (campaign_id, client_id, outcome, at) VALUES (?, ?, ?, ?)');
    try {
      for (const [i, clientId] of ids.entries()) {
        if (i >= this.max) { bump('capped'); continue; }
        // a client written to for this mailing is never written to again (a retry after a crash)
        if (this.db.prepare('SELECT 1 FROM cab_campaign_log WHERE campaign_id = ? AND client_id = ?').get(id, clientId)) { bump('already'); continue; }
        const outcome: MailOutcome = await this.d.mail.sendCampaign(clientId, c.kind, notice, `рассылка #${id}`);
        mark.run(id, clientId, outcome, this.d.hq.now());
        bump(outcome);
      }
    } catch (e) {
      // sendCampaign never throws; this is a bug guard: the row is closed, nothing is retried by itself
      this.db.prepare("UPDATE cab_campaigns SET status = 'failed', counts = ? WHERE id = ?").run(JSON.stringify(counts), id);
      throw e;
    }
    this.db.prepare("UPDATE cab_campaigns SET status = 'sent', counts = ?, sent_at = ? WHERE id = ?").run(JSON.stringify(counts), this.d.hq.now(), id);
    log('info', 'campaign sent', { campaignId: id, ...counts });
    this.d.hq.log(ACTOR, 'campaign_sent', 'campaign', String(id), `email ${counts.email ?? 0}, no_consent ${counts.no_consent ?? 0}, failed ${counts.failed ?? 0}, capped ${counts.capped ?? 0}`);
  }

  private view(r: Row) {
    const link = r.approval_link_id ? this.d.hq.approvalLink(r.approval_link_id) : undefined;
    return {
      id: r.id, kind: r.kind, subject: { ru: r.subject_ru, en: r.subject_en }, segment: JSON.parse(r.segment) as Segment, status: r.status,
      taskId: r.task_id, approvalId: link?.approvalId ?? null, counts: JSON.parse(r.counts) as Record<string, number>,
      createdAt: new Date(r.created_at).toISOString(), sentAt: r.sent_at === null ? null : new Date(r.sent_at).toISOString(),
    };
  }

  list(): { items: ReturnType<Campaigns['view']>[] } {
    return { items: (this.db.prepare('SELECT * FROM cab_campaigns ORDER BY id DESC LIMIT 200').all() as Row[]).map((r) => this.view(r)) };
  }

  /** One mailing with the journal: client ids and outcomes (never texts, never addresses). */
  detail(id: number): { status: number; body: Record<string, unknown> } {
    const r = this.row(id);
    if (!r) return { status: 404, body: { ok: false, error: 'not_found' } };
    const log = this.db.prepare('SELECT client_id, outcome, at FROM cab_campaign_log WHERE campaign_id = ? ORDER BY client_id LIMIT 2000').all(id) as { client_id: number; outcome: string; at: number }[];
    return { status: 200, body: { ok: true, campaign: this.view(r), log: log.map((l) => ({ clientId: l.client_id, outcome: l.outcome, at: new Date(l.at).toISOString() })) } };
  }

  async handle(method: string, seg: string[], body: unknown): Promise<{ status: number; body: Record<string, unknown> } | null> {
    if (seg.length === 0 && method === 'GET') return { status: 200, body: { ok: true, ...this.list() } };
    if (seg.length === 0 && method === 'POST') return this.create(body);
    if (seg.length === 1 && method === 'GET' && /^\d{1,12}$/.test(seg[0]!)) return this.detail(Number(seg[0]));
    return null;
  }
}
