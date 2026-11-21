import { errMsg, log, type Db } from '@fir/core';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import type { DrillStatus } from './drill.js';
import { fail, ok } from './pult-crm.js';

/**
 * `GET /admin/processes` and `POST /admin/processes/drill`: the map of the process chains of `docs/process-audit` (client money chain, support,
 * content, letters, infrastructure) with the health of every step, read from HQ's own tables (last success, failures of the last 7 days,
 * stuck items). Read-only: the only write is the drill button, which runs the EXISTING drill (`drill.ts`: tasks tagged `drill`, the test
 * client «Тест учения», removed by `clear`). Contract: `docs/admin-crm-api.md`, «Processes».
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW_DAYS = 7;

export type StepHealth = 'ok' | 'warn' | 'fail' | 'idle';

interface Probe {
  /** One number (ms) or null: the last time the step worked. */
  last: string;
  /** `?` = window start (ms). The count of failures in the window. */
  failures: string;
  /** `?` = the stuck threshold (ms before now). The count of items waiting longer than `stuckMs`. */
  stuck: string;
  /** `?` = window start. One row `{at, text}`: the newest failure. */
  lastFailure?: string; // SQL returning (at, text): the text is a kind or a code, never a body of an error, a title or a client's words
  stuckMs?: number;
}
interface StepDef extends Probe { id: string; title: string; hint: string }
interface ChainDef { id: string; title: string; steps: StepDef[] }

const NOT_DRILL = "tags NOT LIKE '%drill%'";
const taskDone = (worker: string): string => `SELECT MAX(updated_at) FROM tasks WHERE assignee_id = '${worker}' AND status = 'done' AND ${NOT_DRILL}`;
const taskBlocked = (worker: string): string => `SELECT COUNT(*) FROM tasks WHERE assignee_id = '${worker}' AND status = 'blocked' AND tags NOT LIKE '%builder%' AND ${NOT_DRILL} AND updated_at >= ?`;
const taskBlockedLast = (worker: string): string =>
  `SELECT t.updated_at AS at, CASE WHEN EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id AND e.kind = 'error') THEN 'task error' ELSE 'task blocked' END AS text FROM tasks t WHERE t.assignee_id = '${worker}' AND t.status = 'blocked' AND t.tags NOT LIKE '%builder%' AND t.${NOT_DRILL} AND t.updated_at >= ? ORDER BY t.updated_at DESC LIMIT 1`;
const taskOpen = (worker: string): string => `SELECT COUNT(*) FROM tasks WHERE assignee_id = '${worker}' AND status IN ('inbox','assigned','running') AND ${NOT_DRILL} AND created_at < ?`;
const none = 'SELECT 0';
const mailFailedCount = (kind: string): string => `SELECT COUNT(*) FROM cab_documents WHERE kind = '${kind}' AND mail_state = 'failed' AND created_at >= ?`;
const mailFailedLast = (kind: string): string =>
  `SELECT created_at AS at, 'письмо не ушло' AS text FROM cab_documents WHERE kind = '${kind}' AND mail_state = 'failed' AND created_at >= ? ORDER BY id DESC LIMIT 1`;
const mailRetry = (kind: string): string => `SELECT COUNT(*) FROM cab_documents WHERE kind = '${kind}' AND (delivered_at IS NULL OR mail_state = 'failed') AND created_at < ?`;
const docLast = (kind: string): string => `SELECT MAX(delivered_at) FROM cab_documents WHERE kind = '${kind}'`;

