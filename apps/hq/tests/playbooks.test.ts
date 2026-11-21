import { ApprovalQueue, MemoryMessenger, MockLlm, TG_MAX, clearPlaybookCache, loadPlaybook, openDb, splitForTelegram, type LlmRequest } from '@fir/core';
import { Hq } from '@fir/hq';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_NAMES } from '../src/commands.js';
import { Director } from '../src/director.js';
import { BackofficeHead, findPlaybookRole, playbookText, seedBackoffice } from '../src/heads/backoffice.js';
import { Reporter } from '../src/reporter.js';
import { clipJson, routedLlm, world } from './helpers.js';

const OWNER = 100;

function boWorld(knowledgeDir?: string) {
  const clock = { t: Date.UTC(2026, 10, 20, 7, 0) };
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
  const head = new BackofficeHead({ hq, llm, queue, messenger, ownerId: OWNER, reporter, ...(knowledgeDir ? { knowledgeDir } : {}) });
  director.commands.set('playbook', { dept: 'backoffice', run: (a) => head.command('playbook', a) });
  return { messenger, director };
}

describe('/playbook', () => {
  it('is a registered command', () => {
    expect(COMMAND_NAMES).toContain('playbook');
  });

  it('finds a role by id, by Russian name and by a start of either', () => {
    expect(findPlaybookRole('content-maker')).toBe('content-maker');
    expect(findPlaybookRole('Контент-мейкер')).toBe('content-maker');
    expect(findPlaybookRole('продажи')).toBe('sales');
    expect(findPlaybookRole('анал')).toBe('analyst');
    expect(findPlaybookRole('строитель')).toBe('renderer-builder');
    expect(findPlaybookRole('космос')).toBeNull();
  });

  it('sends the Правила section of the shipped playbook, not the other sections, through the Director', async () => {
    const w = boWorld();
    await w.director.onCommand('playbook', 'контент-мейкер');
    const text = w.messenger.last()!.text;
    expect(text).toContain('Плейбук «Content Maker»: правила');
    expect(text).toContain('Хук в первые 2 секунды');
    expect(text).not.toContain('Чеклист перед сдачей');
    expect(text).not.toContain('Метрики успеха');
    expect(text).toContain('knowledge/playbooks/content-maker.md');
    expect(splitForTelegram(text).every((p) => p.length <= TG_MAX)).toBe(true);
  });

  it('without a role it lists the roles; an unknown role says so', async () => {
    const w = boWorld();
    await w.director.onCommand('playbook', '');
    expect(w.messenger.last()!.text).toContain('Роли: content-maker (Content Maker)');
    await w.director.onCommand('playbook', 'космос');
    expect(w.messenger.last()!.text).toContain('Не нашёл роль «космос»');
  });

  it('a long playbook goes out split by the Telegram limit with nothing lost', () => {
    clearPlaybookCache();
    const dir = mkdtempSync(join(tmpdir(), 'pbk-'));
    mkdirSync(join(dir, 'playbooks'));
    const rules = Array.from({ length: 120 }, (_, i) => `- правило ${i}: ${'слово '.repeat(20).trim()}`).join('\n');
    writeFileSync(join(dir, 'playbooks', 'seo.md'), `# Плейбук: SEO\n\n## Правила\n${rules}\n\n## Чеклист перед сдачей\n1. Ок.\n`);
    const text = playbookText('seo', dir);
    expect(text.length).toBeGreaterThan(TG_MAX * 2);
    const parts = splitForTelegram(text);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => p.length <= TG_MAX)).toBe(true);
    for (let i = 0; i < 120; i++) expect(parts.join('\n')).toContain(`- правило ${i}:`);
    expect(loadPlaybook('seo', dir)).toContain('Чеклист');
  });

  it('a missing playbook file is reported, not thrown', () => {
    clearPlaybookCache();
    const dir = mkdtempSync(join(tmpdir(), 'pbk-'));
    mkdirSync(join(dir, 'playbooks'));
    expect(playbookText('seo', dir)).toContain('не найден в базе знаний');
  });
});

describe('Marketing head: reel script lint before approval', () => {
  const topicIntent = { split: () => JSON.stringify({ action: 'topic', topic: 'бот-администратор для барбершопа', type: 'clip' }) };

  /** The first generated script has two calls to action; the model is not asked to review it: the code check rejects it. */
  it('a script with two calls to action goes back once with the lint remarks and then passes', async () => {
    const base = routedLlm({ ...topicIntent });
    let gens = 0;
    let reviews = 0;
    const feedback: string[] = [];
    const llm = {
      enabled: true,
      complete: (req: LlmRequest) => {
        if (req.system.includes('Проверь материал по чек-листу')) reviews++;
        if (req.messages[0]!.content.includes('Прошлый вариант отклонён')) feedback.push(req.messages[0]!.content);
        if (req.messages[0]!.content.startsWith('Составь сценарий')) {
          gens++;
          if (!req.messages[0]!.content.includes('Прошлый вариант отклонён')) return Promise.resolve(JSON.stringify({ ...JSON.parse(clipJson()), cta: 'Напишите в @firtech_bot или зайдите на firtech.pro' }));
        }
        return base.complete(req);
      },
    };
    const w = world({ llm });
    const t = w.hq.createTask({ title: 'Сделай ролик про барбершоп', dept: 'marketing', creator: 'owner' });
    await w.marketing.onHeartbeat();
    expect(gens).toBeGreaterThan(2); // the first pass (with the worker's own repair) and the head's rework
    expect(feedback).toHaveLength(2);
    expect(feedback[0]).toContain('больше одного призыва');
    const comments = w.hq.events(t.id).filter((e) => e.kind === 'comment').map((e) => e.body);
    expect(comments[0]).toContain('больше одного призыва');
    expect(reviews).toBe(1); // the first review never reached the model; the second one did
    expect(w.hq.task(t.id)!.status).toBe('approval');
    expect(w.hq.queuedApprovals()[0]!.summary).not.toContain('Ревью отдела');
  });

  it('a clean script goes straight to the model review (no rework)', async () => {
    let reviews = 0;
    const base = routedLlm({ ...topicIntent });
    const llm = { enabled: true, complete: (req: LlmRequest) => { if (req.system.includes('Проверь материал по чек-листу')) reviews++; return base.complete(req); } };
    const w = world({ llm });
    const t = w.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner' });
    await w.marketing.onHeartbeat();
    expect(reviews).toBe(1);
    expect(w.hq.events(t.id).filter((e) => e.kind === 'comment')).toHaveLength(0);
  });
});
