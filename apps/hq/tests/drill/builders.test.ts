import { afterEach, describe, expect, it } from 'vitest';
import { BuilderBridge, RestGithubClient, type GithubClient, type IssueState } from '../../src/bridge.js';
import { drillWorld, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

const g = useGuard();
let w: DrillWorld;
afterEach(async () => { await w?.close(); });

function gh(over: Partial<GithubClient> = {}) {
  const created: string[] = [];
  const state: { s: IssueState } = { s: { number: 5, url: 'https://github.com/o/r/issues/5', state: 'open', labels: [], lastComment: null } };
  const client: GithubClient = {
    createIssue: (i) => { created.push(i.title); return Promise.resolve({ number: 5, url: state.s.url }); },
    getIssue: () => Promise.resolve(state.s),
    ...over,
  };
  return { client, created, state };
}

describe('/builders, /builder and the GitHub bridge', () => {
  it('a task handed to the builders becomes one issue, a question is raised once, a closed issue sends the task to review, a reopened one blocks it again', async () => {
    w = await drillWorld({ withServer: false });
    const t = w.hq.createTask({ title: 'Нужен инструмент', dept: 'marketing', creator: 'owner' });
    await w.cmd('builder', String(t.id));
    expect(w.ownerSaw()).toContain('передана строителям');
    await w.cmd('builder', String(t.id)); // again: already with the builders
    const f = gh();
    const bridge = new BuilderBridge({ hq: w.hq, github: f.client, pollMinutes: 10 });
    await bridge.poll();
    await bridge.poll();
    expect(f.created).toHaveLength(1);
    await w.cmd('builders');
    expect(w.ownerSaw()).toContain('Нужен инструмент');
    f.state.s = { ...f.state.s, labels: ['builder-blocked-question'], lastComment: 'Какой хост?' };
    await bridge.poll();
    await bridge.poll();
    expect(w.alerts.filter((a) => a.includes('вопрос'))).toHaveLength(1);
    f.state.s = { ...f.state.s, state: 'closed', labels: [], lastComment: 'Готово: /opt/fir-agents/data/hq/artifacts/x.txt' };
    await bridge.poll();
    expect(w.hq.task(t.id)!.status).toBe('review');
    f.state.s = { ...f.state.s, state: 'open' };
    await bridge.poll();
    expect(w.hq.task(t.id)!.status).toBe('blocked');
    expect(g.errors()).toEqual([]);
    expect(g.rejections).toEqual([]);
  });
  it('GitHub is down or the token is wrong: errors are logged per task, nothing throws, the task stays blocked for the next poll', async () => {
    w = await drillWorld({ withServer: false });
    const t = w.hq.createTask({ title: 'Нужен бот', dept: 'sales', creator: 'owner' });
    await w.cmd('builder', String(t.id));
    const down = gh({ createIssue: () => Promise.reject(new Error('GitHub POST /issues: HTTP 401')), getIssue: () => Promise.reject(new Error('HTTP 502')) });
    const bridge = new BuilderBridge({ hq: w.hq, github: down.client });
    await expect(bridge.poll()).resolves.toBeUndefined();
    expect(w.hq.task(t.id)!.status).toBe('blocked');
    expect(g.expectErrors().map((l) => l.msg)).toContain('builder issue not created');
    const rest = new RestGithubClient('ghp_secret_token_value', 'o/r', (() => Promise.resolve(new Response('no', { status: 403 }))) as typeof fetch);
    await expect(rest.createIssue({ title: 't', body: 'b', labels: [] })).rejects.toThrow(/HTTP 403/);
    expect(g.lines.some((l) => JSON.stringify(l).includes('ghp_secret'))).toBe(false);
    await expect(new BuilderBridge({ hq: w.hq, github: null }).poll()).resolves.toBeUndefined();
    expect(g.rejections).toEqual([]);
  });
});

describe('/drill: the in-office drill itself', () => {
  it('runs every department, reports a table, can be cleared, and leaves no real work behind', async () => {
    w = await drillWorld();
    const out = await w.cmd('drill', '');
    void out;
    expect(w.ownerSaw()).toContain('Учения начались');
    for (let i = 0; i < 6; i++) await w.beat();
    const report = await w.drill.command('report');
    expect(report).toMatch(/маркетинг|marketing/i);
    expect((await w.adm('GET', '/admin/drill')).json.text).toContain('Учения');
    expect((await w.adm('POST', '/admin/drill', { arg: 'sales' })).status).toBe(200);
    expect((await w.adm('POST', '/admin/drill', { arg: 'bogus' })).json.text).toContain('Формат');
    expect(await w.drill.command('clear')).toMatch(/Удалил|удал|Нет/i);
    expect(w.hq.tasks({ tag: 'drill', limit: 100 })).toHaveLength(0);
    expect(g.errors().map((l) => `${l.msg}: ${String(l.err)}`)).toEqual([]);
    expect(g.rejections).toEqual([]);
  });
});
