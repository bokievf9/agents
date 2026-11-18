import type { LlmClient, LlmRequest } from '@fir/core';
import type { Hq } from './hq.js';

/** The core client returns text only, so tokens are estimated: about 4 characters per token. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * Wraps an LlmClient so every call is written to `costs` for the agent and task. A department over its
 * monthly limit gets an error instead of a call (callers fall back or the task is blocked).
 */
export function meterLlm(llm: LlmClient, hq: Hq, ctx: { agentId: string; taskId?: number | null }): LlmClient {
  return {
    get enabled() {
      return llm.enabled;
    },
    async complete(req: LlmRequest): Promise<string> {
      const agent = hq.agent(ctx.agentId);
      if (agent && hq.overBudget(agent.dept)) throw new Error(`Лимит расходов отдела ${agent.dept} исчерпан`);
      const out = await llm.complete(req);
      const input = estimateTokens(req.system + req.messages.map((m) => m.content).join(''));
      hq.recordCost({ taskId: ctx.taskId ?? null, agentId: ctx.agentId, model: req.tier, inputTokens: input, outputTokens: estimateTokens(out) });
      return out;
    },
  };
}
