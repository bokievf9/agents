import { describe, expect, it } from 'vitest';
import { BuilderBridge, RestGithubClient, extractResult, type GithubClient, type IssueState } from '../src/bridge.js';
import { world } from './helpers.js';

class MockGithub implements GithubClient {
  created: { title: string; body: string; labels: string[] }[] = [];
  issues = new Map<number, IssueState>();
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
}

function setup(github: GithubClient | null = new MockGithub()) {
  const w = world();
  const bridge = new BuilderBridge({ hq: w.hq, github });
  w.director.onBuilderTask = () => bridge.syncNew();
  return { ...w, bridge, gh: github as MockGithub };
}

const builderTask = (w: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) => {
  const t = w.hq.createTask({ title: 'Интеграция с Kaspi', body: 'Нужна оплата через Kaspi', dept: 'marketing', creator: 'owner', meta: extra });
  w.hq.block(t.id, 'director', 'Нужен строитель', ['builder']);
  return t;
};

describe('builder bridge', () => {
  it('creates an issue with the agreed body and stores meta.issue', async () => {
    const w = setup();
    w.hq.comment(builderTask(w, { script: 'Сцена 1' }).id, 'owner', 'срочно');
    await w.bridge.poll();
    expect(w.gh.created).toHaveLength(1);
    const i = w.gh.created[0]!;
    expect(i.title).toBe('Интеграция с Kaspi');
    expect(i.labels).toEqual(['builder']);
    const t = w.hq.tasks({ status: 'blocked' })[0]!;
    expect(i.body).toContain('Отдел: marketing');
    expect(i.body).toContain(`Задача Shell: #${t.id}`);
    expect(i.body).toContain('Нужна оплата через Kaspi');
    expect(i.body).toContain('## Сценарий (одобрен владельцем)\nСцена 1');
    expect(i.body).toContain('срочно');
    expect(i.body).toContain('## Критерии приёмки');
    expect(i.body.trimEnd().endsWith(`HQ-TASK: ${t.id}`)).toBe(true);
    expect(t.meta.issue).toEqual({ number: 41, url: 'https://github.com/bokievf9/agents/issues/41' });
    expect(w.hq.activity().some((a) => a.action === 'builder_issue_created')).toBe(true);
    await w.bridge.poll(); // no duplicate
    expect(w.gh.created).toHaveLength(1);
  });

  it('without a token nothing happens and the task stays blocked and in the summary', async () => {
    const w = setup(null);
    const t = builderTask(w);
    await w.bridge.poll();
    expect(w.bridge.enabled).toBe(false);
    expect(w.hq.task(t.id)).toMatchObject({ status: 'blocked' });
    expect(w.hq.task(t.id)!.meta.issue).toBeUndefined();
    expect(w.director.morningSummary()).toContain('нужен строитель');
  });

  it('a closed issue moves the task to review with the last comment, path stored in meta.result', async () => {
    const w = setup();
    const t = builderTask(w);
    await w.bridge.poll();
    w.gh.issues.set(41, { ...w.gh.issues.get(41)!, state: 'closed', lastComment: 'Готово: /opt/fir-agents/data/hq/artifacts/clip-7.mp4. HQ-TASK: 1' });
    await w.bridge.poll();
    const after = w.hq.task(t.id)!;
    expect(after.status).toBe('review');
    expect(after.meta.result).toBe('/opt/fir-agents/data/hq/artifacts/clip-7.mp4');
    expect(after.assigneeId).toBe('marketing-head');
    expect(w.hq.events(t.id).some((e) => e.kind === 'result' && e.body.startsWith('Результат строителя: Готово'))).toBe(true);
  });

  it('a URL in the last comment becomes meta.result; no link keeps the comment only', async () => {
    const w = setup();
    const a = builderTask(w);
    const b = builderTask(w);
    await w.bridge.poll();
    w.gh.issues.set(41, { ...w.gh.issues.get(41)!, state: 'closed', lastComment: 'Смотри https://example.com/r.mp4.' });
    w.gh.issues.set(42, { ...w.gh.issues.get(42)!, state: 'closed', lastComment: 'сделано на сервере' });
    await w.bridge.poll();
    expect(w.hq.task(a.id)!.meta.result).toBe('https://example.com/r.mp4');
    expect(w.hq.task(b.id)!.meta.result).toBeUndefined();
    expect(w.hq.task(b.id)!.status).toBe('review');
    expect(extractResult('ничего')).toBeNull();
  });

  it('a reopened issue sends the task back to blocked', async () => {
    const w = setup();
    const t = builderTask(w);
    await w.bridge.poll();
    w.gh.issues.set(41, { ...w.gh.issues.get(41)!, state: 'closed', lastComment: 'https://x.io/a' });
    await w.bridge.poll();
    expect(w.hq.task(t.id)!.status).toBe('review');
    w.gh.issues.set(41, { ...w.gh.issues.get(41)!, state: 'open' });
    await w.bridge.poll();
    expect(w.hq.task(t.id)!.status).toBe('blocked');
    await w.bridge.poll();
    expect(w.gh.created).toHaveLength(1);
  });

  it('the question label alerts the owner once', async () => {
    const w = setup();
    const t = builderTask(w);
    await w.bridge.poll();
    w.gh.issues.set(41, { ...w.gh.issues.get(41)!, labels: ['builder', 'builder-blocked-question'], lastComment: 'Какой формат голоса?' });
    await w.bridge.poll();
    await w.bridge.poll();
    const alerts = w.messenger.sent.filter((m) => m.text.includes('Строитель задал вопрос'));
    expect(alerts).toHaveLength(1);
    expect(w.hq.events(t.id).some((e) => e.body.includes('Какой формат голоса?'))).toBe(true);
  });

  it('Director: /builders lists tasks with issue links, summary counts open issues, intent task goes through the bridge', async () => {
    const w = setup();
    w.hq.createTask({ title: 'Другая', dept: 'marketing', creator: 'owner' });
    builderTask(w);
    await w.bridge.poll();
    await w.director.onCommand('builders');
    expect(w.messenger.last()!.text).toContain('https://github.com/bokievf9/agents/issues/41');
    expect(w.director.morningSummary()).toContain('Открытых builder-issue: 1');
    const t = w.hq.createTask({ title: 'Бот', dept: 'hq', creator: 'owner', tags: ['builder'] });
    w.hq.block(t.id, 'director', 'x', ['builder']);
    await w.director.onBuilderTask!();
    expect(w.gh.created).toHaveLength(2);
  });

  it('REST client: create posts to the repo with the token, getIssue reads the last comment', async () => {
    const calls: { url: string; method: string; auth: string | null }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method!, auth: (init.headers as Record<string, string>).authorization ?? null });
      if (init.method === 'POST') return new Response(JSON.stringify({ number: 5, html_url: 'https://github.com/o/r/issues/5' }));
      if (url.includes('/comments')) return new Response(JSON.stringify([{ body: 'итог' }]));
      return new Response(JSON.stringify({ number: 5, html_url: 'u', state: 'closed', comments: 3, labels: [{ name: 'builder' }] }));
    }) as unknown as typeof fetch;
    const c = new RestGithubClient('tok', 'o/r', fetchFn);
    expect(await c.createIssue({ title: 't', body: 'b', labels: ['builder'] })).toEqual({ number: 5, url: 'https://github.com/o/r/issues/5' });
    expect(await c.getIssue(5)).toMatchObject({ state: 'closed', labels: ['builder'], lastComment: 'итог' });
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/repos/o/r/issues', method: 'POST', auth: 'Bearer tok' });
    expect(calls[2]!.url).toContain('/issues/5/comments?per_page=1&page=3');
  });
});

