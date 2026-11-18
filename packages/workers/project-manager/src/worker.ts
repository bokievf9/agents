import type { KindSpec, Payload } from '@fir/core';
import type { SubtaskSpec, Task, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { fmtDate, guessProduct, planMilestones } from './plan.js';
import { buildSpec, statusMessage } from './spec.js';
import { PmStore, type Product } from './store.js';

export const WORKER_ID = 'project-manager';
export const KIND_SPEC = 'pm_spec';
export const KIND_STATUS = 'pm_client_status';
const PRODUCTS: Product[] = ['site', 'bot', 'app', 'automation'];

export const storeFor = (ctx: Pick<WorkerCtx, 'db' | 'now'>): PmStore => new PmStore(ctx.db, ctx.now);

/**
 * The project manager. `meta.action`: `create` (client, what, optional product and source: a project with milestones and a
 * ТЗ for the owner's approval) or `client_status` (projectId: a status message for the client). Nothing leaves the
 * system: the owner sends the texts himself.
 */
export class ProjectManagerWorker implements Worker {
  readonly id = WORKER_ID;

  async plan(): Promise<SubtaskSpec[] | null> {
    return null;
  }

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    const store = storeFor(ctx);
    if (task.meta.action === 'client_status') {
      const p = store.project(Number(task.meta.projectId));
      if (!p) return { ok: false, result: '', error: 'проект не найден' };
      const text = statusMessage(p, store.milestones(p.id), ctx.tz);
      await ctx.requestApproval(KIND_STATUS, { text, projectId: p.id }, `Статус клиенту по проекту #${p.id} «${p.client}»:\n\n${text}`);
      ctx.log('pm_status_drafted', String(p.id));
      return { ok: true, result: `Черновик статуса для клиента «${p.client}» (проект #${p.id}).` };
    }
    const client = typeof task.meta.client === 'string' ? task.meta.client.trim() : '';
    const what = typeof task.meta.what === 'string' ? task.meta.what.trim() : '';
    if (!client || !what) return { ok: false, result: '', error: 'нужны клиент и описание: /project <клиент>: <что делаем>' };
    const given = PRODUCTS.find((x) => x === task.meta.product);
    const product = given ?? guessProduct(`${what} ${typeof task.meta.service === 'string' ? task.meta.service : ''}`);
    const source = typeof task.meta.source === 'string' ? task.meta.source : 'owner';
    const p = store.createProject({ client, what, product, source, taskId: task.id });
    const ms = planMilestones(product, ctx.now(), ctx.tz).map((m) => store.addMilestone({ projectId: p.id, ...m }));
    const spec = await buildSpec(ctx.llm, p, ms, ctx.tz);
    store.setSpec(p.id, spec);
    await ctx.requestApproval(KIND_SPEC, { text: spec, projectId: p.id }, `ТЗ проекта #${p.id} «${client}»:\n\n${spec}`);
    ctx.log('pm_project_created', `${p.id} ${product}`);
    return { ok: true, result: `Проект #${p.id} «${client}»: ${ms.map((m) => `${m.title} ${fmtDate(m.dueAt, ctx.tz)}`).join(', ')}. ТЗ ждёт одобрения.` };
  }
}

export interface PmHooks {
  /** The owner approved a ТЗ: the project becomes active, the head creates builder tasks. */
  onSpecApproved(projectId: number): void;
  /** A client status text is ready: it goes to the owner, who sends it. */
  deliverStatus(projectId: number, text: string): Promise<void>;
}

/** Approval kinds for the head to register. The ТЗ is level 0 and locked (scope and terms bind the client); the status is level 1. */
export function kindSpecs(ctx: Pick<WorkerCtx, 'db' | 'now'>, hooks: PmHooks): Record<string, KindSpec> {
  return {
    [KIND_SPEC]: {
      initialLevel: 0,
      locked: true,
      execute: async (payload: Payload) => {
        const store = storeFor(ctx);
        const id = Number(payload.projectId);
        if (!store.project(id)) throw new Error('project not found');
        if (typeof payload.text === 'string' && payload.text.trim()) store.setSpec(id, payload.text);
        store.setStatus(id, 'active');
        hooks.onSpecApproved(id);
      },
    },
    [KIND_STATUS]: {
      initialLevel: 1,
      execute: async (payload: Payload) => {
        if (typeof payload.text !== 'string' || !payload.text.trim()) throw new Error('empty status');
        await hooks.deliverStatus(Number(payload.projectId), payload.text);
      },
    },
  };
}
