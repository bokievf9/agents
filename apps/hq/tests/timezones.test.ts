import { Cron } from 'croner';
import { startRoutines } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { seedTiming } from '../src/timing.js';
import { OWNER, routedLlm, world } from './helpers.js';

/**
 * Two clocks (owner decision 2026-11-19). The owner lives in Kuala Lumpur (UTC+8): the morning summary, the approval batch, the weekly digest,
 * alerts and quiet hours run on his clock. The market is Dushanbe (UTC+5): client bot hours, slots, publishing times stay on the company clock.
 * Both zones have no daylight saving, so the offsets below are exact.
 */
const J = JSON.stringify;
const KL = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);
const DU = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h - 5, mi);
const next = (cron: string, tz: string, after: number) => new Cron(cron, { timezone: tz, paused: true }).nextRun(new Date(after))!.getTime();
// Wed 2026-11-18 15:00 Kuala Lumpur = 12:00 Dushanbe = 07:00 UTC (the shared test clock)
const NOW_UTC = Date.UTC(2026, 10, 18, 7, 0);

describe('the Director runs on the owner clock', () => {
  it('summary 08:00, approval batch 09:00, weekly digest Monday 08:30: all Kuala Lumpur', () => {
    const w = world();
    const plan = Object.fromEntries(w.director.schedulePlan().map((p) => [p.name, p]));
    expect(plan['director-summary']).toMatchObject({ cron: '0 8 * * *', tz: 'Asia/Kuala_Lumpur' });
    expect(plan['director-approvals']).toMatchObject({ cron: '0 9 * * *', tz: 'Asia/Kuala_Lumpur' });
    expect(plan['director-digest']).toMatchObject({ cron: '30 8 * * 1', tz: 'Asia/Kuala_Lumpur' });
    // the next firings on the fixed clock, as instants
    expect(next(plan['director-summary']!.cron, plan['director-summary']!.tz, NOW_UTC)).toBe(KL(2026, 11, 19, 8));
    expect(next(plan['director-approvals']!.cron, plan['director-approvals']!.tz, NOW_UTC)).toBe(KL(2026, 11, 19, 9));
    expect(next(plan['director-digest']!.cron, plan['director-digest']!.tz, NOW_UTC)).toBe(KL(2026, 11, 23, 8, 30)); // Monday
    // 09:00 in Kuala Lumpur is 06:00 in Dushanbe: the same batch would have been three hours later on the company clock
    expect(KL(2026, 11, 19, 9)).toBe(DU(2026, 11, 19, 6));
  });

  it('the owner moves: his clock changes the plan, the company clock stays', () => {
    const w = world();
    w.hq.setSetting('owner_tz', 'Asia/Dushanbe');
    const batch = w.director.schedulePlan().find((p) => p.name === 'director-approvals')!;
    expect(batch.tz).toBe('Asia/Dushanbe');
    expect(next(batch.cron, batch.tz, NOW_UTC)).toBe(DU(2026, 11, 19, 9));
    expect(w.hq.tz).toBe('Asia/Dushanbe');
  });

  it('the morning summary is dated on the owner day (01:00 in Kuala Lumpur is still the evening before in Dushanbe)', () => {
    const w = world();
    w.clock.t = DU(2026, 11, 19, 22); // 19.11 22:00 Dushanbe = 20.11 01:00 Kuala Lumpur
    expect(w.director.morningSummary()).toContain('Утренняя сводка, 20.11');
    w.hq.setSetting('owner_tz', 'Asia/Dushanbe');
    expect(w.director.morningSummary()).toContain('Утренняя сводка, 19.11');
  });

  it('quiet hours 23:00-08:00 are the owner night: an alert at 23:30 Kuala Lumpur waits for the summary, at 12:00 it goes out', async () => {
    const w = world();
    w.hq.setSetting('quiet_hours', '23:00-08:00');
    w.clock.t = KL(2026, 11, 18, 12);
    await w.hq.alert('днём');
    expect(w.messenger.last()!.text).toBe('Алерт: днём');
    const n = w.messenger.sent.length;
    w.clock.t = KL(2026, 11, 18, 23, 30); // 20:30 in Dushanbe: evening for the market, night for the owner
    await w.hq.alert('ночью');
    expect(w.messenger.sent).toHaveLength(n);
    expect(w.director.morningSummary()).toContain('ночью');
    w.clock.t = KL(2026, 11, 19, 8, 5);
    await w.hq.alert('утром');
    expect(w.messenger.last()!.text).toBe('Алерт: утром');
  });

  it('the weekly digest: the week in numbers, what departments reported, what is stuck', async () => {
    const w = world({ llm: routedLlm({ intent: () => J({ type: 'unknown' }) }) });
    const t = w.hq.createTask({ title: 'Недельный отчёт', dept: 'marketing', creator: 'routine' });
    w.hq.claim(t.id, 'marketing-head');
    w.hq.addEvent(t.id, 'report', 'marketing-head', 'Охват вырос на 12%');
    w.hq.complete(t.id, 'marketing-head', 'готово');
    const stuck = w.hq.createTask({ title: 'Застрявшая', dept: 'marketing', creator: 'owner' });
    w.hq.block(stuck.id, 'marketing-head', 'нет ключа');
    const text = w.director.weeklyDigest();
    expect(text).toMatch(/^Недельный дайджест, 11\.11-18\.11/);
    expect(text).toContain('Задач выполнено: Маркетинг 1');
    expect(text).toContain('Охват вырос на 12%');
    expect(text).toContain('#2');
    await w.director.sendWeeklyDigest();
    expect(w.messenger.last()!.chatId).toBe(OWNER);
    expect(w.messenger.last()!.text).toContain('Недельный дайджест');
  });
});

