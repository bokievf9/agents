import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEPARTMENTS, TOOL_ERROR_CODES, TOOL_POLICY, createTools, fail, failStatus, isAllowed, okv, readToolStats, registryNames, toolCatalog, withTool, type CallContext,
} from '../../src/index.js';
import { FakeJournal, NOW, fakeNet, tools } from './helpers.js';

const DOC = readFileSync(new URL('../../../../docs/tools.md', import.meta.url), 'utf8');

describe('registry completeness', () => {
  it('every tool of the registry is in the policy and every policy row is a tool', () => {
    const names = registryNames();
    const policy = TOOL_POLICY.map((p) => p.name).sort();
    expect(names).toEqual(policy);
    expect(new Set(policy).size).toBe(policy.length);
  });

  it('every tool is named in docs/tools.md', () => {
    for (const p of TOOL_POLICY) expect(DOC, p.name).toContain(`\`${p.name}`);
  });

  it('departments in the policy are known ones; every department has the basic tools', () => {
    for (const p of TOOL_POLICY) for (const d of p.departments) expect(DEPARTMENTS).toContain(d);
    for (const d of DEPARTMENTS) for (const n of ['web.getJson', 'llm.json', 'prices.get', 'clock.now', 'knowledge.search']) expect(isAllowed(n, d), `${d} ${n}`).toBe(true);
    expect(isAllowed('web.search', 'production')).toBe(false);
    expect(isAllowed('nonsense', 'marketing')).toBe(false);
    expect(isAllowed('web.getJson', 'stranger')).toBe(false);
  });

  it('an unknown tool and a forbidden one are not_allowed, journaled, never thrown', async () => {
    const { t, journal } = tools({ dept: 'production', agentId: 'pm' });
    expect(await t.call('web.nothing')).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(await t.call('constructor')).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(await t.call('web.search', 'x')).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(await t.web.search('боты')).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(await t.call('clock.now')).toMatchObject({ ok: true });
    expect(journal.lines.map((l) => l.action)).toEqual(['tool:web.nothing', 'tool:constructor', 'tool:web.search', 'tool:web.search']);
    expect(t.list()).not.toContain('web.search');
    expect(t.can('web.getJson')).toBe(true);
  });

  it('call() dispatches by the dotted name', async () => {
    const net = fakeNet({ 'https://api.example.com/': Response.json({ a: 1 }) });
    const { t } = tools({ fetch: net.fetch });
    expect(await t.call('web.getJson', 'https://api.example.com/x', { hosts: ['api.example.com'] })).toEqual({ ok: true, value: { a: 1 } });
    expect(await t.call('mac.poster.enqueue', 0, 'instagram')).toMatchObject({ ok: false, error: 'not_configured' }); // no db
  });

  it('the catalog lists rights, set-up state and today\'s counters', async () => {
    const { t, journal } = tools({ fetch: fakeNet({}).fetch });
    await t.web.getJson('https://api.example.com/x', { hosts: ['api.example.com'] }); // 404
    await t.media.qr('hi'); // marketing may not: a not_allowed call counts as an error
    const cat = toolCatalog({ journal, now: () => NOW, tz: 'Asia/Dushanbe', config: { resendApiKey: 'k', emailFrom: 'a@b.co' } });
    expect(cat).toHaveLength(TOOL_POLICY.length);
    expect(cat.find((c) => c.name === 'web.getJson')).toMatchObject({ callsToday: 1, errorsToday: 1, configured: true });
    expect(cat.find((c) => c.name === 'media.qr')).toMatchObject({ callsToday: 1, errorsToday: 1 });
    expect(cat.find((c) => c.name === 'email.send')!.configured).toBe(true);
    expect(cat.find((c) => c.name === 'google.searchConsole')!.configured).toBe(false);
    expect(cat.find((c) => c.name === 'files.put')!.configured).toBe(false);
  });
});

