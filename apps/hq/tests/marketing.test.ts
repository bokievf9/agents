import { describe, expect, it } from 'vitest';
import { OWNER, OffLlm, routedLlm, world } from './helpers.js';
import { storeFor } from '@fir/worker-content-maker';

const J = JSON.stringify;

/** Fires the routine and runs one heartbeat of the head, the way the process does. */
async function cycle(w: ReturnType<typeof world>) {
  await w.marketing.onHeartbeat();
}

describe('Marketing head: weekly pack end to end', () => {
  it('routine -> subtasks -> review -> approvals queued -> batch -> approve -> ready; parent done and reported', async () => {
    const w = world({ groupTopics: true });
    const t = w.hq.runRoutine('marketing-weekly-pack')!;
    expect(w.hq.pendingHeartbeats()).toBe(1);
    await cycle(w);

    const kids = w.hq.tasks({ parentId: t.id });
    expect(kids).toHaveLength(8); // 7 clips + a carousel in an even week
    expect(kids.every((k) => k.status === 'approval' && k.assigneeId === 'content-maker')).toBe(true);
    expect(w.hq.task(t.id)).toMatchObject({ status: 'done' });
    expect(w.hq.task(t.id)!.result).toContain('материалов 8, на одобрение 8');
    // The head never writes to the owner: nothing in the private chat before the batch
    expect(w.messenger.sent).toHaveLength(0);
    expect(w.hq.queuedApprovals()).toHaveLength(8);
    // The report went to the department topic and into the journal
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0]).toMatchObject({ chatId: -1001, threadId: 7 });
    expect(w.hq.reports(0)).toHaveLength(1);
    // Costs of the head and worker calls were metered per department
    expect(w.hq.costSummary(0)[0]!.dept).toBe('marketing');

    // The Director's batch: a header with «Одобрить все обычные», then one numbered series, each card with buttons
    expect(await w.director.sendApprovalBatch(false)).toBe(8);
    const cards = w.messenger.sent.filter((m) => m.buttons?.flat().some((b) => /^ap:\d+:a$/.test(b.data)));
    expect(cards).toHaveLength(8);
    expect(cards[0]!.text).toContain('[1/8] marketing');
    expect(cards[0]!.text).toContain('Пакет, материал 1 из 8');
    expect(cards.every((m) => m.chatId === OWNER && m.buttons![0]!.length === 3)).toBe(true);

    const first = w.queue.pending()[0]!;
    await w.decide('approve', first.id);
    const kid = w.hq.tasks({ parentId: t.id, status: 'done' });
    expect(kid).toHaveLength(1);
    const store = storeFor({ db: w.db, now: w.hq.now });
    expect(store.readyRows().map((r) => r.platform)).toEqual(['instagram', 'tiktok', 'shorts']);
    expect(store.readyRows()[0]!.plannedDate).toBe('2026-11-23');
    expect(w.queue.level('content_item')).toBe(0);
  });

  it('a pack that already exists is not made twice', async () => {
    const w = world();
    w.hq.runRoutine('marketing-weekly-pack');
    await cycle(w);
    const first = w.hq.tasks({ dept: 'marketing' }).length;
    const t2 = w.hq.runRoutine('marketing-weekly-pack')!;
    await cycle(w);
    expect(w.hq.tasks({ dept: 'marketing' })).toHaveLength(first + 1);
    expect(w.hq.task(t2.id)!.result).toContain('уже есть');
  });

  it('the routine does not start a second pack while the first one is still open', async () => {
    const w = world();
    expect(w.hq.runRoutine('marketing-weekly-pack')).not.toBeNull();
    expect(w.hq.runRoutine('marketing-weekly-pack')).toBeNull();
  });

  it('the daily routine reports what is ready to publish today', async () => {
    const w = world({ groupTopics: true });
    w.hq.runRoutine('marketing-weekly-pack');
    await cycle(w);
    await w.director.sendApprovalBatch(false);
    // approve the item planned for 2026-11-23 and look at that day
    const first = w.queue.pending()[0]!;
    await w.decide('approve', first.id);
    w.clock.t = Date.UTC(2026, 10, 23, 4, 30); // Mon 09:30 Tashkent
    const t = w.hq.runRoutine('marketing-daily-today')!;
    await cycle(w);
    expect(w.hq.task(t.id)).toMatchObject({ status: 'done' });
    expect(w.hq.task(t.id)!.result).toContain('к выходу (1)');
    expect(w.posted.at(-1)!.text).toContain('к выходу (1)');
  });
});

