/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { Cron } from 'croner';
import { describe, expect, it } from 'vitest';
import { seedOrg } from '../src/org.js';
import { AGENT_STATUSES } from '../src/office.js';
import { instructionsDir } from './helpers.js';
import { pultWorld, serve } from './pult-helpers.js';
import { TOOL_POLICY, createTools } from '@fir/core';
import { appTools } from '../src/tools.js';

const DAY = 86_400_000;

describe('GET /admin/company/playbooks/:role', () => {
  it('the whole markdown of a role; unknown role or missing file is 404', async () => {
    const p = pultWorld();
    const r = await p.call('GET', '/admin/company/playbooks/seo');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, role: 'seo' });
    expect(r.json.text).toContain('## Правила');
    expect((await p.call('GET', '/admin/company/playbooks/nope')).status).toBe(404);
    expect((await p.call('POST', '/admin/company/playbooks/seo', {})).status).toBe(404);
  });
});

describe('GET /admin/company', () => {
  it('tools: every tool with departments, set-up state (never a key), today\'s calls and errors, limits', async () => {
    const plain = pultWorld();
    const none = (await plain.call('GET', '/admin/company')).json.tools as any[];
    expect(none).toHaveLength(TOOL_POLICY.length);
    for (const t of none) expect(Object.keys(t).sort()).toEqual(['callsToday', 'configured', 'departments', 'env', 'errorsToday', 'limits', 'name']);
    expect(none.find((t) => t.name === 'email.send').configured).toBe(false);

    const app = appTools(plain.w.hq, { enabled: true, complete: () => Promise.resolve('') }, {
      dataDir: '/tmp/x', rendersDir: '/tmp/x/renders', knowledgeDir: undefined, mediaSecret: 'm', igPublicBase: 'https://hq.example/media', braveSearchKey: 'BRAVE-SECRET', resendApiKey: 'RESEND-SECRET',
      emailFrom: 'a@b.co', gscServiceAccountJson: undefined, gscSiteUrl: undefined, youtubeApiKey: undefined, youtubeChannelId: undefined, ytOauthClientJson: undefined, ytRefreshToken: undefined, trongridApiKey: undefined, toncenterApiKey: undefined,
    });
    const p = pultWorld({ admin: { tools: app } });
    const t = createTools({ agentId: 'content-maker', dept: 'marketing', journal: p.w.hq, db: p.w.db, now: p.w.hq.now, tz: p.w.hq.tz });
    await t.media.qr('x'); // not allowed for marketing: one call, one error
    await t.cache.set('k', 1, 1000);
    const r = await p.call('GET', '/admin/company');
    const by = Object.fromEntries((r.json.tools as any[]).map((x) => [x.name, x]));
    expect(by['media.qr']).toMatchObject({ callsToday: 1, errorsToday: 1, departments: ['sales', 'support', 'backoffice'] });
    expect(by['cache.set']).toMatchObject({ callsToday: 1, errorsToday: 0 });
    expect(by['email.send'].configured).toBe(true);
    expect(by['files.url'].configured).toBe(true);
    expect(by['llm.json'].configured).toBe(true);
    expect(by['media.png'].configured).toBe(true);
    expect(by['crm.leads'].configured).toBe(true);
    expect(by['google.searchConsole'].configured).toBe(false);
    expect(by['web.search'].limits).toMatchObject({ minGapMs: 1000, cacheTtlMs: 3_600_000 });
    expect(JSON.stringify(r.json)).not.toMatch(/BRAVE-SECRET|RESEND-SECRET/);
  });

  it('401 without the token; routines, costs, trust, playbooks and workers in the contract shape', async () => {
    const p = pultWorld();
    const s = await serve(p);
    expect((await s.http('GET', '/admin/company', undefined, {})).status).toBe(401);
    await s.close();
    const r = await p.call('GET', '/admin/company');
    expect(r.status).toBe(200);
    const j = r.json;
    expect(j.ok).toBe(true);
    expect(j.routines.length).toBeGreaterThan(5);
    for (const x of j.routines) expect(Object.keys(x).sort()).toEqual(['cron', 'dept', 'enabled', 'lastRunAt', 'lastStatus', 'name', 'nextRunAt', 'title', 'tz']);
    expect(Object.keys(j.costs).sort()).toEqual(['byDay', 'byDept']);
    expect(j.playbooks.map((x: any) => x.role)).toEqual(['content-maker', 'publisher', 'trend-scout', 'seo', 'analyst', 'sales', 'renderer-builder']);
    for (const x of j.playbooks) {
      expect(Object.keys(x).sort()).toEqual(['lines', 'role', 'sourceSkills', 'updatedAt']);
      expect(x.lines).toBeGreaterThan(10);
      expect(Number.isNaN(Date.parse(x.updatedAt))).toBe(false);
    }
    expect(j.playbooks.find((x: any) => x.role === 'seo').sourceSkills).toEqual(['seo-audit', 'ai-seo', 'programmatic-seo', 'schema', 'site-architecture']);
    expect(j.trust.length).toBeGreaterThan(3);
    for (const t of j.trust) expect(Object.keys(t).sort()).toEqual(['approvals', 'kind', 'level', 'locked']);
    expect(j.workers.length).toBeGreaterThan(10);
    for (const x of j.workers) {
      expect(Object.keys(x).sort()).toEqual(['dept', 'id', 'state', 'title']);
      expect(AGENT_STATUSES).toContain(x.state);
    }
    expect(j.workers.find((x: any) => x.id === 'content-maker')).toMatchObject({ dept: 'marketing', title: 'Content Maker' });
  });

  it('nextRunAt comes from the cron in the routine\'s own clock (owner or company), disabled ones have none', async () => {
    const p = pultWorld();
    const r = await p.call('GET', '/admin/company');
    const pack = r.json.routines.find((x: any) => x.name === 'marketing-weekly-pack');
    expect(pack.tz).toBe(p.w.hq.ownerTz);
    const expected = new Cron('0 6 * * 1', { timezone: p.w.hq.ownerTz, paused: true }).nextRun(new Date(p.t()))!;
    expect(pack.nextRunAt).toBe(expected.toISOString());
    const daily = r.json.routines.find((x: any) => x.name === 'marketing-daily-today');
    expect(daily.tz).toBe(p.w.hq.tz);
    expect(daily.nextRunAt).toBe(new Cron('0 9 * * *', { timezone: p.w.hq.tz, paused: true }).nextRun(new Date(p.t()))!.toISOString());
    expect(pack.lastRunAt).toBeNull();
    expect(pack.lastStatus).toBeNull();
    await p.call('POST', '/admin/company/routines/marketing-daily-today', { enabled: false });
    const again = await p.call('GET', '/admin/company');
    expect(again.json.routines.find((x: any) => x.name === 'marketing-daily-today')).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('costs: today and month by department with the limit, the last 30 days by day', async () => {
    const p = pultWorld({ budget: 50 });
    const { hq } = p.w;
    const rec = (usd: number, at: number) => { p.w.clock.t = at; hq.recordCost({ agentId: 'marketing-head', model: 'claude-haiku-5-5', inputTokens: 1, outputTokens: 1, usd }); };
    const now = Date.UTC(2026, 10, 18, 7, 0);
    rec(1.5, now - 60_000); rec(0.5, now - 2 * 60_000); // today (12:00 in Tashkent)
    rec(2, now - 3 * DAY); // Sunday 15.11: this month, not today
    rec(4, now - 20 * DAY); // 29.10: last month, but inside the 30 days
    rec(7, now - 40 * DAY); // outside the 30 days
    p.w.clock.t = now;
    const r = await p.call('GET', '/admin/company');
    expect(r.json.costs.byDept.marketing).toEqual({ todayUsd: 2, monthUsd: 4, limitUsd: 50 });
    expect(r.json.costs.byDept.support).toEqual({ todayUsd: 0, monthUsd: 0, limitUsd: 0 });
    const days = r.json.costs.byDay;
    expect(days).toHaveLength(30);
    expect(days.at(-1)).toEqual({ date: '2026-11-18', usd: 2 });
    expect(days[0].date).toBe('2026-10-20');
    expect(days.find((d: any) => d.date === '2026-11-15').usd).toBe(2);
    expect(days.find((d: any) => d.date === '2026-10-29').usd).toBe(4);
    expect(days.reduce((n: number, d: any) => n + d.usd, 0)).toBe(8);
  });

  it('trust lists every kind with its level, lock and the number of approvals', async () => {
    const p = pultWorld();
    const r = await p.call('GET', '/admin/company');
    const kind = (k: string) => r.json.trust.find((t: any) => t.kind === k);
    expect(kind('content_item')).toEqual({ kind: 'content_item', level: 0, locked: false, approvals: 0 });
    expect(kind('billing_invoice')).toMatchObject({ locked: true, level: 0 });
    p.w.hq.runRoutine('marketing-weekly-pack');
    await p.w.marketing.onHeartbeat();
    await p.w.director.sendApprovalBatch(false);
    const first = (await p.call('GET', '/admin/content?week=2026-W48')).json.days.flatMap((d: any) => d.items)[0];
    await p.call('POST', `/admin/content/${first.id}`, { action: 'approve' });
    expect((await p.call('GET', '/admin/company')).json.trust.find((t: any) => t.kind === 'content_item').approvals).toBe(1);
  });
});

describe('POST /admin/company/routines/:name', () => {
  it('switches a routine off and on, tells the app to restart its cron jobs, and the owner\'s switch survives a restart', async () => {
    let restarts = 0;
    const p = pultWorld({ admin: { onRoutinesChange: () => { restarts++; } } });
    const name = 'marketing-daily-today';
    let r = await p.call('POST', `/admin/company/routines/${name}`, { enabled: false });
    expect(r.json).toMatchObject({ ok: true, item: { name, enabled: false, nextRunAt: null } });
    expect(restarts).toBe(1);
    expect(p.w.hq.routineByName(name)!.enabled).toBe(false);
    // the next start syncs the routines from code: the owner's switch stays
    seedOrg(p.w.hq, { instructionsDir, marketingBudgetUsd: 0 });
    expect(p.w.hq.routineByName(name)!.enabled).toBe(false);
    // a disabled routine does not fire
    expect(p.w.hq.runRoutine(name)).toBeNull();
    r = await p.call('POST', `/admin/company/routines/${name}`, { enabled: true });
    expect(r.json.item).toMatchObject({ enabled: true, nextRunAt: expect.stringMatching(/^\d{4}-/) });
    expect(restarts).toBe(2);
    expect(p.w.hq.activity(10).map((a) => a.action)).toEqual(expect.arrayContaining(['routine_disabled', 'routine_enabled']));
  });

  it('validates the body, unknown routine 404, and the route needs a POST', async () => {
    const p = pultWorld();
    const name = 'marketing-daily-today';
    for (const bad of [{}, { enabled: 'yes' }, { enabled: 1 }, { enabled: true, extra: 1 }, null]) {
      expect((await p.call('POST', `/admin/company/routines/${name}`, bad)).json.error, JSON.stringify(bad)).toBe('invalid');
    }
    expect((await p.call('POST', '/admin/company/routines/nope', { enabled: true })).status).toBe(404);
    expect((await p.call('GET', `/admin/company/routines/${name}`)).status).toBe(404);
    expect(p.w.hq.routineByName(name)!.enabled).toBe(true);
  });
});

describe('POST /admin/company/routines/:name/run', () => {
  it('fires the routine now through Hq.runRoutine: a task, last run recorded, the head woken', async () => {
    const p = pultWorld();
    const name = 'marketing-trends-daily';
    const r = await p.call('POST', `/admin/company/routines/${name}/run`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, taskId: expect.any(Number) });
    const t = p.w.hq.task(r.json.taskId)!;
    expect(t).toMatchObject({ dept: 'marketing', creator: 'routine', routineId: p.w.hq.routineByName(name)!.id });
    const list = (await p.call('GET', '/admin/company')).json.routines.find((x: any) => x.name === name);
    expect(list.lastRunAt).toBe(new Date(p.t()).toISOString());
    expect(list.lastStatus).toBe(t.status);
    // the previous task is still open: the `skip` policy refuses a second run
    const again = await p.call('POST', `/admin/company/routines/${name}/run`);
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ ok: false, error: 'not_started', reason: 'busy' });
    expect(p.w.hq.tasks({ dept: 'marketing' }).filter((x) => x.routineId === t.routineId)).toHaveLength(1);
  });

  it('a disabled routine does not run; unknown 404; GET is not a way to run', async () => {
    const p = pultWorld();
    await p.call('POST', '/admin/company/routines/marketing-trends-daily', { enabled: false });
    const r = await p.call('POST', '/admin/company/routines/marketing-trends-daily/run');
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe('disabled');
    expect((await p.call('POST', '/admin/company/routines/nope/run')).status).toBe(404);
    expect((await p.call('GET', '/admin/company/routines/marketing-trends-daily/run')).status).toBe(404);
  });
});

