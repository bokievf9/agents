/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DEDUPE_TTL_MS, leadDedupe } from '../src/lead-dedupe.js';
import { createWebhook } from '../src/webhook.js';

const LEAD = { name: 'Дильноза', contact: '@dilnoza', service: 'bot', siteLeadId: 'site-lead-0001' };

async function boot(clock: { t: number }) {
  const db = new Database(':memory:') as any;
  let made = 0;
  const s = createWebhook(
    () => new Promise((r) => setTimeout(() => r({ id: ++made, leadId: 100 + made }), 20)),
    'secret', () => clock.t, undefined, undefined, undefined, { leadDedupe: leadDedupe(db, () => clock.t) },
  );
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  return { s, made: () => made, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}
const post = (url: string, b: unknown) => fetch(`${url}/lead`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lead-token': 'secret' }, body: JSON.stringify(b) });

describe('POST /lead idempotency by siteLeadId', () => {
  it('a resend answers like the first with duplicate: true and creates nothing; another id or none makes a new lead', async () => {
    const clock = { t: 1_000_000 };
    const { s, made, url } = await boot(clock);
    try {
      const a = await (await post(url, LEAD)).json();
      expect(a).toEqual({ ok: true, id: 1, leadId: 101, notified: true });
      expect(await (await post(url, LEAD)).json()).toEqual({ ok: true, id: 1, leadId: 101, notified: true, duplicate: true });
      expect(made()).toBe(1);
      expect((await (await post(url, { ...LEAD, siteLeadId: 'site-lead-0002' })).json() as any).id).toBe(2);
      const none = { name: LEAD.name, contact: LEAD.contact, service: LEAD.service };
      expect((await (await post(url, none)).json() as any).id).toBe(3);
      expect((await (await post(url, none)).json() as any).id).toBe(4);
    } finally {
      s.close();
    }
  });

  it('two simultaneous requests with one id make one lead; after the TTL the id is free again', async () => {
    const clock = { t: 1_000_000 };
    const { s, made, url } = await boot(clock);
    try {
      const [r1, r2] = await Promise.all([post(url, LEAD), post(url, LEAD)]);
      const bodies = [await r1.json(), await r2.json()] as any[];
      expect(made()).toBe(1);
      expect(bodies.filter((b) => b.duplicate).length).toBe(1);
      expect(bodies.every((b) => b.id === 1 && b.notified === true)).toBe(true);
      clock.t += DEDUPE_TTL_MS + 1;
      expect(((await (await post(url, LEAD)).json()) as any).duplicate).toBeUndefined();
      expect(made()).toBe(2);
    } finally {
      s.close();
    }
  });

  it('a malformed siteLeadId is ignored, not a 400', async () => {
    const { s, made, url } = await boot({ t: 1 });
    try {
      expect((await post(url, { ...LEAD, siteLeadId: 'x' })).status).toBe(200);
      expect((await post(url, { ...LEAD, siteLeadId: 'x' })).status).toBe(200);
      expect(made()).toBe(2);
    } finally {
      s.close();
    }
  });
});
