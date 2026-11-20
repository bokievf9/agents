import { execFile } from 'node:child_process';
import { clip } from '../hq.js';
import { buildArgv, fitBody, parseCliOutput } from './spec.js';

/** The slice of the HQ client the runner uses (`HqClient` in `../hq.ts`). */
export interface ReachHq {
  reachJobs(channels?: string[]): Promise<{ items: ReachJobView[]; counts: Record<string, number> }>;
  reachClaim(id: number, channels?: string[]): Promise<boolean>;
  reachResult(id: number, body: { ok: true; result: unknown } | { ok: false; error: string }): Promise<void>;
}

export interface ReachJobView {
  id: number;
  channel: string;
  action: string;
  args: unknown;
}

export interface CliRun {
  stdout: string;
  /** Exit code; null when the process was killed (timeout) or did not start. */
  code: number | null;
  timedOut: boolean;
  /** The process could not be started (no such binary). */
  spawnError?: string;
}

export type RunCli = (argv: string[], timeoutMs: number) => Promise<CliRun>;

export interface ReachRunDeps {
  client: ReachHq;
  runCli: RunCli;
  /** Channels set up on the Mac (from `agent-reach doctor`); undefined: the doctor failed, nothing is reported and every channel is tried. */
  enabled?: string[] | undefined;
  /** Jobs per run (default 20). */
  max?: number;
  /** Hard limit per job (default 120 s). */
  timeoutMs?: number;
  log: (line: string) => void;
}

export interface ReachRunResult {
  seen: number;
  done: number;
  failed: number;
  skipped: number;
  /** A reason the whole run stopped early (HQ unreachable), else undefined. */
  stopped?: string;
}

/** The real CLI: `execFile` (no shell), SIGKILL at the limit, 8 MB of output. */
export function execAgentReach(bin: string): RunCli {
  return (argv, timeoutMs) =>
    new Promise((resolve) => {
      execFile(bin, argv, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, env: process.env }, (err, stdout) => {
        if (!err) return resolve({ stdout: String(stdout), code: 0, timedOut: false });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (e.code === 'ENOENT' || e.code === 'EACCES') return resolve({ stdout: '', code: null, timedOut: false, spawnError: e.message });
        resolve({ stdout: String(stdout ?? ''), code: typeof e.code === 'number' ? e.code : null, timedOut: e.killed === true });
      });
    });
}

/**
 * One run: the queued jobs of HQ (at most `max`, one after another, so never two CLI calls at once), each claimed first (another run that got there first
 * wins: 409, skipped), run through `agent-reach` with a hard limit, and answered. The CLI's JSON is data: `ok`, `items`, `meta`, `error` are copied, nothing
 * in it is executed. A job the Mac cannot do (unknown action, a value that does not pass the table) is answered as failed with the reason, so the agent does
 * not wait for it. A channel that is not set up is not guessed from `doctor`: public routes work without `agent-reach add` (Reddit, web), so the CLI decides and its
 * NEED_SETUP / NEED_LOGIN answer is passed on as a failed job.
 */
export async function runReach(d: ReachRunDeps): Promise<ReachRunResult> {
  const out: ReachRunResult = { seen: 0, done: 0, failed: 0, skipped: 0 };
  const max = d.max ?? 20;
  const timeoutMs = d.timeoutMs ?? 120_000;
  let jobs: ReachJobView[];
  try {
    jobs = (await d.client.reachJobs(d.enabled)).items.slice(0, max);
  } catch (e) {
    out.stopped = `HQ: ${e instanceof Error ? e.message : String(e)}`;
    d.log(`Остановился: ${out.stopped}`);
    return out;
  }
  out.seen = jobs.length;
  d.log(`В очереди заданий: ${jobs.length}${d.enabled ? ` (каналы Мака: ${d.enabled.join(', ') || 'нет'})` : ''}.`);
  for (const job of jobs) {
    const label = `#${job.id} ${job.channel}.${job.action}`;
    let won: boolean;
    try {
      won = await d.client.reachClaim(job.id, d.enabled);
    } catch (e) {
      out.stopped = `HQ: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }
    if (!won) {
      out.skipped++;
      d.log(`  ${label}: уже взято другим запуском.`);
      continue;
    }
    const answer = async (body: Parameters<ReachHq['reachResult']>[1]) => {
      try {
        await d.client.reachResult(job.id, body);
      } catch (e) {
        d.log(`  ${label}: HQ не принял ответ: ${e instanceof Error ? e.message : String(e)}`);
        out.stopped = 'HQ не принял ответ';
      }
    };
    const fail = async (reason: string) => {
      out.failed++;
      d.log(`  ${label}: ошибка: ${reason}`);
      await answer({ ok: false, error: clip(reason, 300) });
    };
    const built = buildArgv(job.channel, job.action, job.args);
    if (!built.ok) {
      await fail(`задание не выполнено на Маке: ${built.reason}`);
      continue;
    }
    const argv = [...built.argv, '--timeout', String(Math.max(10, Math.floor(timeoutMs / 1000) - 15))];
    d.log(`→ ${label}`);
    const run = await d.runCli(argv, timeoutMs);
    if (run.spawnError) await fail(`agent-reach не запустился: ${run.spawnError}`);
    else if (run.timedOut) await fail(`таймаут ${Math.round(timeoutMs / 1000)} с`);
    else {
      const parsed = parseCliOutput(run.stdout);
      if (!parsed) await fail(`ответ agent-reach не JSON (код ${run.code ?? '?'})`);
      else {
        if (parsed.ok) out.done++;
        else out.failed++;
        d.log(`  ${label}: ${parsed.ok ? `готово, записей ${parsed.items.length}` : `agent-reach: ${parsed.error?.code ?? 'ok=false'}`}`);
        await answer({ ok: true, result: fitBody(parsed) });
      }
    }
    if (out.stopped) break;
  }
  d.log(`Итог: готово ${out.done}, ошибок ${out.failed}, пропущено ${out.skipped}${out.stopped ? `, запуск прерван: ${out.stopped}` : ''}.`);
  return out;
}

export interface DoctorChannel {
  channel: string;
  level: string;
  status: string;
}

/** `agent-reach doctor`: which channels are set up (a channel that is `not_added` or removed is not). `null`: the output could not be read. */
export function parseDoctor(stdout: string): DoctorChannel[] | null {
  try {
    const j = JSON.parse(stdout) as { result?: { channels?: unknown } };
    const list = j.result?.channels;
    if (!Array.isArray(list)) return null;
    return list
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).channel === 'string')
      .map((c) => ({ channel: String(c.channel), level: String(c.level ?? ''), status: String(c.status ?? '') }));
  } catch {
    return null;
  }
}

export const isEnabled = (c: DoctorChannel): boolean => !/^(not_added|removed|needs?_login|login)/.test(c.status);

/** The channels of the Mac as HQ knows them (`settings.reach.channels`): the ones Agent Reach has set up and that HQ may ask. */
export function enabledChannels(list: DoctorChannel[], known: readonly string[]): string[] {
  return list.filter(isEnabled).map((c) => c.channel).filter((c) => known.includes(c)).sort();
}
