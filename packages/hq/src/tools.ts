import { createTools, type Tools } from '@fir/core';
import type { WorkerCtx } from './types.js';

/**
 * The toolbox of a worker run: the one the head gave (`ctx.tools`), else a plain one for the department (no journal, no keys):
 * hand-built contexts in tests and scripts still get safe network and the same error format.
 */
export function toolsOf(ctx: Pick<WorkerCtx, 'tools' | 'db' | 'now' | 'tz' | 'llm'>, dept: string, agentId = 'worker'): Tools {
  return ctx.tools ?? createTools({ agentId, dept, db: ctx.db, now: ctx.now, tz: ctx.tz, llm: ctx.llm });
}
