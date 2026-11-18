import { ApprovalQueue, MemoryMessenger, MockLlm, OffLlm, openDb, type LlmClient, type LlmRequest } from '@fir/core';
import { Hq } from '@fir/hq';
import { ProspectorWorker, storeFor as prospectStoreFor } from '@fir/worker-prospector';
import { fileURLToPath } from 'node:url';
import { Director } from '../src/director.js';
import { SalesHead, seedSales } from '../src/heads/sales.js';
import { seedOrg } from '../src/org.js';
import { Reporter, type TopicSender } from '../src/reporter.js';

export const OWNER = 100;
// Wed 2026-11-18 12:00 Tashkent (07:00 UTC)
export const NOW = Date.UTC(2026, 10, 18, 7, 0);
export const DAY = 86_400_000;
export const instructionsDir = fileURLToPath(new URL('../instructions', import.meta.url));

const HEAD = 'id,ниша,город,название,сайт,instagram,telegram,телефон,что заметил,что предложить,зацепка для первого сообщения,источник,дата проверки';
const row = (id: string, niche: string, city: string, name: string, offer: string, phone = '') =>
  `${id},"${niche}",${city},"${name}",,,,${phone},"нет записи","${offer}","${name}: запись только звонком. Покажу бота, который принимает заявки вечером.",https://2gis.uz/x/${id},2026-11-18`;
export const CSV = [
  HEAD,
  row('P001', 'Доставка еды и кафе', 'Ташкент', 'Кафе Ромашка', 'Бот-заказ и бронь в Telegram', '+998900000001'),
  row('P002', 'Магазины в Instagram/Telegram', 'Алматы', 'Цветы Роза', 'Telegram Mini App: каталог и заказ'),
  row('P003', 'Учебные центры и репетиторы', 'Бишкек', 'Cambridge', 'Бот-администратор: запись на пробный урок', '+996555000003'),
  row('P004', 'Салоны, барбершопы, стоматологии', 'Алматы', 'Blanche', 'ИИ-приёмщик заявок', '+77010000004'),
  row('P005', 'Учебные центры и репетиторы', 'Ташкент', 'Master Mind', 'Бот-администратор: запись на пробный урок', '+998909924939'),
].join('\n');

export const json = (message: string): string => JSON.stringify({ message });
export const GOOD = 'Здравствуйте! Это Фирдавс из Fir Tech. У Cambridge запись на курс идёт только по звонку, поэтому вечером заявки теряются. Настроим бота для записи на пробный урок, от $250. Как сейчас обрабатываете вечерние заявки?';

export interface Replies {
  /** Director's intent parse. */
  intent?: (text: string) => string;
  /** Head's split of a free-text task. */
  split?: (text: string) => string;
  /** Head's review of a lead reply; default: everything is fine. */
  review?: (text: string, n: number) => string;
  /** The Scout's drafts (first/follow-up/reply, strict JSON {"message"}). */
  scout?: (req: LlmRequest) => string;
}

/** Routes by the system prompt: Director parse, head split, head review, Scout drafts; anything else is garbage. */
export function routedLlm(r: Replies = {}): MockLlm {
  let reviews = 0;
  return new MockLlm((req: LlmRequest) => {
    const user = req.messages[0]!.content;
    if (req.system.includes('Разбери сообщение владельца')) return (r.intent ?? (() => '{"type":"unknown"}'))(user);
    if (req.system.includes('Определи, какому исполнителю отдела продаж')) return (r.split ?? (() => '{"action":"none"}'))(user);
    if (req.system.includes('Проверь ответ клиенту по чек-листу')) return (r.review ?? (() => '{"ok":true,"issues":[]}'))(user, ++reviews);
    if (r.scout) return r.scout(req);
    return 'not json';
  });
}

export function salesWorld(opts: { llm?: LlmClient; groupTopics?: boolean; budget?: number; replyLevel?: 0 | 1; csv?: boolean; batchSize?: number } = {}) {
  const clock = { t: NOW };
  const db = openDb(':memory:');
  const messenger = new MemoryMessenger();
  const hq = new Hq(db, { now: () => clock.t });
  const queue = new ApprovalQueue(db, messenger, OWNER, 20, () => clock.t);
  hq.attachQueue(queue);
  seedOrg(hq, { instructionsDir, marketingBudgetUsd: 0 });
  seedSales(hq, { instructionsDir, salesBudgetUsd: opts.budget ?? 0 });
  const llm = opts.llm ?? routedLlm();
  const posted: { chatId: number; threadId: number; text: string }[] = [];
  const send: TopicSender = (chatId, threadId, text) => Promise.resolve(void posted.push({ chatId, threadId, text }));
  const reporter = opts.groupTopics
    ? new Reporter(-1001, { sales: 8, general: 2 }, new Map([['sales', send], ['general', send]]))
    : new Reporter(undefined, {}, new Map());
  const director = new Director({ hq, llm, messenger, queue, ownerId: OWNER, reporter });
  const prospector = new ProspectorWorker({ batchSize: opts.batchSize ?? 10 });
  const sales = new SalesHead({ hq, llm, queue, messenger, ownerId: OWNER, reporter, prospector, replyLevel: opts.replyLevel ?? 1, ...(opts.batchSize ? { batchSize: opts.batchSize } : {}) });
  director.onSalesReply = (id, text) => sales.startReply(id, text);
  director.editors.set('sales:reply', sales);
  const store = prospectStoreFor({ db, now: hq.now });
  if (opts.csv !== false) store.importCsv(CSV);
  const alerts: string[] = [];
  hq.onAlert((t) => void alerts.push(t));
  /** The owner presses a decision the way the Telegram glue does. */
  const decide = async (action: 'approve' | 'edit' | 'reject', approvalId: number) => {
    await queue.handle(action, approvalId, OWNER);
    director.afterDecision();
  };
  return { clock, db, messenger, hq, queue, llm, posted, reporter, director, sales, store, alerts, decide };
}
export { OffLlm };
