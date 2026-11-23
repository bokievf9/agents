import type { Db } from '@fir/core';
import { log, errMsg } from '@fir/core';
import type { Hq } from '@fir/hq';
import { stageState } from '@fir/worker-project-manager';
import { addCabMessage, ensureCabinetTables } from './cabinet.js';
import type { ClientMail, MailOutcome } from './client-mail.js';
import { StageContext, type LeadStageRow, type Stage } from './lead-stage.js';

/**
 * The client's journey after a lead (owner 2026-11-24: «клиент не знает, что делать после заявки»). One pure derivation from what already exists (stage,
 * documents, invoices, milestones, the «legal entity not registered yet» switch `payments.enabled`) gives the client (a) where the project is, (b) what happens
 * next and when, (c) what he does now, (d) where the answer arrives. Added to the cabinet payloads next to the old `nextStep`/`nextAction`. Contract: `docs/admin-crm-api.md`, «Journey».
 * The same module sends the Fira welcome line and the email «Заявка получена» once per lead and the notice of the transitions that no document email covers.
 */
export const JOURNEY_STAGES = ['received', 'reviewing', 'quote', 'contract', 'invoice', 'paid', 'start', 'stages', 'done', 'lost'] as const;
export type JourneyStage = (typeof JOURNEY_STAGES)[number];
export interface Bi { ru: string; en: string }
export type ActionKind = 'accept_quote' | 'sign' | 'pay' | 'accept_stage' | 'answer' | 'none';
export interface Journey {
  stage: JourneyStage;
  since: string;
  eta?: string;
  etaText?: Bi;
  clientAction?: { kind: ActionKind; href?: string; label?: Bi };
  answersWhere: string[];
  nextWeWill: Bi;
  /** «этап k из N» while the project runs. */
  stageOf?: { no: number; total: number };
}

const DAY = 86_400_000;
export const PAYMENTS_SETTING = 'payments.enabled';
export const paymentsEnabled = (hq: Pick<Hq, 'setting'>): boolean => hq.setting(PAYMENTS_SETTING) === '1';

export interface DocLine { id: number; state: string; deliveredAt: number | null; acceptedAt: number | null; signedAt: number | null; createdAt: number }
export interface StageIn { stageNo: number; state: 'awaiting_payment' | 'in_progress' | 'awaiting_acceptance' | 'accepted'; title: string | null; dueAt: number | null; paidAt: number | null; acceptedAt: number | null; payUrl: string | null }
export interface JourneyInput {
  now: number;
  leadCreatedAt: number;
  leadStage: Stage;
  managerRepliedAt: number | null;
  quote: DocLine | null;
  contract: DocLine | null;
  invoice: DocLine | null;
  stages: StageIn[];
  /** `pm_projects.status` of the lead's project, null when there is none. */
  projectStatus: string | null;
  /** A paid invoice of the lead without milestones (an older project). */
  paidAt: number | null;
  paymentsEnabled: boolean;
  telegram: boolean;
}

/** `n` working days after `ms` (Saturday and Sunday skipped, UTC days: the promise is «3 рабочих дня», not an hour). */
export function addWorkdays(ms: number, n: number): number {
  let t = ms;
  let left = n;
  while (left > 0) {
    t += DAY;
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) left--;
  }
  return t;
}

const iso = (ms: number) => new Date(ms).toISOString();
const DOCS = '/cabinet?tab=documents';
const docHref = (id: number | null) => (id === null ? DOCS : `${DOCS}&doc=${id}`);
const ACTION_LABEL: Record<Exclude<ActionKind, 'none'>, Bi> = {
  accept_quote: { ru: 'Открыть КП и принять', en: 'Open the proposal and accept' },
  sign: { ru: 'Прочитать и подписать договор', en: 'Read and sign the contract' },
  pay: { ru: 'Оплатить этап', en: 'Pay the stage' },
  accept_stage: { ru: 'Принять этап', en: 'Accept the stage' },
  answer: { ru: 'Написать менеджеру', en: 'Write to the manager' },
};
const action = (kind: Exclude<ActionKind, 'none'>, href: string): Journey['clientAction'] => ({ kind, href, label: ACTION_LABEL[kind] });
const NO_ACTION: Journey['clientAction'] = { kind: 'none' };

