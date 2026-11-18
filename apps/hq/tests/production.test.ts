import { ApprovalQueue, MemoryMessenger, MockLlm, openDb } from '@fir/core';
import { Hq } from '@fir/hq';
import { PmStore } from '@fir/worker-project-manager';
import { describe, expect, it } from 'vitest';
import { BuilderBridge, type GithubClient, type IssueState } from '../src/bridge.js';
import { Director } from '../src/director.js';
import { PRODUCTION_HEAD_ID, ProductionHead, seedProduction } from '../src/heads/production.js';
import { Reporter } from '../src/reporter.js';

const OWNER = 100;
const DAY = 86_400_000;
// Wed 2026-11-18 12:00 Tashkent
const T0 = Date.UTC(2026, 10, 18, 7, 0);

class MockGithub implements GithubClient {
  issues = new Map<number, IssueState>();
  created: { title: string; body: string }[] = [];
  async createIssue(i: { title: string; body: string; labels: string[] }) {
    this.created.push(i);
    const number = 40 + this.created.length;
    const url = `https://github.com/bokievf9/agents/issues/${number}`;
    this.issues.set(number, { number, url, state: 'open', labels: i.labels, lastComment: null });
    return { number, url };
  }
  async getIssue(n: number) {
    return this.issues.get(n)!;
  }
  close(n: number, comment: string) {
    this.issues.set(n, { ...this.issues.get(n)!, state: 'closed', lastComment: comment });
  }
}

function world() {
  const clock = { t: T0 };
  const db = openDb(':memory:');
  const messenger = new MemoryMessenger();
  const hq = new Hq(db, { now: () => clock.t });
  const queue = new ApprovalQueue(db, messenger, OWNER, 20, () => clock.t);
  hq.attachQueue(queue);
  hq.upsertAgent({ id: 'director', dept: 'hq', role: 'director', title: 'Директор' });
  hq.upsertAgent({ id: 'support-head', dept: 'support', role: 'head', title: 'Сопровождение' });
  seedProduction(hq, { productionBudgetUsd: 0 }, () => 'Инструкция головы производства');
  const llm = new MockLlm(() => '');
  const reporter = new Reporter(undefined, {}, new Map());
  const director = new Director({ hq, llm, messenger, queue, ownerId: OWNER, reporter });
  const head = new ProductionHead({ hq, llm, queue, messenger, ownerId: OWNER, reporter });
  director.commands.set('project', { dept: 'production', run: (a) => head.command('project', a) });
  director.summaryLines.push(() => head.overdueLine());
  const gh = new MockGithub();
  const bridge = new BuilderBridge({ hq, github: gh });
  const approveAll = async () => {
    await hq.releaseApprovals();
    for (const p of queue.pending()) await queue.handle('approve', p.id, OWNER);
    director.afterDecision();
  };
  return { clock, hq, messenger, queue, director, head, gh, bridge, approveAll, store: new PmStore(db, () => clock.t) };
}

async function projectWithApprovedSpec(w: ReturnType<typeof world>) {
  await w.director.onCommand('project', 'Салон Роза: Telegram-бот для записи клиентов');
  await w.head.onHeartbeat();
  await w.approveAll();
  return w.store.projects()[0]!;
}

