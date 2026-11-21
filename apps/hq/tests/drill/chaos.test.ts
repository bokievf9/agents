import { afterEach, describe, expect, it } from 'vitest';
import { COMMANDS } from '../../src/commands.js';
import { TOKENS, drillWorld, type DrillWorld } from './world.js';
import { seedEverything, LEAD } from './seed.js';
import { useGuard } from './guard.js';

const g = useGuard();
let w: DrillWorld;
afterEach(async () => { await w?.close(); });

const ARGS = ['', '1', '2', '3', '99999', 'abc', 'Dilnoza', 'Dilnoza: вопрос про оплату', 'Dilnoza 50 доп работы', '1 1', '1 2', '1 brief', 'договор Dilnoza', 'Cambridge -> Zed', 'marketing', 'sales', 'report', 'clear', '<b>x</b>', 'x'.repeat(2500), 'https://www.instagram.com/reel/ABC123/', 'seo 0', 'lead_price 1', '12 3 4'];
const ROUTES: [string, string][] = [['GET', '/admin/state'], ['GET', '/admin/review?status=all'], ['GET', '/admin/hub'], ['GET', '/admin/crm/leads'], ['GET', '/admin/crm/projects/1'], ['GET', '/admin/crm/invoices'], ['GET', '/admin/chats?status=all'], ['GET', '/admin/content'], ['GET', '/admin/company'], ['GET', '/admin/office'], ['GET', '/admin/tasks?open=1'], ['GET', '/admin/inbox'], ['GET', '/admin/metrics/week'], ['GET', '/admin/trends'],
  ['POST', '/admin/ping'], ['POST', '/admin/inbox/read'], ['POST', '/admin/presence'], ['POST', '/admin/crm/leads/1'], ['POST', '/admin/crm/leads/1/reply'], ['POST', '/admin/crm/invoices/1'], ['POST', '/admin/crm/projects/1'], ['POST', '/admin/crm/tickets/1'], ['POST', '/admin/crm/prospects/1'], ['POST', '/admin/review/ap_1'], ['POST', '/admin/review/ap_2'], ['POST', '/admin/review/ap_5'], ['POST', '/admin/content/1'], ['POST', '/admin/company/routines/support-daily/run'], ['POST', '/admin/company/trust/lead_reply'], ['POST', '/admin/say'], ['POST', '/admin/command'], ['POST', '/admin/tasks/1/retry'], ['POST', '/admin/drill'], ['POST', '/admin/prices/reload'], ['POST', '/admin/trends'], ['POST', '/admin/chats/c1/reply']];
const BODIES = [{}, { action: 'approve' }, { action: 'reject' }, { action: 'edit', text: { draft: 'Новый текст владельца.' } }, { action: 'send' }, { action: 'revise', note: 'короче' }, { action: 'mark_paid' }, { action: 'remind' }, { action: 'complete_milestone', milestoneId: 1 }, { action: 'note', text: 'заметка' }, { action: 'set_status', status: 'paused' },
  { stage: 'qualified' }, { stage: 'lost', lost_reason: 'не ответил' }, { text: 'Ответ владельца' }, { at: '2026-11-24T10:00:00Z' }, { mode: 'desk' }, { mode: 'away' }, { all: true }, { name: 'status', arg: '' }, { name: 'tasks', arg: 'sales' }, { arg: 'report' }, { enabled: false }, { level: 1 }, { url: 'https://www.instagram.com/reel/ABC123/' }, { ids: [1, 2] }, { status: 'closed' }, null, 'x', 7];

/** The faults the walk injects itself (a Telegram 502, a dead gateway): errors that name them are expected. */
const INJECTED = /502 Bad Gateway|gateway down 502/;

