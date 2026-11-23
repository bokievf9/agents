import { migrate, type Db } from '@fir/core';
import type { Hq } from '@fir/hq';
import { ALL_TOPICS, FORMAT_TOPICS, pickFormatTopics, pickTopics, storeFor } from '@fir/worker-content-maker';
import type { Cadence } from './settings.js';
import { isoWeekOf, shiftWeek, todayIn, weekRange, WEEK_RE } from './shell-week.js';

/**
 * Weekly plans of the marketing chat (2026-11-24): Fira proposes, the owner accepts. A plan is a week and its slots (day, platform, type, topic),
 * stored `pending`; `accept` turns every slot into a Studio order for its day (`requestStudioOrder`, the Content Maker writes the item, it comes to the
 * review center as always) and the accepted slots show in the calendar until their item exists. Nothing is published from here.
 */

export const PLAN_TYPES = ['clip', 'post', 'carousel', 'story'] as const;
export const PLAN_PLATFORMS = ['instagram', 'tiktok', 'shorts'] as const;
export type PlanType = (typeof PLAN_TYPES)[number];
export type PlanPlatform = (typeof PLAN_PLATFORMS)[number];
export type PlanStatus = 'pending' | 'accepted' | 'dropped';
export const MAX_SLOTS = 21;

export interface PlanSlot {
  n: number;
  day: string;
  platform: PlanPlatform;
  type: PlanType;
  topic: string;
  /** The Studio order (task id) once the plan is accepted. */
  orderId?: number;
}