describe('withTool: the result contract', () => {
  const cx = (journal = new FakeJournal()): CallContext & { journal: FakeJournal } => ({ agentId: 'a', dept: 'marketing', taskId: 3, journal, now: () => NOW, tz: 'Asia/Dushanbe', sleep: () => Promise.resolve() });

  it('success: one activity line «ok Nms» on the task, counters bumped', async () => {
    const c = cx();
    expect(await withTool('web.getJson', c, { allowed: true }, () => Promise.resolve(okv(5)))).toEqual({ ok: true, value: 5 });
    expect(c.journal.lines).toEqual([{ agentId: 'a', action: 'tool:web.getJson', objectType: 'task', objectId: '3', detail: 'ok 0ms' }]);
    expect(readToolStats(c.journal, '2026-11-20')).toEqual({ 'web.getJson': { calls: 1, errors: 0, codes: {} } });
  });

  it('a throwing tool becomes internal; not allowed and not configured never run', async () => {
    const c = cx();
    let ran = 0;
    const boom = () => {
      ran++;
      throw new Error('kaput');
    };
    expect(await withTool('x', c, { allowed: true }, boom)).toMatchObject({ ok: false, error: 'internal', retryable: false });
    expect(await withTool('x', c, { allowed: false }, boom)).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(await withTool('x', c, { allowed: true, configured: false }, boom)).toMatchObject({ ok: false, error: 'not_configured' });
    expect(ran).toBe(1);
    expect(readToolStats(c.journal, '2026-11-20').x).toEqual({ calls: 3, errors: 3, codes: { internal: 1, not_allowed: 1, not_configured: 1 } });
  });

  it('retries only retryable failures, with backoff', async () => {
    const sleeps: number[] = [];
    const c = { ...cx(), sleep: (ms: number) => (sleeps.push(ms), Promise.resolve()) };
    let n = 0;
    const flaky = () => Promise.resolve(++n < 3 ? fail('network', 'down') : okv('ok'));
    expect(await withTool('x', c, { allowed: true, retries: 2 }, flaky)).toEqual({ ok: true, value: 'ok' });
    expect(sleeps).toEqual([500, 1000]);
    n = 0;
    expect(await withTool('x', c, { allowed: true, retries: 5 }, () => Promise.resolve((n++, fail('invalid', 'bad'))))).toMatchObject({ error: 'invalid' });
    expect(n).toBe(1);
  });

  it('secrets never reach a message; quiet tools journal only failures', async () => {
    const c = { ...cx(), secrets: ['SUPERSECRET'] };
    expect(await withTool('x', c, { allowed: true }, () => Promise.resolve(fail('upstream', 'key SUPERSECRET rejected')))).toMatchObject({ message: 'key *** rejected' });
    const q = cx();
    await withTool('cache.get', q, { allowed: true, quiet: true }, () => Promise.resolve(okv(1)));
    expect(q.journal.lines).toEqual([]);
    expect(readToolStats(q.journal, '2026-11-20')['cache.get']!.calls).toBe(1);
  });

  it('failStatus maps HTTP statuses; codes are the documented set', () => {
    expect(failStatus(404, 'h')).toMatchObject({ error: 'not_found', retryable: false, status: 404 });
    expect(failStatus(429, 'h')).toMatchObject({ error: 'rate_limited', retryable: true });
    expect(failStatus(503, 'h')).toMatchObject({ error: 'upstream', retryable: true });
    expect(failStatus(400, 'h')).toMatchObject({ error: 'upstream', retryable: false });
    for (const code of TOOL_ERROR_CODES) expect(DOC).toContain(`\`${code}\``);
  });

  it('a broken journal does not break the call', async () => {
    const bad = { log: () => { throw new Error('db locked'); }, setting: () => '', setSetting: () => undefined };
    expect(await withTool('x', { ...cx(), journal: bad }, { allowed: true }, () => Promise.resolve(okv(1)))).toEqual({ ok: true, value: 1 });
  });

  it('a toolbox without a journal still works', async () => {
    const t = createTools({ agentId: 'x', dept: 'sales' });
    expect((await t.media.qr('x')).ok).toBe(true);
    expect(t.clock.week('2026-11-20')).toEqual({ week: '2026-W47', from: '2026-11-16', to: '2026-11-22' });
  });
});
