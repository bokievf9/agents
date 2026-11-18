import { MemoryMessenger, MockLlm, openDb } from '@fir/core';
import { Prospector } from '../src/agent.js';
import { loadPrompts } from '../src/draft.js';
import { ProspectStore } from '../src/store.js';

export const OWNER = 111;
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

export interface Rig {
  store: ProspectStore;
  messenger: MemoryMessenger;
  llm: MockLlm;
  agent: Prospector;
  clock: { t: number };
}

/** Everything on mocks: in-memory SQLite, memory messenger, scripted LLM, a movable clock. */
export function rig(handler: ConstructorParameters<typeof MockLlm>[0] = () => 'not json', batchSize = 10): Rig {
  const clock = { t: T0 };
  const now = () => clock.t;
  const store = new ProspectStore(openDb(':memory:'), now);
  store.importCsv(CSV);
  const messenger = new MemoryMessenger();
  const llm = new MockLlm(handler);
  const prompts = loadPrompts(new URL('../prompts', import.meta.url).pathname);
  const agent = new Prospector({ store, messenger, llm, prompts, ownerId: OWNER, batchSize, now });
  return { store, messenger, llm, agent, clock };
}

export const json = (message: string): string => JSON.stringify({ message });
