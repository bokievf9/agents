import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { MockLlm, OffLlm, getPrices, isoWeek, openDb, redactContacts } from '../../src/index.js';
import { NOW, tools } from './helpers.js';

const req = { tier: 'haiku' as const, system: 's', messages: [{ role: 'user' as const, content: 'u' }] };

describe('llm tools', () => {
  it('json: schema-checked, upstream on garbage, not_configured in LLM off, invalid request', async () => {
    const schema = z.object({ n: z.number() });
    expect(await tools({ llm: new MockLlm(() => 'вот: {"n": 3}') }).t.llm.json(req, schema)).toEqual({ ok: true, value: { n: 3 } });
    const junk = new MockLlm(() => 'нет');
    expect(await tools({ llm: junk }).t.llm.json(req, schema)).toMatchObject({ ok: false, error: 'upstream', retryable: false });
    expect(junk.calls).toHaveLength(3); // tryJson asks three times, the tool does not multiply that
    expect(await tools({ llm: new OffLlm() }).t.llm.json(req, schema)).toMatchObject({ error: 'not_configured' });
    expect(await tools({ llm: new MockLlm(() => '{}') }).t.llm.json({ ...req, messages: [] }, schema)).toMatchObject({ error: 'invalid' });
  });

  it('text: the answer, or upstream when the model fails', async () => {
    expect(await tools({ llm: new MockLlm(() => 'привет') }).t.llm.text(req)).toEqual({ ok: true, value: 'привет' });
    expect(await tools({ llm: new MockLlm(() => Promise.reject(new Error('502'))) }).t.llm.text(req)).toMatchObject({ error: 'upstream' });
    expect(await tools().t.llm.text(req)).toMatchObject({ error: 'not_configured' });
  });
});

describe('prices, playbook, knowledge', () => {
  it('prices are the site price list; a playbook excerpt by role', async () => {
    const { t } = tools();
    expect(await t.prices.get()).toEqual({ ok: true, value: getPrices() });
    const ex = await t.playbook.excerpt('trend-scout');
    expect(ex.ok && ex.value).toContain('Трендвотчер');
    expect(ex.ok && ex.value.length).toBeLessThanOrEqual(2500);
    expect(await t.playbook.excerpt('nobody')).toMatchObject({ error: 'invalid' });
  });

  it('knowledge: full-text over knowledge/**.md and lessons; add writes a lesson the weekly export picks up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fir-kb-'));
    mkdirSync(join(dir, 'playbooks'));
    mkdirSync(join(dir, 'lessons'));
    writeFileSync(join(dir, 'playbooks', 'sales.md'), '# Продажи\n\n## Правила\n- Отвечать в течение часа.\n- Цены только из прайс-листа.\n');
    writeFileSync(join(dir, 'lessons', '2026-11.md'), '## dono\n- 2026-11-02: деплой через docker compose, не забыть права на data.\n');
    const db = openDb(':memory:');
    const { t } = tools({ db, config: { knowledgeDir: dir } });
    expect(await t.knowledge.search('цены прайс')).toMatchObject({ ok: true, value: [{ kind: 'file', ref: 'playbooks/sales.md', title: 'Продажи' }] });
    expect(await t.knowledge.add({ project: 'vibely', text: 'Деплой упал: забыли миграцию перед рестартом.' })).toEqual({ ok: true, value: { id: 1 } });
    const r = await t.knowledge.search('деплоя');
    expect(r.ok && r.value.map((h) => h.ref)).toEqual(expect.arrayContaining(['lessons/2026-11.md', 'lesson:1']));
    expect(db.prepare('SELECT project, exported_task FROM kb_lessons').all()).toEqual([{ project: 'vibely', exported_task: null }]);
    expect(await t.knowledge.search('ab')).toMatchObject({ error: 'invalid' });
    expect(await t.knowledge.add({ project: 'x', text: 'short' })).toMatchObject({ error: 'invalid' });
    expect(await t.knowledge.add({ project: 'x', text: 'y'.repeat(2001) })).toMatchObject({ error: 'too_large' });
    expect(await tools().t.knowledge.add({ project: 'x', text: 'долгий урок без базы' })).toMatchObject({ error: 'not_configured' });
  });
});

