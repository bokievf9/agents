/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { describe, expect, it } from 'vitest';
import { createAdmin } from '../src/admin.js';
import { RateLimiter } from '../src/client/sanitize.js';
import { pultLinks } from '../src/links.js';
import { OwnerNotices } from '../src/notices.js';
import { SEED_SOURCE, createSettings, startValues, type SettingsDefaults } from '../src/settings.js';
import { OWNER } from './helpers.js';
import { pultWorld } from './pult-helpers.js';

const DEFAULTS: SettingsDefaults = { trustThreshold: 20, slotHours: ['11:00', '15:00'], kpValidDays: 14, clientLlmDailyCap: 300, tgApprovalCards: false, tgGroupReports: false };

function setup() {
  const p = pultWorld();
  const { w } = p;
  const limiter = new RateLimiter(20, 300, () => w.clock.t, () => w.hq.tz);
  const slotHours: [string, string] = ['11:00', '15:00'];
  let scheduled = 0;
  const settings = createSettings({
    hq: w.hq, queue: w.queue, defaults: DEFAULTS, slotHours, now: () => w.clock.t, limiters: () => [limiter],
    setLevel: (kind, level) => void w.director.levelCommand(`${kind} ${level}`),
    onSchedule: () => { scheduled++; w.director.start(); },
  });
  const sent: string[] = [];
  const notices = new OwnerNotices({ hq: w.hq, links: pultLinks(), deliver: (html) => { sent.push(html); return Promise.resolve('sent'); } });
  const patch = (b: unknown) => settings.patch(b);
  return { p, w, settings, limiter, slotHours, notices, sent, patch, scheduled: () => scheduled };
}

