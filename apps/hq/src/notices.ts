import { errMsg, escapeHtml, log, migrate, productName, zonedParts, type Db } from '@fir/core';
import type { AlertKind, AlertOpts, Hq } from '@fir/hq';
import type { PultLinks, PultScreen } from './links.js';
import { kindRu } from './tg.js';

/**
 * The reminders of the one HQ bot (owner 2026-11-22: «в Telegram только напоминания: новый клиент, новая заявка, документ на одобрение; мало
 * инфы, только основное, никаких функций»). Each event is one or two lines and one link into the Пульт; names of clients may be there, contacts and
 * texts of clients never (the log rule carried over to Telegram).
 *
 * Where the events come from: `scan()` reads the tables every 30 seconds (`dueTick`) and notes what is new by a key (`ref`), so every path that
 * writes them (the site, the cabinet, the bots, the Пульт, the payment watch) is covered and a restart repeats nothing; alerts are pushed by the
 * Director (`alert`). Grouping: one message in 5 minutes per type (payments, alerts and summaries go at once); in the owner's quiet hours nothing goes,
 * the night's notices become one line of the morning summary (`takeNight`). At the desk (the site open) a notice is skipped: the inbox shows it.
 */

export type NoticeType = 'client' | 'lead' | 'approval' | 'payment' | 'stage_ready' | 'stage_accepted' | 'signed' | 'call' | 'human' | 'chat' | 'alert' | 'summary';
export const NOTICE_TYPES: readonly NoticeType[] = ['client', 'lead', 'approval', 'payment', 'stage_ready', 'stage_accepted', 'signed', 'call', 'human', 'chat', 'alert', 'summary'];
/** The switch of a type in the settings (`notice.<name>`): the two stage types share one. Summaries are not switchable. */
const SWITCH: Partial<Record<NoticeType, string>> = { client: 'client', lead: 'lead', approval: 'approval', payment: 'payment', stage_ready: 'stage', stage_accepted: 'stage', signed: 'signed', call: 'call', human: 'human', chat: 'chat' };

/** Alerts that are reminders (Telegram); the rest stay in the Пульт and count in the morning line. */
export const TG_ALERT_KINDS: ReadonlySet<AlertKind> = new Set<AlertKind>(['lost_lead', 'email_failed', 'llm', 'budget', 'service']);

const UNGROUPED: ReadonlySet<NoticeType> = new Set<NoticeType>(['payment', 'human', 'alert', 'summary']);
export const GROUP_MS = 5 * 60_000;
const WINDOW_MS = 3 * 86_400_000;
const KEEP_MS = 30 * 86_400_000;
const NIGHT_STALE_MS = 12 * 3_600_000;
const MAX_ATTEMPTS = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owner_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  ref TEXT UNIQUE,
  text TEXT NOT NULL,
  link TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'queued',
  night INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS owner_notices_open ON owner_notices (state, type, id);