async function walk(seed: number, steps: number) {
  w = await drillWorld();
  for (const k of w.queue.trustTable()) if (seed % 2) w.queue.setLevel(k.kind, 0);
  let s = seed;
  const rnd = (n: number) => { s = (s * 1664525 + 1013904223) % 4294967296; return Math.floor(s / 65536) % n; };
  const pick = <T,>(a: T[]): T => a[rnd(a.length)]!;
  await seedEverything(w);
  const ids = () => [...w.queue.pending().map((r) => r.id), 1, 2, 3, 99999];
  for (let i = 0; i < steps; i++) {
    const k = rnd(17);
    try {
      await step(i, k);
    } catch (e) {
      if (!INJECTED.test(String(e))) throw e; // a dead Telegram or gateway may reject a direct call; anything else is a bug
    }
    if (i % 25 === 0) await w.settle();
  }
  await w.settle();

  async function step(i: number, k: number) {
    if (k === 0) await w.cmd(pick(COMMANDS).name, pick(ARGS));
    else if (k === 1) await w.say(`/${pick(COMMANDS).name} ${pick(ARGS)}`);
    else if (k === 2) { const id = pick(ids()); await w.press(`ap:${id}:${pick(['a', 'e', 'r', 'f', 's'])}`); }
    else if (k === 3) await w.press(pick(['ap:all', 'ap:later', 'ap:show', 'pg:all:0', 'pg:sales:0', 'dp:list', `dp:${pick(['sales', 'support', 'marketing', 'production', 'backoffice'])}:${pick(['o', 'p', 'r'])}`, `tk:${pick(ids())}:${pick(['o', 'r', 'x', 'X', 'j'])}`, `pk:${pick(ids())}:${pick(['o', 'v'])}`, `pc:${pick(ids())}:c`, `pb:${pick(ids())}`, `ce:${pick(ids())}:caption`, `rl:${pick(ids())}:${pick(['y', 'n'])}`]));
    else if (k === 4) await w.say(pick(['Сделай пост про бота', 'статус', 'какие задачи у продаж?', 'Новый текст владельца', 'ок', '/skip', 'клиент Dilnoza ответил: интересно', 'поставь утреннюю сводку на 9:15']));
    else if (k === 5 || k === 6) { const [m, p] = pick(ROUTES); const r = await w.adm(m, p.replace(/ap_\d+/, `ap_${pick(ids())}`), m === 'POST' ? pick(BODIES) : undefined); expect(r.status, `${m} ${p}`).toBeLessThan(500); }
    else if (k === 7) { await w.beat(); await w.notices.scan(); }
    else if (k === 8) w.hq.runRoutine(pick(w.hq.routines()).name);
    else if (k === 9) w.clock.t += pick([60_000, 3_600_000, 6 * 3_600_000, 86_400_000]);
    else if (k === 10) await w.director.sendApprovalBatch(rnd(2) === 0);
    else if (k === 11) { const p = w.queue.pending(); if (p.length) await w.decide(rnd(3) === 0 ? 'reject' : 'approve', pick(p).id); }
    else if (k === 12) await w.http('POST', '/lead', { ...LEAD, name: `Visitor ${i}`, contact: `@visitor_${i}`, service: pick(['bots', 'websites', 'apps', 'unknown']), message: pick(['Сколько стоит?', 'Нужен бот', '', 'x'.repeat(1900)]) }, { 'x-lead-token': TOKENS.lead });
    else if (k === 14) { w.state.down = rnd(2) === 0; w.state.garbage = !w.state.down && rnd(3) === 0; }
    else if (k === 15) { let n = rnd(4); const real = w.tg.sendMessage.bind(w.tg); w.tg.sendMessage = (...a: Parameters<typeof real>) => (n-- > 0 ? Promise.reject(Object.assign(new Error('502 Bad Gateway'), { error_code: 502 })) : real(...a)); }
    else if (k === 16) await w.http('POST', '/audit', { url: `https://site-${rnd(5)}.example.org`, contact: `@aud_${rnd(5)}_x`, locale: 'ru' }, { 'x-lead-token': TOKENS.lead });
    else await w.http('POST', '/chat', { sessionId: `visitor-chaos-${rnd(4)}-0001`, locale: pick(['ru', 'en']), message: pick(['Здравствуйте', 'Сколько стоит бот?', 'хочу сайт', '+992 90 111 22 33']) }, { 'x-chat-token': TOKENS.chat });
  }
}

describe('chaos: the whole office under a random walk of owner, site and visitor actions', () => {
  const seeds = process.env.SEEDS ? process.env.SEEDS.split(',').map(Number) : [11, 12, 13, 14];
  it.each(seeds)('seed %i: nothing throws, nothing answers 500, no unhandled rejection, no error line', async (seed) => {
    await walk(seed, Number(process.env.STEPS ?? 250));
    expect(g.rejections).toEqual([]);
    expect(g.errors().map((l) => `${l.msg}: ${String(l.err)}`).filter((l) => !INJECTED.test(l))).toEqual([]);
  }, 180_000);
});
