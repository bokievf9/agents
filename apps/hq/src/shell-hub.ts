import type { Db } from '@fir/core';

/** `GET /admin/hub`: one cheap summary for the office hub (a query per table, 50 inbox rows, cached 5 s). Contract: `docs/admin-crm-api.md` («Shell v3»). */
export const HUB_DEPTS = ['marketing', 'sales', 'support', 'production', 'backoffice', 'director'] as const;
export type InboxItemKind = 'approval' | 'alert' | 'lead' | 'payment' | 'ticket' | 'content' | 'info';
export interface HubInboxItem { id: string; at: string; dept: string; kind: InboxItemKind; title: string; link: string }
const INBOX_LIMIT = 50;
const TTL_MS = 5_000;
const iso = (ms: number) => new Date(ms).toISOString();
const clip = (s: string, n = 140) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export function createHub(db: Db, now: () => number) {
  const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
  const all = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];
  let cached: { at: number; body: Record<string, unknown> } | null = null;

  function build(): Record<string, unknown> {
    const departments: Record<string, { pending: number; approvals: number; alerts: number; running: number; lastActivityAt: string | null }> = {};
    const last: Record<string, number> = {};
    for (const d of HUB_DEPTS) departments[d] = { pending: 0, approvals: 0, alerts: 0, running: 0, lastActivityAt: null };
    const dept = (d: string) => (departments[d] ??= { pending: 0, approvals: 0, alerts: 0, running: 0, lastActivityAt: null });

    // tasks: one grouped query. pending = waiting to be worked, running, alerts = blocked (needs a person)
    for (const r of all<{ dept: string; status: string; n: number; m: number }>("SELECT dept, status, COUNT(*) n, MAX(updated_at) m FROM tasks WHERE tags NOT LIKE '%drill%' GROUP BY dept, status")) {
      const d = dept(r.dept);
      if (r.status === 'inbox' || r.status === 'assigned' || r.status === 'review') d.pending += r.n;
      else if (r.status === 'running') d.running += r.n;
      else if (r.status === 'blocked') d.alerts += r.n;
      last[r.dept] = Math.max(last[r.dept] ?? 0, r.m);
    }

    const inbox: (HubInboxItem & { ms: number })[] = [];
    const push = (ms: number, x: Omit<HubInboxItem, 'at'>) => inbox.push({ ...x, at: iso(ms), ms });

    // approvals waiting for the owner: link rows joined to their still-open core row (one query), content cards link to the item
    if (has('task_approvals') && has('approvals')) {
      for (const r of all<{ dept: string; n: number }>("SELECT dept, COUNT(*) n FROM task_approvals WHERE state IN ('queued', 'asked') GROUP BY dept")) dept(r.dept).approvals = r.n;
      const rows = all<{ id: number; dept: string; kind: string; summary: string; created_at: number; approval_id: number; item: number | null }>(
        `SELECT t.id, t.dept, t.kind, t.summary, t.created_at, t.approval_id, json_extract(t.payload, '$.itemId') item
         FROM task_approvals t JOIN approvals a ON a.id = t.approval_id
         WHERE t.state = 'asked' AND a.status IN ('pending', 'editing') ORDER BY t.id DESC LIMIT ?`, INBOX_LIMIT);
      for (const r of rows) {
        const content = r.kind === 'content_item' && typeof r.item === 'number';
        push(r.created_at, {
          id: `approval:${r.approval_id}`, dept: r.dept, kind: content ? 'content' : 'approval', title: clip(r.summary),
          link: content ? `content:item:${r.item}` : `approvals:${r.approval_id}`,
        });
      }
    }
    if (has('li_leads')) {
      for (const r of all<{ id: number; name: string; service: string; created_at: number }>('SELECT id, name, service, created_at FROM li_leads ORDER BY id DESC LIMIT 15')) {
        push(r.created_at, { id: `lead:${r.id}`, dept: 'sales', kind: 'lead', title: clip(`Заявка: ${r.name || 'без имени'}${r.service ? ` (${r.service})` : ''}`), link: `leads:${r.id}` });
      }
    }
    if (has('bl_invoices')) {
      for (const r of all<{ id: number; number: string; client: string; amount_usd: number; paid_at: number }>("SELECT id, number, client, amount_usd, paid_at FROM bl_invoices WHERE status = 'paid' AND paid_at IS NOT NULL ORDER BY paid_at DESC LIMIT 10")) {
        push(r.paid_at, { id: `payment:${r.id}`, dept: 'support', kind: 'payment', title: clip(`Оплачен счёт ${r.number}: ${r.client}, $${r.amount_usd}`), link: `invoices:${r.id}` });
      }
    }
    if (has('cs_tickets')) {
      for (const r of all<{ id: number; client_name: string; text: string; created_at: number }>("SELECT id, client_name, text, created_at FROM cs_tickets WHERE status = 'open' ORDER BY id DESC LIMIT 10")) {
        push(r.created_at, { id: `ticket:${r.id}`, dept: 'support', kind: 'ticket', title: clip(`${r.client_name}: ${r.text}`), link: `tickets:${r.id}` });
      }
    }
    // the playground (2026-11-22): the client's demo agent was made with his lead («демо на ваших данных») or when he accepted the КП, and went live with the first payment
    if (has('activity') && has('pg_agents')) {
      for (const r of all<{ id: number; action: string; at: number; agent: number; name: string; client: string; client_id: number }>(
        `SELECT a.id, a.action, a.at, g.id agent, g.name, g.client_id, COALESCE(NULLIF(c.name, ''), c.email, '') client
         FROM activity a JOIN pg_agents g ON CAST(a.object_id AS INTEGER) = g.id LEFT JOIN cab_clients c ON c.id = g.client_id
         WHERE a.object_type = 'agent' AND a.action IN ('agent_auto_created', 'agent_demo_for_lead', 'agent_live') ORDER BY a.id DESC LIMIT 10`,
      )) {
        const live = r.action === 'agent_live';
        push(r.at, {
          id: `agent:${r.action}:${r.id}`, dept: 'production', kind: 'info', link: `clients:${r.client_id}`,
          title: clip(live ? `Агент «${r.name}» клиента ${r.client} включён в рабочий режим (оплачен этап 1)` : `Агент «${r.name}» клиента ${r.client || 'без кабинета'} создан в демо-режиме (${r.action === 'agent_demo_for_lead' ? 'по заявке, демо на данных клиента' : 'КП принято'})`),
        });
      }
    }
    if (has('owner_inbox')) {
      for (const r of all<{ id: number; at: number; kind: string; text: string }>("SELECT id, at, kind, text FROM owner_inbox WHERE kind IN ('alert', 'summary') ORDER BY id DESC LIMIT 15")) {
        push(r.at, { id: `inbox:${r.id}`, dept: 'director', kind: r.kind === 'alert' ? 'alert' : 'info', title: clip(r.text), link: `inbox:${r.id}` });
      }
    }
    for (const [d, ms] of Object.entries(last)) dept(d).lastActivityAt = iso(ms);
    inbox.sort((a, b) => b.ms - a.ms || b.id.localeCompare(a.id));
    return { generatedAt: iso(now()), departments, inbox: inbox.slice(0, INBOX_LIMIT).map((x): HubInboxItem => ({ id: x.id, at: x.at, dept: x.dept, kind: x.kind, title: x.title, link: x.link })) };
  }

  return {
    get(): Record<string, unknown> {
      const t = now();
      if (cached && t - cached.at < TTL_MS && t >= cached.at) return cached.body;
      const body = build();
      cached = { at: t, body };
      return body;
    },
  };
}