describe('routines: the owner clock for what lands in his morning, the company clock for the market', () => {
  it('the pack and the reports run on the owner clock before his batch, «что публикуем» on the company clock', () => {
    const w = world();
    const pack = w.hq.routineByName('marketing-weekly-pack')!;
    const daily = w.hq.routineByName('marketing-daily-today')!;
    expect([pack.tz, daily.tz]).toEqual(['owner', 'company']);
    expect(w.hq.routineTz(pack)).toBe('Asia/Kuala_Lumpur');
    expect(w.hq.routineTz(daily)).toBe('Asia/Dushanbe');
    // Monday 06:00 Kuala Lumpur (Sunday 22:00 UTC): the pack is ready before the 09:00 batch
    expect(next(pack.cron, w.hq.routineTz(pack), NOW_UTC)).toBe(KL(2026, 11, 23, 6));
    expect(next(pack.cron, w.hq.routineTz(pack), NOW_UTC)).toBeLessThan(next('0 9 * * 1', 'Asia/Kuala_Lumpur', NOW_UTC));
    // 09:00 Dushanbe = 04:00 UTC
    expect(next(daily.cron, w.hq.routineTz(daily), NOW_UTC)).toBe(DU(2026, 11, 19, 9));
  });

  it('startRoutines schedules every routine on its own clock', () => {
    const w = world();
    const jobs = startRoutines(w.hq);
    try {
      const at = (name: string) => jobs.find((j) => j.name === `routine:${name}`)!.nextRun(new Date(NOW_UTC))!.getTime();
      expect(at('marketing-weekly-pack')).toBe(KL(2026, 11, 23, 6));
      expect(at('marketing-daily-today')).toBe(DU(2026, 11, 19, 9));
      expect(at('marketing-trends-daily')).toBe(KL(2026, 11, 19, 7, 30));
    } finally {
      jobs.forEach((j) => j.stop());
    }
  });

  it('a clock changed by the owner reaches the routines (the app restarts them through onTimingChange)', async () => {
    let n = 0;
    const w = world({ llm: routedLlm({ intent: () => J({ type: 'rule', target: 'setting', key: 'owner_tz', value: 'Asia/Dushanbe' }) }) });
    w.director.onTimingChange = () => void n++;
    await w.director.onText('я переехал в Душанбе');
    const seq = Number(/rl:(\d+):y/.exec(w.messenger.last()!.buttons![0]![0]!.data)![1]);
    expect(await w.director.onRuleButton(seq, true)).toBe('Применено');
    expect(w.hq.ownerTz).toBe('Asia/Dushanbe');
    expect(n).toBe(1);
    w.director.stop();
  });
});

