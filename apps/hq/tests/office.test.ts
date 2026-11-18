import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { openDb } from '@fir/core';
import { Hq } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { buildOffice, cachedOffice, deriveStatus, officeSchema, publicActivity, publicTitle } from '../src/office.js';
import { createWebhook } from '../src/webhook.js';
import { NOW } from './helpers.js';

function world(now = NOW) {
  const hq = new Hq(openDb(':memory:'), { now: () => now });
  hq.upsertAgent({ id: 'director', dept: 'hq', role: 'director', title: 'Директор' });
  hq.upsertAgent({ id: 'marketing-head', dept: 'marketing', role: 'head', title: 'Голова маркетинга' });
  hq.upsertAgent({ id: 'content-maker', dept: 'marketing', role: 'worker', title: 'Контент-мейкер', bossId: 'marketing-head' });
  hq.upsertAgent({ id: 'sales-head', dept: 'sales', role: 'head', title: 'Голова продаж' });
  return hq;
}

const facts = (o: Partial<Parameters<typeof deriveStatus>[0]> = {}) => ({ paused: false, sleeping: false, tasks: [], lastSeenAt: NOW, now: NOW, ...o });

describe('GET /office access', () => {
  async function start(office?: { token: string; get: () => unknown }) {
    const server = createWebhook(() => Promise.resolve(1), 'lead', Date.now, office);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/office` };
  }
  it('404 without OFFICE_TOKEN, 401 on a wrong token, 200 with the right one', async () => {
    const off = await start();
    try {
      expect((await fetch(off.url, { headers: { 'x-office-token': 'x' } })).status).toBe(404);
    } finally { off.server.close(); }
    const hq = world();
    const on = await start({ token: 'office-secret', get: cachedOffice(hq) });
    try {
      expect((await fetch(on.url)).status).toBe(401);
      expect((await fetch(on.url, { headers: { 'x-office-token': 'nope' } })).status).toBe(401);
      expect((await fetch(on.url, { headers: { 'x-lead-token': 'lead' } })).status).toBe(401);
      const ok = await fetch(on.url, { headers: { 'x-office-token': 'office-secret' } });
      expect(ok.status).toBe(200);
      expect(officeSchema.safeParse(await ok.json()).success).toBe(true);
    } finally { on.server.close(); }
  });
});

describe('office data', () => {
  it('matches the schema on an empty and on a busy database', () => {
    const hq = world();
    expect(officeSchema.parse(buildOffice(hq, NOW)).departments.map((d) => d.id)).toEqual(['marketing', 'sales']);
    const t = hq.createTask({ title: 'Клип: ИИ-приёмщик', dept: 'marketing', creator: 'head', assigneeId: 'content-maker' });
    hq.claim(t.id, 'content-maker');
    hq.recordCost({ agentId: 'content-maker', model: 'x', inputTokens: 100, outputTokens: 50, usd: 0.5, taskId: t.id });
    const o = officeSchema.parse(buildOffice(hq, NOW));
    const w = o.departments[0]!.workers[0]!;
    expect(w).toMatchObject({ id: 'content-maker', status: 'working', tasksToday: 1, costTodayUsd: 0.5, currentTask: { id: t.id, title: 'Клип: ИИ-приёмщик' } });
    expect(o.costs).toMatchObject({ todayUsd: 0.5, tokensToday: 150, byDept: { marketing: 0.5 } });
    expect(o.tasks.counts.running).toBe(1);
    expect(o.health.firtech.ok).toBeNull();
  });

  it('caches for 5 seconds', () => {
    const hq = world();
    let clock = 1000;
    const get = cachedOffice(hq, 5000, () => clock);
    const a = get();
    hq.createTask({ title: 'новая', dept: 'marketing', creator: 'owner' });
    clock += 4000;
    expect(get()).toBe(a);
    clock += 1500;
    expect(get()).not.toBe(a);
  });

  it('counts pending approvals and builder issues', () => {
    const hq = world();
    const t = hq.createTask({ title: 'нужен строитель', dept: 'marketing', creator: 'head', tags: ['builder'] });
    hq.block(t.id, 'head', 'x');
    expect(buildOffice(hq, NOW).director.openBuilderIssues).toBe(0);
    hq.setMeta(t.id, { issue: { number: 3, url: 'u' } });
    expect(buildOffice(hq, NOW).director.openBuilderIssues).toBe(1);
  });
});

describe('status derivation', () => {
  it('covers the main cases', () => {
    expect(deriveStatus(facts({ paused: true }))).toBe('paused');
    expect(deriveStatus(facts({ tasks: [{ status: 'running', updatedAt: NOW }] }))).toBe('working');
    expect(deriveStatus(facts({ tasks: [{ status: 'approval', updatedAt: NOW }, { status: 'done', updatedAt: NOW - 1 }] }))).toBe('waiting');
    expect(deriveStatus(facts({ tasks: [{ status: 'review', updatedAt: NOW }] }))).toBe('waiting');
    expect(deriveStatus(facts({ tasks: [{ status: 'blocked', updatedAt: NOW }] }))).toBe('blocked');
    expect(deriveStatus(facts())).toBe('idle');
    expect(deriveStatus(facts({ sleeping: true }))).toBe('sleeping');
    expect(deriveStatus(facts({ sleeping: true, tasks: [{ status: 'running', updatedAt: NOW }] }))).toBe('working');
    expect(deriveStatus(facts({ tasks: [{ status: 'running', updatedAt: NOW }], lastSeenAt: NOW - 11 * 60_000 }))).toBe('offline');
    expect(deriveStatus(facts({ lastSeenAt: null }))).toBe('idle');
  });

  it('reads paused departments and night hours from the database', () => {
    const hq = world();
    hq.setDeptStatus('marketing', 'paused');
    expect(buildOffice(hq, NOW).departments[0]!.workers[0]!.status).toBe('paused');
    // 2026-11-19 22:00 UTC = 03:00 Tashkent: night
    const night = Date.UTC(2026, 10, 19, 22, 0);
    expect(buildOffice(world(night), night).departments[1]!.head!.status).toBe('sleeping');
    expect(buildOffice(world(), NOW).departments[1]!.head!.status).toBe('idle');
  });
});

describe('privacy', () => {
  it('masks lead and client task titles', () => {
    const hq = world();
    const id = hq.createTask({ title: 'Лид с сайта (bots)', dept: 'sales', creator: 'routine', meta: { action: 'lead', lead: { name: 'Dilnoza', contact: '@dilnoza' } } }).id;
    hq.createTask({ title: 'Проект: Салон Роза', dept: 'sales', creator: 'owner', meta: { action: 'project' } });
    hq.createTask({ title: 'Клип: ИИ-приёмщик', dept: 'marketing', creator: 'head' });
    const o = buildOffice(hq, NOW);
    const text = JSON.stringify(o);
    expect(o.tasks.recent.find((t) => t.id === id)!.title).toBe(`Лид #${id}`);
    expect(text).not.toMatch(/Dilnoza|dilnoza|Роза|Лид с сайта/);
    expect(text).toContain('Клип: ИИ-приёмщик');
    expect(publicTitle({ id: 7, title: 'Ответ бизнесу #3 Кафе', dept: 'sales', routineId: null, meta: { action: 'reply' } })).toBe('Sales: задача #7');
  });

  it('strips contacts and free text from the activity feed', () => {
    expect(publicActivity({ action: 'task_created', objectType: 'task', objectId: '12' })).toEqual({ action: 'task_created', object: 'task:12' });
    expect(publicActivity({ action: 'Написал @ivan', objectType: 'lead', objectId: '+7 999 123 45 67' })).toEqual({ action: 'event', object: null });
    expect(publicActivity({ action: 'x', objectType: null, objectId: 'a@b.co' }).object).toBeNull();
    const hq = world();
    hq.log('sales-head', 'note', 'lead', '@dilnoza', 'телефон +79991234567');
    expect(JSON.stringify(buildOffice(hq, NOW).activity)).not.toMatch(/dilnoza|7999/);
  });
});