/** The one derivation. Never throws, never reads the database. */
export function deriveJourney(i: JourneyInput): Journey {
  const answersWhere = ['cabinet', 'email', ...(i.telegram ? ['telegram'] : [])];
  const mk = (stage: JourneyStage, since: number, nextWeWill: Bi, extra: Partial<Journey> = {}): Journey => ({ stage, since: iso(since), clientAction: NO_ACTION, answersWhere, nextWeWill, ...extra });
  const first = i.stages[0];
  const paidAt = first?.paidAt ?? i.paidAt ?? (i.invoice?.state === 'paid' ? i.invoice.acceptedAt ?? i.invoice.createdAt : null);
  const firstPaid = paidAt !== null || i.leadStage === 'paid' || i.leadStage === 'project';

  if (i.leadStage === 'lost' && !firstPaid) return mk('lost', i.now, { ru: 'Заявка закрыта. Если задача осталась, напишите менеджеру проекта, вернёмся к ней.', en: 'The request is closed. If the task is still on, write to the project manager and we will pick it up.' }, { clientAction: action('answer', '/cabinet?tab=messages') });

  if (i.projectStatus === 'done' || (i.stages.length > 0 && i.stages.every((s) => s.state === 'accepted'))) {
    const at = Math.max(0, ...i.stages.map((s) => s.acceptedAt ?? 0)) || i.now;
    return mk('done', at, { ru: 'Проект завершён. Мы остаёмся на связи в разделе «Сообщения».', en: 'The project is complete. We stay in touch in Messages.' });
  }

  if (firstPaid) {
    const at = paidAt ?? i.now;
    const startAt = addWorkdays(at, 3);
    const projectOn = i.projectStatus !== null && i.projectStatus !== 'draft';
    if (!projectOn) {
      return mk('paid', at, { ru: 'Оплата получена. Назначаем дату старта и готовим задачи первого этапа.', en: 'Payment received. We are setting the start date and preparing the first stage.' }, {
        eta: iso(startAt), etaText: { ru: 'Старт через 3 рабочих дня после оплаты', en: 'We start 3 working days after payment' },
      });
    }
    if (i.now < startAt) {
      return mk('start', at, { ru: 'Готовим старт: собираем материалы и план первого этапа.', en: 'We are preparing the start: collecting materials and the plan of the first stage.' }, {
        eta: iso(startAt), etaText: { ru: `Старт ${new Date(startAt).toISOString().slice(0, 10)}`, en: `Start on ${new Date(startAt).toISOString().slice(0, 10)}` },
      });
    }
    const cur = i.stages.find((s) => s.state !== 'accepted');
    const total = i.stages.length;
    const stageOf = cur && total ? { no: cur.stageNo, total } : undefined;
    const label = cur ? `${cur.stageNo}/${total}${cur.title ? `: ${cur.title}` : ''}` : '';
    const eta = cur?.dueAt ? { eta: iso(cur.dueAt) } : {};
    const base = { ...(stageOf ? { stageOf } : {}), ...eta };
    if (cur?.state === 'awaiting_acceptance') {
      return mk('stages', startAt, { ru: `Этап ${label} готов. Посмотрите результат и примите его, на приёмку 7 дней.`, en: `Stage ${label} is ready. Review the result and accept it, you have 7 days.` }, {
        ...base, etaText: { ru: 'Приёмка 7 дней', en: '7 days to accept' }, clientAction: action('accept_stage', '/cabinet?tab=projects'),
      });
    }
    if (cur?.state === 'awaiting_payment') {
      const can = i.paymentsEnabled && cur.payUrl;
      return mk('stages', startAt, { ru: `Этап ${label}: готовим счёт или ждём оплаты, затем начинаем работу.`, en: `Stage ${label}: we are preparing the invoice or waiting for payment, then we start.` }, { ...base, ...(can ? { clientAction: action('pay', cur.payUrl!) } : {}) });
    }
    return mk('stages', startAt, { ru: `Работаем над этапом ${label}. Когда он будет готов, пришлём на приёмку.`, en: `We are working on stage ${label}. When it is ready you will get it to accept.` }, { ...base, etaText: { ru: 'Приёмка 7 дней после готовности', en: '7 days to accept once ready' } });
  }

  const inv = i.invoice;
  const awaitingPay = first && first.state === 'awaiting_payment' && first.payUrl;
  if (inv && inv.state === 'issued' || awaitingPay) {
    const since = inv?.deliveredAt ?? inv?.createdAt ?? i.now;
    if (!i.paymentsEnabled) {
      return mk('invoice', since, { ru: 'Счёт на этап 1 выставлен. Оплату откроем после регистрации юрлица, вас уведомим.', en: 'The invoice for stage 1 is issued. We will open payment after our legal entity is registered and let you know.' }, {
        etaText: { ru: 'Оплату откроем после регистрации юрлица, уведомим', en: 'Payment opens after our legal entity is registered; we will notify you' },
      });
    }
    return mk('invoice', since, { ru: 'Счёт на этап 1 выставлен. После оплаты старт через 3 рабочих дня.', en: 'The invoice for stage 1 is issued. After payment we start in 3 working days.' }, {
      etaText: { ru: 'После оплаты старт через 3 рабочих дня', en: 'We start 3 working days after payment' }, clientAction: action('pay', first?.payUrl ?? docHref(inv?.id ?? null)),
    });
  }

  const c = i.contract;
  if (c && c.state !== 'void' || i.quote?.state === 'accepted') {
    const since = c?.signedAt ?? c?.deliveredAt ?? i.quote?.acceptedAt ?? i.now;
    if (c?.state === 'awaiting_signature') {
      return mk('contract', since, { ru: 'Договор готов. Прочитайте и подпишите его в кабинете, это пара минут.', en: 'The contract is ready. Read and sign it in the cabinet, it takes a couple of minutes.' }, { clientAction: action('sign', docHref(c.id)) });
    }
    return mk('contract', since, c?.state === 'signed'
      ? { ru: 'Договор подписан. Готовим счёт на первый этап.', en: 'Contract signed. We are preparing the invoice for the first stage.' }
      : { ru: 'КП принято. Готовим договор, пришлём его в кабинет.', en: 'Proposal accepted. We are preparing the contract and will send it to the cabinet.' }, {
      etaText: { ru: 'Обычно в течение рабочего дня', en: 'Usually within a working day' },
    });
  }

  const q = i.quote;
  if (q && q.state !== 'void') {
    const since = q.deliveredAt ?? q.createdAt;
    if (q.state === 'awaiting_client') return mk('quote', since, { ru: 'КП готово. Прочитайте его и нажмите «Принять» или задайте вопрос.', en: 'Your proposal is ready. Read it and press «Accept», or ask a question.' }, { clientAction: action('accept_quote', docHref(q.id)) });
    return mk('quote', since, q.state === 'expired'
      ? { ru: 'Срок КП истёк. Напишите менеджеру, обновим предложение.', en: 'The proposal has expired. Write to the manager and we will update it.' }
      : { ru: 'Ваш ответ по КП у менеджера, он ответит в сообщениях.', en: 'Your answer about the proposal is with the manager, who replies in Messages.' }, { clientAction: action('answer', '/cabinet?tab=messages') });
  }

  const reviewing = i.leadStage !== 'new' || i.managerRepliedAt !== null;
  if (reviewing) {
    const since = i.managerRepliedAt ?? i.leadCreatedAt;
    return mk('reviewing', since, { ru: 'Проверяем смету и готовим КП и счёт на первый этап. Они появятся в кабинете.', en: 'We are checking the estimate and preparing the proposal and the first invoice. They will appear in the cabinet.' }, {
      eta: iso(since + DAY), etaText: { ru: 'До 1 рабочего дня, обычно быстрее', en: 'Within 1 working day, usually faster' },
    });
  }
  return mk('received', i.leadCreatedAt, { ru: 'Заявка у нас. Менеджер проекта уже смотрит её.', en: 'We have your request. The project manager is looking at it.' }, {
    eta: iso(i.leadCreatedAt + 5 * 60_000), etaText: { ru: 'Первый ответ за 5 минут, круглосуточно', en: 'First reply within 5 minutes, around the clock' },
  });
}

