import type { LlmClient, LlmRequest, LlmResult } from '@fir/core';
import type { Hq } from './hq.js';

/** Fallback for providers that report no usage: about 4 characters per token. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * Wraps an LlmClient so every call is written to `costs` for the agent and task. The provider's real usage (tokens and
 * the model that answered) is used when the client reports it; otherwise tokens are estimated and the model is the tier.
 * A department over its monthly limit gets an error instead of a call for non-urgent work (callers fall back or the task is blocked).
 */
export function meterLlm(llm: LlmClient, hq: Hq, ctx: { agentId: string; taskId?: number | null; urgent?: boolean }): LlmClient {
  const run = async (req: LlmRequest): Promise<LlmResult> => {
    const agent = hq.agent(ctx.agentId);
    // a department over its money limit gets no new calls, except for urgent work (a client is waiting, priority 2)
    if (agent && hq.overBudget(agent.dept) && !hq.isUrgent(ctx.taskId, ctx.urgent)) throw new Error(`Лимит расходов отдела ${agent.dept} исчерпан`);
    const end = hq.beginLlm(ctx.agentId);
    let res: LlmResult;
    try {
      res = llm.completeDetailed ? await llm.completeDetailed(req) : { text: await llm.complete(req) };
    } finally {
      end();
    }
    const u = res.usage;
    hq.recordCost({
      taskId: ctx.taskId ?? null,
      agentId: ctx.agentId,
      model: u?.model || req.tier,
      inputTokens: u ? u.inputTokens : estimateTokens(req.system + req.messages.map((m) => m.content).join('')),
      outputTokens: u ? u.outputTokens : estimateTokens(res.text),
      ...(ctx.urgent ? { urgent: true } : {}),
    });
    return res;
  };
  return {
    get enabled() {
      return llm.enabled;
    },
    async complete(req) {
      return (await run(req)).text;
    },
    completeDetailed: run,
  };
}
