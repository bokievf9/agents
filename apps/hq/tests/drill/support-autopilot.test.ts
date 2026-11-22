/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { PmStore } from '@fir/worker-project-manager';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKENS, drillWorld, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

/** `autopilot.support`: the Support head's draft answer is sent alone or waits for the owner, by the escalation policy and the mode. */
const g = useGuard();
let w: DrillWorld;
afterEach(async () => { await w?.close(); });

const PLAIN = 'Как оплатить проект? Какие реквизиты?';
let n = 0;

async function client(vip: boolean) {
  const email = `ap${++n}.${vip ? 'vip' : 'plain'}@example.com`;
  const lead = await w.http('POST', '/lead', { name: `Client ${n}`, contact: `@c${n}`, service: 'bots', budget: '$300-500', message: 'Нужен бот для салона', locale: 'ru', source: 'miniapp', clientEmail: email, cabinetId: `sb-${n}`, clientName: `Client ${n}` }, { 'x-lead-token': TOKENS.lead });
  const { leadId } = (await lead.json()) as any;
  await w.beat();
  const cid = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(email)}`)).json.client.id as number;
  if (vip) new PmStore(w.db, w.hq.now).createProject({ client: `Client ${n}`, what: 'Бот для салона', product: 'bot', source: 'sales', taskId: null, leadId, packId: null });
  return cid;
}
async function start(mode: string, vip = false) {
  w = await drillWorld({ flow: true });
  for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
  if (mode) w.hq.setSetting('autopilot.support', mode);
  return client(vip);
}
const settle = async () => { await new Promise((r) => setTimeout(r, 20)); await w.beat(); };
const say = async (cid: number, text: string) => {
  const before = w.alerts.length;
  expect((await w.adm('POST', `/admin/clients/${cid}/threads/support/messages`, { text })).status).toBe(200);
  await settle();
  return { alerts: w.alerts.slice(before) };
};
const answers = async (cid: number) => ((await w.adm('GET', `/admin/clients/${cid}/threads/support/messages`)).json.items as any[]).filter((m) => m.from === 'firtech');
/** Proposals of the Support head still for the owner: queued for his batch, or already a card. */
const waiting = () => {
  const queued = w.db.prepare("SELECT id, approval_id FROM task_approvals WHERE kind LIKE 'support_%' AND state = 'queued'").all() as { id: number; approval_id: number | null }[];
  const known = new Set(queued.map((q) => q.approval_id));
  return [...queued, ...w.queue.pending().filter((r) => r.kind.startsWith('support_') && !known.has(r.id))];
};
const decisions = () => (w.db.prepare("SELECT decision FROM decisions WHERE kind LIKE 'support_%'").all() as { decision: string }[]).map((d) => d.decision);

describe('support autopilot: mode x reason', () => {
  it('policy: a plain question is answered alone and journalled as autopilot; the client sees the answer', async () => {
    const cid = await start('policy');
    const r = await say(cid, PLAIN);
    expect(waiting()).toHaveLength(0);
    expect(decisions()).toEqual(['autopilot']);
    expect((await answers(cid)).length).toBe(1);
    expect(r.alerts).toEqual([]);
    expect((await w.adm('GET', '/admin/audit?limit=100')).text).toContain('autopilot');
    expect(g.errors()).toEqual([]);
  });

  it('policy: a client with a project (VIP) waits for the owner and one reminder goes out, not repeated', async () => {
    const cid = await start('policy', true);
    const r = await say(cid, PLAIN);
    expect(waiting()).toHaveLength(1);
    expect(decisions()).toEqual([]);
    expect((await answers(cid)).length).toBe(0);
    expect(r.alerts.filter((a) => a.includes('Поддержка'))).toHaveLength(1);
    expect(r.alerts.join(' ')).not.toContain('оплатить');
    await w.beat();
    expect(w.alerts.filter((a) => a.includes('Поддержка:'))).toHaveLength(1);
  });

  it('autopilot: plain and VIP are answered alone', async () => {
    const plain = await start('autopilot');
    await say(plain, PLAIN);
    expect((await answers(plain)).length).toBe(1);
    const vip = await client(true);
    await say(vip, PLAIN);
    expect((await answers(vip)).length).toBe(1);
    expect(waiting()).toHaveLength(0);
    expect(decisions()).toEqual(['autopilot', 'autopilot']);
  });

  it.each([
    ['autopilot', 'Дайте скидку, пожалуйста, или рассрочку'],
    ['autopilot', 'Хочу вернуть деньги, верните оплату'],
    ['policy', 'Дайте скидку, пожалуйста'],
    ['autopilot', 'Нужен юрист, будет претензия и суд'],
    ['autopilot', 'Позовите живого человека, это очень срочно'],
  ])('%s: «%s» always waits for the owner', async (mode, text) => {
    const cid = await start(mode);
    const r = await say(cid, text);
    expect(waiting()).toHaveLength(1);
    expect(decisions()).toEqual([]);
    expect((await answers(cid)).length).toBe(0);
    expect(r.alerts.length).toBeGreaterThan(0);
  });

  it('ask_me: everything waits, a plain question too', async () => {
    const cid = await start('ask_me');
    await say(cid, PLAIN);
    expect(waiting()).toHaveLength(1);
    expect(decisions()).toEqual([]);
    expect((await answers(cid)).length).toBe(0);
  });

  it('money stays owner-only in every mode, even when the model lets it through (the money kind is locked, the discount word is checked)', async () => {
    for (const mode of ['ask_me', 'policy', 'autopilot']) {
      const cid = await start(mode);
      await say(cid, 'Сделайте скидку 20% на второй этап');
      expect(waiting().length, mode).toBe(1);
      expect(decisions(), mode).toEqual([]);
      await w.close();
    }
  });

  it('a draft with a [placeholder] is never sent alone (nothing in the KB for the question)', async () => {
    const cid = await start('autopilot');
    await say(cid, 'Какая погода в Душанбе завтра на выставке?');
    expect(waiting()).toHaveLength(1);
    expect(decisions()).toEqual([]);
  });

  it('the owner\'s own /ticket command is never auto-sent', async () => {
    await start('autopilot');
    await w.support.onCommand('ticket', 'Тест: Как оплатить проект?');
    expect(decisions()).toEqual([]);
    expect(waiting()).toHaveLength(1);
  });

  it('at most 20 auto-sent answers per client per day, then they wait', async () => {
    const cid = await start('autopilot');
    await say(cid, PLAIN);
    expect(decisions()).toEqual(['autopilot']);
    const key = (w.db.prepare('SELECT client_key k FROM support_autopilot').get() as { k: string }).k;
    for (let i = 0; i < 19; i++) w.db.prepare('INSERT INTO support_autopilot (client_key, ticket_id, at) VALUES (?, 0, ?)').run(key, w.clock.t - 1000);
    await say(cid, 'Как оплатить следующий этап?');
    expect(waiting()).toHaveLength(1);
    expect(decisions()).toEqual(['autopilot']);
    expect(g.lines.some((l) => l.msg.includes('daily limit'))).toBe(true);
  });
});

describe('support autopilot over the default trust level', () => {
  it('support_answer is at level 1 by default: the policy still decides (legal waits, plain goes as autopilot, not as the trust level `auto`)', async () => {
    w = await drillWorld({ flow: true });
    expect(w.queue.level('support_answer')).toBe(1);
    const a = await client(false);
    await say(a, 'Нужен юрист, будет претензия и суд');
    expect(waiting()).toHaveLength(1);
    expect(decisions()).toEqual([]);
    const b = await client(false);
    await say(b, PLAIN);
    expect(decisions()).toEqual(['autopilot']);
    expect((await answers(b)).length).toBe(1);
  });
});

describe('support autopilot: fail closed', () => {
  it('a failing evaluation (broken tables) leaves the answer in the queue with a warning', async () => {
    const cid = await start('autopilot');
    w.db.exec('DROP TABLE support_autopilot');
    w.db.exec('CREATE TABLE support_autopilot (x)');
    await say(cid, PLAIN);
    expect(waiting()).toHaveLength(1);
    expect(decisions()).toEqual([]);
    expect(g.lines.some((l) => l.msg.includes('support autopilot failed'))).toBe(true);
  });

  it('a failing delivery leaves the answer in the owner queue (journal auto_failed, not sent)', async () => {
    const cid = await start('autopilot');
    const orig = (w.queue as any).spec.bind(w.queue);
    (w.queue as any).spec = (kind: string) => { const s = orig(kind); return kind === 'support_answer' ? { ...s, execute: () => Promise.reject(new Error('boom')) } : s; };
    await say(cid, PLAIN);
    expect(waiting()).toHaveLength(1);
    expect(decisions()).toEqual(['auto_failed']);
    expect((await answers(cid)).length).toBe(0);
    g.expectErrors();
  });
});
