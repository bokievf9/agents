import { REACH_CHANNELS, REACH_SETTING_CHANNELS, ReachStore, reachChannels, cleanArgs, reachSpec, type ReachJob, type ReachResult, type ReachStatus } from '@fir/core';
import type { Hq } from '@fir/hq';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import { fail, ok } from './shell-crm.js';

/**
 * Agent Reach on the owner's Mac, the HQ side (`docs/admin-crm-api.md`, «Reach (2026-11-21)»). The queue is `rc_jobs` (core `ReachStore`), the agents fill it through
 * `ctx.tools.reach`, the Mac helper (`packages/mac-poster`, `reach:run`) reads and answers it through these routes, all under `x-admin-token`:
 * `GET /admin/reach/jobs`, `POST /admin/reach/jobs/:id/claim`, `POST /admin/reach/jobs/:id/result`, `POST /admin/reach`, `GET /admin/reach/:id`.
 * A task parked on a job (`blocked`, tag `reach-wait`, `meta.reachJob`) goes back to its inbox when the job is answered or expires.
 */
export const REACH_WAIT_TAG = 'reach-wait';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const STATUSES = ['queued', 'running', 'done', 'failed'] as const;
const resultSchema = z
  .object({
    ok: z.boolean(),
    items: z.array(z.record(z.string(), z.unknown())).max(200).default([]),
    meta: z.record(z.string(), z.unknown()).default({}),
    error: z.object({ code: z.string().max(60).optional(), message: z.string().max(500).optional(), hint: z.string().max(500).optional() }).passthrough().optional(),
  })
  .passthrough();
const answerBody = z.union([
  z.object({ ok: z.literal(true), result: resultSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.string().trim().min(1).max(300), result: resultSchema.optional() }).strict(),
]);
const claimBody = z.object({ channels: z.array(z.enum(REACH_CHANNELS as [string, ...string[]])).max(20).optional() }).strict();
const manualBody = z.object({ channel: z.string().max(30), action: z.string().max(30), args: z.record(z.string(), z.unknown()).default({}) }).strict();

export function jobView(j: ReachJob, withResult: boolean) {
  return {
    id: j.id, channel: j.channel, action: j.action, args: j.args, status: j.status, taskId: j.taskId, agentId: j.agentId, error: j.error,
    createdAt: iso(j.createdAt), startedAt: iso(j.startedAt), finishedAt: iso(j.finishedAt), ...(withResult ? { result: j.result } : {}),
  };
}

