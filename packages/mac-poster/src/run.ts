import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { BlockedError, ManualError, StuckError } from './guards.js';
import { clip, type HqClient, type HqDay } from './hq.js';
import { formatPlan, selectItems, type PlanItem } from './select.js';
import type { SitePoster } from './site.js';
import { leftToday, markStuck, recordAttempt, recordPost, shouldSkip, type State } from './state.js';
import { weeksFor } from './week.js';

export interface RunDeps {
  client: Pick<HqClient, 'content' | 'file' | 'published' | 'failed'>;
  state: State;
  saveState: (s: State) => void;
  /** Opens the browser (only when there is something to post and it is not a dry run). */
  openSite: () => SitePoster;
  date: string;
  dryRun: boolean;
  limit: number;
  dailyCap: number;
  log: (line: string) => void;
  /** Temp folder for downloads (default: a new one under the OS temp dir, removed at the end). */
  workDir?: string;
}

export interface RunResult {
  plan: PlanItem[];
  posted: { id: PlanItem['id']; url: string }[];
  failed: { id: PlanItem['id']; reason: string }[];
  stopped?: string;
}

/** One run for Instagram: fetch the weeks, pick, download, post one by one, report each result to HQ. */
export async function runInstagram(d: RunDeps): Promise<RunResult> {
  const days: HqDay[] = [];
  for (const week of weeksFor(d.date)) days.push(...(await d.client.content(week)));
  const plan = selectItems(days, d.date, { skip: (id) => shouldSkip(d.state, id, d.date) });
  const left = leftToday(d.state, d.date, d.dailyCap);
  d.log(formatPlan(plan, { date: d.date, limit: d.limit, leftToday: left }));
  const out: RunResult = { plan, posted: [], failed: [] };
  const todo = plan.slice(0, Math.min(d.limit, left));
  if (d.dryRun || todo.length === 0) {
    if (!d.dryRun && left === 0 && plan.length) d.log(`Дневной лимит ${d.dailyCap} публикаций исчерпан.`);
    return out;
  }
  const work = d.workDir ?? mkdtempSync(join(tmpdir(), 'fir-mac-poster-'));
  const site = d.openSite();
  try {
    await site.start();
    for (const item of todo) {
      d.log(`→ #${item.id} ${item.kind} «${item.title}»`);
      let files: string[];
      try {
        files = await download(d.client, item, work);
      } catch (e) {
        // HQ or the tunnel failed: not the item's fault, try again next run
        out.stopped = `файлы #${item.id} не скачались: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
      recordAttempt(d.state, item.id, d.date);
      d.saveState(d.state);
      try {
        const { url } = await site.post(item, files);
        recordPost(d.state, d.date);
        d.saveState(d.state);
        out.posted.push({ id: item.id, url });
        await report(d, () => d.client.published(item.id, url));
      } catch (e) {
        if (e instanceof BlockedError) {
          // the item was not the problem: let the next run try it again
          delete d.state.attempts[String(item.id)];
          d.saveState(d.state);
          out.stopped = e.message;
          break;
        }
        const reason = clip(e instanceof Error ? e.message : String(e), 300);
        if (e instanceof StuckError) {
          markStuck(d.state, item.id, reason);
          d.saveState(d.state);
        }
        out.failed.push({ id: item.id, reason });
        d.log(`  ошибка #${item.id}: ${reason}`);
        await report(d, () => d.client.failed(item.id, e instanceof ManualError || e instanceof StuckError ? reason : `не получилось: ${reason}`));
      }
    }
  } catch (e) {
    out.stopped = e instanceof Error ? e.message : String(e);
  } finally {
    await site.close();
    if (!d.workDir) rmSync(work, { recursive: true, force: true });
  }
  if (out.stopped) d.log(`Остановился: ${out.stopped}`);
  d.log(`Итог: опубликовано ${out.posted.length}, ошибок ${out.failed.length}${out.stopped ? ', запуск прерван' : ''}.`);
  return out;
}

/** A report that HQ did not take is logged, never fatal (the post is out; the owner can press «Опубликовано»). */
async function report(d: RunDeps, f: () => Promise<unknown>): Promise<void> {
  try {
    await f();
  } catch (e) {
    d.log(`  HQ не принял отчёт: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Downloads the item's files through `GET /admin/files/<path>` into `<work>/<id>-<n>-<name>`. */
export async function download(client: Pick<HqClient, 'file'>, item: PlanItem, work: string): Promise<string[]> {
  const out: string[] = [];
  for (const [i, f] of item.files.entries()) {
    const local = join(work, `${String(item.id).replace(/\W/g, '')}-${i + 1}-${basename(f.path)}`);
    writeFileSync(local, await client.file(f.path));
    out.push(local);
  }
  return out;
}