export const CHAINS: ChainDef[] = [
  {
    id: 'client',
    title: 'Заявка, КП, договор, оплата, производство, приёмка',
    steps: [
      {
        id: 'lead', title: 'Заявка принята', hint: 'Сайт, чат или Telegram: лид и задача Продаж',
        last: `SELECT MAX(created_at) FROM li_leads WHERE task_id IN (SELECT id FROM tasks WHERE ${NOT_DRILL})`,
        failures: taskBlocked('lead-intake'), lastFailure: taskBlockedLast('lead-intake'), stuck: taskOpen('lead-intake'), stuckMs: 2 * HOUR,
      },
      {
        id: 'quote', title: 'КП у клиента', hint: 'Одобрено владельцем, ушло в кабинет и на почту',
        last: docLast('quote'), failures: mailFailedCount('quote'), lastFailure: mailFailedLast('quote'), stuck: mailRetry('quote'), stuckMs: HOUR,
      },
      {
        id: 'accept', title: 'КП принято', hint: 'Клиент нажал «Принять» (отказ или срок идут в сбои)',
        last: "SELECT MAX(accepted_at) FROM cab_documents WHERE kind = 'quote'",
        failures: "SELECT COUNT(*) FROM cab_documents WHERE kind = 'quote' AND state IN ('declined','expired') AND created_at >= ?",
        lastFailure: "SELECT created_at AS at, 'КП ' || state AS text FROM cab_documents WHERE kind = 'quote' AND state IN ('declined','expired') AND created_at >= ? ORDER BY id DESC LIMIT 1",
        stuck: "SELECT COUNT(*) FROM cab_documents WHERE kind = 'quote' AND state = 'awaiting_client' AND delivered_at IS NOT NULL AND delivered_at < ?", stuckMs: 7 * DAY,
      },
      {
        id: 'contract', title: 'Договор у клиента', hint: 'Черновик одобрен, ушёл на подпись',
        last: docLast('contract'), failures: mailFailedCount('contract'), lastFailure: mailFailedLast('contract'), stuck: mailRetry('contract'), stuckMs: HOUR,
      },
      {
        id: 'sign', title: 'Договор подписан', hint: 'Подпись мышью и подписанный PDF (P-12)',
        last: 'SELECT MAX(signed_at) FROM cab_documents WHERE kind = \'contract\'',
        failures: "SELECT COUNT(*) FROM cab_documents WHERE kind = 'contract' AND state = 'signed' AND signed_pdf_rel IS NULL AND signed_at >= ?",
        lastFailure: "SELECT signed_at AS at, 'подписан, но PDF не собран' AS text FROM cab_documents WHERE kind = 'contract' AND state = 'signed' AND signed_pdf_rel IS NULL AND signed_at >= ? ORDER BY id DESC LIMIT 1",
        stuck: "SELECT COUNT(*) FROM cab_documents WHERE kind = 'contract' AND state = 'awaiting_signature' AND delivered_at IS NOT NULL AND delivered_at < ?", stuckMs: 7 * DAY,
      },
      {
        id: 'invoice', title: 'Счёт выставлен', hint: 'Счёт этапа, ссылка на оплату, письмо',
        last: 'SELECT MAX(issued_at) FROM bl_invoices', failures: mailFailedCount('invoice'), lastFailure: mailFailedLast('invoice'),
        stuck: "SELECT COUNT(*) FROM bl_invoices WHERE status = 'draft' AND created_at < ?", stuckMs: DAY,
      },
      {
        id: 'paid', title: 'Оплата получена', hint: 'Сеть или вручную; просрочка идёт в зависшие',
        last: "SELECT MAX(paid_at) FROM bl_invoices WHERE status = 'paid'", failures: none,
        stuck: "SELECT COUNT(*) FROM bl_invoices WHERE status = 'issued' AND due_date < date(? / 1000, 'unixepoch')", stuckMs: 0,
      },
      {
        id: 'project', title: 'Проект в работе', hint: 'Проект и вехи, ТЗ, строитель',
        last: "SELECT MAX(created_at) FROM pm_projects WHERE source != 'drill'", failures: taskBlocked('project-manager'), lastFailure: taskBlockedLast('project-manager'),
        stuck: "SELECT COUNT(*) FROM pm_milestones m JOIN pm_projects p ON p.id = m.project_id WHERE m.status = 'open' AND m.due_at < ? AND p.status = 'active' AND p.source != 'drill' AND (m.stage_no IS NULL OR m.paid_at IS NOT NULL)",
        stuckMs: DAY,
      },
      {
        id: 'stage', title: 'Этап принят', hint: 'Готов этап, клиент принял',
        last: 'SELECT MAX(accepted_at) FROM pm_milestones', failures: none,
        stuck: "SELECT COUNT(*) FROM pm_milestones m JOIN pm_projects p ON p.id = m.project_id WHERE m.status = 'done' AND m.accepted_at IS NULL AND m.done_at < ? AND p.source != 'drill'", stuckMs: 3 * DAY,
      },
      {
        id: 'act', title: 'Акт выдан', hint: 'Последний этап принят, акт в «Документах»',
        last: docLast('act'), failures: mailFailedCount('act'), lastFailure: mailFailedLast('act'), stuck: mailRetry('act'), stuckMs: HOUR,
      },
    ],
  },
  {
    id: 'support',
    title: 'Поддержка',
    steps: [
      {
        id: 'ticket', title: 'Тикет принят', hint: 'Кабинет, Telegram или чат агента',
        last: "SELECT MAX(created_at) FROM cs_tickets WHERE client_name != 'Тест учения'", failures: none, stuck: none,
      },
      {
        id: 'answer', title: 'Ответ клиенту', hint: 'SLA 4 часа: дольше значит зависший',
        last: "SELECT MAX(answered_at) FROM cs_tickets WHERE client_name != 'Тест учения'", failures: taskBlocked('customer-support'), lastFailure: taskBlockedLast('customer-support'),
        stuck: "SELECT COUNT(*) FROM cs_tickets WHERE status = 'open' AND answered_at IS NULL AND client_name != 'Тест учения' AND created_at < ?", stuckMs: 4 * HOUR,
      },
    ],
  },
  {
    id: 'content',
    title: 'Контент-конвейер',
    steps: [
      { id: 'trends', title: 'Тренды', hint: 'Разведка трендов дня и недели', last: taskDone('trend-scout'), failures: taskBlocked('trend-scout'), lastFailure: taskBlockedLast('trend-scout'), stuck: taskOpen('trend-scout'), stuckMs: 6 * HOUR },
      {
        id: 'make', title: 'Материал недели', hint: 'Тексты и визуал, затем ревью',
        last: taskDone('content-maker'), failures: taskBlocked('content-maker'), lastFailure: taskBlockedLast('content-maker'), stuck: taskOpen('content-maker'), stuckMs: 12 * HOUR,
      },
      { id: 'publish', title: 'Публикация', hint: 'Пакет публикации только из одобренного', last: taskDone('publisher'), failures: taskBlocked('publisher'), lastFailure: taskBlockedLast('publisher'), stuck: taskOpen('publisher'), stuckMs: 12 * HOUR },
    ],
  },
  {
    id: 'letters',
    title: 'Письма и уведомления клиентам',
    steps: [
      {
        id: 'mail', title: 'Письма ушли', hint: 'Resend: сбои пишутся в журнал и раз в час владельцу',
        last: 'SELECT MAX(delivered_at) FROM cab_documents', failures: 'SELECT COUNT(*) FROM email_failures WHERE at >= ?',
        lastFailure: "SELECT at, kind AS text FROM email_failures WHERE at >= ? ORDER BY id DESC LIMIT 1",
        stuck: "SELECT COUNT(*) FROM cab_documents WHERE kind IN ('quote','contract','invoice','act') AND delivered_at IS NULL AND created_at < ?", stuckMs: HOUR,
      },
    ],
  },
  {
    id: 'infra',
    title: 'Рутины, одобрения, учёт',
    steps: [
      {
        id: 'routines', title: 'Рутины по расписанию', hint: 'Каждая включённая рутина отрабатывает и не зависает',
        last: 'SELECT MAX(last_run_at) FROM routines WHERE enabled = 1',
        failures: `SELECT COUNT(*) FROM tasks WHERE routine_id IS NOT NULL AND status = 'blocked' AND ${NOT_DRILL} AND updated_at >= ?`,
        lastFailure: `SELECT updated_at AS at, 'routine task blocked' AS text FROM tasks WHERE routine_id IS NOT NULL AND status = 'blocked' AND ${NOT_DRILL} AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1`,
        stuck: `SELECT COUNT(*) FROM tasks WHERE routine_id IS NOT NULL AND status IN ('inbox','assigned','running') AND ${NOT_DRILL} AND created_at < ?`, stuckMs: 6 * HOUR,
      },
      {
        id: 'approvals', title: 'Одобрения исполняются', hint: 'Решение владельца доходит до действия',
        last: "SELECT MAX(created_at) FROM task_approvals WHERE state = 'executed' AND task_id IN (SELECT id FROM tasks WHERE " + NOT_DRILL + ')',
        failures: "SELECT COUNT(*) FROM task_approvals WHERE state = 'failed' AND created_at >= ? AND task_id IN (SELECT id FROM tasks WHERE " + NOT_DRILL + ')',
        lastFailure: "SELECT created_at AS at, 'approval failed' AS text FROM task_approvals WHERE state = 'failed' AND created_at >= ? AND task_id IN (SELECT id FROM tasks WHERE " + NOT_DRILL + ') ORDER BY id DESC LIMIT 1',
        stuck: "SELECT COUNT(*) FROM task_approvals WHERE state IN ('queued','asked') AND created_at < ? AND task_id IN (SELECT id FROM tasks WHERE " + NOT_DRILL + ')', stuckMs: 2 * DAY,
      },
    ],
  },
];

