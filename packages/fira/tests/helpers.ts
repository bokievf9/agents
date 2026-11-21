import { FIRTECH_TOOLS, firtechGuardContext, loadCompanyPack, loadNichePack, loadRolePack, makeSpec, memoryStores, type AgentSpec, type RunDeps } from '../src/index.js';
import type { LlmClient } from '@fir/core';

export const NOW = Date.UTC(2026, 10, 22, 9, 0, 0);
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const leadManagerSpec = (over: Partial<Parameters<typeof makeSpec>[0]> = {}): AgentSpec =>
  makeSpec({ role: loadRolePack('lead-manager'), niche: loadNichePack('it-services'), company: loadCompanyPack('firtech'), ...over });

export function deps(llm: LlmClient, clock = { t: NOW }): RunDeps & ReturnType<typeof memoryStores> & { clock: { t: number } } {
  const stores = memoryStores();
  return { llm, ...stores, now: () => clock.t, tools: FIRTECH_TOOLS, guard: firtechGuardContext('ru'), clock };
}
