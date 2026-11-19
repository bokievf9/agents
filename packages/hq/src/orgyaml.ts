import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { Hq } from './hq.js';

const agentSchema = z.strictObject({
  id: z.string().min(1),
  dept: z.string().min(1),
  role: z.enum(['director', 'head', 'worker']),
  title: z.string().min(1),
  instructions: z.string().default(''),
  boss_id: z.string().nullable().default(null),
  status: z.enum(['active', 'paused']).default('active'),
  trust_level: z.number().int().min(0).max(1).default(0),
  /** Name of an env var, not a token. */
  bot: z.string().regex(/^[A-Z][A-Z0-9_]*$/).nullable().default(null),
  budget_usd_month: z.number().min(0).default(0),
});

const routineSchema = z.strictObject({
  name: z.string().min(1),
  cron: z.string().min(1),
  dept: z.string().min(1),
  assignee_id: z.string().nullable().default(null),
  title: z.string().min(1),
  body: z.string().default(''),
  meta: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().default(0),
  overlap: z.enum(['skip', 'allow']).default('skip'),
  enabled: z.boolean().default(true),
  tz: z.enum(['company', 'owner']).default('company'),
});

const orgSchema = z.strictObject({
  version: z.literal(1),
  settings: z.record(z.string(), z.string()).default({}),
  agents: z.array(agentSchema).default([]),
  routines: z.array(routineSchema).default([]),
});

/** Only these settings travel with an exported company (never alert markers or anything token-like). */
export const EXPORTED_SETTINGS = ['tz', 'owner_tz', 'summary_time', 'approval_time', 'digest_time', 'quiet_hours'];

/** The company as a template: org, instructions, routines, settings. No secrets, no tasks, no costs. */
export function exportOrg(hq: Hq): string {
  const all = hq.allSettings();
  return stringify({
    version: 1,
    settings: Object.fromEntries(EXPORTED_SETTINGS.map((k) => [k, all[k] ?? ''])),
    agents: hq.agents().map((a) => ({
      id: a.id, dept: a.dept, role: a.role, title: a.title, instructions: a.instructions, boss_id: a.bossId, status: a.status,
      trust_level: a.trustLevel, bot: a.bot, budget_usd_month: a.budgetUsdMonth,
    })),
    routines: hq.routines().map((r) => ({
      name: r.name, cron: r.cron, dept: r.dept, assignee_id: r.assigneeId, title: r.title, body: r.body, meta: r.meta,
      priority: r.priority, overlap: r.overlap, enabled: r.enabled, tz: r.tz,
    })),
  }, { lineWidth: 0 });
}

/** Upserts agents, routines and settings from YAML. Throws on unknown fields, bad values or secret-looking settings. */
export function importOrg(hq: Hq, yamlText: string): { agents: number; routines: number; settings: number } {
  const org = orgSchema.parse(parse(yamlText));
  for (const k of Object.keys(org.settings)) if (!EXPORTED_SETTINGS.includes(k)) throw new Error(`Setting "${k}" is not importable`);
  const run = hq.db.transaction(() => {
    for (const a of org.agents) {
      hq.upsertAgent({
        id: a.id, dept: a.dept, role: a.role, title: a.title, instructions: a.instructions, bossId: a.boss_id, status: a.status,
        trustLevel: a.trust_level, bot: a.bot, budgetUsdMonth: a.budget_usd_month,
      });
    }
    for (const r of org.routines) {
      hq.scheduleRoutine({
        name: r.name, cron: r.cron, dept: r.dept, assigneeId: r.assignee_id, title: r.title, body: r.body, meta: r.meta,
        priority: r.priority, overlap: r.overlap, enabled: r.enabled, tz: r.tz,
      });
    }
    for (const [k, v] of Object.entries(org.settings)) hq.setSetting(k, v);
  });
  run();
  hq.log('director', 'org_imported');
  return { agents: org.agents.length, routines: org.routines.length, settings: Object.keys(org.settings).length };
}