describe('Marketing head: review, rework, failures', () => {
  const topicIntent = { split: () => J({ action: 'topic', topic: 'бот-администратор для барбершопа', type: 'clip' }) };

  it('a free-text task is split by the LLM; one rework with the review remarks, then approval', async () => {
    let seen = '';
    const base = routedLlm({
      ...topicIntent,
      review: (_t, n) => (n === 1 ? J({ ok: false, issues: ['слишком длинный хук'] }) : J({ ok: true, issues: [] })),
    });
    const w = world({
      llm: {
        enabled: true,
        complete: (req) => {
          if (req.messages[0]!.content.includes('слишком длинный хук')) seen += '[feedback]';
          return base.complete(req);
        },
      },
    });
    const t = w.hq.createTask({ title: 'Сделай ролик про барбершоп', dept: 'marketing', creator: 'owner' });
    await cycle(w);
    expect(seen).toContain('[feedback]');
    expect(w.hq.task(t.id)!.status).toBe('approval');
    const comments = w.hq.events(t.id).filter((e) => e.kind === 'comment').map((e) => e.body);
    expect(comments[0]).toContain('слишком длинный хук');
    const statuses = w.hq.events(t.id).filter((e) => e.kind === 'status').map((e) => e.body);
    expect(statuses.some((s) => s.includes('review -> running'))).toBe(true);
    expect(w.hq.queuedApprovals()).toHaveLength(1);
    expect(w.hq.queuedApprovals()[0]!.summary).toContain('вторая версия');
    expect(w.hq.queuedApprovals()[0]!.summary).not.toContain('Ревью отдела');
  });

  it('only one rework: remarks that remain are attached to the approval card', async () => {
    const w = world({ llm: routedLlm({ ...topicIntent, review: () => J({ ok: false, issues: ['мало конкретики'] }) }) });
    const t = w.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner' });
    await cycle(w);
    expect(w.hq.task(t.id)!.status).toBe('approval');
    expect(w.hq.queuedApprovals()[0]!.summary).toContain('Ревью отдела после доработки: мало конкретики');
    expect(w.hq.events(t.id).filter((e) => e.kind === 'comment')).toHaveLength(1);
  });

  it('without an LLM the heuristic split works for obvious wordings and generation fails cleanly', async () => {
    const w = world({ llm: new OffLlm() });
    const t = w.hq.createTask({ title: 'Нужен клип про цены', dept: 'marketing', creator: 'owner' });
    const other = w.hq.createTask({ title: 'Купить рекламу у блогера', dept: 'marketing', creator: 'owner' });
    await cycle(w);
    expect(w.hq.task(t.id)!.status).toBe('blocked');
    expect(w.hq.events(t.id).some((e) => e.kind === 'error' && e.body.includes('LLM off'))).toBe(true);
    expect(w.hq.task(other.id)!.status).toBe('blocked');
    expect(w.hq.events(other.id).some((e) => e.body.includes('Нет подходящего исполнителя'))).toBe(true);
    expect(w.messenger.sent.some((m) => m.text.startsWith('Алерт:'))).toBe(true);
  });

  it('a model returning garbage blocks the task with an alert, nothing is proposed', async () => {
    const llm = routedLlm({ ...topicIntent });
    const w = world({ llm: { enabled: true, complete: (r) => (r.system.includes('Составь') || r.messages[0]!.content.startsWith('Составь') ? Promise.resolve('не json') : llm.complete(r)) } });
    const t = w.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner' });
    await cycle(w);
    expect(w.hq.task(t.id)!.status).toBe('blocked');
    expect(w.hq.events(t.id).some((e) => e.kind === 'error' && e.body.includes('не дала валидный ответ'))).toBe(true);
    expect(w.hq.queuedApprovals()).toHaveLength(0);
  });

  it('a paused department takes no tasks; resumed, it does', async () => {
    const w = world({ llm: routedLlm(topicIntent) });
    w.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner' });
    w.hq.setDeptStatus('marketing', 'paused');
    w.hq.wake('marketing-head', 'task');
    expect(w.hq.claimDueHeartbeats()).toHaveLength(0);
    await cycle(w); // even a direct call does nothing
    expect(w.hq.tasks({ status: 'inbox' })).toHaveLength(1);
    w.hq.setDeptStatus('marketing', 'active');
    await cycle(w);
    expect(w.hq.tasks({ status: 'inbox' })).toHaveLength(0);
  });

  it('over the department budget: the task is blocked and the owner is alerted once', async () => {
    const w = world({ llm: routedLlm(topicIntent), budget: 1 });
    w.hq.recordCost({ agentId: 'content-maker', model: 'm', inputTokens: 0, outputTokens: 0, usd: 1.5 });
    await Promise.resolve();
    expect(w.messenger.sent.filter((m) => m.text.includes('лимит расходов')).length).toBe(1);
    const t = w.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner' });
    await cycle(w);
    expect(w.hq.task(t.id)!.status).toBe('blocked');
    expect(w.hq.events(t.id).some((e) => e.body.includes('Лимит'))).toBe(true);
  });
});

