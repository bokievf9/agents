import { errMsg, log } from '@fir/core';
import type { Hq } from './hq.js';
import type { Agent, Heartbeat } from './types.js';

export type HeartbeatHandler = (agent: Agent, hb: Heartbeat) => Promise<void>;

/** At most this many heads work at the same time (LLM calls still go through the gateway's own limits). */
export const MAX_CONCURRENT_HEADS = 3;

/**
 * The core's 30-second worker: hands due wake-ups to the handler, one per agent. Every agent runs on its own: a head that
 * is busy never delays another head's wake-up (its own pending wake-up stays queued until it is free), and at most
 * `maxConcurrent` agents work at once. A wake-up that finds no free slot stays pending for the next pass.
 */
export class HeartbeatWorker {
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly hq: Hq,
    private readonly handler: HeartbeatHandler,
    private readonly intervalMs = 30_000,
    private readonly maxConcurrent = MAX_CONCURRENT_HEADS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Agents whose handler is running right now. */
  get busy(): string[] {
    return [...this.running];
  }

  /**
   * One pass: starts the handlers of due wake-ups for free agents while slots remain. Resolves when the handlers started
   * in THIS pass have finished (the interval does not wait for it, so passes overlap). Returns how many were started.
   */
  async tick(): Promise<number> {
    const free = this.maxConcurrent - this.running.size;
    if (free <= 0) return 0;
    const due = this.hq.claimDueHeartbeats(this.running, free);
    const runs = due.flatMap((hb) => {
      const agent = this.hq.agent(hb.agentId);
      if (!agent) return [];
      this.running.add(agent.id);
      const run = (async () => {
        this.hq.log(agent.id, agent.role === 'head' ? 'head_wake' : 'agent_wake', 'agent', agent.id);
        try {
          await this.handler(agent, hb);
        } catch (e) {
          log('error', 'heartbeat handler failed', { agent: agent.id, err: errMsg(e) });
          this.hq.log(agent.id, 'heartbeat_failed');
        } finally {
          this.running.delete(agent.id);
        }
      })();
      const tracked = run.finally(() => this.inFlight.delete(tracked));
      this.inFlight.add(tracked);
      return [tracked];
    });
    await Promise.all(runs);
    return due.length;
  }

  /** Resolves when no handler is running (shutdown, tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }
}
