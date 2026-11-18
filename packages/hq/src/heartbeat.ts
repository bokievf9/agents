import { errMsg, log } from '@fir/core';
import type { Hq } from './hq.js';
import type { Agent, Heartbeat } from './types.js';

export type HeartbeatHandler = (agent: Agent, hb: Heartbeat) => Promise<void>;

/**
 * The core's 30-second worker: hands due wake-ups to the handler, one per agent. An agent whose previous
 * wake-up is still running is skipped (its pending wake-up stays queued), so nobody runs twice at once.
 */
export class HeartbeatWorker {
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Set<string>();
  private ticking = false;

  constructor(
    private readonly hq: Hq,
    private readonly handler: HeartbeatHandler,
    private readonly intervalMs = 30_000,
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

  /** One pass. Resolves when every handler started in it has finished. Returns the number of wake-ups handled. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const due = this.hq.claimDueHeartbeats(this.running);
      await Promise.all(
        due.map(async (hb) => {
          const agent = this.hq.agent(hb.agentId);
          if (!agent) return;
          this.running.add(agent.id);
          try {
            await this.handler(agent, hb);
          } catch (e) {
            log('error', 'heartbeat handler failed', { agent: agent.id, err: errMsg(e) });
            this.hq.log(agent.id, 'heartbeat_failed');
          } finally {
            this.running.delete(agent.id);
          }
        }),
      );
      return due.length;
    } finally {
      this.ticking = false;
    }
  }
}