describe('Marketing head: owner decisions and part editing', () => {
  async function oneItem() {
    const w = world({ llm: routedLlm({ split: () => J({ action: 'topic', topic: 'тема' }) }) });
    const t = w.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner' });
    await cycle(w);
    await w.director.sendApprovalBatch(false);
    return { w, t, aid: w.queue.pending()[0]!.id };
  }

  it('reject: the task and the item are rejected', async () => {
    const { w, t, aid } = await oneItem();
    await w.decide('reject', aid);
    expect(w.hq.task(t.id)!.status).toBe('rejected');
    expect(storeFor({ db: w.db, now: w.hq.now }).counts().rejected).toBe(1);
  });

  it('edit asks which part, replaces only that part, asks again; approval keeps the edit flag', async () => {
    const { w, t, aid } = await oneItem();
    const before = w.queue.get(aid)!.payload.text as string;
    expect(await w.director.onEditPressed(aid)).toBe('Что править?');
    expect(w.messenger.last()!.buttons![0]!.map((b) => b.text)).toEqual(['Сценарий', 'Instagram', 'TikTok', 'Shorts']);
    expect(await w.director.onPartPicked(aid, 'tiktok')).toContain('TikTok');
    expect(await w.director.onPartPicked(aid, 'nope')).toBe('Нет такой части');
    await w.director.onPartPicked(aid, 'tiktok');
    await w.director.onText('Новая подпись для тикток\n#новый'); // consumed by the editor, no LLM parse
    const after = w.queue.get(aid)!.payload.text as string;
    expect(after).toContain('== TikTok ==\nНовая подпись для тикток\n#новый');
    expect(after).toContain('== Instagram ==\nig подпись');
    expect(after.split('== TikTok ==')[0]).toBe(before.split('== TikTok ==')[0]);
    expect(w.messenger.last()!.buttons).toBeDefined(); // asked again
    await w.decide('approve', aid);
    const store = storeFor({ db: w.db, now: w.hq.now });
    expect(store.counts()).toMatchObject({ ready: 1, edited: 1 });
    expect(store.readyRows()[1]!.text).toContain('Новая подпись для тикток');
    expect(w.hq.task(t.id)!.status).toBe('done');
  });

  it('script edit drops markers from the text; empty text is refused and re-armed; /skip cancels', async () => {
    const { w, aid } = await oneItem();
    await w.director.onPartPicked(aid, 'script');
    await w.director.onText('   ');
    expect(w.messenger.last()!.text).toContain('Часть не изменена');
    await w.director.onText('Клип, 25 с: правка\n== Instagram ==\nCTA: firtech.pro');
    const text = w.queue.get(aid)!.payload.text as string;
    expect(text.startsWith('Клип, 25 с: правка\nCTA: firtech.pro')).toBe(true);
    expect(text.match(/== Instagram ==/g)).toHaveLength(1);
    await w.director.onPartPicked(aid, 'instagram');
    await w.director.onCommand('skip');
    expect(await w.marketing.consume('текст')).toBe(false);
  });

  it('an edit of an already decided item is not applied; other kinds fall through to the core edit', async () => {
    const { w, aid } = await oneItem();
    await w.director.onPartPicked(aid, 'tiktok');
    await w.decide('reject', aid);
    await w.director.onText('поздно');
    expect(w.messenger.last()!.text).toContain('уже обработан');
    expect(await w.director.onEditPressed(aid)).toBe('Уже обработано');
    w.hq.registerKind('other', { initialLevel: 0, execute: () => Promise.resolve() });
    const t2 = w.hq.createTask({ title: 'x', dept: 'marketing', creator: 'owner' });
    w.hq.claim(t2.id, 'marketing-head');
    await w.hq.requestApproval(t2.id, 'marketing-head', 'other', { text: 'z' }, 's');
    await w.hq.releaseApprovals();
    expect(await w.director.onEditPressed(w.queue.pending()[0]!.id)).toBeNull();
  });
});

describe('Marketing head: silent mode', () => {
  it('without a group or bot the report only lands in the task journal and the morning summary', async () => {
    const w = world(); // no group topics
    w.hq.runRoutine('marketing-weekly-pack');
    await cycle(w);
    expect(w.posted).toHaveLength(0);
    expect(w.messenger.sent).toHaveLength(0);
    expect(w.director.morningSummary()).toContain('marketing: Пакет недели');
  });
});