`;

/** The words of a group of notices of one type («Новые заявки: 3»). */
const GROUP_RU: Record<NoticeType, [string, PultScreen]> = {
  client: ['Новые клиенты в кабинете', 'clients'],
  lead: ['Новые заявки', 'leads'],
  approval: ['На одобрение', 'review'],
  payment: ['Оплаты', 'money'],
  stage_ready: ['Этапы готовы к приёмке', 'projects'],
  stage_accepted: ['Этапы приняты', 'projects'],
  signed: ['Договоры подписаны', 'projects'],
  call: ['Созвоны забронированы', 'calls'],
  human: ['Клиенты просят человека', 'chats'],
  chat: ['Сообщения клиентов', 'chats'],
  alert: ['Алерты', 'company'],
  summary: ['Сводки', 'home'],
};
/** The night line of the morning summary. */
const NIGHT_RU: Record<NoticeType, string> = {
  client: 'новых клиентов', lead: 'заявок', approval: 'на одобрение', payment: 'оплат', stage_ready: 'этапов к приёмке', stage_accepted: 'этапов принято',
  signed: 'подписей договоров', call: 'созвонов', human: 'просьб позвать человека', chat: 'сообщений клиентов', alert: 'алертов', summary: 'сводок',
};
const SOURCE_RU: Record<string, string> = {
  site: 'сайт', form: 'сайт', lead: 'сайт', web: 'веб-чат', chat: 'веб-чат', telegram: 'Telegram', bot: 'Telegram', cabinet: 'кабинет', builder: 'сборка проекта',
  audit: 'аудит', referral: 'рекомендация', owner: 'вручную', prospector: 'Разведчик',
};

/** Phones, emails and handles never reach Telegram, even inside an alert written elsewhere. */
export function noContacts(s: string): string {
  return s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[контакт]')
    .replace(/(^|[\s(,:])@[A-Za-z][A-Za-z0-9_]{3,31}\b/g, '$1[контакт]')
    .replace(/t\.me\/[A-Za-z0-9_+]+/g, '[контакт]')
    // a phone: 7+ digits written with + or spaces, or 9+ digits in a row; an invoice number (FT-2026-014) or a date (2026-11-22) is not one
    .replace(/(?<![\w-])\+?\d[\d\s().-]{5,}\d(?![\w-])/g, (m) => {
      const digits = m.match(/\d/g)?.length ?? 0;
      return digits >= 7 && (m.startsWith('+') || /[\s()]/.test(m) || digits >= 9) ? '[контакт]' : m;
    });
}

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** One event a detector found: its notice and the short label for a group line. */
interface Found { type: NoticeType; ref: string; text: string; link: string; label: string }

interface Row { id: number; at: number; type: NoticeType; ref: string | null; text: string; link: string; label: string; state: string; night: number; attempts: number; sent_at: number | null }

export interface NoticeDeps {
  hq: Hq;
  links: PultLinks;
  /** The Telegram side: the owner channel's `notice` (skips at the desk). */
  deliver: (html: string) => Promise<'sent' | 'desk' | 'capture'>;
}

export class OwnerNotices {
  private readonly db: Db;
  private flushing: Promise<number> | null = null;

  constructor(private readonly d: NoticeDeps) {
    this.db = d.hq.db;
    migrate(this.db, SCHEMA);
  }

  private get now(): number {
    return this.d.hq.now();
  }

  /** The owner's switches (settings): a type switched off is recorded as `muted` (never sent, never replayed when it is switched on again). */
  private enabled(type: NoticeType): boolean {
    const name = SWITCH[type];
    return name === undefined || this.d.hq.setting(`notice.${name}`) !== '0';
  }

  /** The grouping window in ms (`notice.group_min`, default 5 minutes; 0: every notice alone). */
  private groupMs(): number {
    const raw = this.d.hq.setting('notice.group_min');
    const n = raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n * 60_000 : GROUP_MS;
  }

  // ---- in ----
  /** Queues one notice (a `ref` already seen is ignored). Payments, alerts and summaries go out at once. Returns whether it was new. */
  async push(type: NoticeType, text: string, link: string, ref?: string): Promise<boolean> {
    const muted = !this.enabled(type);
    const r = this.db
      .prepare('INSERT OR IGNORE INTO owner_notices (at, type, ref, text, link, night, state) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(this.now, type, ref ?? null, type === 'summary' ? text.slice(0, 1500) : oneLine(noContacts(text), 400), link, type !== 'summary' && this.d.hq.isQuiet() ? 1 : 0, muted ? 'muted' : 'queued');
    if (!r.changes) return false;
    if (muted) return true;
    if (UNGROUPED.has(type)) await this.flush();
    return true;
  }

  /** An alert from `hq.alert` (through the Director): the reminder kinds only; the rest stays in the Пульт. */
  async alert(text: string, o: AlertOpts = {}): Promise<boolean> {
    if (!TG_ALERT_KINDS.has(o.kind ?? 'other')) return false;
    if (this.d.hq.setting(`notice.alert.${o.kind ?? 'other'}`) === '0') return false;
    const line = o.short?.trim() || text.split('\n')[0]!;
    return this.push('alert', line, this.d.links.to(o.kind === 'lost_lead' ? 'leads' : o.kind === 'email_failed' ? 'chats' : 'company'));
  }

  // ---- out ----
  /** Sends what is due. Safe to call often; one flush at a time. Returns how many notices went out (or were skipped at the desk). */
  flush(): Promise<number> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async doFlush(): Promise<number> {
    const now = this.now;
    const quiet = this.d.hq.isQuiet();
    // the night starts: what is still waiting goes to the morning summary (a summary itself is never held)
    if (quiet) this.db.prepare("UPDATE owner_notices SET night = 1 WHERE state = 'queued' AND night = 0 AND type != 'summary'").run();
    // a night notice nobody summarised (the summary did not run): it goes as a day one after 12 hours
    else this.db.prepare("UPDATE owner_notices SET night = 0 WHERE state = 'queued' AND night = 1 AND at < ?").run(now - NIGHT_STALE_MS);
    const rows = (this.db.prepare("SELECT * FROM owner_notices WHERE state = 'queued' AND night = 0 ORDER BY id").all() as Row[]).filter((r) => !quiet || r.type === 'summary');
    let done = 0;
    for (const type of NOTICE_TYPES) {
      const mine = rows.filter((r) => r.type === type);
      if (!mine.length) continue;
      if (UNGROUPED.has(type)) {
        for (const r of mine) done += await this.send([r], r.text, r.link);
        continue;
      }
      const last = (this.db.prepare("SELECT MAX(sent_at) m FROM owner_notices WHERE type = ? AND state IN ('sent','desk')").get(type) as { m: number | null }).m;
      if (last !== null && now - last < this.groupMs()) continue;
      if (mine.length === 1) done += await this.send(mine, mine[0]!.text, mine[0]!.link);
      else {
        const [title, screen] = GROUP_RU[type];
        const names = mine.map((r) => r.label || this.short(r.text)).filter(Boolean);
        const list = names.slice(0, 4).join('; ');
        done += await this.send(mine, `${title}: ${mine.length}${list ? ` (${list}${names.length > 4 ? '; …' : ''})` : ''}.`, this.d.links.to(screen));
      }
    }
    if (done) this.db.prepare('DELETE FROM owner_notices WHERE at < ?').run(now - KEEP_MS);
    return done;
  }

  /** The part of a notice text after its «Что:» lead, for a group line. */
  private short(text: string): string {
    const i = text.indexOf(': ');
    return oneLine((i > 0 ? text.slice(i + 2) : text).replace(/\.$/, ''), 60);
  }

  private async send(rows: Row[], text: string, link: string): Promise<number> {
    const ids = rows.map((r) => r.id);
    const html = `${escapeHtml(text)}${link && !text.includes(link) ? `\n${escapeHtml(link)}` : ''}`;
    const mark = (state: string) => this.db.prepare(`UPDATE owner_notices SET state = ?, sent_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(state, this.now, ...ids);
    try {
      const r = await this.d.deliver(html);
      mark(r === 'sent' ? 'sent' : 'desk');
      return rows.length;
    } catch (e) {
      this.db.prepare(`UPDATE owner_notices SET attempts = attempts + 1, state = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE state END WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      log('warn', 'owner notice not delivered', { type: rows[0]!.type, count: rows.length, err: errMsg(e) });
      return 0;
    }
  }

  /** The night's notices as one line of the morning summary (they are marked, never sent one by one). Null: a quiet night. */
  takeNight(): string | null {
    const rows = this.db.prepare("SELECT id, type, text FROM owner_notices WHERE state = 'queued' AND night = 1 AND type != 'summary' ORDER BY id").all() as { id: number; type: NoticeType; text: string }[];
    if (!rows.length) return null;
    this.db.prepare(`UPDATE owner_notices SET state = 'summary', sent_at = ? WHERE id IN (${rows.map(() => '?').join(',')})`).run(this.now, ...rows.map((r) => r.id));
    const parts = NOTICE_TYPES.map((t) => [t, rows.filter((r) => r.type === t).length] as const).filter(([, n]) => n > 0).map(([t, n]) => `${NIGHT_RU[t]} ${n}`);
    const alerts = rows.filter((r) => r.type === 'alert').slice(0, 3).map((r) => oneLine(r.text, 120));
    return `За ночь: ${parts.join(', ')}.${alerts.length ? ` Алерты: ${alerts.join('; ')}.` : ''}`;
  }

  /** What is still waiting (tests, the drill). */
  queued(): { type: NoticeType; text: string; night: boolean }[] {
    return (this.db.prepare("SELECT type, text, night FROM owner_notices WHERE state = 'queued' ORDER BY id").all() as { type: NoticeType; text: string; night: number }[])
      .map((r) => ({ type: r.type, text: r.text, night: r.night === 1 }));
  }

  // ---- the scan of the tables ----
  private has(table: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  }

  private cols(table: string): Set<string> {
    return new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  }

  /**
   * Finds the new events and queues their notices, then flushes. The first scan of a database only marks what exists (a deploy does not replay
   * the last three days). Never throws: a failed detector is a warn line and the others run.
   */
  async scan(): Promise<number> {
    const seeding = this.d.hq.setting('notices.seeded') !== '1';
    const since = this.now - WINDOW_MS;
    const found: Found[] = [];
    const detectors: [string, () => void][] = [
      ['clients', () => this.clients(since, found)],
      ['leads', () => this.leads(since, found)],
      ['approvals', () => this.approvals(since, found)],
      ['payments', () => this.payments(since, found)],
      ['stages', () => this.stages(since, found)],
      ['signatures', () => this.signatures(since, found)],
      ['calls', () => this.calls(found)],
    ];
    for (const [name, run] of detectors) {
      try {
        run();
      } catch (e) {
        log('warn', 'notice scan failed', { detector: name, err: errMsg(e) });
      }
    }
    let n = 0;
    if (seeding) {
      const ins = this.db.prepare("INSERT OR IGNORE INTO owner_notices (at, type, ref, text, link, state) VALUES (?, ?, ?, ?, ?, 'seeded')");
      for (const f of found) ins.run(this.now, f.type, f.ref, '', '');
      this.d.hq.setSetting('notices.seeded', '1');
      return 0;
    }
    for (const f of found) {
      const muted = !this.enabled(f.type);
      const r = this.db.prepare('INSERT OR IGNORE INTO owner_notices (at, type, ref, text, link, label, night, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(this.now, f.type, f.ref, oneLine(noContacts(f.text), 400), f.link, oneLine(noContacts(f.label), 60), this.d.hq.isQuiet() ? 1 : 0, muted ? 'muted' : 'queued');
      if (!muted) n += r.changes;
    }
    await this.flush();
    return n;
  }

  private drillTask = (taskId: number | null | undefined): boolean => {
    if (!taskId) return false;
    const t = this.db.prepare('SELECT tags FROM tasks WHERE id = ?').get(taskId) as { tags: string } | undefined;
    return Boolean(t && `,${t.tags},`.includes(',drill,'));
  };

  private clients(since: number, out: Found[]): void {
    if (!this.has('cab_clients')) return;
    const rows = this.db.prepare('SELECT id, name, created_at FROM cab_clients WHERE created_at >= ? ORDER BY id').all(since) as { id: number; name: string }[];
    for (const r of rows) {
      const name = r.name.trim() || `клиент #${r.id}`;
      out.push({ type: 'client', ref: `client:${r.id}`, text: `Новый клиент в кабинете: ${name}.`, link: this.d.links.to('clients'), label: name });
    }
  }

  private leads(since: number, out: Found[]): void {
    if (!this.has('li_leads')) return;
    const c = this.cols('li_leads');
    const rows = this.db.prepare(`SELECT id, task_id, name, origin, niche, service${c.has('enrichment') ? ', enrichment' : ''} FROM li_leads WHERE created_at >= ? ORDER BY id`).all(since) as
      { id: number; task_id: number; name: string; origin: string; niche: string; service: string; enrichment?: string | null }[];
    for (const r of rows) {
      if (this.drillTask(r.task_id)) continue;
      let family = '';
      let niche = r.niche;
      try {
        const e = r.enrichment ? (JSON.parse(r.enrichment) as { productFamily?: string; niche?: string }) : {};
        family = str(e.productFamily);
        niche ||= str(e.niche);
      } catch { /* no enrichment */ }
      const product = family ? productName(family, 'ru') : r.service ? productName(r.service, 'ru') : '';
      const parts = [SOURCE_RU[r.origin] ?? r.origin, niche, product].map((x) => x.trim()).filter(Boolean);
      const who = r.name.trim() ? ` «${oneLine(r.name, 40)}»` : '';
      out.push({ type: 'lead', ref: `lead:${r.id}`, text: `Новая заявка #${r.id}${who}: ${parts.join(', ') || 'без деталей'}.`, link: this.d.links.to('lead', r.id), label: `#${r.id}${who}` });
    }
  }

  private clientOf(payload: Record<string, unknown>): string {
    for (const k of ['client', 'clientName', 'business', 'company', 'referred', 'name']) {
      const v = str(payload[k]);
      if (v) return oneLine(v, 40);
    }
    const leadId = typeof payload.leadId === 'number' ? payload.leadId : null;
    if (leadId !== null && this.has('li_leads')) {
      const l = this.db.prepare('SELECT name FROM li_leads WHERE id = ?').get(leadId) as { name: string } | undefined;
      if (l?.name.trim()) return oneLine(l.name, 40);
    }
    const projectId = typeof payload.projectId === 'number' ? payload.projectId : null;
    if (projectId !== null && this.has('pm_projects')) {
      const p = this.db.prepare('SELECT client FROM pm_projects WHERE id = ?').get(projectId) as { client: string } | undefined;
      if (p?.client.trim()) return oneLine(p.client, 40);
    }
    return '';
  }

  private approvals(since: number, out: Found[]): void {
    const held = this.cols('task_approvals').has('held');
    const rows = this.db.prepare(`SELECT id, task_id, kind, payload FROM task_approvals WHERE created_at >= ? AND state IN ('queued','asked') AND kind != 'content_item'${held ? ' AND held = 0' : ''} ORDER BY id`).all(since) as
      { id: number; task_id: number; kind: string; payload: string }[];
    for (const r of rows) {
      if (this.drillTask(r.task_id)) continue;
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(r.payload) as Record<string, unknown>; } catch { /* keep empty */ }
      const client = this.clientOf(payload);
      out.push({ type: 'approval', ref: `approval:${r.id}`, text: `На одобрение: ${kindRu(r.kind)}${client ? `, ${client}` : ''}.`, link: this.d.links.to('review', r.id), label: `${kindRu(r.kind)}${client ? ` ${client}` : ''}` });
    }
  }

  private payments(since: number, out: Found[]): void {
    if (!this.has('bl_invoices')) return;
    const c = this.cols('bl_invoices');
    const rows = this.db.prepare(`SELECT id, number, client, amount_usd${c.has('stage_no') ? ', stage_no' : ''} FROM bl_invoices WHERE status = 'paid' AND paid_at >= ? ORDER BY id`).all(since) as
      { id: number; number: string; client: string; amount_usd: number; stage_no?: number | null }[];
    for (const r of rows) {
      const stage = r.stage_no ? `, этап ${r.stage_no}` : '';
      out.push({ type: 'payment', ref: `paid:${r.id}`, text: `Оплата пришла: ${oneLine(r.client, 40)}${stage}, ${money(r.amount_usd)} (счёт ${r.number}).`, link: this.d.links.to('money', r.number), label: r.number });
    }
  }

  private stages(since: number, out: Found[]): void {
    if (!this.has('pm_milestones') || !this.has('pm_projects')) return;
    const rows = this.db.prepare(`SELECT m.id, m.project_id, m.stage_no, m.status, m.done_at, m.accepted_at, p.client FROM pm_milestones m JOIN pm_projects p ON p.id = m.project_id
      WHERE m.kind = 'stage' AND ((m.status = 'done' AND m.accepted_at IS NULL AND m.done_at >= ?) OR m.accepted_at >= ?) ORDER BY m.id`).all(since, since) as
      { id: number; project_id: number; stage_no: number | null; status: string; done_at: number | null; accepted_at: number | null; client: string }[];
    for (const r of rows) {
      const no = r.stage_no ?? '?';
      const label = `${oneLine(r.client, 40)}, этап ${no}`;
      if (r.accepted_at !== null) out.push({ type: 'stage_accepted', ref: `accepted:${r.id}`, text: `Этап ${no} принят: ${oneLine(r.client, 40)} (проект #${r.project_id}).`, link: this.d.links.to('project', r.project_id), label });
      else out.push({ type: 'stage_ready', ref: `ready:${r.id}`, text: `Этап ${no} готов к приёмке: ${oneLine(r.client, 40)} (проект #${r.project_id}).`, link: this.d.links.to('project', r.project_id), label });
    }
  }

  private signatures(since: number, out: Found[]): void {
    if (!this.has('bo_signatures') || !this.has('cab_documents')) return;
    const rows = this.db.prepare(`SELECT s.id, d.number, d.project_id, c.name FROM bo_signatures s JOIN cab_documents d ON d.id = s.doc_id LEFT JOIN cab_clients c ON c.id = d.client_id
      WHERE s.at >= ? ORDER BY s.id`).all(since) as { id: number; number: string; project_id: number | null; name: string | null }[];
    for (const r of rows) {
      const who = oneLine(r.name?.trim() || 'клиент', 40);
      out.push({ type: 'signed', ref: `signed:${r.id}`, text: `Договор подписан: ${who}${r.number ? ` (${r.number})` : ''}.`, link: r.project_id ? this.d.links.to('project', r.project_id) : this.d.links.to('projects'), label: who });
    }
  }

  private calls(out: Found[]): void {
    if (!this.has('li_leads')) return;
    const rows = this.db.prepare('SELECT id, task_id, name, chosen_slot FROM li_leads WHERE chosen_slot IS NOT NULL AND chosen_slot >= ? ORDER BY id').all(this.now - 3_600_000) as
      { id: number; task_id: number; name: string; chosen_slot: number }[];
    for (const r of rows) {
      if (this.drillTask(r.task_id)) continue;
      const p = zonedParts(r.chosen_slot, this.d.hq.ownerTz);
      const when = `${String(p.d).padStart(2, '0')}.${String(p.mo).padStart(2, '0')} ${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
      const who = oneLine(r.name.trim() || `заявка #${r.id}`, 40);
      out.push({ type: 'call', ref: `call:${r.id}:${r.chosen_slot}`, text: `Созвон забронирован: ${who}, ${when} (ваше время).`, link: this.d.links.to('lead', r.id), label: `${who} ${when}` });
    }
  }
}
