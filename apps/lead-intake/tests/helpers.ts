import { ApprovalQueue, MemoryMessenger, openDb, OffLlm, type LlmClient } from '@fir/core';
import { LeadAgent } from '../src/agent.js';
import type { Config } from '../src/config.js';
import { LeadStore } from '../src/store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OWNER = 100;
export const CLIENT = 555;
export const NOW = Date.UTC(2026, 10, 18, 7, 0); // Wed 12:00 in Tashkent

export function setup(opts: { llm?: LlmClient; replyLevel?: 0 | 1; rateLimit?: number } = {}) {
  const clock = { t: NOW };
  const now = () => clock.t;
  const messenger = new MemoryMessenger();
  const db = openDb(':memory:');
  const queue = new ApprovalQueue(db, messenger, OWNER, 20, now);
  const store = new LeadStore(db, now);
  const leadsFile = join(mkdtempSync(join(tmpdir(), 'leads-')), 'leads.jsonl');
  const cfg: Pick<Config, 'ownerId' | 'tz' | 'slotHours' | 'rateLimit' | 'rateWindowMs' | 'leadsFile' | 'replyLevel'> = {
    ownerId: OWNER, tz: 'Asia/Tashkent', slotHours: ['11:00', '15:00'], rateLimit: opts.rateLimit ?? 20,
    rateWindowMs: 600_000, leadsFile, replyLevel: opts.replyLevel ?? 1,
  };
  const agent = new LeadAgent({ store, queue, messenger, llm: opts.llm ?? new OffLlm(), cfg, now });
  const say = (text: string, chatId = CLIENT, isBot = false) =>
    agent.onClientMessage({ chatId, name: 'Aziz', username: 'aziz', isBot, text });
  return { messenger, queue, store, agent, say, leadsFile, clock };
}
