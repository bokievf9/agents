import { ApprovalQueue, MemoryMessenger, MockLlm, openDb } from '@fir/core';
import { Hq } from '@fir/hq';
import { KbStore } from '@fir/worker-knowledge';
import { PmStore } from '@fir/worker-project-manager';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Director } from '../src/director.js';
import { BackofficeHead, seedBackoffice } from '../src/heads/backoffice.js';
import { Reporter } from '../src/reporter.js';

const OWNER = 100;
const T0 = Date.UTC(2026, 10, 18, 7, 0);

interface DocRow { type: string; client: string; version: number; text: string; status: string; project_id: number | null }

function world(knowledgeDir?: string) {
  const clock = { t: T0 };
  const db = openDb(':memory:');
  const messenger = new MemoryMessenger();
  const hq = new Hq(db, { now: () => clock.t });
  const queue = new ApprovalQueue(db, messenger, OWNER, 20, () => clock.t);
  hq.attachQueue(queue);
  hq.upsertAgent({ id: 'director', dept: 'hq', role: 'director', title: 'Директор' });
  seedBackoffice(hq, { backofficeBudgetUsd: 0 }, () => 'Инструкция головы бэк-офиса');
  const llm = new MockLlm(() => '');
  const reporter = new Reporter(undefined, {}, new Map());
  const director = new Director({ hq, llm, messenger, queue, ownerId: OWNER, reporter });
  const head = new BackofficeHead({ hq, llm, queue, messenger, ownerId: OWNER, reporter, knowledgeDir });
  for (const n of ['doc', 'lesson', 'kb']) director.commands.set(n, { dept: 'backoffice', run: (a) => head.command(n, a) });
  director.summaryLines.push(() => head.pendingLine());
  const docs = () => db.prepare('SELECT * FROM bo_documents ORDER BY id').all() as DocRow[];
  return { clock, db, hq, messenger, queue, director, head, docs };
}