describe('Production head', () => {
  it('seeds the department and the 10:30 routine once', () => {
    const w = world();
    expect(w.hq.agents('production').map((a) => a.id).sort()).toEqual(['deployer', 'production-head', 'project-manager', 'reviewer']);
    expect(w.hq.routines().map((r) => [r.name, r.cron])).toEqual([['production-overdue', '30 10 * * *']]);
    seedProduction(w.hq, { productionBudgetUsd: 5 }, () => 'другая');
    expect(w.hq.agent(PRODUCTION_HEAD_ID)!.instructions).toBe('Инструкция головы производства');
    expect(w.hq.routines()).toHaveLength(1);
  });

  it('/project creates the project, four milestones with dates, and a ТЗ for approval (level 0)', async () => {
    const w = world();
    await w.director.onCommand('project', 'Салон Роза: Telegram-бот для записи клиентов');
    expect(w.messenger.last()!.text).toContain('Салон Роза');
    await w.head.onHeartbeat();
    const p = w.store.projects()[0]!;
    expect(p).toMatchObject({ client: 'Салон Роза', product: 'bot', status: 'draft' });
    const ms = w.store.milestones(p.id);
    expect(ms.map((m) => m.title)).toEqual(['Бриф', 'Прототип', 'Сдача', 'Оплата']);
    expect(ms[0]!.dueAt).toBeLessThan(ms[1]!.dueAt);
    expect(ms[3]!.dueAt - T0).toBeGreaterThan(13 * DAY);
    expect(p.spec).toContain('[цена]');
    expect(p.spec).toContain('Состав работ');
    const queued = w.hq.queuedApprovals();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: 'pm_spec', dept: 'production' });
    expect(w.queue.level('pm_spec')).toBe(0);
    expect(w.hq.tasks({ status: 'blocked' })).toHaveLength(0); // nothing for builders before approval
  });

  it('a malformed /project is refused and creates nothing', async () => {
    const w = world();
    await w.director.onCommand('project', 'без двоеточия');
    expect(w.messenger.last()!.text).toContain('Формат');
    expect(w.hq.tasks({ dept: 'production' })).toHaveLength(0);
  });

  it('the approved ТЗ activates the project and makes builder tasks for prototype and delivery', async () => {
    const w = world();
    const p = await projectWithApprovedSpec(w);
    expect(w.store.project(p.id)!.status).toBe('active');
    const builders = w.hq.tasks({ status: 'blocked' }).filter((t) => t.tags.includes('builder'));
    expect(builders.map((t) => t.title)).toEqual(['Салон Роза: Прототип', 'Салон Роза: Сдача']);
    expect(builders[0]!.meta).toMatchObject({ kind: 'work', projectId: p.id });
    expect(w.store.milestones(p.id).filter((m) => m.taskId)).toHaveLength(2);
    await w.bridge.poll();
    expect(w.gh.created.map((i) => i.title)).toEqual(['Салон Роза: Прототип', 'Салон Роза: Сдача']);
    expect(w.gh.created[0]!.body).toContain('Состав работ');
  });

  it('a builder result with a PR gets a review task; review done closes the milestone; delivery makes deploy and monitoring tasks', async () => {
    const w = world();
    const p = await projectWithApprovedSpec(w);
    await w.head.command('target', `${p.id} ours /opt/fir-sites/rosa https://rosa.example.com`);
    await w.bridge.poll();
    // prototype (issue 41) closed with a PR link
    w.gh.close(41, 'Готово: https://github.com/bokievf9/agents/pull/7');
    await w.bridge.poll();
    await w.head.onHeartbeat();
    const review = w.hq.tasks({ status: 'blocked' }).find((t) => t.title.startsWith('Ревью:'))!;
    expect(review).toBeDefined();
    expect(review.tags).toContain('builder');
    expect(review.meta).toMatchObject({ kind: 'review', labelHint: 'review', ref: 'https://github.com/bokievf9/agents/pull/7' });
    expect(review.body).toContain('Безопасность');
    expect(review.body).toContain('Миграции');
    expect(w.store.milestoneOf(p.id, 'prototype')!.status).toBe('open'); // waits for the review
    // the review issue (42 would be delivery): find its number from meta.issue
    await w.bridge.poll();
    const reviewIssue = (w.hq.task(review.id)!.meta.issue as { number: number }).number;
    w.gh.close(reviewIssue, 'Замечаний нет');
    await w.bridge.poll();
    await w.head.onHeartbeat();
    expect(w.store.milestoneOf(p.id, 'prototype')!.status).toBe('done');
    expect(w.hq.task(review.id)!.status).toBe('done');

    // delivery without a link: no review, milestone done, deploy and monitoring requested
    const deliveryIssue = (w.hq.tasks({ status: 'blocked' }).find((t) => t.title === 'Салон Роза: Сдача')!.meta.issue as { number: number }).number;
    w.gh.close(deliveryIssue, 'Готово, всё в main');
    await w.bridge.poll();
    await w.head.onHeartbeat();
    expect(w.store.milestoneOf(p.id, 'delivery')!.status).toBe('done');
    const deploy = w.hq.tasks({ status: 'blocked' }).find((t) => t.title === 'Деплой: Салон Роза')!;
    expect(deploy.tags).toContain('builder');
    expect(deploy.body).toContain('DNS');
    expect(deploy.body).toContain('/opt/fir-sites/rosa');
    const mon = w.hq.tasks({ dept: 'support' })[0]!;
    expect(mon.title).toBe('добавить https://rosa.example.com в мониторинг');
  });

  it('overdue milestones: only for active projects, in the summary line and the daily routine task', async () => {
    const w = world();
    await w.director.onCommand('project', 'Салон Роза: сайт-визитка');
    await w.head.onHeartbeat();
    w.clock.t = T0 + 20 * DAY;
    expect(w.store.overdue()).toHaveLength(0); // the ТЗ is not approved yet: no deadlines
    expect(w.head.overdueLine()).toBeNull();
    await w.approveAll();
    expect(w.store.overdue().map((m) => m.title)).toEqual(['Бриф', 'Прототип', 'Сдача', 'Оплата']);
    expect(w.head.overdueLine()).toContain('Салон Роза: Бриф');
    expect(w.director.morningSummary()).toContain('Просрочены этапы проектов');
    w.store.markDone(w.store.milestones(1)[0]!.id);
    expect(w.store.overdue()).toHaveLength(3);
    const t = w.hq.runRoutine('production-overdue')!;
    await w.head.onHeartbeat();
    expect(w.hq.task(t.id)).toMatchObject({ status: 'done' });
    expect(w.hq.task(t.id)!.result).toContain('Просрочены');
  });

  it('/pstatus drafts a client status at level 1 and hands it to the owner without prices', async () => {
    const w = world();
    const p = await projectWithApprovedSpec(w);
    w.store.markDone(w.store.milestones(p.id)[0]!.id);
    expect(await w.head.command('pstatus', 'Роза')).toContain('Роза');
    await w.head.onHeartbeat();
    const msg = w.messenger.sent.at(-1)!.text;
    expect(msg).toContain('отправьте сами');
    expect(msg).toContain('бриф');
    expect(msg).not.toMatch(/\$|₽|\[цена\]/);
  });

  it('/mdone closes the last milestone and the project', async () => {
    const w = world();
    const p = await projectWithApprovedSpec(w);
    for (const k of ['brief', 'prototype', 'delivery']) await w.head.command('mdone', `${p.id} ${k}`);
    const last = await w.head.command('mdone', `${p.id} payment`);
    expect(last).toContain('Проект закрыт');
    expect(last).toContain('/lesson');
    expect(w.store.project(p.id)!.status).toBe('done');
  });
  it('a free-form task from the Director becomes a builder task: blocked, tagged builder, issue created, result closes it', async () => {
    const w = world();
    const t = w.hq.createTask({ title: 'Исправление ошибки на проде', body: 'Мониторинг: OmniRoute HTTP 404', dept: 'production', creator: 'owner' });
    await w.head.onHeartbeat();
    const blocked = w.hq.task(t.id)!;
    expect(blocked.status).toBe('blocked');
    expect(blocked.tags).toContain('builder');
    expect(blocked.meta.kind).toBe('adhoc');
    expect(w.hq.events(t.id).filter((e) => e.kind === 'report').at(-1)!.body).toContain('передана строителям');
    await w.bridge.poll();
    expect(w.gh.created.map((i) => i.title)).toContain('Исправление ошибки на проде');
    const issue = (w.hq.task(t.id)!.meta.issue as { number: number }).number;
    w.gh.close(issue, 'Починил: /healthz вместо /health');
    await w.bridge.poll();
    await w.head.onHeartbeat();
    expect(w.hq.task(t.id)!.status).toBe('done');
    expect(w.hq.events(t.id).filter((e) => e.kind === 'report').at(-1)!.body).toContain('Строитель закончил');
  });
});