describe('events.week', () => {
  it('the last seven days of site counters on the company clock; available false without the table', async () => {
    const db = openDb(':memory:');
    const { t } = tools({ db });
    expect(await t.events.week()).toMatchObject({ ok: true, value: { available: false, from: '2026-11-14', to: '2026-11-20' } });
    db.exec("CREATE TABLE site_events (day TEXT, name TEXT, path TEXT DEFAULT '', ref TEXT DEFAULT '', locale TEXT DEFAULT '', count INTEGER, PRIMARY KEY (day, name, path, ref, locale))");
    db.prepare("INSERT INTO site_events (day, name, path, count) VALUES ('2026-11-20','lead_sent','/ru',2),('2026-11-19','lead_sent','/en',1),('2026-11-14','chat_open','',5),('2026-11-13','chat_open','',9)").run();
    const r = await t.events.week();
    expect(r).toMatchObject({ ok: true, value: { available: true, totals: { lead_sent: 3, chat_open: 5 } } });
    expect(r.ok && r.value.byDay.map((d) => d.count)).toEqual([5, 0, 0, 0, 0, 1, 2]);
    expect(await tools({ db, dept: 'sales' }).t.events.week()).toMatchObject({ error: 'not_allowed' });
  });
});

describe('crm (read-only views, department scoping)', () => {
  const crm = (panel: string, q: Record<string, string>) => ({
    ok: true,
    items: panel === 'documents' ? [{ id: 'bl:1', kind: q.kind, number: 'FT-1' }] : [{ id: 1, name: 'Салон', contact: '@salon', phone: '+992', nested: { email: 'a@b.c', stage: 'new' }, stage: 'new', limit: q.limit }],
  });

  it('sales sees contacts, marketing does not; invoices are documents of kind invoice; limits clamp', async () => {
    const s = await tools({ dept: 'sales', crm }).t.crm.leads({ limit: 1000 });
    expect(s).toMatchObject({ ok: true, value: [{ contact: '@salon', phone: '+992', limit: '100' }] });
    const m = await tools({ dept: 'marketing', crm }).t.crm.leads();
    expect(m).toEqual({ ok: true, value: [{ id: 1, name: 'Салон', nested: { stage: 'new' }, stage: 'new', limit: '50' }] });
    expect(await tools({ dept: 'backoffice', crm }).t.crm.invoices()).toEqual({ ok: true, value: [{ id: 'bl:1', kind: 'invoice', number: 'FT-1' }] });
    expect(await tools({ dept: 'production', crm }).t.crm.leads()).toMatchObject({ error: 'not_allowed' });
    expect(await tools({ dept: 'sales' }).t.crm.leads()).toMatchObject({ error: 'not_configured' });
    expect(await tools({ dept: 'support', crm: () => ({ ok: false, error: 'invalid_status' }) }).t.crm.tickets({ status: 'x' })).toMatchObject({ error: 'invalid' });
    expect(redactContacts([{ contact: 1, a: [{ email: 2, b: 3 }] }])).toEqual([{ a: [{ b: 3 }] }]);
  });
});

describe('clock', () => {
  it('now, zoned in a valid zone (else the company one), ISO weeks across a year end', () => {
    const { t } = tools();
    expect(t.clock.now()).toBe(NOW);
    expect(t.clock.zoned()).toMatchObject({ date: '2026-11-20', h: 11, tz: 'Asia/Dushanbe' });
    expect(t.clock.zoned('Asia/Kuala_Lumpur')).toMatchObject({ h: 14, tz: 'Asia/Kuala_Lumpur' });
    expect(t.clock.zoned('Mars/Base')).toMatchObject({ tz: 'Asia/Dushanbe' });
    expect(t.clock.week()).toEqual({ week: '2026-W47', from: '2026-11-16', to: '2026-11-22' });
    expect(isoWeek('2027-01-01')).toEqual({ week: '2026-W53', from: '2026-12-28', to: '2027-01-03' });
    expect(isoWeek('2024-12-30')).toEqual({ week: '2025-W01', from: '2024-12-30', to: '2025-01-05' });
    expect(t.clock.week('garbage')).toEqual(t.clock.week());
  });
});
