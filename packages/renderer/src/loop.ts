import { storeFor, parseReel, shortReason, type RenderJob, type RenderQueue, type ReelScript } from '@fir/worker-content-maker';
import type { Db } from '@fir/core';

export interface LoopDeps {
  db: Db;
  queue: RenderQueue;
  now: () => number;
  /** Renders one reel and returns the output path. Throws on failure. */
  render: (job: RenderJob, script: ReelScript) => Promise<string>;
  /** Hard cap per job; the render itself also gets a cancel signal. */
  timeoutMs: number;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`render timed out after ${Math.round(ms / 1000)} s`)), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e instanceof Error ? e : new Error(String(e)))));
  });

/** One poll: claims at most one job and runs it to the end. Returns the job's final state, or null when the queue was empty. */
export async function tick(d: LoopDeps): Promise<RenderJob | null> {
  const job = d.queue.claim();
  if (!job) return null;
  d.log('info', 'render started', { job: job.id, item: job.itemId, attempt: job.attempts });
  const item = storeFor({ db: d.db, now: d.now }).item(job.itemId);
  const script = item ? parseReel(item.text) : null;
  if (!script) {
    // nothing to retry: the text is gone or unreadable, so the attempt cap is set to 1
    const failed = d.queue.fail(job.id, item ? 'в сценарии не нашёл сцен (текст правили вручную?)' : 'материал не найден', 1);
    d.log('warn', 'render skipped', { job: job.id, item: job.itemId });
    return failed;
  }
  const t0 = d.now();
  try {
    const path = await withTimeout(d.render(job, script), d.timeoutMs);
    d.queue.complete(job.id, path);
    d.log('info', 'render done', { job: job.id, item: job.itemId, seconds: Math.round((d.now() - t0) / 1000) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const after = d.queue.fail(job.id, msg);
    d.log('warn', 'render failed', { job: job.id, item: job.itemId, attempt: after.attempts, final: after.status === 'failed', reason: shortReason(msg) });
  }
  return d.queue.get(job.id) ?? null;
}

/** Polls forever (until `signal` aborts); one job at a time, a short breather after a job so a retry is not instant. */
export async function runLoop(d: LoopDeps, pollMs: number, signal: AbortSignal): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true }); });
  while (!signal.aborted) {
    try {
      const job = await tick(d);
      if (job) { await sleep(2000); continue; }
    } catch (e) {
      d.log('error', 'render loop error', { err: e instanceof Error ? e.message : String(e) });
    }
    await sleep(pollMs);
  }
}
