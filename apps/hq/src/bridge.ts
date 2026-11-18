import { errMsg, log, schedule } from '@fir/core';
import type { Hq, Task } from '@fir/hq';
import type { Cron } from 'croner';

export const BUILDER_TAG = 'builder';
export const QUESTION_LABEL = 'builder-blocked-question';
export const ARTIFACTS_DIR = '/opt/fir-agents/data/hq/artifacts/';
const ACTOR = 'bridge';

export interface IssueRef {
  number: number;
  url: string;
}

export interface IssueState {
  number: number;
  url: string;
  state: 'open' | 'closed';
  labels: string[];
  /** Body of the last comment, null when there is none. */
  lastComment: string | null;
}

/** The only GitHub surface the bridge uses; tests pass a mock. */
export interface GithubClient {
  createIssue(i: { title: string; body: string; labels: string[] }): Promise<IssueRef>;
  getIssue(number: number): Promise<IssueState>;
}

interface RestIssue {
  number: number;
  html_url: string;
  state: string;
  comments: number;
  labels: (string | { name?: string })[];
}

/** REST client with fine-grained token (Issues read/write on one repo). Never logs the token. */
export class RestGithubClient implements GithubClient {
  constructor(
    private readonly token: string,
    private readonly repo: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`https://api.github.com/repos/${this.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'fir-agents-hq',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async createIssue(i: { title: string; body: string; labels: string[] }): Promise<IssueRef> {
    const r = await this.call<RestIssue>('POST', '/issues', i);
    return { number: r.number, url: r.html_url };
  }

  async getIssue(number: number): Promise<IssueState> {
    const r = await this.call<RestIssue>('GET', `/issues/${number}`);
    let lastComment: string | null = null;
    if (r.comments > 0) {
      const list = await this.call<{ body?: string }[]>('GET', `/issues/${number}/comments?per_page=1&page=${r.comments}`);
      lastComment = list.at(-1)?.body ?? null;
    }
    return {
      number: r.number, url: r.html_url, state: r.state === 'closed' ? 'closed' : 'open',
      labels: r.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean), lastComment,
    };
  }
}

export interface BridgeDeps {
  hq: Hq;
  /** Absent (no GITHUB_TOKEN): the bridge does nothing, tasks stay blocked. */
  github: GithubClient | null;
  pollMinutes?: number;
}

const issueOf = (t: Task): IssueRef | undefined => {
  const i = t.meta.issue as Partial<IssueRef> | undefined;
  return i && typeof i.number === 'number' && typeof i.url === 'string' ? { number: i.number, url: i.url } : undefined;
};

/** First artifact path or URL in a result comment. */
export function extractResult(comment: string): string | null {
  const path = new RegExp(`${ARTIFACTS_DIR.replace(/\//g, '\\/')}[^\\s)\\]>"'\`]+`).exec(comment);
  if (path) return path[0].replace(/[.,;:]+$/, '');
  const url = /https?:\/\/[^\s)\]>"'`]+/.exec(comment);
  return url ? url[0].replace(/[.,;:]+$/, '') : null;
}

/** The text of the issue for a task: department, id, context, acceptance checklist, the HQ-TASK marker. */
export function issueBody(hq: Hq, t: Task): string {
  const out: string[] = [`Отдел: ${t.dept}`, `Задача HQ: #${t.id}`, ''];
  out.push('## Контекст', t.body.trim() || '(без описания)');
  const m = t.meta;
  const str = (k: string) => (typeof m[k] === 'string' && (m[k] as string).trim() ? (m[k] as string).trim() : null);
  const section = (title: string, text: string | null) => text && out.push('', `## ${title}`, text);
  section('Сценарий (одобрен владельцем)', str('script'));
  section('Субтитры', Array.isArray(m.subtitles) ? (m.subtitles as unknown[]).map((s, i) => `${i + 1}. ${String(s)}`).join('\n') : null);
  section('CTA', str('cta'));
  if (m.captions && typeof m.captions === 'object') {
    section('Подписи по платформам', Object.entries(m.captions as Record<string, unknown>).map(([p, c]) => `### ${p}\n${String(c)}`).join('\n\n'));
  }
  section('Целевая спецификация', str('target'));
  const notes = hq.events(t.id).filter((e) => e.kind === 'comment' || e.kind === 'attachment').slice(-5);
  if (notes.length) section('Последние комментарии', notes.map((e) => `- ${e.actor ?? '?'}: ${e.body.slice(0, 800)}`).join('\n'));
  out.push(
    '', '## Критерии приёмки',
    '- [ ] Результат сделан по описанию выше',
    '- [ ] Проверки проекта (typecheck, lint, tests, build) зелёные, если менялся код',
    `- [ ] Результат положен в \`${ARTIFACTS_DIR}\` или выложен по URL`,
    '- [ ] Последний комментарий перед закрытием: путь или URL результата',
    '', `HQ-TASK: ${t.id}`,
  );
  return out.join('\n').slice(0, 60_000);
}

/**
 * HQ <-> GitHub issues for `builder` tasks. A blocked task tagged `builder` becomes an issue; a closed issue sends the
 * task to review with the builder's last comment; a reopened one blocks it again. Without a token it does nothing.
 */
export class BuilderBridge {
  private job: Cron | null = null;

  constructor(private readonly d: BridgeDeps) {}

  private get hq(): Hq {
    return this.d.hq;
  }

  get enabled(): boolean {
    return this.d.github !== null;
  }

  start(): void {
    this.stop();
    if (!this.enabled) return log('warn', 'GITHUB_TOKEN is not set, builder bridge is off (builder tasks stay blocked)');
    const n = Math.min(59, Math.max(1, Math.round(this.d.pollMinutes ?? 10)));
    this.job = schedule('builder-bridge', `*/${n} * * * *`, this.hq.tz, () => this.poll());
    void this.poll();
  }

  stop(): void {
    this.job?.stop();
    this.job = null;
  }

  /** One pass: new issues first, then the state of the open ones. Errors of one task never stop the others. */
  async poll(): Promise<void> {
    if (!this.d.github) return;
    await this.syncNew();
    await this.syncOpen();
  }

  /** Creates issues for blocked builder tasks that have none. */
  async syncNew(): Promise<number> {
    const gh = this.d.github;
    if (!gh) return 0;
    let n = 0;
    for (const t of this.hq.tasks({ status: 'blocked' })) {
      if (!t.tags.includes(BUILDER_TAG) || issueOf(t)) continue;
      try {
        const issue = await gh.createIssue({ title: t.title.slice(0, 250), body: issueBody(this.hq, t), labels: [BUILDER_TAG] });
        this.hq.setMeta(t.id, { issue });
        this.hq.addEvent(t.id, 'comment', ACTOR, `Issue для строителя: ${issue.url}`);
        this.hq.log(ACTOR, 'builder_issue_created', 'task', String(t.id), `#${issue.number}`);
        n++;
      } catch (e) {
        log('error', 'builder issue not created', { task: t.id, err: errMsg(e) });
      }
    }
    return n;
  }

  private async syncOpen(): Promise<void> {
    const gh = this.d.github;
    if (!gh) return;
    const watched = [...this.hq.tasks({ status: 'blocked' }), ...this.hq.tasks({ status: 'review' }).filter((t) => t.meta.builderClosed === true)];
    for (const t of watched) {
      const ref = issueOf(t);
      if (!ref) continue;
      try {
        await this.check(t, ref, await gh.getIssue(ref.number));
      } catch (e) {
        log('error', 'builder issue check failed', { task: t.id, err: errMsg(e) });
      }
    }
  }

  private async check(t: Task, ref: IssueRef, s: IssueState): Promise<void> {
    if (t.status === 'review') {
      if (s.state === 'open') {
        this.hq.setMeta(t.id, { builderClosed: false });
        this.hq.setStatus(t.id, 'blocked', ACTOR, `issue #${ref.number} открыт снова`);
        this.hq.addEvent(t.id, 'comment', ACTOR, `Issue #${ref.number} переоткрыт, задача снова ждёт строителя`);
      }
      return;
    }
    if (s.state === 'closed') {
      const comment = (s.lastComment ?? '').trim();
      const result = extractResult(comment);
      this.hq.setMeta(t.id, { builderClosed: true, ...(result ? { result } : {}) });
      this.hq.addEvent(t.id, 'result', ACTOR, `Результат строителя: ${comment || '(комментария нет)'}`.slice(0, 4000));
      this.hq.setStatus(t.id, 'running', ACTOR, `issue #${ref.number} закрыт`);
      this.hq.setStatus(t.id, 'review', ACTOR, 'результат строителя');
      const head = this.hq.headOf(t.dept);
      if (head) this.hq.assign(t.id, head.id, ACTOR);
      this.hq.log(ACTOR, 'builder_issue_closed', 'task', String(t.id), `#${ref.number}`);
      return;
    }
    const asking = s.labels.includes(QUESTION_LABEL);
    if (asking && t.meta.builderQuestion !== true) {
      this.hq.setMeta(t.id, { builderQuestion: true });
      const q = (s.lastComment ?? '').trim();
      this.hq.addEvent(t.id, 'comment', ACTOR, `Вопрос строителя: ${q || '(см. issue)'}`.slice(0, 4000));
      await this.hq.alert(`Строитель задал вопрос по задаче #${t.id} «${t.title.slice(0, 80)}»: ${ref.url}`);
    } else if (!asking && t.meta.builderQuestion === true) {
      this.hq.setMeta(t.id, { builderQuestion: false });
    }
  }
}

/** Open builder tasks for `/builders` and the morning summary (works without a bridge instance). */
export function openBuilderTasks(hq: Hq): Task[] {
  return hq.tasks({ open: true, limit: 200 }).filter((t) => t.tags.includes(BUILDER_TAG));
}
