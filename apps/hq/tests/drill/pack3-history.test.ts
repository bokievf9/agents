import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drillWorld, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

useGuard();

/** P-17: what the owner writes in Telegram and what HQ answers there is kept in `director_history` (source `telegram`), next to the site's lines. */
describe('Director history keeps the Telegram lines', () => {
  let w: DrillWorld;
  beforeAll(async () => { w = await drillWorld({}); });
  afterAll(async () => { await w.close?.(); });

  it('a question and an old /command in Telegram appear in the history with source telegram; the site lines keep source site', async () => {
    await w.say('/pult');
    await w.settle();
    await w.say('/status');
    await w.settle();
    await w.say('привет');
    await w.settle();
    await w.adm('POST', '/admin/say', { text: 'какая-то задача с сайта' });
    const items = (await w.adm('GET', '/admin/director/history?limit=50')).json.items as { role: string; text: string; source: string }[];
    const tg = items.filter((i) => i.source === 'telegram');
    expect(tg.map((i) => i.role).slice(0, 4)).toEqual(['command', 'hq', 'command', 'hq']);
    expect(tg[0]!.text).toBe('/pult');
    expect(tg[2]!.text).toBe('/status');
    expect(tg.some((i) => i.role === 'owner' && i.text === 'привет')).toBe(true);
    expect(items.filter((i) => i.source === 'site').some((i) => i.role === 'owner' && i.text === 'какая-то задача с сайта')).toBe(true);
  });
});
