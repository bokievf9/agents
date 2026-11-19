import { log, type Db } from '@fir/core';
import type { SubtaskSpec, Task, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { buildChecks, DAY_MS, realDeps, type BotProbe, type CheckDeps, type CheckResult, type MonitorConfig } from './checks.js';
import { MonitorStore, step } from './state.js';

export const WORKER_ID = 'monitoring';

export interface MonEvent {
  kind: 'down' | 'recovered';
  checkId: string;
  /** Alert text for the owner (the head sends it through the Director's alert path). */
  text: string;
}

export interface TickResult {
  results: CheckResult[];
  events: MonEvent[];
}

export function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'меньше минуты';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} ч ${min % 60} мин` : `${h} ч`;
}

const nameOf = (r: CheckResult): string => r.label;

/**
 * Health checks for the company's own services. `tick` runs every check once, applies the hysteresis (alert after two
 * failures in a row, one "recovered" message, nothing in between) and returns the events for the head to send. Samples
 * and incidents live in `mon_*` tables for the daily uptime line. The worker never writes to anyone itself.
 */
export class MonitoringWorker implements Worker {
  readonly id = WORKER_ID;
  private readonly deps: CheckDeps;
  private bot: BotProbe | undefined;

  constructor(private readonly cfg: MonitorConfig, deps?: CheckDeps) {
    this.deps = deps ?? realDeps(cfg);
  }

  store(db: Db): MonitorStore {
    return new MonitorStore(db);
  }

  /** Starts watching the public client bot: its `bot` and `bot:silence` checks run with every tick. */
  watchBot(probe: BotProbe): void {
    this.bot = probe;
  }

  /** Adds a health URL to the list checked from the next tick on (false: already monitored). */
  addUrl(db: Db, url: string): boolean {
    if (this.cfg.urls.includes(url)) return false;
    return this.store(db).addUrl(url);
  }

  async tick(db: Db): Promise<TickResult> {
    const store = this.store(db);
    const urls = [...new Set([...this.cfg.urls, ...store.urls()])];
    const checks = buildChecks({ ...this.cfg, urls }, this.deps, this.bot);
    const results = (
      await Promise.all(
        checks.map((c) =>
          (c.runMany ? c.runMany() : c.run().then((r) => [r])).catch((e: unknown): CheckResult[] => [
            { id: c.id, label: c.id, ok: false, detail: e instanceof Error ? e.message.slice(0, 120) : 'сбой проверки' },
          ]),
        ),
      )
    ).flat();
    const now = this.deps.now();
    const events: MonEvent[] = [];
    for (const r of results) {
      if (r.skipped) {
        // could not run: logged as skipped, never counted as a pass (no state change, no sample)
        log('info', 'monitor check skipped', { check: r.id, why: r.detail });
        continue;
      }
      const s = step(store.state(r.id), r.ok, now);
      store.saveState(r.id, s.next);
      if (r.soft) continue; // colours the public status only: no uptime sample, incident or alert
      store.sample(now, r.id, r.ok);
      if (s.event === 'down') {
        store.openIncident(r.id, s.next.failSince, `${nameOf(r)}: ${r.detail}`);
        events.push({ kind: 'down', checkId: r.id, text: `Мониторинг: ${nameOf(r)} не в порядке (две проверки подряд). ${r.detail}.` });
      } else if (s.event === 'recovered') {
        store.closeIncident(r.id, now);
        events.push({ kind: 'recovered', checkId: r.id, text: `Мониторинг: ${nameOf(r)} снова в норме, простой ${fmtDuration(s.downMs ?? 0)}.` });
      }
    }
    store.prune(now);
    return { results, events };
  }

  /** The line for the morning summary: 24 h uptime and the incidents. */
  dailyLine(db: Db): string {
    const now = this.deps.now();
    return dailyLine(this.store(db), now);
  }

  async plan(): Promise<SubtaskSpec[] | null> {
    return null;
  }

  /** Task entry: `meta.action` is `check` (default, one tick) or `status` (the daily line). */
  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    if (task.meta.action === 'status') return { ok: true, result: this.dailyLine(ctx.db) };
    const { results, events } = await this.tick(ctx.db);
    const skipped = results.filter((r) => r.skipped);
    const bad = results.filter((r) => !r.ok && !r.skipped);
    const passed = results.length - bad.length - skipped.length;
    const tail = skipped.length ? `, пропущено: ${skipped.map((r) => r.label).join(', ')}` : '';
    const head = bad.length ? `Не в порядке: ${bad.map((r) => `${r.label} (${r.detail})`).join('; ')}${tail}` : `Все проверки в норме (${passed})${tail}.`;
    return { ok: true, result: events.length ? `${head}\n${events.map((e) => e.text).join('\n')}` : head };
  }
}

export function dailyLine(store: MonitorStore, now: number): string {
  const since = now - DAY_MS;
  const up = store.uptime(since);
  if (up.pct === null) return 'Мониторинг: за сутки нет данных.';
  const inc = store.incidents(since);
  const incText = inc.length
    ? `инцидентов ${inc.length}: ${inc
        .map((i) => `${i.detail.split(':')[0] ?? i.checkId} ${i.endedAt === null ? 'не закончен' : fmtDuration(i.endedAt - i.startedAt)}`)
        .join(', ')}`
    : 'инцидентов нет';
  return `Мониторинг: аптайм за 24 ч ${up.pct}%, ${incText}.`;
}
