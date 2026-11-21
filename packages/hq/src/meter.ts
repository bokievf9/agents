import type { LlmChatRequest, LlmClient, LlmRequest, LlmResult, LlmTurn } from '@fir/core';
import type { Hq } from './hq.js';

/** Fallback for providers that report no usage: about 4 characters per token. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * Wraps an LlmClient so every call is written to `costs` for the agent and task. The provider's real usage (tokens and
 * the model that answered) is used when the client reports it; otherwise tokens are estimated and the model is the tier.
 * A department over its monthly limit gets an error instead of a call for non-urgent work (callers fall back or the task is blocked).
 */
export function meterLlm(llm: LlmClient, hq: Hq, ctx: { agentId: string; taskId?: number | null; urgent?: boolean }): LlmClient {
  const gate = () => {
    const agent = hq.agent(ctx.agentId);
    // a department over its money limit gets no new calls, except for urgent work (a client is waiting, priority 2)
    if (agent && hq.overBudget(agent.dept) && !hq.isUrgent(ctx.taskId, ctx.urgent)) throw new Error(`Лимит расходов отдела ${agent.dept} исчерпан`);
  };
  const run = async (req: LlmRequest): Promise<LlmResult> => {
    gate();
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
      ...(u?.cacheReadTokens ? { cacheReadTokens: u.cacheReadTokens } : {}),
      ...(ctx.urgent ? { urgent: true } : {}),
    });
    return res;
  };
  /** Native tool use (Fira agents, the owner's assistant): the same limit and the same `costs` row per model call. */
  const chat = async (req: LlmChatRequest): Promise<LlmTurn> => {
    gate();
    const end = hq.beginLlm(ctx.agentId);
    let turn: LlmTurn;
    try {
      turn = await llm.chat!(req);
    } finally {
      end();
    }
    const u = turn.usage;
    const sys = typeof req.system === 'string' ? req.system : req.system.map((b) => b.text).join('');
    const said = req.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('');
    hq.recordCost({
      taskId: ctx.taskId ?? null,
      agentId: ctx.agentId,
      model: u?.model || req.tier,
      inputTokens: u ? u.inputTokens : estimateTokens(sys + said),
      outputTokens: u ? u.outputTokens : estimateTokens(JSON.stringify(turn.content)),
      ...(u?.cacheReadTokens ? { cacheReadTokens: u.cacheReadTokens } : {}),
      ...(ctx.urgent ? { urgent: true } : {}),
    });
    return turn;
  };
  return {
    get enabled() {
      return llm.enabled;
    },
    async complete(req) {
      return (await run(req)).text;
    },
    completeDetailed: run,
    ...(llm.chat ? { chat } : {}),
  };
}