export interface Plan {
  id: number;
  week: string;
  status: PlanStatus;
  slots: PlanSlot[];
  createdAt: number;
  acceptedAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mk_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  slots TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER
);
CREATE INDEX IF NOT EXISTS mk_plans_status ON mk_plans (status, id);
`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const clip = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** `this`, `next`, a `YYYY-Www` label or nothing (next week) on the company's clock; null when the label is not a week. */
export function planWeek(raw: unknown, now: number, tz: string): string | null {
  const thisWeek = isoWeekOf(todayIn(now, tz));
  if (raw === undefined || raw === null || raw === '' || raw === 'next') return shiftWeek(thisWeek, 1);
  if (raw === 'this') return thisWeek;
  return typeof raw === 'string' && WEEK_RE.test(raw) && weekRange(raw) ? raw : null;
}

/** The slots of a week by the cadence: one per publishing day, types rotate (reel, carousel, post, story), platforms rotate, fresh topics. */
export function cadenceSlots(db: Db, now: number, week: string, cadence: Cadence, rng: () => number = Math.random): Omit<PlanSlot, 'n'>[] {
  const r = weekRange(week)!;
  const days = cadence.days.map((d) => addDays(r.from, (d + 6) % 7)).sort();
  const types: PlanType[] = ['clip', 'carousel', 'clip', 'post', 'clip', 'story', 'clip'];
  const history = storeFor({ db, now: () => now }).history();
  const reels = pickTopics(history, days.length, now, rng);
  const formats = FORMAT_TOPICS.length ? pickFormatTopics(history, days.length, rng) : [];
  return days.map((day, i) => {
    const type = types[i % types.length]!;
    const topic = (type === 'post' || type === 'story' ? formats[i] ?? reels[i] : reels[i]) ?? ALL_TOPICS[i % ALL_TOPICS.length]!;
    return { day, platform: cadence.platforms[i % cadence.platforms.length] ?? 'instagram', type, topic: clip(topic.text, 200) };
  });
}

/** Slots from the model (or the API): only real days of the week, known types and platforms, a topic; at most `MAX_SLOTS`. */
export function cleanSlots(raw: unknown, week: string, fallbackPlatform: PlanPlatform = 'instagram'): Omit<PlanSlot, 'n'>[] {
  if (!Array.isArray(raw)) return [];
  const r = weekRange(week)!;
  const out: Omit<PlanSlot, 'n'>[] = [];
  for (const s of raw.slice(0, MAX_SLOTS)) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const day = typeof o.day === 'string' && DATE.test(o.day) && o.day >= r.from && o.day <= r.to ? o.day : null;
    const type = (PLAN_TYPES as readonly string[]).includes(String(o.type)) ? (o.type as PlanType) : null;
    const platform = (PLAN_PLATFORMS as readonly string[]).includes(String(o.platform)) ? (o.platform as PlanPlatform) : fallbackPlatform;
    const topic = typeof o.topic === 'string' ? clip(o.topic, 200) : '';
    if (day && type && topic.length >= 3) out.push({ day, platform, type, topic });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

interface Row { id: number; week: string; status: PlanStatus; slots: string; created_at: number; accepted_at: number | null }
const plan = (r: Row): Plan => ({ id: r.id, week: r.week, status: r.status, slots: JSON.parse(r.slots) as PlanSlot[], createdAt: r.created_at, acceptedAt: r.accepted_at });

export type StudioOrder = (o: { mode: 'prompt'; prompt: string; type?: PlanType; plannedDate?: string }) => { taskId: number } | null;
export type AcceptResult = { ok: true; plan: Plan; orders: number[] } | { ok: false; status: number; error: string };

export class MarketingPlans {
  constructor(private readonly hq: Hq) {
    migrate(hq.db, SCHEMA);
  }

  get(id: number): Plan | undefined {
    const r = this.hq.db.prepare('SELECT * FROM mk_plans WHERE id = ?').get(id) as Row | undefined;
    return r ? plan(r) : undefined;
  }

  list(o: { status?: PlanStatus; limit?: number } = {}): Plan[] {
    const rows = (o.status
      ? this.hq.db.prepare('SELECT * FROM mk_plans WHERE status = ? ORDER BY id DESC LIMIT ?').all(o.status, o.limit ?? 20)
      : this.hq.db.prepare('SELECT * FROM mk_plans ORDER BY id DESC LIMIT ?').all(o.limit ?? 20)) as Row[];
    return rows.map(plan);
  }

  /** A new pending plan; an older pending plan of the same week is dropped (one open proposal per week). Journaled as the owner's (he asked for it). */
  propose(week: string, slots: Omit<PlanSlot, 'n'>[]): Plan {
    const db = this.hq.db;
    const id = db.transaction(() => {
      db.prepare("UPDATE mk_plans SET status = 'dropped' WHERE week = ? AND status = 'pending'").run(week);
      const numbered = slots.slice(0, MAX_SLOTS).map((s, i) => ({ n: i + 1, ...s }));
      return Number(db.prepare('INSERT INTO mk_plans (week, status, slots, created_at) VALUES (?, ?, ?, ?)').run(week, 'pending', JSON.stringify(numbered), this.hq.now()).lastInsertRowid);
    })();
    this.hq.log('owner', 'marketing_plan_proposed', 'plan', String(id), `${week} ${slots.length}`);
    return this.get(id)!;
  }

  /** The pending plan becomes accepted: one Studio order per slot, for its day. Only a pending plan; a second accept is 409. */
  accept(id: number, order: StudioOrder | null): AcceptResult {
    const p = this.get(id);
    if (!p) return { ok: false, status: 404, error: 'not_found' };
    if (p.status !== 'pending') return { ok: false, status: 409, error: p.status === 'accepted' ? 'already_accepted' : 'dropped' };
    if (!order) return { ok: false, status: 503, error: 'unavailable' };
    // claim first (atomic): two clicks never make the orders twice
    const claimed = this.hq.db.prepare("UPDATE mk_plans SET status = 'accepted', accepted_at = ? WHERE id = ? AND status = 'pending'").run(this.hq.now(), id).changes;
    if (!claimed) return { ok: false, status: 409, error: 'already_accepted' };
    const orders: number[] = [];
    const slots = p.slots.map((s) => {
      const made = order({ mode: 'prompt', prompt: s.topic, type: s.type, plannedDate: s.day });
      if (made) orders.push(made.taskId);
      return made ? { ...s, orderId: made.taskId } : s;
    });
    this.hq.db.prepare('UPDATE mk_plans SET slots = ? WHERE id = ?').run(JSON.stringify(slots), id);
    this.hq.log('owner', 'marketing_plan_accepted', 'plan', String(id), `${p.week} ${orders.length}`);
    return { ok: true, plan: this.get(id)!, orders };
  }

  /** Accepted slots of days in [from, to] whose order has not delivered an item yet (the item itself is on the calendar then). */
  calendarSlots(from: string, to: string): (PlanSlot & { planId: number })[] {
    const db = this.hq.db;
    const delivered = (taskId: number) => Boolean(db.prepare("SELECT 1 FROM task_approvals WHERE kind = 'content_item' AND (task_id = ? OR task_id IN (SELECT id FROM tasks WHERE parent_id = ?)) LIMIT 1").get(taskId, taskId));
    const out: (PlanSlot & { planId: number })[] = [];
    for (const p of this.list({ status: 'accepted', limit: 200 })) {
      for (const s of p.slots) if (s.day >= from && s.day <= to && !(s.orderId && delivered(s.orderId))) out.push({ ...s, planId: p.id });
    }
    return out;
  }
}