describe('presence: the desk belongs to the owner day', () => {
  const setup = () => {
    const w = world({ presence: true });
    w.hq.setSetting('quiet_hours', '23:00-08:00');
    return w;
  };

  it('a forgotten tab pinging through the owner night does not keep the desk into the next day', async () => {
    const w = setup();
    w.clock.t = KL(2026, 11, 18, 21);
    await w.channel!.setMode('desk');
    w.clock.t = KL(2026, 11, 18, 23, 50);
    await w.channel!.ping(); // quiet hours: this ping does not carry the day on
    expect(w.channel!.effective()).toBe('desk'); // still the same owner day
    w.clock.t = KL(2026, 11, 19, 0, 5);
    await w.channel!.ping();
    expect(w.channel!.effective()).toBe('away'); // his midnight passed: Telegram again
    w.clock.t = KL(2026, 11, 19, 8, 10);
    await w.channel!.ping(); // the open site in the morning, outside quiet hours
    expect(w.channel!.effective()).toBe('desk');
  });

  it('the day boundary is the owner one, not the company one', async () => {
    const w = setup();
    w.clock.t = Date.UTC(2026, 10, 18, 15, 0); // 23:00 Kuala Lumpur 18.11, 20:00 Dushanbe 18.11
    await w.channel!.setMode('desk');
    w.clock.t = Date.UTC(2026, 10, 18, 17, 29); // 01:29 Kuala Lumpur 19.11 but 22:29 Dushanbe 18.11
    await w.channel!.ping();
    expect(w.channel!.effective()).toBe('away');
    // the same instant on a company-day check would still be 18.11 and the desk would have held
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dushanbe' }).format(new Date(w.clock.t))).toBe('2026-11-18');
  });
});

describe('the first start of the clocks', () => {
  it('seedTiming writes what is missing and never touches what the owner or the server already has', () => {
    const w = world();
    seedTiming(w.hq, { tz: 'Asia/Almaty', ownerTz: 'Asia/Singapore' });
    expect(w.hq.tz).toBe('Asia/Almaty');
    expect(w.hq.ownerTz).toBe('Asia/Singapore');
    expect(w.hq.setting('quiet_hours')).toBe('23:00-08:00');
    seedTiming(w.hq, { tz: 'Europe/Moscow', ownerTz: 'Asia/Tokyo' });
    expect([w.hq.tz, w.hq.ownerTz]).toEqual(['Asia/Almaty', 'Asia/Singapore']);
    w.hq.setSetting('quiet_hours', ''); // the owner switched the quiet hours off on purpose
    seedTiming(w.hq, { tz: 'Europe/Moscow', ownerTz: 'Asia/Tokyo' });
    expect(w.hq.setting('quiet_hours')).toBe('');
  });

  it('OWNER_TZ defaults to Kuala Lumpur, TZ (the company) to Dushanbe, a bad zone fails at start', () => {
    const base = { HQ_BOT_TOKEN: 't', OWNER_TELEGRAM_ID: '1' };
    expect(loadConfig(base)).toMatchObject({ tz: 'Asia/Dushanbe', ownerTz: 'Asia/Kuala_Lumpur' });
    expect(loadConfig({ ...base, TZ: 'Asia/Tashkent', OWNER_TZ: 'Asia/Singapore' })).toMatchObject({ tz: 'Asia/Tashkent', ownerTz: 'Asia/Singapore' });
    expect(() => loadConfig({ ...base, OWNER_TZ: 'Mars/Olympus' })).toThrow();
  });
});

describe('the company clock stays the market clock', () => {
  it('call slots and the client bot hours are read on the company clock (Dushanbe), not the owner one', async () => {
    const { nextSlots } = await import('@fir/worker-lead-intake');
    // Thursday 2026-11-19 22:00 Dushanbe: the next working days are Fri and Mon, slots 11:00 and 15:00 Dushanbe
    const [a, b] = nextSlots(DU(2026, 11, 19, 22), 'Asia/Dushanbe', ['11:00', '15:00']);
    expect(a).toBe(DU(2026, 11, 20, 11));
    expect(b).toBe(DU(2026, 11, 23, 15));
  });
});