describe('POST /admin/company/trust/:kind', () => {
  it('changes the level with the code of /level, a locked kind included, and says what the item is now', async () => {
    const p = pultWorld();
    const q = p.w.queue;
    let r = await p.call('POST', '/admin/company/trust/content_item', { level: 1 });
    expect(r.json).toEqual({ ok: true, item: { kind: 'content_item', level: 1, locked: false, approvals: 0 } });
    expect(q.level('content_item')).toBe(1);
    r = await p.call('POST', '/admin/company/trust/content_item', { level: 0 });
    expect(r.json.item.level).toBe(0);
    expect(q.level('content_item')).toBe(0);
    // money kinds are locked at level 0 and move only by the owner's own decision (the way /level unlocks)
    r = await p.call('POST', '/admin/company/trust/billing_invoice', { level: 1 });
    expect(r.json.item).toMatchObject({ kind: 'billing_invoice', level: 1, locked: true });
    expect(q.level('billing_invoice')).toBe(1);
    // the same effect as the Telegram command
    await p.w.director.onCommand('level', 'billing_invoice 0');
    expect(q.level('billing_invoice')).toBe(0);
    expect(p.w.hq.activity(10).filter((a) => a.action === 'level_set').length).toBeGreaterThanOrEqual(4);
  });

  it('validates the level (0 or 1 only), unknown kind 404', async () => {
    const p = pultWorld();
    for (const bad of [{}, { level: 2 }, { level: '1' }, { level: -1 }, { level: 1, extra: true }, null]) {
      const r = await p.call('POST', '/admin/company/trust/content_item', bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.json).toMatchObject({ error: 'invalid', allowed: [0, 1] });
    }
    expect((await p.call('POST', '/admin/company/trust/nope', { level: 1 })).status).toBe(404);
    expect((await p.call('POST', '/admin/company/trust/content_item%ZZ', { level: 1 })).status).toBe(404);
    expect(p.w.queue.level('content_item')).toBe(0);
  });
});
