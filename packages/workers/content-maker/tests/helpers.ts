import { MockLlm, OffLlm, openDb, type LlmClient, type LlmRequest, type Payload } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { fileURLToPath } from 'node:url';
import { ContentMakerWorker } from '../src/worker.js';

export const promptsDir = fileURLToPath(new URL('../prompts', import.meta.url));
// Wed 2026-11-18 12:00 Tashkent: the next pack week starts Mon 2026-11-23
export const NOW = Date.UTC(2026, 10, 18, 7, 0);

const cap = (t: string) => ({ text: `${t} подпись`, hashtags: ['#fir', '#боты', '#ai'] });

export function clipJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: 'Запись ночью',
    hook: 'Клиент пишет в 2 ночи, а бот отвечает',
    durationSec: 28,
    scenes: [
      { voice: 'Клиент пишет в два часа ночи.', subtitle: 'Запись в 2:00' },
      { voice: 'Бот-администратор предлагает свободные окна.', subtitle: 'Свободные окна' },
      { voice: 'Клиент выбирает время и получает подтверждение.', subtitle: 'Подтверждение' },
      { voice: 'Утром мастер видит запись в календаре. Пример сценария.', subtitle: 'Пример сценария' },
    ],
    cta: 'Напишите нам, ссылка firtech.pro в профиле',
    captions: { instagram: cap('ig'), tiktok: cap('tt'), shorts: { title: 'Бот-администратор', text: 'Запись без переписки', hashtags: ['#shorts', '#боты'] } },
    ...over,
  });
}

export function carouselJson(): string {
  return JSON.stringify({
    title: 'Что входит в бота-администратора',
    slides: Array.from({ length: 6 }, (_, i) => ({ title: `Слайд ${i + 1}`, lines: [`Строка ${i + 1}`] })),
    cta: 'firtech.pro в профиле',
    captions: { instagram: cap('ig') },
  });
}

/** Mock model: carousel prompt gets a carousel, everything else a clip. */
export const smartLlm = () => new MockLlm((r: LlmRequest) => (r.messages[0]!.content.startsWith('Составь карусель') ? carouselJson() : clipJson()));

export interface Staged {
  kind: string;
  payload: Payload;
  summary: string;
}

/** A worker context the way a head builds it: shared in-memory db, requestApproval stages proposals. */
export function setup(opts: { llm?: LlmClient; clipsPerWeek?: number; carouselsPerWeek?: number } = {}) {
  const db = openDb(':memory:');
  const staged: Staged[] = [];
  const clock = { t: NOW };
  const logs: string[] = [];
  const llm = opts.llm ?? smartLlm();
  const ctx: WorkerCtx = {
    llm, db, tz: 'Asia/Tashkent', now: () => clock.t,
    requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
    log: (action, detail) => void logs.push(detail ? `${action}: ${detail}` : action),
  };
  const worker = new ContentMakerWorker({ promptsDir, rng: () => 0.1, ...(opts.clipsPerWeek !== undefined ? { clipsPerWeek: opts.clipsPerWeek } : {}), ...(opts.carouselsPerWeek !== undefined ? { carouselsPerWeek: opts.carouselsPerWeek } : {}) });
  let n = 0;
  const task = (meta: Record<string, unknown>, title = 'T'): Task => ({
    id: ++n, title, body: '', dept: 'marketing', assigneeId: 'content-maker', creator: 'routine', parentId: null, status: 'running', priority: 0,
    dueAt: null, result: null, costUsd: 0, meta, tags: [], routineId: null, createdAt: 0, updatedAt: 0,
  });
  return { worker, ctx, db, staged, clock, logs, task, llm };
}
export { OffLlm };
