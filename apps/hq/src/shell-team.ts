import type { Hq } from '@fir/hq';
import type { AdminReply } from './admin.js';
import { fail, ok } from './shell-crm.js';
import { TEAM_HREF } from './team-chat-tools.js';
import type { TeamChat } from './team-chat.js';
import type { TeamPresence } from './team-presence.js';
import type { Standup } from './team-standup.js';

/**
 * `/admin/team/*` (2026-11-24, contract `docs/admin-crm-api.md`, «Команда»): the members with presence, one member's card, its chat, an
 * assignment, the stand-up and the reply to it. Behind the admin token like every `/admin/*` route.
 */

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function createShellTeam(d: { hq: Hq; presence: TeamPresence; chat: TeamChat; standup: Standup }) {
  const { hq, presence, chat, standup } = d;
  const db = hq.db;

  /** The latest results of an agent: tasks it finished, approvals the owner granted on its tasks, its chat answers (newest first, 10). */
  function recent(id: string): { at: string; kind: string; title: string; href: string }[] {
    const out: { ms: number; kind: string; title: string; href: string }[] = [];
    for (const r of db.prepare("SELECT e.task_id id, MAX(e.at) at, t.title title FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE e.kind = 'result' AND e.actor = ? GROUP BY e.task_id ORDER BY at DESC LIMIT 10").all(id) as { id: number; at: number; title: string }[]) {
      out.push({ ms: r.at, kind: 'task', title: clip(r.title, 100), href: TEAM_HREF.task(r.id) });
    }
    for (const r of db.prepare("SELECT a.approval_id ap, a.summary s, a.created_at at FROM task_approvals a JOIN tasks t ON t.id = a.task_id WHERE a.state = 'executed' AND t.assignee_id = ? ORDER BY a.id DESC LIMIT 10").all(id) as { ap: number | null; s: string; at: number }[]) {
      out.push({ ms: r.at, kind: 'approval', title: clip(r.s, 100), href: r.ap ? `/admin/approvals?id=ap_${r.ap}` : TEAM_HREF.approvals() });
    }
    for (const r of db.prepare("SELECT id, text, at FROM team_chat WHERE agent_id = ? AND role = 'agent' AND state = 'done' AND text != '' ORDER BY id DESC LIMIT 10").all(id) as { id: number; text: string; at: number }[]) {
      out.push({ ms: r.at, kind: 'reply', title: clip(r.text, 100), href: `/admin/team/${id}?message=${r.id}` });
    }
    return out.sort((a, b) => b.ms - a.ms).slice(0, 10).map((x) => ({ at: new Date(x.ms).toISOString(), kind: x.kind, title: x.title, href: x.href }));
  }

  function card(id: string): AdminReply {
    const m = presence.member(id);
    if (!m) return fail(404, 'not_found');
    const v = hq.instructionVersions(id)[0];
    return ok({ member: m, recent: recent(id), instructions: { version: v?.version ?? 0, updatedAt: v ? new Date(v.at).toISOString() : null } });
  }

  async function handle(method: string, seg: string[], query: URLSearchParams, body: unknown): Promise<AdminReply> {
    const [a, b] = seg;
    if (seg.length === 0) return method === 'GET' ? ok({ members: presence.members() }) : fail(405, 'method_not_allowed');
    if (a === 'standup') {
      if (seg.length === 1) return method === 'GET' ? standup.get(query) : fail(405, 'method_not_allowed');
      if (seg.length === 2 && b === 'reply') return method === 'POST' ? standup.reply(body) : fail(405, 'method_not_allowed');
      return fail(404, 'not_found');
    }
    if (!a || !chat.exists(a)) return fail(404, 'not_found');
    if (seg.length === 1) return method === 'GET' ? card(a) : fail(405, 'method_not_allowed');
    if (seg.length === 2 && b === 'chat') {
      if (method === 'GET') return chat.get(a, query);
      if (method === 'POST') {
        const r = await chat.post(a, body);
        presence.invalidate();
        return r;
      }
      return fail(405, 'method_not_allowed');
    }
    if (seg.length === 2 && b === 'assign') return method === 'POST' ? chat.assign(a, body) : fail(405, 'method_not_allowed');
    return fail(404, 'not_found');
  }

  return { handle };
}