describe('GET and PATCH /admin/settings', () => {
  it('GET: every group with its effective value (the env is the default), the trust table with thresholds, usage next to the limits', () => {
    const { settings, w } = setup();
    const r = settings.get();
    expect(r.status).toBe(200);
    const b = r.body as any;
    expect(b.ok).toBe(true);
    expect(b.settings.schedule).toMatchObject({ summaryTime: '08:00', approvalTime: '09:00', digestDay: 1, digestTime: '08:30', ownerTz: 'Asia/Kuala_Lumpur', tz: 'Asia/Dushanbe' });
    expect(b.settings.notices.types).toMatchObject({ client: true, lead: true, approval: true, payment: true, stage: true, signed: true, call: true, chat: true, human: true });
    expect(b.settings.notices.alerts).toMatchObject({ lost_lead: true, email_failed: true, llm: true, budget: true, service: true });
    expect(b.settings.notices).toMatchObject({ groupWindowMin: 5, skipWhileDesk: true });
    expect(b.settings.trust.defaultThreshold).toBe(20);
    expect(b.settings.trust.kinds.length).toBeGreaterThan(0);
    for (const k of b.settings.trust.kinds) expect(Object.keys(k).sort()).toEqual(['approvals', 'custom', 'kind', 'level', 'locked', 'streak', 'threshold']);
    expect(b.settings.limits.clientLlmDailyCap).toBe(300);
    expect(Object.keys(b.settings.limits.deptBudgetUsd).sort()).toEqual(['backoffice', 'director', 'marketing', 'production', 'sales', 'support']);
    expect(b.settings.calls).toEqual({ slotHours: ['11:00', '15:00'], durationMin: 30, bufferMin: 0 });
    expect(b.settings.kp).toEqual({ validDays: 14, defaultLang: 'ru' });
    expect(b.settings.playground).toEqual({ draftMsgsPerDay: 50, liveMsgsPerDay: 500 });
    expect(b.settings.service).toEqual({ tgApprovalCards: false, tgGroupReports: false });
    expect(b.usage.deptMonthUsd).toMatchObject({ marketing: 0 });
    expect(b.restartRequired).toBe(false);
    expect(b.restartKeys).toEqual([]);
    expect(w.hq.setting('summary_time')).toBe('08:00');
  });

  it('validation: a bad value, an unknown key, an unknown kind or department answers 400 or 422 and nothing is written (all or nothing)', () => {
    const { patch, settings, w } = setup();
    expect(patch({ schedule: { summaryTime: '25:00' } }).status).toBe(400);
    expect(patch({ schedule: { digestDay: 7 } }).status).toBe(400);
    expect(patch({ schedule: { ownerTz: 'Mars/Base' } }).status).toBe(400);
    expect(patch({ nonsense: 1 }).status).toBe(400);
    expect(patch({ limits: { deptBudgetUsd: { marketing: -1 } } }).status).toBe(400);
    expect(patch({ limits: { deptBudgetUsd: { cooking: 5 } } }).status).toBe(400);
    expect(patch({ calls: { slotHours: ['11:00'] } }).status).toBe(400);
    const bad = patch({ schedule: { summaryTime: '07:15' }, trust: { levels: { no_such_kind: 1 } } });
    expect(bad.status).toBe(422);
    expect((bad.body as any).error).toBe('unknown_kind');
    const noDept = patch({ schedule: { summaryTime: '07:15' }, limits: { deptBudgetUsd: { sales: 5 } } }); // pultWorld has no Sales head
    expect(noDept.status).toBe(422);
    expect((noDept.body as any).error).toBe('unknown_department');
    expect(w.hq.setting('summary_time')).toBe('08:00');
    expect(settings.history()).toEqual([]);
  });

  it('the schedule is applied at once without a restart: the Director\'s cron jobs follow, and every change is journaled (key, old, new)', () => {
    const { patch, settings, w, scheduled } = setup();
    const r = patch({ schedule: { summaryTime: '09:30', digestDay: 3, quietHours: { from: '22:00', to: '07:00' }, ownerTz: 'Asia/Dubai' } });
    expect(r.status).toBe(200);
    const b = r.body as any;
    expect(b.changed.sort()).toEqual(['schedule.digestDay', 'schedule.ownerTz', 'schedule.quietHours', 'schedule.summaryTime']);
    expect(b.restartRequired).toBe(false);
    expect(b.settings.schedule).toMatchObject({ summaryTime: '09:30', digestDay: 3, quietHours: { from: '22:00', to: '07:00' }, ownerTz: 'Asia/Dubai' });
    expect(scheduled()).toBe(1);
    const plan = w.director.schedulePlan();
    expect(plan.find((x) => x.name === 'director-summary')).toMatchObject({ cron: '30 9 * * *', tz: 'Asia/Dubai' });
    expect(plan.find((x) => x.name === 'director-digest')).toMatchObject({ cron: '30 8 * * 3' });
    expect(w.hq.isQuiet(Date.UTC(2026, 10, 22, 19, 0))).toBe(true); // 23:00 in Dubai (UTC+4)
    const log = settings.history();
    expect(log.map((l) => l.key).sort()).toEqual(['schedule.digestDay', 'schedule.ownerTz', 'schedule.quietHours', 'schedule.summaryTime']);
    expect(log.find((l) => l.key === 'schedule.summaryTime')).toMatchObject({ old: '08:00', new: '09:30', source: 'owner' });
    // the same body again changes nothing and writes nothing
    expect((patch({ schedule: { summaryTime: '09:30' } }).body as any).changed).toEqual([]);
    expect(settings.history()).toHaveLength(4);
    // quiet hours off
    expect((patch({ schedule: { quietHours: null } }).body as any).settings.schedule.quietHours).toBeNull();
  });

  it('reminders: a type switched off is never sent and never replayed; the grouping window and the alert kinds follow the settings', async () => {
    const { patch, notices, sent, w } = setup();
    patch({ notices: { types: { lead: false }, alerts: { budget: false } } });
    await notices.push('lead', 'Новая заявка #1.', 'https://firtech.pro/admin/office', 'lead:1');
    await notices.push('client', 'Новый клиент: Анвар.', 'https://firtech.pro/admin/office', 'client:1');
    await notices.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Новый клиент');
    expect(await notices.alert('бюджет', { kind: 'budget', short: 'Расходы 80%' })).toBe(false);
    expect(await notices.alert('письмо', { kind: 'email_failed', short: 'Письмо не ушло' })).toBe(true);
    patch({ notices: { types: { lead: true } } });
    await notices.flush();
    expect(sent.some((s) => s.includes('заявка #1'))).toBe(false); // what came while it was off stays muted
    // grouping window 0: every notice alone, even the same type twice in a row
    patch({ notices: { groupWindowMin: 0 } });
    w.clock.t += 1000;
    await notices.push('client', 'Новый клиент: Роза.', 'https://firtech.pro/admin/office', 'client:2');
    await notices.flush();
    await notices.push('client', 'Новый клиент: Зарина.', 'https://firtech.pro/admin/office', 'client:3');
    await notices.flush();
    expect(sent.filter((s) => s.includes('Новый клиент')).length).toBe(3);
  });

  it('trust: the threshold per kind (and the global one) is read by the queue, the level is set the way /level does, GET shows both', () => {
    const { patch, settings, w } = setup();
    const kind = w.queue.trustTable().find((k) => !k.locked)!.kind;
    w.queue.thresholdFor = startValues(w.hq, DEFAULTS).trustThreshold;
    expect(w.queue.thresholdFor(kind)).toBe(20);
    patch({ trust: { defaultThreshold: 10 } });
    expect(w.queue.thresholdFor(kind)).toBe(10);
    const r = patch({ trust: { thresholds: { [kind]: 5 }, levels: { [kind]: 1 } } }).body as any;
    expect(w.queue.thresholdFor(kind)).toBe(5);
    expect(w.queue.level(kind)).toBe(1);
    expect(r.settings.trust.kinds.find((k: any) => k.kind === kind)).toMatchObject({ level: 1, threshold: 5, custom: true });
    patch({ trust: { thresholds: { [kind]: null } } });
    expect(w.queue.thresholdFor(kind)).toBe(10);
    expect(settings.history().some((l) => l.key === `trust.levels.${kind}` && l.old === '0' && l.new === '1')).toBe(true);
  });

  it('limits: a department limit goes to the head\'s budget at once (overBudget reads it), the Director\'s own work is limited on the Director, the client cap reaches the gates', () => {
    const { patch, w, limiter, settings } = setup();
    const r = patch({ limits: { deptBudgetUsd: { marketing: 25, support: 15, director: 5 }, clientLlmDailyCap: 2 } }).body as any;
    expect(r.settings.limits.deptBudgetUsd).toMatchObject({ marketing: 25, support: 15, director: 5 });
    expect(w.hq.agent('marketing-head')!.budgetUsdMonth).toBe(25);
    expect(w.hq.deptBudget('marketing')).toBe(25);
    expect(w.hq.deptBudget('hq')).toBe(5);
    w.hq.recordCost({ agentId: 'director', model: 'x', inputTokens: 0, outputTokens: 0, usd: 5.5 });
    expect(w.hq.overBudget('hq')).toBe(true);
    expect(w.hq.overBudget('marketing')).toBe(false);
    expect((settings.get().body as any).usage.deptMonthUsd.director).toBe(5.5);
    expect(r.settings.limits.clientLlmDailyCap).toBe(2);
    expect(limiter.llmAllowed()).toBe(true);
    limiter.llmUsed();
    limiter.llmUsed();
    expect(limiter.llmAllowed()).toBe(false); // the cap of 2 applies to the running gate
  });

  it('calls, КП, agents of the platform and the service flags: stored, applied where they are read live, the flags say restartRequired', () => {
    const { patch, w, slotHours } = setup();
    const r = patch({
      calls: { slotHours: ['10:00', '16:30'], durationMin: 45, bufferMin: 15 }, kp: { validDays: 30, defaultLang: 'en' },
      playground: { draftMsgsPerDay: 20, liveMsgsPerDay: 800 }, service: { tgApprovalCards: true },
    }).body as any;
    expect(slotHours).toEqual(['10:00', '16:30']); // the pair the Sales worker holds changes in place
    expect(r.settings.calls).toEqual({ slotHours: ['10:00', '16:30'], durationMin: 45, bufferMin: 15 });
    expect(startValues(w.hq, DEFAULTS).kpValidDays()).toBe(30);
    expect(r.settings.kp).toEqual({ validDays: 30, defaultLang: 'en' });
    expect(r.settings.playground).toEqual({ draftMsgsPerDay: 20, liveMsgsPerDay: 800 });
    expect(r.restartRequired).toBe(true);
    expect(r.restartKeys).toEqual(['service.tgApprovalCards']);
    expect(startValues(w.hq, DEFAULTS).tgApprovalCards).toBe(true); // the next start takes it
  });

  it('the first department limits are written once when every limit is 0 («seed 2026-11-23»), never over the owner\'s own values, never twice', () => {
    const a = setup();
    expect(a.settings.seedBudgets()).toBe(true);
    expect(a.w.hq.deptBudget('marketing')).toBe(25);
    expect(a.w.hq.deptBudget('hq')).toBe(5);
    const seeded = a.settings.history().filter((l) => l.source === SEED_SOURCE);
    expect(seeded.map((l) => l.key).sort()).toEqual(['limits.deptBudgetUsd.director', 'limits.deptBudgetUsd.marketing', 'limits.deptBudgetUsd.production', 'limits.deptBudgetUsd.support']);
    expect(seeded.find((l) => l.key === 'limits.deptBudgetUsd.marketing')).toMatchObject({ old: '0', new: '25' });
    a.patch({ limits: { deptBudgetUsd: { marketing: 0 } } });
    expect(a.settings.seedBudgets()).toBe(false); // marked: the owner's 0 stays
    expect(a.w.hq.deptBudget('marketing')).toBe(0);

    const b = setup();
    b.w.hq.setDeptBudget('marketing', 7);
    expect(b.settings.seedBudgets()).toBe(false); // somebody has a limit: nothing is written
    expect(b.w.hq.deptBudget('support')).toBe(0);
  });

  it('the admin API serves GET and PATCH on /admin/settings and 503 without the settings object', async () => {
    const { w, settings } = setup();
    const mk = (withSettings: boolean) => createAdmin({ hq: w.hq, queue: w.queue, director: w.director, channel: w.channel!, ownerId: OWNER, now: () => w.clock.t, commandNames: [], ...(withSettings ? { settings } : {}) });
    const on = mk(true);
    const get = await on.handle({ method: 'GET', path: '/admin/settings', query: new URLSearchParams(), body: null });
    expect(get.status).toBe(200);
    const patched = await on.handle({ method: 'PATCH', path: '/admin/settings', query: new URLSearchParams(), body: { kp: { validDays: 21 } } });
    expect(patched.status).toBe(200);
    expect((patched.body as any).changed).toEqual(['kp.validDays']);
    expect((await mk(false).handle({ method: 'GET', path: '/admin/settings', query: new URLSearchParams(), body: null })).status).toBe(503);
  });
});

describe('autopilot.leadManager and the human alert (Fira hooks)', () => {
  it('defaults to policy, accepts the three modes, rejects others, journals the change; the human alert reaches Telegram', async () => {
    const { settings, patch, notices, w } = setup();
    expect((settings.get().body as any).settings.autopilot).toEqual({ leadManager: 'policy' });
    const r = patch({ autopilot: { leadManager: 'autopilot' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: ['autopilot.leadManager'] });
    expect(w.hq.setting('autopilot.leadManager')).toBe('autopilot');
    expect(settings.history()[0]).toMatchObject({ key: 'autopilot.leadManager', old: 'policy', new: 'autopilot' });
    expect(patch({ autopilot: { leadManager: 'ask_me' } }).status).toBe(200);
    expect(patch({ autopilot: { leadManager: 'yolo' } }).status).toBe(400);
    expect(w.hq.setting('autopilot.leadManager')).toBe('ask_me');
    expect(await notices.alert('Нужен человек: вопрос о скидке', { kind: 'human' })).toBe(true);
    patch({ notices: { alerts: { human: false } } });
    expect(await notices.alert('Нужен человек', { kind: 'human' })).toBe(false);
  });
});