describe('Back Office head', () => {
  it('seeds the department, the Sunday 19:00 routine and the nightly backup and cleanup routines', () => {
    const w = world();
    expect(w.hq.agents('backoffice').map((a) => a.id).sort()).toEqual(['backoffice-head', 'documents', 'knowledge']);
    expect(w.hq.routines().map((r) => [r.name, r.cron])).toEqual([['backoffice-lessons-weekly', '0 19 * * 0'], ['backoffice-backup-daily', '30 3 * * *'], ['backoffice-renders-cleanup', '45 3 * * *']]);
  });

  it('/doc fills the contract template from the project, versions it, locks the level and refuses placeholders', async () => {
    const w = world();
    const pm = new PmStore(w.db, () => w.clock.t);
    const p = pm.createProject({ client: 'Салон Роза', what: 'Telegram-бот для записи', product: 'bot', source: 'owner', taskId: null });
    pm.addMilestone({ projectId: p.id, kind: 'prototype', title: 'Прототип', dueAt: T0 + 6 * 86_400_000 });
    await w.director.onCommand('doc', 'договор роза');
    await w.head.onHeartbeat();
    expect(w.docs()).toHaveLength(1);
    const d = w.docs()[0]!;
    expect(d).toMatchObject({ type: 'contract', client: 'Салон Роза', version: 1, status: 'pending', project_id: p.id });
    expect(d.text).toContain('Договор оказания услуг № 2026-1');
    expect(d.text).toContain('Telegram-бот для записи');
    expect(d.text).toContain('- Прототип: до 24.11');
    expect(d.text).toContain('18.11.2026');
    expect(d.text).toContain('[цена]'); // never made up
    expect(d.text).not.toContain('{{');
    expect(w.queue.level('bo_document')).toBe(0);
    expect(w.head.pendingLine()).toContain('Договор оказания услуг «Салон Роза» v1');
    expect(w.director.morningSummary()).toContain('Документы ждут решения');
    // approving with open placeholders fails: nothing goes to the owner as a final text
    await w.hq.releaseApprovals();
    await w.queue.handle('approve', w.queue.pending()[0]!.id, OWNER);
    w.director.afterDecision();
    expect(w.docs()[0]!.status).toBe('rejected');
    expect(w.messenger.sent.some((m) => m.text.includes('Отправьте клиенту сами'))).toBe(false);
    // a second request makes version 2
    await w.director.onCommand('doc', 'договор Салон Роза');
    await w.head.onHeartbeat();
    expect(w.docs().map((x) => x.version)).toEqual([1, 2]);
  });

  it('a fully filled document approved by the owner goes to him to send', async () => {
    const w = world();
    await w.director.onCommand('doc', 'политика');
    await w.head.onHeartbeat();
    await w.hq.releaseApprovals();
    const card = w.queue.pending()[0]!;
    await w.queue.handle('edit', card.id, OWNER);
    await w.queue.submitEdit(OWNER, 'Политика конфиденциальности, готовый текст.');
    await w.queue.handle('approve', w.queue.pending()[0]!.id, OWNER);
    expect(w.messenger.last()!.text).toContain('Отправьте клиенту сами');
    expect(w.messenger.last()!.text).toContain('готовый текст');
    expect(w.docs()[0]!.status).toBe('approved');
  });

  it('every template type fills without leftover {{ }}; offer and policy need no client, the act does', async () => {
    const w = world();
    for (const t of ['оферта', 'политика']) await w.director.onCommand('doc', t);
    await w.director.onCommand('doc', 'акт');
    expect(w.messenger.last()!.text).toContain('нужен клиент');
    await w.director.onCommand('doc', 'акт Иванов');
    await w.head.onHeartbeat();
    expect(w.docs().map((r) => r.type)).toEqual(['offer', 'privacy', 'act']);
    for (const r of w.docs()) expect(r.text).not.toContain('{{');
    expect(w.docs()[2]!.text).toContain('Акт сдачи-приёмки');
  });

  it('/lesson stores a lesson; /kb finds it and a playbook title', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-'));
    mkdirSync(join(dir, 'playbooks'));
    writeFileSync(join(dir, 'playbooks', 'deploy.md'), '# Деплой на сервер клиента\n\nшаги');
    const w = world(dir);
    await w.director.onCommand('lesson', 'Салон Роза: предоплату просить до начала прототипа');
    expect(w.messenger.last()!.text).toContain('Урок #1');
    await w.director.onCommand('lesson', 'нет двоеточия');
    expect(w.messenger.last()!.text).toContain('Формат');
    await w.director.onCommand('kb', 'предоплата прототип');
    expect(w.messenger.last()!.text).toContain('[Салон Роза] предоплату просить');
    await w.director.onCommand('kb', 'деплой клиента');
    expect(w.messenger.last()!.text).toContain('Деплой на сервер клиента');
    await w.director.onCommand('kb', 'космос');
    expect(w.messenger.last()!.text).toContain('пусто');
  });

  it('the Sunday routine turns new lessons into one builder task and marks them exported; no lessons, no task', async () => {
    const w = world();
    const empty = w.hq.runRoutine('backoffice-lessons-weekly')!;
    await w.head.onHeartbeat();
    expect(w.hq.task(empty.id)).toMatchObject({ status: 'done' });
    expect(w.hq.tasks({ status: 'blocked' })).toHaveLength(0);

    await w.head.command('lesson', 'Салон Роза: бриф закрывать письменно');
    await w.head.command('lesson', 'Кафе Ош: доступы к домену просить в первый день');
    w.clock.t += 8 * 86_400_000;
    const t = w.hq.runRoutine('backoffice-lessons-weekly')!;
    await w.head.onHeartbeat();
    const bt = w.hq.tasks({ status: 'blocked' })[0]!;
    expect(bt.title).toBe('Обновить knowledge/lessons');
    expect(bt.tags).toContain('builder');
    expect(bt.body).toContain('knowledge/lessons/2026-11.md');
    expect(bt.body).toContain('## Салон Роза');
    expect(bt.body).toContain('бриф закрывать письменно');
    expect(new KbStore(w.db, () => w.clock.t).unexported()).toHaveLength(0);
    expect(w.hq.task(t.id)).toMatchObject({ status: 'done' });
    w.clock.t += 8 * 86_400_000;
    w.hq.runRoutine('backoffice-lessons-weekly');
    await w.head.onHeartbeat();
    expect(w.hq.tasks({ status: 'blocked' })).toHaveLength(1);
  });
});
