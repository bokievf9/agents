import { HostQueue, ReachStore, createTools, openDb, type ToolFetch } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { readSourcePage } from '../src/source-page.js';

const URL_ = 'https://example.org/post';
const LONG = '<html><body><p>' + 'Бот принимает запись ночью и напоминает клиенту о визите. '.repeat(12) + '</p></body></html>';
const SHORT = '<html><body><div id="app"></div><script>boot()</script></body></html>';

function world(page: string, channels: string[] = []) {
  const db = openDb(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('reach.channels', JSON.stringify(channels));
  const seen: string[] = [];
  const fetch: ToolFetch = (url) => {
    seen.push(url);
    return Promise.resolve(url.startsWith('https://r.jina.ai/') ? new Response('', { status: 503 }) : new Response(page, { headers: { 'content-type': 'text/html' } }));
  };
  const tools = createTools({ agentId: 'content-maker', dept: 'marketing', db, now: () => 0, fetch, lookup: () => Promise.resolve(['93.184.216.34']), queue: new HostQueue(() => 0, () => Promise.resolve()) });
  return { db, tools, seen };
}

describe('the source page of a content item', () => {
  it('a readable page is used as it is, no reach job', async () => {
    const w = world(LONG, ['web']);
    const r = await readSourcePage(w.tools, w.db, URL_);
    expect(r?.via).toBe('own');
    expect(r?.text.length).toBeGreaterThan(400);
    expect(w.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'rc_jobs'").get()).toEqual({ n: 0 });
  });

  it('a script-built page (own and Jina both under 400 characters): the Mac is asked; queued gives null now, done gives the Mac text', async () => {
    const w = world(SHORT, ['web']);
    expect(await readSourcePage(w.tools, w.db, URL_)).toBeNull();
    const store = new ReachStore(w.db, () => 0);
    expect(store.get(1)).toMatchObject({ channel: 'web', action: 'read', status: 'queued', args: { target: URL_ } });
    store.claim(1);
    store.finish(1, { ok: true, result: { ok: true, items: [{ text: 'Полный текст страницы, собранный на Маке. '.repeat(20) }], meta: {} } });
    const r = await readSourcePage(w.tools, w.db, URL_);
    expect(r?.via).toBe('reach');
    expect(r?.text).toContain('Полный текст страницы');
  });

  it('the Mac has no web channel, or the job failed: the short text of the page (or nothing), never an error', async () => {
    const off = world(SHORT, []);
    expect(await readSourcePage(off.tools, off.db, URL_)).toBeNull();
    const w = world(SHORT, ['web']);
    await readSourcePage(w.tools, w.db, URL_);
    const store = new ReachStore(w.db, () => 0);
    store.claim(1);
    store.finish(1, { ok: false, error: 'PLATFORM_BLOCKED' });
    expect(await readSourcePage(w.tools, w.db, URL_)).toBeNull();
    expect(await readSourcePage(w.tools, w.db, 'http://insecure.example/x')).toBeNull();
  });
});

describe('a topic task with meta.sourceUrl', () => {
  it('the page text reaches the model as data; without a readable page the item is still made', async () => {
    const { MockLlm } = await import('@fir/core');
    const { setup, clipJson } = await import('./helpers.js');
    const w = world(LONG);
    const prompts: string[] = [];
    const s = setup({ llm: new MockLlm((r) => { prompts.push(r.messages[0]!.content); return clipJson(); }) });
    const ctx = { ...s.ctx, db: w.db, tools: w.tools };
    const r = await s.worker.run(s.task({ action: 'topic', topic: 'рилс: бот ночью', sourceUrl: URL_ }), ctx);
    expect(r.ok).toBe(true);
    expect(prompts.some((p) => p.includes('Текст страницы-источника') && p.includes('напоминает клиенту о визите'))).toBe(true);
    const bad = await s.worker.run(s.task({ action: 'topic', topic: 'рилс: бот ночью', sourceUrl: 'not a url' }), ctx);
    expect(bad.ok).toBe(true);
  });
});