const bodySchema = z.object({ action: z.enum(['start', 'clear']) }).strict();
const clip = (s: string, n = 160): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export interface PultProcessesDeps {
  db: Db;
  now: () => number;
  /** The Drill: `command('')` starts it, `command('clear')` removes the test data, `status()` is the table as data. Absent: the button answers 503. */
  drill?: { command(arg: string): Promise<string>; status(): DrillStatus } | undefined;
}

export function createProcesses(d: PultProcessesDeps) {
  const { db, now } = d;

  /** A table that does not exist yet (a worker never started) is an empty result, not an error. */
  const run = <T>(sql: string, args: unknown[], empty: T, pick: (row: Record<string, unknown> | undefined) => T): T => {
    try {
      return pick(db.prepare(sql).get(...args.slice(0, (sql.match(/\?/g) ?? []).length)) as Record<string, unknown> | undefined);
    } catch (e) {
      if (/no such (table|column)/i.test(errMsg(e))) return empty;
      log('warn', 'processes probe failed', { err: errMsg(e) });
      return empty;
    }
  };
  const first = (r: Record<string, unknown> | undefined): number | null => {
    const v = r ? Object.values(r)[0] : null;
    return typeof v === 'number' ? v : null;
  };

  function step(def: StepDef) {
    const t = now();
    const since = t - WINDOW_DAYS * DAY;
    const lastOk = run(def.last, [], null as number | null, first);
    const failures = run(def.failures, [since], 0, (r) => first(r) ?? 0);
    const stuck = run(def.stuck, [t - (def.stuckMs ?? DAY)], 0, (r) => first(r) ?? 0);
    const lastFailure = def.lastFailure
      ? run(def.lastFailure, [since], null as { at: number; text: string } | null, (r) => (r && typeof r.at === 'number' ? { at: r.at, text: clip(String(r.text ?? '')) } : null))
      : null;
    let health: StepHealth;
    if (failures > 0 && (lastOk === null || (lastFailure && lastFailure.at > lastOk))) health = 'fail';
    else if (failures > 0 || stuck > 0) health = 'warn';
    else if (lastOk === null) health = 'idle';
    else health = 'ok';
    return {
      id: def.id, title: def.title, hint: def.hint, health, lastOkAt: iso(lastOk), failures7d: failures, stuck,
      lastFailure: lastFailure ? { at: iso(lastFailure.at), text: lastFailure.text } : null,
    };
  }

  function get(): AdminReply {
    const chains = CHAINS.map((c) => {
      const steps = c.steps.map(step);
      const health: StepHealth = steps.some((s) => s.health === 'fail') ? 'fail' : steps.some((s) => s.health === 'warn') ? 'warn' : steps.every((s) => s.health === 'idle') ? 'idle' : 'ok';
      return { id: c.id, title: c.title, health, steps };
    });
    const counts = { ok: 0, warn: 0, fail: 0, idle: 0 };
    for (const c of chains) for (const s of c.steps) counts[s.health]++;
    return ok({ generatedAt: iso(now()), windowDays: WINDOW_DAYS, counts, chains, drill: d.drill ? d.drill.status() : null });
  }

  async function drill(body: unknown): Promise<AdminReply> {
    if (!d.drill) return fail(503, 'unavailable');
    const p = bodySchema.safeParse(body);
    if (!p.success) return fail(400, 'bad_request');
    const text = await d.drill.command(p.data.action === 'start' ? '' : 'clear');
    return ok({ action: p.data.action, text, drill: d.drill.status() });
  }

  return { get, drill };
}