// ---- loading the input from the tables ----
interface LeadLike extends LeadStageRow { created_at: number; client_id?: number | null }
const has = (db: Db, t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
const hasCol = (db: Db, t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c);

const lineOf = (r: { id: number; state: string; delivered_at: number | null; accepted_at: number | null; signed_at: number | null; created_at: number } | undefined): DocLine | null =>
  r ? { id: r.id, state: r.state, deliveredAt: r.delivered_at, acceptedAt: r.accepted_at, signedAt: r.signed_at, createdAt: r.created_at } : null;

export interface JourneyOpts { paymentsEnabled: boolean; stageCtx?: StageContext; payUrlOf?: (invoiceNumber: string) => string | null }

/** The journey of one lead row. */
export function journeyOfLead(db: Db, now: number, l: LeadLike, o: JourneyOpts): Journey {
  const ctx = o.stageCtx ?? StageContext.load(db);
  const docs = has(db, 'cab_documents')
    ? (db.prepare("SELECT id, kind, state, delivered_at, accepted_at, signed_at, created_at FROM cab_documents WHERE lead_id = ? AND kind IN ('quote', 'contract', 'invoice') ORDER BY id").all(l.id) as ({ kind: string } & Parameters<typeof lineOf>[0] & object)[])
    : [];
  const last = (k: string) => lineOf([...docs].reverse().find((d) => d.kind === k));
  const invoices = docs.filter((d) => d.kind === 'invoice');
  const invoice = lineOf(invoices.find((d) => d.state === 'issued') ?? invoices.find((d) => d.state === 'paid') ?? invoices.at(-1));
  let stages: StageIn[] = [];
  let projectStatus: string | null = null;
  if (has(db, 'pm_projects') && hasCol(db, 'pm_projects', 'lead_id')) {
    const p = db.prepare('SELECT id, status FROM pm_projects WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(l.id) as { id: number; status: string } | undefined;
    if (p) {
      projectStatus = p.status;
      if (hasCol(db, 'pm_milestones', 'stage_no')) {
        type M = { title: string; title_en: string | null; due_at: number; status: string; stage_no: number; invoice_number: string | null; paid_at: number | null; accepted_at: number | null };
        stages = (db.prepare('SELECT * FROM pm_milestones WHERE project_id = ? AND stage_no IS NOT NULL ORDER BY stage_no').all(p.id) as M[]).map((m) => ({
          stageNo: m.stage_no, state: stageState({ paidAt: m.paid_at, acceptedAt: m.accepted_at, status: m.status }), title: m.title.replace(/^Этап \d+:\s*/, ''), dueAt: m.due_at, paidAt: m.paid_at, acceptedAt: m.accepted_at,
          payUrl: m.invoice_number && m.paid_at === null ? o.payUrlOf?.(m.invoice_number) ?? null : null,
        }));
      }
    }
  }
  let paidAt: number | null = null;
  if (has(db, 'bl_invoices') && hasCol(db, 'bl_invoices', 'lead_id')) {
    paidAt = (db.prepare("SELECT MIN(paid_at) p FROM bl_invoices WHERE lead_id = ? AND status = 'paid'").get(l.id) as { p: number | null }).p;
  }
  const replied = has(db, 'cab_messages')
    ? (db.prepare("SELECT MIN(at) a FROM cab_messages WHERE lead_id = ? AND \"from\" = 'manager'").get(l.id) as { a: number | null }).a
    : null;
  const tg = l.client_id != null && has(db, 'cab_clients')
    ? (db.prepare('SELECT tg_chat_id, notify_channel FROM cab_clients WHERE id = ?').get(l.client_id) as { tg_chat_id: number | null; notify_channel: string } | undefined)
    : undefined;
  return deriveJourney({
    now, leadCreatedAt: l.created_at, leadStage: ctx.stageOf(l), managerRepliedAt: replied, quote: last('quote'), contract: last('contract'), invoice, stages, projectStatus, paidAt,
    paymentsEnabled: o.paymentsEnabled, telegram: Boolean(tg && tg.tg_chat_id && tg.notify_channel === 'telegram'),
  });
}

/** The journey of a project through its lead; null for a project with no lead. */
export function journeyOfProject(db: Db, now: number, projectId: number, o: JourneyOpts): Journey | null {
  if (!has(db, 'pm_projects') || !hasCol(db, 'pm_projects', 'lead_id') || !has(db, 'li_leads')) return null;
  const p = db.prepare('SELECT lead_id FROM pm_projects WHERE id = ?').get(projectId) as { lead_id: number | null } | undefined;
  if (!p?.lead_id) return null;
  const l = db.prepare('SELECT * FROM li_leads WHERE id = ?').get(p.lead_id) as LeadLike | undefined;
  return l ? journeyOfLead(db, now, l, o) : null;
}

// ---- the welcome and the notices ----
const JSCHEMA = `
CREATE TABLE IF NOT EXISTS journey_state (
  lead_id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL,
  at INTEGER NOT NULL,
  thread INTEGER NOT NULL DEFAULT 0,
  email TEXT
);`;

export interface Notified { thread: boolean; email: MailOutcome | 'document' | null }

/** What the client was told at the lead's current journey stage (read-only, the Shell's «уведомлён» marks); nothing before the first tick. */
export function notifiedOf(db: Db, leadId: number): Notified {
  if (!has(db, 'journey_state')) return { thread: false, email: null };
  const r = db.prepare('SELECT thread, email FROM journey_state WHERE lead_id = ?').get(leadId) as { thread: number; email: string | null } | undefined;
  return { thread: r?.thread === 1, email: (r?.email as Notified['email']) ?? null };
}

export interface JourneyNotifierDeps { hq: Hq; mail: ClientMail | undefined; siteUrl: string }

const STEPS: Record<'ru' | 'en', string[]> = {
  ru: [
    'Мы проверяем смету, до 1 рабочего дня, обычно быстрее.',
    'КП и счёт на первый этап появятся в кабинете, вы получите письмо. Их нужно принять и подписать.',
    'После оплаты первого этапа старт через 3 рабочих дня.',
  ],
  en: [
    'We check the estimate within 1 working day, usually faster.',
    'The proposal and the invoice for the first stage appear in your cabinet and you get an email. You accept and sign them.',
    'After the first stage is paid we start in 3 working days.',
  ],
};

export function welcomeText(lang: 'ru' | 'en', o: { number: number; coupon?: string | undefined; email?: string | undefined }): string {
  const ru = lang === 'ru';
  const steps = STEPS[lang].map((s, n) => `${n + 1}. ${s}`).join('\n');
  const where = ru ? `Ответ придёт сюда, в кабинет${o.email ? ` и на почту ${o.email}` : ''}.` : `The answer arrives here in your cabinet${o.email ? ` and by email to ${o.email}` : ''}.`;
  const coupon = o.coupon ? (ru ? `\nКупон ${o.coupon} учтён, он будет в КП.` : `\nYour coupon ${o.coupon} is noted and will be in the proposal.`) : '';
  return ru
    ? `Заявка №${o.number} принята. Это Фира, помощница команды Fir Tech.\nЧто дальше:\n${steps}\n${where}${coupon}`
    : `Request #${o.number} received. This is Fira, the Fir Tech team's assistant.\nWhat happens next:\n${steps}\n${where}${coupon}`;
}

export class JourneyNotifier {
  constructor(private readonly d: JourneyNotifierDeps) {
    ensureCabinetTables(d.hq.db);
    d.hq.db.exec(JSCHEMA);
  }

  private get db(): Db { return this.d.hq.db; }

  private opts(): JourneyOpts { return { paymentsEnabled: paymentsEnabled(this.d.hq) }; }

  private lead(id: number): LeadLike | undefined {
    return this.db.prepare('SELECT * FROM li_leads WHERE id = ?').get(id) as LeadLike | undefined;
  }

  private client(id: number) {
    return this.db.prepare('SELECT id, email, name, locale FROM cab_clients WHERE id = ?').get(id) as { id: number; email: string; name: string; locale: string } | undefined;
  }

  private setState(leadId: number, stage: string, patch: { thread?: boolean; email?: string | null } = {}): void {
    this.db.prepare(
      `INSERT INTO journey_state (lead_id, stage, at, thread, email) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(lead_id) DO UPDATE SET stage = excluded.stage, at = excluded.at, thread = excluded.thread, email = excluded.email`,
    ).run(leadId, stage, this.d.hq.now(), patch.thread ? 1 : 0, patch.email ?? null);
  }

  /**
   * The welcome of a new web lead of a cabinet client: Fira's line in the `lead-<id>` thread and the email «Заявка получена», each once per lead (a mark
   * written before the send, so a retry or a restart never doubles it). The email follows the client's consent and channel choice (`ClientMail.send`).
   */
  async welcome(leadId: number, o: { coupon?: string | undefined } = {}): Promise<{ thread: boolean; email: MailOutcome | null }> {
    const l = this.lead(leadId);
    if (!l || l.client_id == null) return { thread: false, email: null };
    const c = this.client(l.client_id);
    if (!c) return { thread: false, email: null };
    const lang = (l as { lang?: string }).lang === 'en' ? 'en' : 'ru';
    const text = welcomeText(lang, { number: leadId, coupon: o.coupon, email: c.email });
    let thread = false;
    let email: MailOutcome | null = null;
    const mail = this.d.mail;
    if (!mail || mail.markOnce(`journey:welcome:thread:${leadId}`)) {
      addCabMessage(this.db, this.d.hq.now(), { clientId: c.id, leadId, from: 'manager', text, by: 'hq' });
      thread = true;
    }
    if (mail && mail.markOnce(`journey:welcome:mail:${leadId}`)) {
      email = await mail.send(c.id, {
        subject: { ru: `Заявка №${leadId} получена`, en: `Request #${leadId} received` },
        text: { ru: text.replace(/^[^\n]*\n/, ''), en: text.replace(/^[^\n]*\n/, '') },
      }, 'journey', `заявка #${leadId}`, `lead-${leadId}`);
    }
    this.setState(leadId, 'received', { thread, email });
    return { thread, email };
  }

  /**
   * From the due ticker: every cabinet lead is compared with the stage the client was last told. The first sight of a lead is a silent baseline (an old lead
   * never gets a burst of notices). A move into a stage the documents or the payment already announce (КП, договор, счёт, оплата, приёмка) is recorded only;
   * the stages with no notice of their own get one: `start` (the date), `invoice` while payments are closed, and «оплата открыта» when the switch is turned on.
   */
  async tick(): Promise<number> {
    if (!has(this.db, 'li_leads') || !hasCol(this.db, 'li_leads', 'client_id')) return 0;
    const rows = this.db.prepare('SELECT * FROM li_leads WHERE client_id IS NOT NULL ORDER BY id DESC LIMIT 300').all() as LeadLike[];
    const ctx = StageContext.load(this.db);
    const o = { ...this.opts(), stageCtx: ctx };
    let sent = 0;
    for (const l of rows) {
      try {
        const j = journeyOfLead(this.db, this.d.hq.now(), l, o);
        const prev = this.db.prepare('SELECT stage FROM journey_state WHERE lead_id = ?').get(l.id) as { stage: string } | undefined;
        if (!prev) { this.setState(l.id, j.stage); continue; }
        if (prev.stage !== j.stage) {
          const own = j.stage === 'start' || (j.stage === 'invoice' && !o.paymentsEnabled);
          if (own && await this.notify(l, j)) sent++;
          else this.setState(l.id, j.stage, { thread: !own, email: own ? null : 'document' });
        } else if (j.stage === 'invoice' && o.paymentsEnabled && this.d.mail?.markedAt(`journey:payhold:${l.id}`) != null) {
          // the legal entity got registered after the invoice was issued: «оплата открыта», once
          if (await this.notify(l, j, 'open')) sent++;
        }
        if (j.stage === 'invoice' && !o.paymentsEnabled) this.d.mail?.markOnce(`journey:payhold:${l.id}`);
      } catch (e) {
        log('warn', 'journey tick failed', { lead: l.id, err: errMsg(e) });
      }
    }
    return sent;
  }

  /** One thread line and one email for a journey move; the marks make it once per lead and stage. */
  private async notify(l: LeadLike, j: Journey, mode: 'move' | 'open' = 'move'): Promise<boolean> {
    const mail = this.d.mail;
    const c = l.client_id != null ? this.client(l.client_id) : undefined;
    if (!c) return false;
    const key = `journey:${mode}:${l.id}:${j.stage}`;
    if (mail && !mail.markOnce(key)) {
      this.setState(l.id, j.stage, { thread: true });
      return false;
    }
    const en = c.locale === 'en';
    const body: Bi = mode === 'open'
      ? { ru: 'Оплата открыта: юрлицо зарегистрировано. Счёт на первый этап ждёт вас в разделе «Документы».', en: 'Payment is open: our legal entity is registered. The invoice for the first stage is waiting in Documents.' }
      : j.nextWeWill;
    const when = j.etaText ? `\n${en ? j.etaText.en : j.etaText.ru}` : '';
    addCabMessage(this.db, this.d.hq.now(), { clientId: c.id, leadId: l.id, from: 'manager', text: `${en ? body.en : body.ru}${when}`, by: 'hq' });
    let email: MailOutcome | null = null;
    if (mail) {
      email = await mail.send(c.id, {
        subject: mode === 'open' ? { ru: 'Оплата открыта', en: 'Payment is open' } : { ru: `Заявка №${l.id}: ${STAGE_SUBJECT[j.stage].ru}`, en: `Request #${l.id}: ${STAGE_SUBJECT[j.stage].en}` },
        text: { ru: `${body.ru}${j.etaText ? `\n${j.etaText.ru}` : ''}`, en: `${body.en}${j.etaText ? `\n${j.etaText.en}` : ''}` },
      }, 'journey', `заявка #${l.id}`, `lead-${l.id}`);
    }
    this.setState(l.id, j.stage, { thread: true, email });
    return true;
  }
}

const STAGE_SUBJECT: Record<JourneyStage, Bi> = {
  received: { ru: 'получена', en: 'received' }, reviewing: { ru: 'проверяем смету', en: 'we are checking the estimate' }, quote: { ru: 'КП готово', en: 'proposal ready' },
  contract: { ru: 'договор', en: 'contract' }, invoice: { ru: 'счёт выставлен', en: 'invoice issued' }, paid: { ru: 'оплата получена', en: 'payment received' },
  start: { ru: 'дата старта', en: 'start date' }, stages: { ru: 'работа по этапам', en: 'work by stages' }, done: { ru: 'проект завершён', en: 'project complete' }, lost: { ru: 'закрыта', en: 'closed' },
};
