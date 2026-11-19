import { MockLlm, openDb, type Payload } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import {
  acceptFindings, auditText, closingLine, collectFacts, fallbackFindings, findingsSchema, isPrivateAddress, leadFacts, SeoWorker, composeFindings,
  type AuditFacts, type FetchFn,
} from '../src/index.js';

const PAGE = `<!doctype html><html><head><title>Салон Лайм</title><meta name="viewport" content="width=device-width">
<meta name="description" content="Стрижки и маникюр"><link rel="canonical" href="https://lime.example/"></head>
<body><h1>Салон Лайм</h1><a href="https://t.me/lime_salon">Написать</a><a href="https://instagram.com/lime">ig</a><form action="/x"></form></body></html>`;
const BARE = '<html><head><title>x</title></head><body><p>hello</p></body></html>';

const html = (body: string, status = 200): Response => new Response(body, { status, headers: { 'content-type': 'text/html' } });
const clock = { t: 1_000 };
const net = (fetchFn: FetchFn, lookup: ((h: string) => Promise<string[]>) | null = null) => ({ fetch: fetchFn, lookup, now: () => (clock.t += 100) });

describe('leadFacts and collectFacts', () => {
  it('reads viewport, messenger button, form and Instagram link', () => {
    expect(leadFacts(PAGE)).toEqual({ viewport: true, messenger: true, form: true, instagram: true });
    expect(leadFacts(BARE)).toEqual({ viewport: false, messenger: false, form: false, instagram: false });
    expect(leadFacts('<a href="https://wa.me/998901234567">w</a>').messenger).toBe(true);
  });

  it('a normal page: facts are booleans and counts, no HTML', async () => {
    const f = await collectFacts('https://lime.example/', net(() => Promise.resolve(html(PAGE))));
    expect(f).toMatchObject({ reachable: true, status: 200, title: 'Салон Лайм', hasDescription: true, h1: 1, canonical: true, og: false, viewport: true, messenger: true, form: true, instagram: true });
    expect(f.ms).toBeGreaterThan(0);
    expect(JSON.stringify(f)).not.toContain('<');
  });

  it('follows redirects but checks every hop; private addresses are never fetched', async () => {
    const calls: string[] = [];
    const lookup = (h: string) => Promise.resolve(h === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34']);
    const f = (url: string) => {
      calls.push(url);
      return Promise.resolve(url.includes('start') ? new Response(null, { status: 302, headers: { location: 'http://internal.example/admin' } }) : html(PAGE));
    };
    const r = await collectFacts('https://ok.example/start', net(f, lookup));
    expect(r).toMatchObject({ reachable: false, reason: 'blocked' });
    expect(calls).toEqual(['https://ok.example/start']);
    expect(isPrivateAddress('127.0.0.1') && isPrivateAddress('192.168.1.1') && isPrivateAddress('::1') && isPrivateAddress('::ffff:10.0.0.1') && isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
  });

  it('errors become a short reason: timeout, dns, http error', async () => {
    expect((await collectFacts('https://a.example/', net(() => Promise.reject(new DOMException('x', 'TimeoutError'))))).reason).toBe('timeout');
    expect((await collectFacts('https://a.example/', net(() => Promise.resolve(html('x')), () => Promise.reject(new Error('ENOTFOUND'))))).reason).toBe('dns');
    expect(await collectFacts('https://a.example/', net(() => Promise.resolve(html('no', 503))))).toMatchObject({ reachable: false, reason: 'http_error', status: 503 });
  });
});

const FACTS: AuditFacts = { reachable: true, status: 200, ms: 3200, title: 'x', hasDescription: false, h1: 0, canonical: false, og: false, viewport: false, messenger: false, form: false, instagram: false };
const five = (extra = '') => ({
  findings: Array.from({ length: 5 }, (_, i) => ({ problem: `Проблема ${i + 1}: клиенты уходят${extra}`, fix: `Исправление ${i + 1}: добавить кнопку` })),
  closing: 'Наш «Бот-администратор» принимает заявки сам. Напишите в @firtech_bot.',
});

describe('findings schema and composition', () => {
  it('exactly five findings and a closing line', () => {
    expect(findingsSchema.safeParse(five()).success).toBe(true);
    expect(findingsSchema.safeParse({ ...five(), findings: five().findings.slice(0, 4) }).success).toBe(false);
    expect(findingsSchema.safeParse({ ...five(), findings: [...five().findings, five().findings[0]] }).success).toBe(false);
  });

  it('a valid model answer is used, cleaned of markup and links', async () => {
    const dirty = five();
    dirty.findings[0]!.problem = '<b>Нет кнопки</b> https://evil.example/x **жирный**';
    const llm = new MockLlm(() => JSON.stringify(dirty));
    const r = await composeFindings(llm, FACTS, 'ru');
    expect(r.findings).toHaveLength(5);
    expect(r.findings[0]!.problem).toBe('Нет кнопки жирный');
    expect(llm.calls[0]!.system).toContain('exactly 5');
    // the user message carries facts only
    expect(llm.calls[0]!.messages[0]!.content).toContain('"messenger":false');
    expect(llm.calls[0]!.messages[0]!.content).not.toContain('<');
  });

  it('a price, a wrong count or garbage falls back to the template (five findings, product by name, no prices)', async () => {
    for (const reply of [JSON.stringify(five(', всего $200')), JSON.stringify({ ...five(), findings: five().findings.slice(1) }), 'не json']) {
      const r = await composeFindings(new MockLlm(() => reply), FACTS, 'ru');
      expect(r.findings).toHaveLength(5);
      expect(r.closing).toContain('Бот-администратор');
      expect(JSON.stringify(r)).not.toMatch(/\$|usd/i);
    }
    expect(acceptFindings(five(), FACTS, 'ru')).not.toBeNull();
  });

  it('a closing line without a real product name is replaced; the matching product follows the gap', () => {
    const odd = { ...five(), closing: 'Купите что-нибудь у нас, это недорого.' };
    expect(acceptFindings(odd, FACTS, 'ru')!.closing).toBe(closingLine(FACTS, 'ru'));
    expect(closingLine({ ...FACTS, messenger: true, form: false }, 'ru')).toContain('ИИ-приёмщик заявок');
    expect(closingLine(FACTS, 'en')).toContain('Booking bot');
  });

  it('an unreachable site: findings about the fact and a request for the Instagram page', async () => {
    const dead: AuditFacts = { ...FACTS, reachable: false, reason: 'timeout', title: null };
    const r = await composeFindings(new MockLlm(() => 'мусор'), dead, 'ru');
    expect(r.findings[0]!.problem).toContain('не ответил');
    expect(r.closing).toContain('Instagram');
    const en = fallbackFindings(dead, 'en');
    expect(en.findings).toHaveLength(5);
    expect(en.closing).toContain('Instagram');
  });

  it('the text for the person has the host and the findings, no HTML and no full URL', () => {
    const text = auditText('lime.example', fallbackFindings(FACTS, 'ru'), 'ru');
    expect(text).toContain('lime.example');
    expect(text.match(/^\d\. /gm)).toHaveLength(5);
    expect(text).not.toMatch(/<|https?:\/\//);
  });
});

describe('SeoWorker action audit', () => {
  const ctxFor = (llm: MockLlm) => {
    const staged: { kind: string; payload: Payload; summary: string }[] = [];
    const ctx: WorkerCtx = {
      llm, db: openDb(':memory:'), tz: 'Asia/Tashkent', now: () => 5,
      requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1), log: () => undefined,
    };
    return { ctx, staged };
  };
  const task = (meta: Record<string, unknown>) => ({ id: 1, meta } as unknown as Task);

  it('fetches the page, asks the model, proposes one approval of kind audit', async () => {
    const { ctx, staged } = ctxFor(new MockLlm(() => JSON.stringify(five())));
    const w = new SeoWorker({ fetch: () => Promise.resolve(html(PAGE)) });
    const r = await w.run(task({ action: 'audit', auditId: 7, url: 'https://lime.example/', locale: 'ru', contact: '@dilnoza' }), ctx);
    expect(r.ok).toBe(true);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.kind).toBe('audit');
    expect(staged[0]!.payload).toMatchObject({ auditId: 7, host: 'lime.example', locale: 'ru' });
    expect(String(staged[0]!.payload.text)).toContain('Проблема 1');
    expect(staged[0]!.summary).toContain('@dilnoza');
    expect(r.result).not.toContain('@dilnoza');
  });

  it('a dead URL still produces an audit about that fact', async () => {
    const { ctx, staged } = ctxFor(new MockLlm(() => 'мусор'));
    const w = new SeoWorker({ fetch: () => Promise.reject(new Error('ECONNREFUSED')) });
    const r = await w.run(task({ action: 'audit', auditId: 8, url: 'https://dead.example/', locale: 'en', contact: '@x_user' }), ctx);
    expect(r).toMatchObject({ ok: true });
    expect(r.result).toContain('не открылся');
    expect(String(staged[0]!.payload.text)).toContain('Instagram');
  });

  it('refuses a task without a url', async () => {
    const { ctx } = ctxFor(new MockLlm(() => ''));
    expect((await new SeoWorker({}).run(task({ action: 'audit' }), ctx)).ok).toBe(false);
  });
});
