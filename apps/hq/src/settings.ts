import { migrate, zonedParts, zonedToMs } from '@fir/core';
import type { ApprovalQueue } from '@fir/core';
import type { Hq } from '@fir/hq';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import type { RateLimiter } from './client/sanitize.js';
import { fail, ok } from './shell-crm.js';

/**
 * The company settings of the Shell (`GET` and `PATCH /admin/settings`, owner 2026-11-22): one JSON over what already lives in the `settings` table, the
 * agents' limits and the env (the env value is only the default until the owner changes it). Every change is validated as a whole, written, applied
 * without a restart where the code reads the value live, and journaled in `settings_log` (key, old, new, time, who; never a text of a client).
 * Contract: `docs/admin-crm-api.md`, section «Настройки (2026-11-22)».
 */

/** What the env says, the default of a setting nobody changed. */
export interface SettingsDefaults {
  trustThreshold: number;
  slotHours: [string, string];
  kpValidDays: number;
  clientLlmDailyCap: number;
  tgApprovalCards: boolean;
  tgGroupReports: boolean;
}

export const DEPT_BUDGET_KEYS = ['marketing', 'sales', 'support', 'production', 'backoffice', 'director'] as const;
/** The first limits (USD a month, owner 2026-11-23: API budget 100 USD), written once when every limit is 0. */
export const SEED_BUDGETS: Record<(typeof DEPT_BUDGET_KEYS)[number], number> = { marketing: 25, sales: 20, support: 15, production: 15, backoffice: 10, director: 5 };
export const SEED_SOURCE = 'seed 2026-11-23';

