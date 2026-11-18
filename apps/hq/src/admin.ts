import { errMsg, log, type ApprovalQueue } from '@fir/core';
import type { Hq, Task } from '@fir/hq';
import { openBuilderTasks } from './bridge.js';
import type { Director } from './director.js';
import { buildOffice } from './office.js';
import type { OwnerChannel } from './presence.js';
import { mask } from './progress.js';

/** The owner's private control API (`/admin/*`): the website workplace. Contract and routes: README «Admin API и присутствие». */
export interface AdminDeps {
  hq: Hq;
  queue: ApprovalQueue;
  director: Director;
  channel: OwnerChannel;
  ownerId: number;
  /** Command names the website may run through `POST /admin/command` (the same set the Telegram bot registers). */
  commandNames: string[];
  /** `/drill` of the Drill (GET: report, POST: the argument). */
  drill?: (arg: string) => Promise<string>;
  now?: () => number;
}

export interface AdminRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}
export interface AdminReply {
  status: number;
  body: Record<string, unknown>;
}

const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 600;
const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): AdminReply => ({ status, body: { ok: false, error, ...extra } });
const ok = (body: Record<string, unknown> = {}): AdminReply => ({ status: 200, body: { ok: true, ...body } });
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function createAdmin(d: AdminDeps): { handle(req: AdminRequest): Promise<AdminReply> } {
  const { hq, queue, director, channel } = d;
  const now = d.now ?? Date.now;
  const hits: number[] = [];
  let served = 0;
  const commands = new Set(d.commandNames.map((n) => n.toLowerCase()));

  const maxTaskId = () => (hq.db.prepare('SELECT COALESCE(MAX(id), 0) m FROM tasks').get() as { m: number }).m;
  const firstOwnerTaskAfter = (id: number): number | undefined =>
    (hq.db.prepare("SELECT MIN(id) m FROM tasks WHERE id > ? AND creator = 'owner'").get(id) as { m: number | null }).m ?? undefined;

  const openTasks = () => hq.tasks({ open: true, limit: 5000 }).filter((t) => !t.tags.includes('drill'));

  function state() {
    return {
      presence: { mode: channel.mode, effective: channel.effective(), lastPingAt: iso(channel.lastPingAt), awayAfterMin: channel.awayAfterMin },
      inboxUnread: channel.unread(),
      approvalsPending: queue.pending().length,
      approvalsQueued: hq.queuedApprovals().length,
      tasksOpen: openTasks().length,
      builderIssues: openBuilderTasks(hq).length,
      quietHours: hq.isQuiet(),
      tz: hq.tz,
      generatedAt: iso(now()),
    };
  }

  function taskView(t: Task) {
    const open = t.status !== 'done' && t.status !== 'rejected';
    const p = t.meta.progress as { line?: unknown } | undefined;
    const last = hq.events(t.id).at(-1);
    return {
      id: t.id, title: t.title, dept: t.dept, status: t.status, assigneeId: t.assigneeId,
      assigneeTitle: (t.assigneeId ? hq.agent(t.assigneeId)?.title : hq.headOf(t.dept)?.title) ?? null,
      priority: t.priority, dueAt: iso(t.dueAt), createdAt: iso(t.createdAt), updatedAt: iso(t.updatedAt), tags: t.tags,
      progressLine: open && t.creator === 'owner' ? director.progress.render(t) : typeof p?.line === 'string' ? p.line : null,
      lastEvent: last ? { at: iso(last.at), kind: last.kind, actor: last.actor, body: mask(last.body).slice(0, 500) } : null,
    };
  }

  function approvalView(id: number) {
    const row = queue.get(id)!;
    const link = hq.approvalByCoreId(id);
    const created = (hq.db.prepare('SELECT created_at c FROM approvals WHERE id = ?').get(id) as { c: number } | undefined)?.c ?? null;
    const parts = director.editors.get(row.kind)?.parts?.(id) ?? undefined;
    return {
      id, kind: row.kind, dept: link?.dept ?? null, summary: row.summary, text: typeof row.payload.text === 'string' ? row.payload.text : '',
      ...(parts ? { parts } : {}), level: queue.level(row.kind), taskId: link?.taskId ?? null, createdAt: iso(created),
      locked: queue.trustTable().find((k) => k.kind === row.kind)?.locked ?? false,
    };
  }

  async function approvals(req: AdminRequest, id: number): Promise<AdminReply> {
    const row = queue.get(id);
    if (!row) return fail(404, 'not_found');
    const b = obj(req.body);
    const action = b.action;
    if (action !== 'approve' && action !== 'reject' && action !== 'edit') return fail(400, 'invalid');
    if (row.status !== 'pending' && row.status !== 'editing') return fail(409, 'already_decided', { status: row.status });
    if (action === 'edit') {
      const text = typeof b.text === 'string' ? b.text.trim() : '';
      if (!text || text.length > 8000) return fail(400, 'invalid');
      const part = typeof b.part === 'string' && b.part ? b.part : undefined;
      const editor = director.editors.get(row.kind);
      if (part !== undefined && !editor?.applyEdit) return fail(400, 'no_parts');
      // the new card the queue sends after an edit is the owner's own action: not stored, not sent
      const { result } = await channel.capture(() => (editor?.applyEdit ? editor.applyEdit(id, text, part) : queue.applyEdit(id, text)));
      if (!result) return fail(409, 'not_applied', { status: queue.get(id)?.status ?? row.status });
      // the Telegram card (if it went there) shows the edited text with its buttons again
      await queue.settleCard(id).catch(() => false);
      return ok({ status: queue.get(id)!.status });
    }
    const { result: message, replies } = await channel.capture(async () => {
      const answer = await queue.handle(action, id, d.ownerId);
      director.afterDecision();
      return answer;
    });
    channel.resolveApproval(id);
    // decided on the site: the Telegram card is edited to «Одобрено» / «Отклонено», no buttons left
    await queue.settleCard(id).catch(() => false);
    const status = queue.get(id)!.status;
    if (status === 'failed') return { status: 200, body: { ok: false, error: 'failed', status, message, notes: replies } };
    return ok({ status, message, notes: replies });
  }

  async function route(req: AdminRequest): Promise<AdminReply> {
    const { method, path, query } = req;
    const b = obj(req.body);
    const seg = path.replace(/^\/admin\//, '').replace(/\/$/, '').split('/');
    const [a, id, sub] = seg;
    const key = `${method} ${a}${id !== undefined && /^\d+$/.test(id) ? '/:id' : id ? `/${id}` : ''}${sub ? `/${sub}` : ''}`;
    const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);

    switch (key) {
      case 'GET state':
        await channel.sync();
        return ok(state());
      case 'POST presence':
        if (b.mode !== 'desk' && b.mode !== 'away') return fail(400, 'invalid');
        await channel.setMode(b.mode);
        return ok(state());
      case 'POST ping':
        await channel.ping();
        return ok(state());
      case 'GET inbox': {
        const after = num(query.get('after') ?? undefined);
        const limit = num(query.get('limit') ?? undefined);
        return ok({ items: channel.list({ ...(after !== null ? { after } : {}), ...(limit !== null ? { limit } : {}), unread: query.get('unread') === '1' }) });
      }
      case 'POST inbox/read': {
        if (b.all === true) return ok({ updated: channel.markRead('all'), inboxUnread: channel.unread() });
        const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is number => Number.isInteger(x)).slice(0, 500) : null;
        if (!ids) return fail(400, 'invalid');
        return ok({ updated: channel.markRead(ids), inboxUnread: channel.unread() });
      }
      case 'GET approvals':
        return ok({ items: queue.pending().map((r) => approvalView(r.id)) });
      case 'GET tasks': {
        const status = query.get('status');
        const limit = Math.min(num(query.get('limit') ?? undefined) ?? 100, 500);
        const list = hq.tasks({
          ...(query.get('dept') ? { dept: query.get('dept')! } : {}),
          ...(status ? { status: status.split(',').filter(Boolean) as Task['status'][] } : {}),
          ...(query.get('open') === '1' ? { open: true } : {}),
          limit: 5000,
        });
        list.sort((x, y) => y.updatedAt - x.updatedAt || y.id - x.id);
        return ok({ items: list.slice(0, limit).map(taskView) });
      }
      case 'GET departments': {
        const office = buildOffice(hq, hq.now());
        return ok({
          items: office.departments.map((dep) => ({
            id: dep.id, title: dep.title, status: hq.headOf(dep.id)?.status === 'paused' ? 'paused' : 'active',
            headId: dep.head?.id ?? null, headTitle: dep.head?.title ?? null,
            workers: dep.workers.map((w) => ({ id: w.id, title: w.title, status: w.status })), counts: dep.tasks,
          })),
        });
      }
      case 'POST say': {
        const text = typeof b.text === 'string' ? b.text.trim() : '';
        if (!text || text.length > 2000) return fail(400, 'invalid');
        const before = maxTaskId();
        const { replies } = await channel.capture(() => director.onText(text));
        const taskId = firstOwnerTaskAfter(before);
        return ok({ replies, ...(taskId !== undefined ? { taskId } : {}) });
      }
      case 'POST command': {
        const name = typeof b.name === 'string' ? b.name.trim().replace(/^\//, '').toLowerCase() : '';
        const arg = typeof b.arg === 'string' ? b.arg.slice(0, 1000) : '';
        if (!name || !commands.has(name)) return fail(400, 'unknown_command');
        const before = maxTaskId();
        const { replies } = await channel.capture(() => director.onCommand(name, arg));
        const taskId = firstOwnerTaskAfter(before);
        return ok({ replies, ...(taskId !== undefined ? { taskId } : {}) });
      }
      case 'GET drill':
        return d.drill ? ok({ text: await d.drill('report') }) : fail(503, 'unavailable');
      case 'POST drill':
        return d.drill ? ok({ text: await d.drill(typeof b.arg === 'string' ? b.arg.slice(0, 40) : '') }) : fail(503, 'unavailable');
      default:
    }
    const n = num(id);
    if (a === 'approvals' && method === 'POST' && n !== null && !sub) return approvals(req, n);
    if (a === 'tasks' && n !== null) {
      const t = hq.task(n);
      if (!t) return fail(404, 'not_found');
      if (method === 'GET' && !sub) {
        const links = hq.db.prepare('SELECT id, approval_id, kind, summary, state, dept, created_at FROM task_approvals WHERE task_id = ? ORDER BY id').all(n) as {
          id: number; approval_id: number | null; kind: string; summary: string; state: string; dept: string; created_at: number;
        }[];
        return ok({
          task: { ...taskView(t), body: t.body, result: t.result, creator: t.creator, parentId: t.parentId, costUsd: t.costUsd },
          events: hq.events(n).map((e) => ({ id: e.id, at: iso(e.at), kind: e.kind, actor: e.actor, body: mask(e.body) })),
          approvals: links.map((l) => ({ id: l.id, approvalId: l.approval_id, kind: l.kind, summary: l.summary, state: l.state, dept: l.dept, createdAt: iso(l.created_at) })),
          children: hq.tasks({ parentId: n, limit: 200 }).map(taskView),
        });
      }
      if (method === 'POST' && sub === 'retry') {
        const { replies } = await channel.capture(() => director.onCommand('retry', String(n)));
        return ok({ replies, task: taskView(hq.task(n)!) });
      }
    }
    return fail(404, 'not_found');
  }

  return {
    async handle(req) {
      const t = now();
      while (hits.length && hits[0]! < t - RATE_WINDOW_MS) hits.shift();
      if (hits.length >= RATE_MAX) {
        log('warn', 'admin rate limited', { served });
        return fail(429, 'rate_limited');
      }
      hits.push(t);
      served++;
      if (served % 200 === 0) log('info', 'admin requests', { served });
      try {
        return await route(req);
      } catch (e) {
        log('error', 'admin request failed', { err: errMsg(e) });
        return fail(500, 'internal');
      }
    },
  };
}
