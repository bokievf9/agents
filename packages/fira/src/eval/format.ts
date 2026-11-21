import { z } from 'zod';
import { MODES } from '../stores.js';
import { TASK_KINDS } from '../spec.js';

/**
 * The eval set format (`evals/*.eval.json`). One file = one agent spec (by its packs) and its cases. A case is a dialogue (history and the new
 * message) and what must hold for the reply: words it must or must not contain, tools it must or must not call, whether it hands off, a rubric for
 * the judge. `script` is the scripted model for CI (no network): with `--live` the real model answers and the script is ignored.
 */

const turn = z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1) });
const scripted = z.object({
  text: z.string().optional(),
  tools: z.array(z.object({ name: z.string(), input: z.record(z.string(), z.unknown()).optional() })).optional(),
});

export const EvalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** Where the case came from (a test of the old runtime, an owner's remark, a real dialogue with consent). */
  from: z.string().optional(),
  lang: z.enum(['ru', 'en']).default('ru'),
  mode: z.enum(MODES).default('anon'),
  /** The kind of turn (`faq` takes the cheap tier under the model policy). */
  task: z.enum(TASK_KINDS).optional(),
  history: z.array(turn).default([]),
  user: z.string().min(1),
  /** Knowledge chunks the company has for this case (title and text), on top of the set's `knowledge`. */
  knowledge: z.array(z.object({ title: z.string(), text: z.string() })).default([]),
  /** Tool results of this case (tool name → data), over the set's `mocks`: the app's data as the agent's tools would return it. */
  mocks: z.record(z.string(), z.unknown()).default({}),
  script: z.array(scripted).optional(),
  expect: z.object({
    contains: z.array(z.string()).default([]),
    notContains: z.array(z.string()).default([]),
    /** Any of these regular expressions (flags `iu`) must match. */
    matches: z.array(z.string()).default([]),
    callsTool: z.array(z.string()).default([]),
    notCallsTool: z.array(z.string()).default([]),
    handoff: z.boolean().optional(),
    fallback: z.boolean().optional(),
    maxChars: z.number().int().positive().optional(),
    /** For the judge: what a good answer does. */
    rubric: z.string().optional(),
  }),
});
export type EvalCase = z.output<typeof EvalCaseSchema>;

export const EvalSetSchema = z.object({
  name: z.string().min(1),
  spec: z.object({ company: z.string(), role: z.string(), niche: z.string() }),
  /** The judge's pass mark (0..1). */
  threshold: z.number().min(0).max(1).default(0.7),
  knowledge: z.array(z.object({ title: z.string(), text: z.string() })).default([]),
  /** Mock data of the app's tools for every case (tool name → result; `mockTools` in `exec-assistant.ts`). */
  mocks: z.record(z.string(), z.unknown()).default({}),
  /** Words no reply of this set may contain (banned names). */
  banned: z.array(z.string()).default([]),
  /** Names of other clients of the company the leak guard knows (the red-team set: they must never reach a reply). */
  clientNames: z.array(z.string()).default([]),
  cases: z.array(EvalCaseSchema).min(1),
});
export type EvalSet = z.output<typeof EvalSetSchema>;

export function parseEvalSet(json: unknown): EvalSet {
  const set = EvalSetSchema.parse(json);
  const ids = new Set<string>();
  for (const c of set.cases) {
    if (ids.has(c.id)) throw new Error(`fira eval: duplicate case id ${c.id}`);
    ids.add(c.id);
  }
  return set;
}