export const NOTICE_SETTING_TYPES = ['client', 'lead', 'approval', 'payment', 'stage', 'signed', 'call', 'chat', 'human'] as const;
export const NOTICE_SETTING_ALERTS = ['lost_lead', 'email_failed', 'llm', 'budget', 'service', 'human'] as const;
/** How much the owner wants to hear from the lead manager (Fira): ask_me = every doubt, policy = the escalation policy, autopilot = only a person asked for, anger, legal. */
export const AUTOPILOT_MODES = ['ask_me', 'policy', 'autopilot'] as const;
/** The publishing cadence of marketing (marketing chat, 2026-11-24): the days (0 Sunday ... 6 Saturday), the time on the company's clock, the platforms. */
export const CADENCE_PLATFORMS = ['instagram', 'tiktok', 'shorts'] as const;
export interface Cadence { days: number[]; time: string; platforms: (typeof CADENCE_PLATFORMS)[number][] }
export const DEFAULT_CADENCE: Cadence = { days: [1, 3, 5], time: '10:00', platforms: ['instagram', 'shorts'] };
const CADENCE_KEY = 'marketing.cadence';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  key TEXT NOT NULL,
  old TEXT NOT NULL,
  new TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'owner'
);
CREATE INDEX IF NOT EXISTS settings_log_at ON settings_log (at);
`;

const HM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const hm = z.string().regex(HM);
const zone = z.string().max(64).refine((v) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, 'timezone');
const bool = z.boolean();
const flags = <T extends readonly string[]>(keys: T) => z.object(Object.fromEntries(keys.map((k) => [k, bool.optional()])) as Record<T[number], z.ZodOptional<z.ZodBoolean>>).strict();

const cadenceBody = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7), time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/),
  platforms: z.array(z.enum(CADENCE_PLATFORMS)).min(1).max(3),
}).strict();

/** The stored cadence (`settings.marketing.cadence`, JSON), else the default; days sorted and unique. */
export function cadenceOf(hq: Pick<Hq, 'setting'>): Cadence {
  try {
    const raw = hq.setting(CADENCE_KEY);
    if (raw) {
      const p = cadenceBody.safeParse(JSON.parse(raw));
      if (p.success) return { days: [...new Set(p.data.days)].sort((a, b) => a - b), time: p.data.time.padStart(5, '0'), platforms: [...new Set(p.data.platforms)] };
    }
  } catch {
    // a broken value is the default
  }
  return { ...DEFAULT_CADENCE, days: [...DEFAULT_CADENCE.days], platforms: [...DEFAULT_CADENCE.platforms] };
}

const patchBody = z.object({
  schedule: z.object({
    summaryTime: hm, approvalTime: hm, digestDay: z.number().int().min(0).max(6), digestTime: hm,
    quietHours: z.object({ from: hm, to: hm }).strict().nullable(), ownerTz: zone, tz: zone,
  }).partial().strict(),
  notices: z.object({
    types: flags(NOTICE_SETTING_TYPES), alerts: flags(NOTICE_SETTING_ALERTS),
    groupWindowMin: z.number().int().min(0).max(120), skipWhileDesk: bool,
  }).partial().strict(),
  trust: z.object({
    defaultThreshold: z.number().int().min(1).max(1000),
    thresholds: z.record(z.string().max(60), z.number().int().min(1).max(1000).nullable()),
    levels: z.record(z.string().max(60), z.union([z.literal(0), z.literal(1)])),
  }).partial().strict(),
  limits: z.object({
    deptBudgetUsd: z.object(Object.fromEntries(DEPT_BUDGET_KEYS.map((k) => [k, z.number().min(0).max(100_000).optional()])) as Record<(typeof DEPT_BUDGET_KEYS)[number], z.ZodOptional<z.ZodNumber>>).strict(),
    clientLlmDailyCap: z.number().int().min(0).max(100_000),
  }).partial().strict(),
  calls: z.object({ slotHours: z.tuple([hm, hm]), durationMin: z.number().int().min(5).max(240), bufferMin: z.number().int().min(0).max(240) }).partial().strict(),
  kp: z.object({ validDays: z.number().int().min(1).max(90), defaultLang: z.enum(['ru', 'en']) }).partial().strict(),
  playground: z.object({ draftMsgsPerDay: z.number().int().min(1).max(2000), liveMsgsPerDay: z.number().int().min(1).max(2000) }).partial().strict(),
  service: z.object({ tgApprovalCards: bool, tgGroupReports: bool }).partial().strict(),
  autopilot: z.object({ leadManager: z.enum(AUTOPILOT_MODES), support: z.enum(AUTOPILOT_MODES) }).partial().strict(),
  marketing: z.object({ cadence: cadenceBody }).partial().strict(),
}).partial().strict();

export type SettingsPatch = z.infer<typeof patchBody>;

export interface SettingsDeps {
  hq: Hq;
  queue: ApprovalQueue;
  defaults: SettingsDefaults;
  /** The schedule changed: the Director's cron jobs and the routines are recreated (`director.start` and `onTimingChange`). */
  onSchedule: () => void;
  /** The owner's own level change (`/level`), the same code. */
  setLevel: (kind: string, level: 0 | 1) => void;
  /** The shared model-answer gates of the client bot and the website chat: the daily cap is set on every one. */
  limiters: () => RateLimiter[];
  /** The mutable pair the Sales worker reads (`SLOT_HOURS`): changed in place. */
  slotHours: [string, string];
  now: () => number;
}

const s1 = (v: boolean) => (v ? '1' : '0');
const intOr = (raw: string, d: number): number => (raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : d);

/** The values the app starts with: the stored setting, else the env default. */
export function startValues(hq: Hq, d: SettingsDefaults) {
  const slots = hq.setting('slot_hours').split(',');
  return {
    clientLlmDailyCap: intOr(hq.setting('client_llm_cap'), d.clientLlmDailyCap),
    slotHours: (slots.length === 2 && slots.every((x) => HM.test(x)) ? [slots[0]!, slots[1]!] : [...d.slotHours]) as [string, string],
    kpValidDays: () => intOr(hq.setting('kp_valid_days'), d.kpValidDays),
    tgApprovalCards: hq.setting('flag.tg_approval_cards') === '' ? d.tgApprovalCards : hq.setting('flag.tg_approval_cards') === '1',
    tgGroupReports: hq.setting('flag.tg_group_reports') === '' ? d.tgGroupReports : hq.setting('flag.tg_group_reports') === '1',
    trustThreshold: (kind: string) => intOr(hq.setting(`trust_threshold:${kind}`), intOr(hq.setting('trust_threshold'), d.trustThreshold)),
  };
}

export function createSettings(d: SettingsDeps) {
  const { hq, queue, defaults } = d;
  const db = hq.db;
  migrate(db, SCHEMA);
  const started = { tgApprovalCards: startValues(hq, defaults).tgApprovalCards, tgGroupReports: startValues(hq, defaults).tgGroupReports };

  const log = (key: string, old: string, next: string, source: string) =>
    db.prepare('INSERT INTO settings_log (at, key, old, new, source) VALUES (?, ?, ?, ?, ?)').run(d.now(), key, old, next, source);
  const stored = (key: string): string | null => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  const on = (key: string, dflt = true): boolean => {
    const v = stored(key);
    return v === null ? dflt : v !== '0';
  };

  const quiet = () => {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(hq.setting('quiet_hours'));
    return m ? { from: `${m[1]!.padStart(2, '0')}:${m[2]}`, to: `${m[3]!.padStart(2, '0')}:${m[4]}` } : null;
  };
  const approvalsOf = (kind: string) => (db.prepare("SELECT COUNT(*) n FROM decisions WHERE kind = ? AND decision IN ('approve', 'auto', 'autopilot')").get(kind) as { n: number }).n;
  const autopilotMode = (key: 'autopilot.leadManager' | 'autopilot.support' = 'autopilot.leadManager'): (typeof AUTOPILOT_MODES)[number] => {
    const v = hq.setting(key);
    return (AUTOPILOT_MODES as readonly string[]).includes(v) ? (v as (typeof AUTOPILOT_MODES)[number]) : 'policy';
  };
  const round = (n: number) => Math.round(n * 100) / 100;

  /** The whole answer: the settings with their effective values, the usage next to the limits, and what needs a restart. */
  function view() {
    const now = d.now();
    const p = zonedParts(now, hq.tz);
    const sv = startValues(hq, defaults);
    const restartKeys: string[] = [];
    if (sv.tgApprovalCards !== started.tgApprovalCards) restartKeys.push('service.tgApprovalCards');
    if (sv.tgGroupReports !== started.tgGroupReports) restartKeys.push('service.tgGroupReports');
    const deptBudgetUsd = Object.fromEntries(DEPT_BUDGET_KEYS.map((k) => [k, hq.deptBudget(k)]));
    const monthUsd = Object.fromEntries(DEPT_BUDGET_KEYS.map((k) => [k, round(hq.monthSpend(k === 'director' ? 'hq' : k))]));
    return {
      settings: {
        schedule: {
          summaryTime: hq.setting('summary_time'), approvalTime: hq.setting('approval_time'), digestDay: intOr(hq.setting('digest_day'), 1), digestTime: hq.setting('digest_time'),
          quietHours: quiet(), ownerTz: hq.ownerTz, tz: hq.tz,
        },
        notices: {
          types: Object.fromEntries(NOTICE_SETTING_TYPES.map((t) => [t, on(`notice.${t}`)])),
          alerts: Object.fromEntries(NOTICE_SETTING_ALERTS.map((k) => [k, on(`notice.alert.${k}`)])),
          groupWindowMin: intOr(hq.setting('notice.group_min'), 5), skipWhileDesk: on('notice.skip_desk'),
        },
        trust: {
          defaultThreshold: intOr(hq.setting('trust_threshold'), defaults.trustThreshold),
          kinds: queue.trustTable().map((k) => ({ kind: k.kind, level: k.level, locked: k.locked, streak: k.streak, approvals: approvalsOf(k.kind), threshold: k.threshold, custom: stored(`trust_threshold:${k.kind}`) !== null })),
        },
        limits: { deptBudgetUsd, clientLlmDailyCap: sv.clientLlmDailyCap },
        calls: { slotHours: sv.slotHours, durationMin: intOr(hq.setting('call_min'), 30), bufferMin: intOr(hq.setting('call_buffer_min'), 0) },
        kp: { validDays: sv.kpValidDays(), defaultLang: hq.setting('kp_lang') === 'en' ? 'en' : 'ru' },
        playground: { draftMsgsPerDay: intOr(hq.setting('pg_limit_draft'), 50), liveMsgsPerDay: intOr(hq.setting('pg_limit_live'), 500) },
        service: { tgApprovalCards: sv.tgApprovalCards, tgGroupReports: sv.tgGroupReports },
        autopilot: { leadManager: autopilotMode(), support: autopilotMode('autopilot.support') },
        marketing: { cadence: cadenceOf(hq) },
      },
      usage: { deptMonthUsd: monthUsd, clientLlmToday: d.limiters()[0]?.llmToday ?? 0, monthStartedAt: new Date(zonedToMs(p.y, p.mo, 1, 0, 0, hq.tz)).toISOString() },
      restartRequired: restartKeys.length > 0, restartKeys,
    };
  }

  function get(): AdminReply {
    return ok(view());
  }

  interface Change { key: string; old: string; next: string; write: () => void }

  function plan(p: SettingsPatch): Change[] | AdminReply {
    const out: Change[] = [];
    const kv = (key: string, next: string, label = key, dflt?: string) => {
      const old = stored(key) ?? dflt ?? hq.setting(key);
      if (old !== next) out.push({ key: label, old, next, write: () => hq.setSetting(key, next) });
    };
    const sv = startValues(hq, defaults);
    const s = p.schedule;
    if (s) {
      if (s.summaryTime !== undefined) kv('summary_time', s.summaryTime, 'schedule.summaryTime');
      if (s.approvalTime !== undefined) kv('approval_time', s.approvalTime, 'schedule.approvalTime');
      if (s.digestTime !== undefined) kv('digest_time', s.digestTime, 'schedule.digestTime');
      if (s.digestDay !== undefined) kv('digest_day', String(s.digestDay), 'schedule.digestDay', String(intOr(hq.setting('digest_day'), 1)));
      if (s.quietHours !== undefined) kv('quiet_hours', s.quietHours === null ? '' : `${s.quietHours.from}-${s.quietHours.to}`, 'schedule.quietHours');
      if (s.ownerTz !== undefined) kv('owner_tz', s.ownerTz, 'schedule.ownerTz');
      if (s.tz !== undefined) kv('tz', s.tz, 'schedule.tz');
    }
    const n = p.notices;
    if (n) {
      for (const [t, v] of Object.entries(n.types ?? {})) if (v !== undefined) kv(`notice.${t}`, s1(v), `notices.types.${t}`, s1(on(`notice.${t}`)));
      for (const [k, v] of Object.entries(n.alerts ?? {})) if (v !== undefined) kv(`notice.alert.${k}`, s1(v), `notices.alerts.${k}`, s1(on(`notice.alert.${k}`)));
      if (n.groupWindowMin !== undefined) kv('notice.group_min', String(n.groupWindowMin), 'notices.groupWindowMin', String(intOr(hq.setting('notice.group_min'), 5)));
      if (n.skipWhileDesk !== undefined) kv('notice.skip_desk', s1(n.skipWhileDesk), 'notices.skipWhileDesk', s1(on('notice.skip_desk')));
    }
    const kinds = new Set(queue.trustTable().map((k) => k.kind));
    const t = p.trust;
    if (t) {
      const unknown = [...Object.keys(t.thresholds ?? {}), ...Object.keys(t.levels ?? {})].filter((k) => !kinds.has(k));
      if (unknown.length) return fail(422, 'unknown_kind', { kinds: unknown });
      if (t.defaultThreshold !== undefined) kv('trust_threshold', String(t.defaultThreshold), 'trust.defaultThreshold', String(intOr(hq.setting('trust_threshold'), defaults.trustThreshold)));
      for (const [kind, v] of Object.entries(t.thresholds ?? {})) {
        const key = `trust_threshold:${kind}`;
        const old = stored(key) ?? '';
        const next = v === null ? '' : String(v);
        if (old !== next) out.push({ key: `trust.thresholds.${kind}`, old, next, write: () => (v === null ? void db.prepare('DELETE FROM settings WHERE key = ?').run(key) : hq.setSetting(key, next)) });
      }
      for (const [kind, level] of Object.entries(t.levels ?? {})) {
        const cur = queue.level(kind);
        if (cur !== level) out.push({ key: `trust.levels.${kind}`, old: String(cur), next: String(level), write: () => d.setLevel(kind, level) });
      }
    }
    const l = p.limits;
    if (l) {
      for (const [dept, usd] of Object.entries(l.deptBudgetUsd ?? {})) {
        if (usd === undefined) continue;
        if (!hq.budgetAgent(dept)) return fail(422, 'unknown_department', { department: dept });
        const old = hq.deptBudget(dept);
        if (old !== usd) out.push({ key: `limits.deptBudgetUsd.${dept}`, old: String(old), next: String(usd), write: () => void hq.setDeptBudget(dept, usd) });
      }
      if (l.clientLlmDailyCap !== undefined) {
        const cap = l.clientLlmDailyCap;
        const old = String(sv.clientLlmDailyCap);
        if (old !== String(cap)) out.push({ key: 'limits.clientLlmDailyCap', old, next: String(cap), write: () => { hq.setSetting('client_llm_cap', String(cap)); d.limiters().forEach((x) => x.setDailyCap(cap)); } });
      }
    }
    const c = p.calls;
    if (c) {
      if (c.slotHours !== undefined) {
        const slots = c.slotHours;
        const next = slots.join(',');
        const old = sv.slotHours.join(',');
        if (old !== next) out.push({ key: 'calls.slotHours', old, next, write: () => { hq.setSetting('slot_hours', next); d.slotHours[0] = slots[0]; d.slotHours[1] = slots[1]; } });
      }
      if (c.durationMin !== undefined) kv('call_min', String(c.durationMin), 'calls.durationMin', String(intOr(hq.setting('call_min'), 30)));
      if (c.bufferMin !== undefined) kv('call_buffer_min', String(c.bufferMin), 'calls.bufferMin', String(intOr(hq.setting('call_buffer_min'), 0)));
    }
    const k = p.kp;
    if (k) {
      if (k.validDays !== undefined) kv('kp_valid_days', String(k.validDays), 'kp.validDays', String(sv.kpValidDays()));
      if (k.defaultLang !== undefined) kv('kp_lang', k.defaultLang, 'kp.defaultLang', hq.setting('kp_lang') === 'en' ? 'en' : 'ru');
    }
    const g = p.playground;
    if (g) {
      if (g.draftMsgsPerDay !== undefined) kv('pg_limit_draft', String(g.draftMsgsPerDay), 'playground.draftMsgsPerDay', String(intOr(hq.setting('pg_limit_draft'), 50)));
      if (g.liveMsgsPerDay !== undefined) kv('pg_limit_live', String(g.liveMsgsPerDay), 'playground.liveMsgsPerDay', String(intOr(hq.setting('pg_limit_live'), 500)));
    }
    const sr = p.service;
    if (sr) {
      if (sr.tgApprovalCards !== undefined) kv('flag.tg_approval_cards', s1(sr.tgApprovalCards), 'service.tgApprovalCards', s1(sv.tgApprovalCards));
      if (sr.tgGroupReports !== undefined) kv('flag.tg_group_reports', s1(sr.tgGroupReports), 'service.tgGroupReports', s1(sv.tgGroupReports));
    }
    const ap = p.autopilot;
    if (ap?.leadManager !== undefined) kv('autopilot.leadManager', ap.leadManager, 'autopilot.leadManager', autopilotMode());
    if (ap?.support !== undefined) kv('autopilot.support', ap.support, 'autopilot.support', autopilotMode('autopilot.support'));
    const mk = p.marketing;
    if (mk?.cadence !== undefined) {
      const c = mk.cadence;
      const next = JSON.stringify({ days: [...new Set(c.days)].sort((a, b) => a - b), time: c.time.padStart(5, '0'), platforms: [...new Set(c.platforms)] });
      kv(CADENCE_KEY, next, 'marketing.cadence', JSON.stringify(cadenceOf(hq)));
    }
    return out;
  }

  /** `PATCH /admin/settings`: a partial body, all or nothing; answers the whole settings again plus `changed` (the keys). `source`: who wrote it in `settings_log`. */
  function patch(body: unknown, source = 'owner'): AdminReply {
    const parsed = patchBody.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid', { fields: parsed.error.issues.slice(0, 10).map((i) => i.path.join('.')) });
    const changes = plan(parsed.data);
    if (!Array.isArray(changes)) return changes;
    db.transaction(() => {
      for (const ch of changes) {
        ch.write();
        log(ch.key, ch.old, ch.next, source);
      }
    })();
    if (changes.some((c) => c.key.startsWith('schedule.'))) d.onSchedule();
    if (changes.length) hq.log('owner', 'settings_changed', 'settings', changes.map((c) => c.key).join(',').slice(0, 300));
    return ok({ changed: changes.map((c) => c.key), ...view() });
  }

  /** The journal, newest first (tests, the owner's «что менялось»). */
  function history(limit = 50): { at: number; key: string; old: string; new: string; source: string }[] {
    return db.prepare('SELECT at, key, old, new, source FROM settings_log ORDER BY id DESC LIMIT ?').all(limit) as { at: number; key: string; old: string; new: string; source: string }[];
  }

  /** `GET /admin/settings/log?limit=`: the last entries (1..200, default 50), newest first, only the values of settings. */
  function logView(query: URLSearchParams): AdminReply {
    const raw = Number(query.get('limit') ?? 50);
    const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.trunc(raw))) : 50;
    // defence in depth: every key written here is a plain setting, but a key that names a secret never shows its values
    const secret = (key: string) => /token|secret|password|passwd|api[_-]?key|private/i.test(key);
    const items = history(limit).map((r) => ({ at: new Date(r.at).toISOString(), key: r.key, old: secret(r.key) ? '***' : r.old, new: secret(r.key) ? '***' : r.new, source: r.source }));
    return ok({ items });
  }

  /**
   * The first department limits (owner 2026-11-23, API budget 100 USD a month): written once, when every limit is still 0 (`limits_seeded` marks it, so a limit
   * the owner sets back to 0 later stays 0). The 80% and 100% alerts of `recordCost` then work as they always did.
   */
  function seedBudgets(): boolean {
    if (stored('limits_seeded') !== null) return false;
    hq.setSetting('limits_seeded', '1');
    if (DEPT_BUDGET_KEYS.some((k) => hq.deptBudget(k) > 0)) return false;
    let any = false;
    for (const k of DEPT_BUDGET_KEYS) {
      if (!hq.setDeptBudget(k, SEED_BUDGETS[k])) continue;
      log(`limits.deptBudgetUsd.${k}`, '0', String(SEED_BUDGETS[k]), SEED_SOURCE);
      any = true;
    }
    return any;
  }

  return { get, patch, view, history, logView, seedBudgets };
}

export type SettingsApi = ReturnType<typeof createSettings>;
