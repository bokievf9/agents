/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createAdmin } from '../src/admin.js';
import { createWebhook } from '../src/webhook.js';
import { OWNER, openPack, routedLlm, world } from './helpers.js';

const J = JSON.stringify;
const TOKEN = 'admin-secret';
const MIN = 60_000;
const taskLlm = () => routedLlm({ intent: () => J({ type: 'task', title: 'Клип про барбершоп', dept: 'marketing' }) });

type W = ReturnType<typeof world>;

async function start(w: W) {
  const admin = createAdmin({
    hq: w.hq, queue: w.queue, director: w.director, channel: w.channel!, ownerId: OWNER, now: () => w.clock.t,
    commandNames: ['status', 'tasks', 'approve', 'retry', 'desk', 'away'], drill: (arg) => Promise.resolve(`drill:${arg}`),
  });
  const server = createWebhook(() => Promise.resolve(0), undefined, Date.now, undefined, undefined, { token: TOKEN, handle: (r) => admin.handle(r) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, token: string | null = TOKEN) => {
    const r = await fetch(`${url}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { 'x-admin-token': token } : {}) }, ...(body !== undefined ? { body: J(body) } : {}),
    });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  return { server, call };
}

const desk = (w: W) => w.channel!.setMode('desk');

describe('presence routing', () => {
  it('at the desk everything lands in the inbox and nothing goes to Telegram', async () => {
    const w = world({ presence: true });
    await desk(w);
    expect(w.channel!.effective()).toBe('desk');
    await w.director.alertOwner('диск почти полон');
    await w.director.sendMorningSummary();
    expect(w.messenger.sent).toHaveLength(0);
    expect(w.channel!.list().map((i) => [i.kind, i.deliveredTg])).toEqual([['alert', false], ['summary', false]]);
  });

  it('away: inbox and Telegram; group-topic reports are untouched', async () => {
    const w = world({ presence: true, groupTopics: true });
    expect(w.channel!.effective()).toBe('away');
    await w.director.alertOwner('диск почти полон');
    expect(w.messenger.to(OWNER)).toEqual(['Алерт: диск почти полон']);
    expect(w.channel!.list()[0]).toMatchObject({ kind: 'alert', deliveredTg: true });
    expect(w.posted.map((p) => p.text)).toEqual(['Алерт: диск почти полон']);
  });

  it('no ping for 20 minutes: auto-away with one digest instead of a replay', async () => {
    const w = world({ presence: true });
    await desk(w);
    await w.director.alertOwner('a1');
    await w.director.alertOwner('a2');
    w.clock.t += 19 * MIN;
    await w.channel!.sync();
    expect(w.channel!.effective()).toBe('desk');
    await w.channel!.ping();
    w.clock.t += 19 * MIN;
    expect(w.channel!.effective()).toBe('desk');
    w.clock.t += 2 * MIN;
    expect(w.channel!.effective()).toBe('away');
    await w.channel!.sync();
    expect(w.messenger.sent).toHaveLength(1);
    expect(w.messenger.sent[0]!.text).toBe('Пока вы были на месте: 0 одобрений, 0 задач готово, 2 алертов. /approve, /status');
    await w.channel!.sync();
    expect(w.messenger.sent).toHaveLength(1); // once
    // the next message goes to Telegram again
    await w.director.alertOwner('a3');
    expect(w.messenger.to(OWNER).at(-1)).toBe('Алерт: a3');
  });

  it('/desk and /away from Telegram answer there, and /away sends the digest', async () => {
    const w = world({ presence: true });
    await w.channel!.asReply(() => w.director.onCommand('desk'));
    expect(w.messenger.to(OWNER)[0]).toContain('Вы за столом');
    await w.director.alertOwner('x');
    expect(w.messenger.sent).toHaveLength(1);
    await w.channel!.asReply(() => w.director.onCommand('away'));
    expect(w.messenger.to(OWNER)[1]).toContain('1 алертов');
    expect(w.messenger.to(OWNER)[2]).toContain('Вы в пути');
    expect(w.hq.setting('presence.mode')).toBe('away');
  });

  it('a reply to something typed in Telegram goes to Telegram even at the desk', async () => {
    const w = world({ presence: true, llm: taskLlm() });
    await desk(w);
    await w.channel!.asReply(() => w.director.onText('сделай клип про барбершоп'));
    expect(w.messenger.sent[0]!.text).toContain('Маркетинг: «Клип про барбершоп»');
    expect(w.hq.tasks({ dept: 'marketing' })[0]!.meta.progress).toMatchObject({ chatId: OWNER, messageId: 1 });
  });
});

describe('admin API', () => {
  it('checks the token', async () => {
    const w = world({ presence: true });
    const { server, call } = await start(w);
    try {
      expect((await call('GET', '/admin/state', undefined, null)).status).toBe(401);
      expect((await call('GET', '/admin/state', undefined, 'nope')).status).toBe(401);
      const ok = await call('GET', '/admin/state');
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({ ok: true, presence: { mode: 'away', effective: 'away', lastPingAt: null, awayAfterMin: 20 }, tasksOpen: 0, approvalsPending: 0, tz: 'Asia/Dushanbe', ownerTz: 'Asia/Kuala_Lumpur' });
      expect((await call('GET', '/admin/nothing')).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('presence and ping', async () => {
    const w = world({ presence: true });
    const { server, call } = await start(w);
    try {
      expect((await call('POST', '/admin/presence', { mode: 'x' })).status).toBe(400);
      const d = await call('POST', '/admin/presence', { mode: 'desk' });
      expect(d.json.presence).toMatchObject({ mode: 'desk', effective: 'desk' });
      w.clock.t += 25 * MIN;
      expect((await call('GET', '/admin/state')).json.presence).toMatchObject({ mode: 'desk', effective: 'away' });
      const p = await call('POST', '/admin/ping');
      expect(p.json.presence).toMatchObject({ mode: 'desk', effective: 'desk' });
    } finally {
      server.close();
    }
  });

  it('say creates a task, returns the replies inline, keeps Telegram and the inbox quiet, and the line is readable', async () => {
    const w = world({ presence: true, llm: taskLlm() });
    const { server, call } = await start(w);
    try {
      await call('POST', '/admin/presence', { mode: 'desk' });
      expect((await call('POST', '/admin/say', { text: '' })).status).toBe(400);
      const r = await call('POST', '/admin/say', { text: 'сделай клип про барбершоп' });
      expect(r.status).toBe(200);
      const t = w.hq.tasks({ dept: 'marketing' })[0]!;
      expect(r.json.taskId).toBe(t.id);
      expect(r.json.replies).toHaveLength(1);
      expect(r.json.replies[0]).toContain(`Задача #${t.id}`);
      expect(w.messenger.sent).toHaveLength(0);
      expect(w.channel!.list()).toHaveLength(0);
      expect(w.hq.task(t.id)!.meta.progress).toMatchObject({ line: expect.stringContaining('ждёт голову отдела') });
      expect(w.hq.task(t.id)!.meta.progress).not.toHaveProperty('messageId');

      const list = await call('GET', '/admin/tasks?open=1&dept=marketing');
      expect(list.json.items).toHaveLength(1);
      expect(list.json.items[0]).toMatchObject({ id: t.id, title: 'Клип про барбершоп', dept: 'marketing', status: 'inbox', assigneeTitle: expect.any(String) });
      expect(list.json.items[0].progressLine).toContain('✅ принял · ⏳ ждёт голову отдела');
      expect(list.json.items[0].lastEvent).toMatchObject({ kind: 'status' });

      // the task finishes at the desk: the final line goes to the inbox, not to Telegram
      w.hq.complete(t.id, 'marketing-head', 'Готово, owner@example.com');
      w.clock.t += 6_000;
      await w.director.progress.tick();
      expect(w.messenger.sent).toHaveLength(0);
      const inbox = (await call('GET', '/admin/inbox')).json.items;
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({ kind: 'progress', taskId: t.id, read: false, deliveredTg: false });
      expect(inbox[0].text).toContain('✅ готово');
      expect(inbox[0].text).not.toContain('owner@example.com');

      const detail = await call('GET', `/admin/tasks/${t.id}`);
      expect(detail.json.task).toMatchObject({ id: t.id, status: 'done' });
      expect(detail.json.events.length).toBeGreaterThan(1);
      expect(detail.json.children).toEqual([]);
      expect((await call('GET', '/admin/tasks/9999')).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('a web-only task that ends after the owner left the desk reaches Telegram', async () => {
    const w = world({ presence: true, llm: taskLlm() });
    const { server, call } = await start(w);
    try {
      await call('POST', '/admin/presence', { mode: 'desk' });
      await call('POST', '/admin/say', { text: 'сделай клип' });
      const t = w.hq.tasks({ dept: 'marketing' })[0]!;
      await call('POST', '/admin/presence', { mode: 'away' });
      w.hq.complete(t.id, 'marketing-head', 'ok');
      w.clock.t += 6_000;
      await w.director.progress.tick();
      expect(w.messenger.to(OWNER)).toHaveLength(1);
      expect(w.messenger.to(OWNER)[0]).toContain('✅ готово');
    } finally {
      server.close();
    }
  });

  it('command: unknown names are refused, known ones are captured; retry', async () => {
    const w = world({ presence: true });
    const { server, call } = await start(w);
    try {
      expect((await call('POST', '/admin/command', { name: 'rm', arg: '' })).status).toBe(400);
      const s = await call('POST', '/admin/command', { name: 'status' });
      expect(s.json.replies).toHaveLength(1);
      expect(w.messenger.sent).toHaveLength(0);
      expect(w.channel!.list()).toHaveLength(0);
      const t = w.hq.createTask({ title: 'Застряла', dept: 'marketing', creator: 'owner' });
      w.hq.block(t.id, 'marketing-head', 'Сбой: тест');
      const r = await call('POST', `/admin/tasks/${t.id}/retry`);
      expect(r.json.ok).toBe(true);
      expect(w.hq.task(t.id)!.status).toBe('inbox');
      expect(r.json.replies).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it('inbox read, paging and unread filter', async () => {
    const w = world({ presence: true });
    const { server, call } = await start(w);
    try {
      await desk(w);
      for (const t of ['a', 'b', 'c']) await w.director.alertOwner(t);
      expect((await call('GET', '/admin/state')).json.inboxUnread).toBe(3);
      const all = (await call('GET', '/admin/inbox?limit=2')).json.items;
      expect(all.map((i: any) => i.text)).toEqual(['Алерт: b', 'Алерт: c']); // the newest, oldest first
      expect((await call('GET', `/admin/inbox?after=${all[0].id}`)).json.items).toHaveLength(1);
      await call('POST', '/admin/inbox/read', { ids: [all[0].id] });
      expect((await call('GET', '/admin/inbox?unread=1')).json.items).toHaveLength(2);
      await call('POST', '/admin/inbox/read', { all: true });
      expect((await call('GET', '/admin/state')).json.inboxUnread).toBe(0);
      expect((await call('POST', '/admin/inbox/read', {})).status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('departments and drill', async () => {
    const w = world({ presence: true });
    const { server, call } = await start(w);
    try {
      const d = (await call('GET', '/admin/departments')).json.items;
      const m = d.find((x: any) => x.id === 'marketing');
      expect(m).toMatchObject({ status: 'active', headId: expect.any(String), counts: { inbox: 0 } });
      expect(m.workers.length).toBeGreaterThan(0);
      w.hq.setDeptStatus('marketing', 'paused');
      expect((await call('GET', '/admin/departments')).json.items.find((x: any) => x.id === 'marketing').status).toBe('paused');
      expect((await call('GET', '/admin/drill')).json.text).toBe('drill:report');
      expect((await call('POST', '/admin/drill', { arg: 'sales' })).json.text).toBe('drill:sales');
    } finally {
      server.close();
    }
  });

  it('rate limit: 600 requests per 10 minutes', async () => {
    const w = world({ presence: true });
    const admin = createAdmin({ hq: w.hq, queue: w.queue, director: w.director, channel: w.channel!, ownerId: OWNER, now: () => w.clock.t, commandNames: [] });
    const req = { method: 'GET', path: '/admin/state', query: new URLSearchParams(), body: null };
    for (let i = 0; i < 600; i++) expect((await admin.handle(req)).status).toBe(200);
    expect((await admin.handle(req)).status).toBe(429);
    w.clock.t += 11 * MIN;
    expect((await admin.handle(req)).status).toBe(200);
  });
});

describe('approvals through the API', () => {
  async function packed() {
    const w = world({ presence: true });
    const { server, call } = await start(w);
    await desk(w);
    w.hq.runRoutine('marketing-weekly-pack');
    await w.marketing.onHeartbeat();
    expect(await w.director.sendApprovalBatch(false)).toBe(1); // the pack's one card
    expect(await openPack(w)).toBe(1); // «Посмотреть по одному»: the 8 items' own cards
    return { w, server, call };
  }

  it('the batch at the desk lands in the inbox only; list, edit a part, approve, reject', async () => {
    const { w, server, call } = await packed();
    try {
      expect(w.messenger.sent).toHaveLength(0);
      const cards = w.channel!.list({ limit: 200 }).filter((i) => i.kind === 'approval');
      expect(cards).toHaveLength(9); // the pack's card and the 8 items
      expect(cards[0]!.approvalId).not.toBeNull();

      const list = (await call('GET', '/admin/approvals')).json.items;
      expect(list).toHaveLength(8);
      const first = list[0];
      expect(first).toMatchObject({ kind: 'content_item', dept: 'marketing', level: 0, locked: false, taskId: expect.any(Number) });
      expect(first.parts.length).toBeGreaterThan(0);
      expect((await call('POST', `/admin/approvals/${first.id}`, { action: 'nope' })).status).toBe(400);

      // edit one part: text changes, the item stays pending, the trust counter resets
      const part = first.parts[0].id;
      const before = first.text as string;
      const e = await call('POST', `/admin/approvals/${first.id}`, { action: 'edit', part, text: 'Совсем новый текст' });
      expect(e.json).toMatchObject({ ok: true, status: 'pending' });
      const after = (await call('GET', '/admin/approvals')).json.items.find((x: any) => x.id === first.id);
      expect(after.text).not.toBe(before);
      expect(after.text).toContain('Совсем новый текст');
      expect(w.queue.get(first.id)!.edited).toBe(true);
      expect(w.messenger.sent).toHaveLength(0); // the re-asked card is not sent anywhere
      expect(w.channel!.list({ limit: 200 }).filter((i) => i.kind === 'approval')).toHaveLength(9);

      const a = await call('POST', `/admin/approvals/${first.id}`, { action: 'approve' });
      expect(a.json).toMatchObject({ ok: true, status: 'executed' });
      expect(w.hq.task(first.taskId)!.status).toBe('done');
      expect(w.queue.streak('content_item')).toBe(0); // an edited one is not a clean approval
      expect((await call('POST', `/admin/approvals/${first.id}`, { action: 'approve' })).status).toBe(409);

      const second = list[1];
      const r = await call('POST', `/admin/approvals/${second.id}`, { action: 'reject' });
      expect(r.json).toMatchObject({ ok: true, status: 'rejected' });
      expect(w.hq.task(second.taskId)!.status).toBe('rejected');
      expect((await call('GET', '/admin/approvals')).json.items).toHaveLength(6);
      expect((await call('GET', '/admin/state')).json.approvalsPending).toBe(6);
      expect((await call('POST', '/admin/approvals/99999', { action: 'approve' })).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('cards that were not delivered go out on /approve in Telegram', async () => {
    const { w, server } = await packed();
    try {
      expect(w.messenger.sent).toHaveLength(0);
      await w.channel!.asReply(() => w.director.onCommand('approve'));
      expect(w.messenger.sent.filter((m) => m.buttons)).toHaveLength(8);
      expect(await w.channel!.asReply(() => w.channel!.resendUndelivered())).toBe(0);
    } finally {
      server.close();
    }
  });

  it('the digest counts the approvals still waiting', async () => {
    const { w, server, call } = await packed();
    try {
      const list = (await call('GET', '/admin/approvals')).json.items;
      await call('POST', `/admin/approvals/${list[0].id}`, { action: 'reject' });
      await call('POST', '/admin/presence', { mode: 'away' });
      expect(w.messenger.sent).toHaveLength(1);
      expect(w.messenger.sent[0]!.text).toContain('7 одобрений');
    } finally {
      server.close();
    }
  });
});

describe('the admin office keeps the real task titles', () => {
  it('GET /admin/office shows «Аудит: example.com»; the public office masks it; the token is required', async () => {
    const w = world({ presence: true });
    const { server, call } = await start(w);
    try {
      const t = w.hq.createTask({ title: 'Аудит: example.com', dept: 'marketing', creator: 'head', meta: { action: 'audit' } });
      const admin = await call('GET', '/admin/office');
      expect(admin.status).toBe(200);
      expect(admin.json.tasks.recent.find((x: any) => x.id === t.id).title).toBe('Аудит: example.com');
      expect(admin.json.tz).toBe('Asia/Dushanbe');
      const { buildOffice } = await import('../src/office.js');
      expect(buildOffice(w.hq, w.clock.t).tasks.recent.find((x) => x.id === t.id)!.title).toBe('Аудит сайта');
      expect((await call('GET', '/admin/office', undefined, null)).status).toBe(401);
    } finally {
      server.close();
    }
  });
});