export function createReach(d: { hq: Hq; now: () => number }) {
  const { hq } = d;
  const store = () => new ReachStore(hq.db, d.now);

  /** Tasks parked on this job (and on no other open one) go back to their department's inbox and the head is woken. Returns the task ids resumed. */
  function resume(job: ReachJob): number[] {
    const out: number[] = [];
    for (const id of [job.taskId, ...job.waiters]) {
      if (id === null) continue;
      const t = hq.task(id);
      if (!t || t.status !== 'blocked' || !t.tags.includes(REACH_WAIT_TAG)) continue;
      // a task that asked for several jobs (subtitles and info of one video) goes on when the last one is settled
      if (store().openForTask(id)) continue;
      hq.setMeta(id, { reachJob: null });
      if (!hq.requeue(id, 'reach')) continue;
      hq.log('reach', 'reach_resumed', 'task', String(id), `job ${job.id} ${job.status}`);
      const head = hq.headOf(t.dept);
      if (head) hq.wake(head.id, 'task');
      out.push(id);
    }
    return out;
  }

  /** Jobs nobody answers fail (queued 6 h, running 30 min) and release their tasks. Returns how many. */
  function sweep(): number {
    const expired = store().expire();
    for (const j of expired) resume(j);
    if (expired.length) hq.log('reach', 'reach_expired', 'jobs', String(expired.length));
    return expired.length;
  }

  /** The worker's side: park the task on the job (`blocked` + tag, no alert). A job answered in the meantime releases it at once. */
  function park(taskId: number, actor: string, jobId: number): void {
    hq.setMeta(taskId, { reachJob: jobId });
    hq.block(taskId, actor, `ждёт Мак: Agent Reach, задание ${jobId}`, [REACH_WAIT_TAG]);
    const j = store().get(jobId);
    if (j && (j.status === 'done' || j.status === 'failed')) resume(j);
  }

  /** What the Mac reports of itself: the channels it has set up (`settings.reach.channels`, a JSON array). */
  const rememberChannels = (channels: string[]) => {
    hq.setSetting(REACH_SETTING_CHANNELS, JSON.stringify([...new Set(channels)].sort()));
    hq.setSetting('reach.seen_at', String(d.now()));
  };
  function list(query: URLSearchParams): AdminReply {
    const st = query.get('status');
    if (st !== null && st !== '' && !(STATUSES as readonly string[]).includes(st)) return fail(400, 'invalid', { hint: 'status' });
    const limRaw = query.get('limit');
    const limit = limRaw === null || limRaw === '' ? 20 : /^\d+$/.test(limRaw) ? Math.min(Math.max(Number(limRaw), 1), 100) : NaN;
    if (!Number.isFinite(limit)) return fail(400, 'invalid', { hint: 'limit' });
    const ch = query.get('channels');
    if (ch) {
      const names = ch.split(',').filter(Boolean);
      if (names.length > 20 || names.some((n) => !(REACH_CHANNELS as string[]).includes(n))) return fail(400, 'invalid', { hint: 'channels' });
      rememberChannels(names);
    }
    sweep();
    const s = store();
    return ok({ items: s.list((st || undefined) as ReachStatus | undefined, limit).map((j) => jobView(j, false)), counts: s.counts(), channels: reachChannels(hq.db) });
  }

  function claim(id: number, body: unknown): AdminReply {
    const parsed = claimBody.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid');
    const s = store();
    const j = s.get(id);
    if (!j) return fail(404, 'not_found');
    if (parsed.data.channels) rememberChannels(parsed.data.channels);
    if (!s.claim(id)) return fail(409, 'already_claimed', { status: j.status });
    hq.log('mac-reach', 'reach_claimed', 'job', String(id), `${j.channel}.${j.action}`);
    return ok({ item: jobView(s.get(id)!, false) });
  }

  function result(id: number, body: unknown): AdminReply {
    const parsed = answerBody.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid');
    const s = store();
    const a = parsed.data;
    const res = s.finish(id, a.ok ? { ok: true, result: a.result as ReachResult } : { ok: false, error: a.error, ...(a.result ? { result: a.result as ReachResult } : {}) });
    if (!res.job) return fail(404, 'not_found');
    if (res.reason === 'not_claimed') return fail(409, 'not_claimed');
    if (!res.applied) return ok({ item: jobView(res.job, false), already: true });
    hq.log('mac-reach', res.job.status === 'done' ? 'reach_done' : 'reach_failed', 'job', String(id), `${res.job.channel}.${res.job.action}`);
    resume(res.job);
    return ok({ item: jobView(res.job, false), already: false });
  }

  /** The owner's (or a script's) own job: the same dedupe, cache and daily cap as an agent's call. */
  function post(body: unknown): AdminReply {
    const parsed = manualBody.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid');
    const spec = reachSpec(parsed.data.channel, parsed.data.action);
    if (!spec) return fail(400, 'invalid', { hint: 'channel/action' });
    const clean = cleanArgs(spec, parsed.data.args);
    if (!clean.ok) return fail(400, 'invalid', { hint: clean.reason });
    const r = store().request(parsed.data.channel, parsed.data.action, clean.args, null, 'owner');
    if (r.kind === 'cap') return fail(429, 'cap', { hint: 'daily cap of reach jobs reached' });
    if (r.created) hq.log('owner', 'reach_job', 'job', String(r.job.id), `${r.job.channel}.${r.job.action}`);
    return ok({ item: jobView(r.job, true), cached: !r.created });
  }

  function get(id: number): AdminReply {
    const j = store().get(id);
    return j ? ok({ item: jobView(j, true) }) : fail(404, 'not_found');
  }

  async function handle(method: string, seg: string[], query: URLSearchParams, body: unknown): Promise<AdminReply> {
    if (method === 'POST' && seg.length === 1) return post(body);
    if (method === 'GET' && seg.length === 2 && seg[1] === 'jobs') return list(query);
    const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : null);
    if (method === 'GET' && seg.length === 2) {
      const id = num(seg[1]);
      return id === null ? fail(404, 'not_found') : get(id);
    }
    if (method === 'POST' && seg.length === 4 && seg[1] === 'jobs') {
      const id = num(seg[2]);
      if (id === null) return fail(404, 'not_found');
      if (seg[3] === 'claim') return claim(id, body);
      if (seg[3] === 'result') return result(id, body);
    }
    return fail(404, 'not_found');
  }

  return { handle, sweep, resume, park, channelOn: (channel: string) => reachChannels(hq.db).includes(channel), purge: () => store().purge() };
}

export type Reach = ReturnType<typeof createReach>;
