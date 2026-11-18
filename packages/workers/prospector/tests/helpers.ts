import { MockLlm, openDb, type Payload } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { ProspectorWorker, storeFor } from '../src/worker.js';

export const DAY = 86_400_000;
export const T0 = Date.UTC(2026, 10, 20, 5, 0);

const HEAD = 'id,ниша,город,название,сайт,instagram,telegram,телефон,что заметил,что предложить,зацепка для первого сообщения,источник,дата проверки';
const row = (id: string, niche: string, city: string, name: string, offer: string, tg = '', phone = '') =>
  `${id},"${niche}",${city},"${name.replaceAll('"', '""')}",,,${tg},${phone},"нет записи, только звонок","${offer}","${name.replaceAll('"', '""')}: запись только звонком. Покажу бота, который принимает заявки вечером.",https://2gis.uz/x/${id},2026-11-18`;

export const CSV = [
  HEAD,
  row('P001', 'Доставка еды и кафе', 'Ташкент', 'Кафе Ромашка', 'Бот-заказ и бронь в Telegram', '', '+998900000001'),
  row('P002', 'Магазины в Instagram/Telegram', 'Алматы', 'Цветы "Роза"', 'Telegram Mini App: каталог и заказ', 'https://t.me/rosa_shop'),
  row('P003', 'Учебные центры и репетиторы', 'Бишкек', 'Cambridge', 'Бот-администратор: запись на пробный урок', '', '+996555000003'),
  row('P004', 'Салоны, барбершопы, стоматологии', 'Алматы', 'Blanche', 'ИИ-приёмщик заявок (WhatsApp, Telegram, Instagram)', '', '+77010000004'),
  row('P005', 'Учебные центры и репетиторы', 'Ташкент', 'Master Mind', 'Бот-администратор: запись на пробный урок', '', '+998909924939'),
  row('P006', 'Учебные центры и репетиторы', 'Бишкек', '  cambridge ', 'дубль по имени и городу'),
  row('P007', 'Учебные центры и репетиторы', '', 'Без города', 'x'),
].join('\r\n');

export interface Staged {
  kind: string;
  payload: Payload;
  summary: string;
}

/** A worker context the way a head builds it: in-memory db, staged approvals, a movable clock, scripted LLM. */
export function rig(handler: ConstructorParameters<typeof MockLlm>[0] = () => 'not json', batchSize = 10) {
  const db = openDb(':memory:');
  const clock = { t: T0 };
  const staged: Staged[] = [];
  const llm = new MockLlm(handler);
  const ctx: WorkerCtx = {
    llm, db, tz: 'Asia/Tashkent', now: () => clock.t,
    requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
    log: () => undefined,
  };
  const store = storeFor(ctx);
  store.importCsv(CSV);
  const worker = new ProspectorWorker({ batchSize, promptsDir: new URL('../prompts', import.meta.url).pathname });
  let n = 0;
  const task = (meta: Record<string, unknown>): Task => ({
    id: ++n, title: 'T', body: '', dept: 'sales', assigneeId: 'prospector', creator: 'routine', parentId: null, status: 'running', priority: 0,
    dueAt: null, result: null, costUsd: 0, meta, tags: [], routineId: null, createdAt: 0, updatedAt: 0,
  });
  const run = (meta: Record<string, unknown>) => worker.run(task(meta), ctx);
  return { db, clock, staged, llm, ctx, store, worker, task, run };
}

export const json = (message: string): string => JSON.stringify({ message });