describe('Marketing: clip build task', () => {
  it('an approved clip creates one blocked builder task with the script in meta; the pack gets the file after review', async () => {
    const w = setup();
    w.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner', meta: { action: 'topic', topic: 'приёмщик заявок', type: 'clip' } });
    await w.marketing.onHeartbeat();
    await w.director.sendApprovalBatch(false);
    await w.decide('approve', w.queue.pending()[0]!.id);
    const t = w.hq.tasks({ status: 'blocked' }).find((x) => x.meta.action === 'build_clip')!;
    expect(t.title).toBe('Собрать клип: Запись ночью');
    expect(t.tags).toEqual(['builder']);
    expect(t.meta.subtitles).toEqual(['Запись в 2:00', 'Свободные окна', 'Подтверждение', 'Пример сценария']);
    expect(t.meta.cta).toBe('Напишите нам, ссылка firtech.pro в профиле');
    expect(Object.keys(t.meta.captions as object)).toEqual(['instagram', 'tiktok', 'shorts']);
    expect(String(t.meta.target)).toContain('9:16');
    await w.bridge.poll();
    expect(w.gh.created[0]!.body).toContain('Подписи по платформам');
    expect(w.gh.created[0]!.body).toContain('Субтитры');
    // builder finishes
    w.gh.issues.set(41, { ...w.gh.issues.get(41)!, state: 'closed', lastComment: '/opt/fir-agents/data/hq/artifacts/clip-1.mp4' });
    await w.bridge.poll();
    expect(w.hq.task(t.id)).toMatchObject({ status: 'review' });
    // the daily pack references the file
    w.clock.t += 2 * 86_400_000;
    w.hq.createTask({ title: 'что публикуем сегодня', dept: 'marketing', creator: 'owner', meta: { action: 'daily' } });
    await w.marketing.onHeartbeat();
    expect(w.messenger.sent.some((m) => m.text.includes('Файл: /opt/fir-agents/data/hq/artifacts/clip-1.mp4'))).toBe(true);
  });
});
