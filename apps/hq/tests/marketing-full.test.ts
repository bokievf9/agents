import { MockLlm, type LlmRequest } from '@fir/core';
import { storeFor } from '@fir/worker-content-maker';
import { describe, expect, it } from 'vitest';
import { OWNER, clipJson, openPack, routedLlm, world } from './helpers.js';

const J = JSON.stringify;
const RSS = '<rss><channel><item><title>ИИ агенты для бизнеса</title><ht:approx_traffic>500+</ht:approx_traffic></item></channel></rss>';

/** Routed LLM that also answers the new workers; everything else goes to the standard router. */
function fullLlm(extra: (r: LlmRequest) => string | null = () => null) {
  const base = routedLlm();
  return new MockLlm((r) => {
    const x = extra(r);
    if (x !== null) return x;
    if (r.system.includes('трендвотчер')) return J({ items: [{ n: 1, hook: 'Агент отвечает ночью', format: 'клип 30 с', why: 'растёт', direction: 'receptionist' }] });
    if (r.system.includes('аналитик отдела')) return J({ recommendations: ['Первая рекомендация', 'Вторая рекомендация', 'Третья рекомендация'] });
    return base.complete(r) as unknown as string;
  });
}

const fetchStub = (html = '<html><head><title>Hi</title></head><body></body></html>') => (url: string): Promise<Response> => {
  if (url.startsWith('https://trends.google.com')) return Promise.resolve(new Response(RSS));
  if (url.startsWith('https://firtech.pro')) return Promise.resolve(new Response(html));
  return Promise.resolve(new Response('', { status: 404 }));
};

async function cycle(w: ReturnType<typeof world>) {
  await w.marketing.onHeartbeat();
}

describe('Marketing: new routines through the head', () => {
  it('the daily trends routine runs the scout, stores five-or-fewer items and reports a brief into the journal', async () => {
    const w = world({ llm: fullLlm(), integrations: { trendsRegions: ['KZ'], fetch: fetchStub() } });
    const t = w.hq.runRoutine('marketing-trends-daily')!;
    await cycle(w);
    expect(w.hq.task(t.id)).toMatchObject({ status: 'done' });
    expect(w.hq.task(t.id)!.result).toContain('Агент отвечает ночью');
    const rep = w.hq.reports(0).find((r) => r.taskId === t.id)!;
    expect(rep.body).toContain('Агент отвечает ночью');
    expect(rep.body).not.toContain('Источник:');
    expect(w.messenger.sent).toHaveLength(0);
    // the content-maker now reads the trends: a topic task carries them into the prompt
    const prompts: string[] = [];
    const w2 = world({ llm: fullLlm((r) => (r.messages[0]!.content.includes('Свежие тренды') ? (prompts.push(r.messages[0]!.content), clipJson()) : null)), integrations: { trendsRegions: ['KZ'], fetch: fetchStub() } });
    w2.hq.runRoutine('marketing-trends-daily');
    await cycle(w2);
    w2.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner', meta: { action: 'topic', topic: 'приёмщик заявок' } });
    await cycle(w2);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain('Агент отвечает ночью');
  });

  it('the weekly analyst report lands in the journal and the Director summary shows it whole', async () => {
    const w = world({ llm: fullLlm() });
    const t = w.hq.runRoutine('marketing-analyst-weekly')!;
    await cycle(w);
    expect(w.hq.task(t.id)!.status).toBe('done');
    const summary = w.director.morningSummary();
    expect(summary).toContain('Недельный отчёт маркетинга');
    expect(summary).toContain('3. Третья рекомендация');
  });

  it('a SEO proposal goes to the Director batch; approving it makes a blocked task tagged builder', async () => {
    const w = world({ llm: fullLlm(), integrations: { fetch: fetchStub() } });
    const t = w.hq.runRoutine('marketing-seo-weekly')!;
    await cycle(w);
    expect(w.hq.task(t.id)!.status).toBe('approval');
    expect(w.hq.queuedApprovals().length).toBe(5);
    expect(await w.director.sendApprovalBatch(false)).toBe(5);
    const first = w.queue.pending()[0]!;
    expect(first.kind).toBe('seo_proposal');
    await w.decide('approve', first.id);
    const fix = w.hq.tasks({ dept: 'marketing', status: 'blocked' }).find((x) => x.meta.action === 'seo_fix')!;
    expect(fix.tags).toContain('builder');
    expect(fix.title).toContain('SEO:');
    expect(w.queue.level('seo_proposal')).toBe(0);
  });

  it('a failing worker blocks the task and alerts; the department keeps going', async () => {
    const w = world({ llm: fullLlm(), integrations: { fetch: () => Promise.resolve(new Response('', { status: 500 })) } });
    const t = w.hq.runRoutine('marketing-seo-weekly')!;
    await cycle(w);
    expect(w.hq.task(t.id)!.status).toBe('blocked');
    expect(w.messenger.sent.some((m) => m.text.includes('не выполнена'))).toBe(true);
  });
});

describe('Marketing: the daily publish flow', () => {
  async function approvedToday() {
    const w = world({ llm: fullLlm() });
    w.hq.runRoutine('marketing-weekly-pack');
    await cycle(w);
    await w.director.sendApprovalBatch(false);
    await openPack(w);
    await w.decide('approve', w.queue.pending()[0]!.id); // the item planned for Mon 23.11
    w.messenger.sent.length = 0;
    w.clock.t = Date.UTC(2026, 10, 23, 4, 0); // Mon 09:00 Tashkent
    return w;
  }

  it('sends the pack with an «Опубликовано» button per platform; the press stores the state; nothing posts by itself', async () => {
    const w = await approvedToday();
    const t = w.hq.runRoutine('marketing-daily-today')!;
    await cycle(w);
    expect(w.hq.task(t.id)!.status).toBe('done');
    expect(w.hq.task(t.id)!.result).toContain('Пакетов отправлено владельцу: 1 из 1');
    const msg = w.messenger.sent.find((m) => m.buttons)!;
    expect(msg.chatId).toBe(OWNER);
    expect(msg.text).toContain('Публикуем: клип');
    expect(msg.buttons![0]!.map((b) => b.text)).toEqual(['Опубликовано: Instagram', 'Опубликовано: TikTok', 'Опубликовано: Shorts']);
    // press TikTok
    const tiktok = msg.buttons![0]![1]!;
    expect(w.marketing.onPublished(Number(tiktok.data.slice(3)))).toBe('Отмечено: TikTok');
    expect(w.marketing.onPublished(Number(tiktok.data.slice(3)))).toBe('Уже отмечено');
    expect(storeFor({ db: w.db, now: w.hq.now }).readyRows().map((r) => r.platform)).toEqual(['instagram', 'shorts']);
    expect(w.hq.activity().some((a) => a.action === 'published')).toBe(true);
    // the next daily run the same day does not resend the item
    w.messenger.sent.length = 0;
    w.hq.runRoutine('marketing-daily-today');
    await cycle(w);
    expect(w.messenger.sent.filter((m) => m.buttons)).toHaveLength(0);
  });

  it('nothing approved for today: a plain report, no private message', async () => {
    const w = world({ llm: fullLlm() });
    const t = w.hq.runRoutine('marketing-daily-today')!;
    await cycle(w);
    expect(w.hq.task(t.id)!.result).toContain('одобренных материалов нет');
    expect(w.messenger.sent).toHaveLength(0);
  });
});
