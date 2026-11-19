import { ApprovalQueue, MemoryMessenger, MockLlm, OffLlm, openDb, type LlmClient, type LlmRequest } from '@fir/core';
import { Hq } from '@fir/hq';
import { fileURLToPath } from 'node:url';
import { Director } from '../src/director.js';
import { MarketingHead, type Integrations } from '../src/heads/marketing.js';
import { seedOrg } from '../src/org.js';
import { OwnerChannel } from '../src/presence.js';
import { Reporter, type TopicSender } from '../src/reporter.js';

export const OWNER = 100;
// Wed 2026-11-18 12:00 Tashkent (07:00 UTC): the next pack week starts Mon 2026-11-23
export const NOW = Date.UTC(2026, 10, 18, 7, 0);
export const instructionsDir = fileURLToPath(new URL('../instructions', import.meta.url));

const cap = (t: string) => ({ text: `${t} подпись`, hashtags: ['#fir', '#боты', '#ai'] });
export const clipJson = () =>
  JSON.stringify({
    title: 'Запись ночью', hook: 'Клиент пишет в 2 ночи, а бот отвечает', durationSec: 28,
    scenes: [
      { voice: 'Клиент пишет в два часа ночи.', subtitle: 'Запись в 2:00' },
      { voice: 'Бот-администратор предлагает свободные окна.', subtitle: 'Свободные окна' },
      { voice: 'Клиент выбирает время и получает подтверждение.', subtitle: 'Подтверждение' },
      { voice: 'Утром мастер видит запись в календаре. Пример сценария.', subtitle: 'Пример сценария' },
    ],
    cta: 'Напишите нам, ссылка firtech.pro в профиле',
    captions: { instagram: cap('ig'), tiktok: cap('tt'), shorts: { title: 'Бот-администратор', text: 'Запись без переписки', hashtags: ['#shorts', '#боты'] } },
  });
export const carouselJson = () =>
  JSON.stringify({
    title: 'Что входит в бота-администратора',
    slides: Array.from({ length: 6 }, (_, i) => ({ title: `Слайд ${i + 1}`, lines: [`Строка ${i + 1}`] })),
    cta: 'firtech.pro в профиле', captions: { instagram: cap('ig') },
  });

export const postJson = () =>
  JSON.stringify({
    title: 'Бот отвечает ночью', lines: ['Клиент пишет в два часа ночи.', 'Утром мастер видит запись.'],
    caption: `Клиент пишет в два часа ночи, а салон закрыт. Бот-администратор отвечает сразу.\n\nЧто происходит дальше:\n- бот показывает свободные окна\n- клиент выбирает время\n- мастер утром видит запись в календаре\n\nПример сценария: так выглядит обычная запись на стрижку без звонков и переписки. Бот спрашивает имя, услугу и удобное время, подтверждает запись и напоминает о ней за день и за час. Если клиент хочет перенести визит, бот предложит другое окно.\n\nНапишите нам в @firtech_bot, подберём состав под ваш бизнес.`,
    hashtags: ['#боты', '#салон', '#автоматизация'],
  });
export const storyJson = () =>
  JSON.stringify({
    title: 'Запись ночью',
    frames: [
      { title: 'Клиент пишет в 2:00', line: 'Салон закрыт, ответа нет.' }, { title: 'Бот отвечает сразу', line: 'Предлагает свободные окна.' },
      { title: 'Запись готова', line: 'Мастер увидит её утром.' }, { title: 'Хотите так же?', line: 'Напишите в @firtech_bot' },
    ],
    leads: 'В @firtech_bot, анкета из трёх шагов',
  });
export const profileJson = () =>
  JSON.stringify({
    bio: 'Боты и ИИ-агенты для малого бизнеса: запись, заявки, ответы 24/7. Конструктор на firtech.pro',
    link: 'Собрать бота под ваш бизнес: firtech.pro',
    highlights: ['Боты', 'Как работает', 'Ниши', 'Вопросы', 'Связаться'].map((name) => ({ name, cover: `${name}: обложка` })),
    pinned: ['Что делает бот-администратор: картинка с примером диалога', 'Как работает конструктор: карусель', 'Как с нами связаться: пост с @firtech_bot'],
    week: ['Пн: рилс про бота-администратора', 'Вт: карусель про приёмщика заявок', 'Ср: пост с чеклистом', 'Чт: история с вопросом', 'Пт: рилс про автоматизацию'],
  });

/** A valid article body (~800 words RU / ~750 EN, five headings, cta, FAQ of three). */
export function articleContent(lang: 'ru' | 'en') {
  const s = lang === 'ru'
    ? 'Бот принимает запись в любое время, показывает свободные окна и напоминает клиенту о визите за день и за час. Владелец видит все записи в одном чате и тратит на рутину гораздо меньше времени.'
    : 'The bot takes bookings at any hour, shows free slots and reminds the customer about the visit a day and an hour before. The owner sees every booking in one chat and spends much less time on routine.';
  const p = (n: number) => ({ type: 'p' as const, text: Array.from({ length: n }, () => s).join(' ') });
  const h = lang === 'ru' ? ['С чего начать', 'Как работает запись', 'Что видит владелец', 'Как подключить', 'Частые вопросы'] : ['Where to start', 'How booking works', 'What the owner sees', 'How to connect', 'Frequently asked questions'];
  return {
    title: lang === 'ru' ? 'Бот для записи клиентов: с чего начать' : 'A booking bot for your business: where to start',
    description: lang === 'ru'
      ? 'Как бот берёт на себя запись и напоминания в вашем бизнесе, что видит владелец и с чего начать подключение: механика на примере, без лишних слов.'
      : 'How a bot takes over booking and reminders in your business, what the owner sees and where to start connecting it: the mechanics on a simple example.',
    blocks: [
      p(3), p(3), { type: 'h2', text: h[0] }, p(4), { type: 'h2', text: h[1] }, p(4), { type: 'h2', text: h[2] }, p(4),
      { type: 'cta', text: lang === 'ru' ? 'Подберите состав, цену назовёт конструктор.' : 'Pick the parts, the builder names the price.' },
      { type: 'h2', text: h[3] }, p(4), { type: 'h2', text: h[4] },
      { type: 'list', items: [1, 2, 3].map((n) => ({ title: `Q${n}?`, text: s })) },
    ],
  };
}

export interface Replies {
  /** Director's intent parse (a JSON object string). */
  intent?: (text: string) => string;
  /** Head's split of a free-text task. */
  split?: (text: string) => string;
  /** Head's review; default: everything is fine. */
  review?: (text: string, n: number) => string;
}

/** Routes by the system prompt: Director parse, head split, head review, or the content-maker generation. */
export function routedLlm(r: Replies = {}): MockLlm {
  let reviews = 0;
  return new MockLlm((req: LlmRequest) => {
    const user = req.messages[0]!.content;
    if (req.system.includes('Разбери сообщение владельца')) return (r.intent ?? (() => '{"type":"unknown"}'))(user);
    if (req.system.includes('Определи, что нужно сделать исполнителю')) return (r.split ?? (() => '{"action":"none"}'))(user);
    if (req.system.includes('Проверь материал по чек-листу')) return (r.review ?? (() => '{"ok":true,"issues":[]}'))(user, ++reviews);
    if (user.startsWith('Составь карусель')) return carouselJson();
    if (user.startsWith('Составь пост')) return postJson();
    if (user.startsWith('Составь историю')) return storyJson();
    if (user.startsWith('Составь пакет настройки')) return profileJson();
    if (user.startsWith('Напиши статью')) return JSON.stringify({ slug: 'bot-dlya-barber', ru: articleContent('ru') });
    if (user.startsWith('Translate')) return JSON.stringify({ en: articleContent('en') });
    return clipJson();
  });
}

/** The old pack (7 reels and a carousel in even weeks): most tests count items, they ask for it explicitly. */
export const OLD_PACK = { postsPerWeek: 0, storiesPerWeek: 0, carouselsPerWeek: 0.5 } as const;

export function world(opts: { presence?: boolean; llm?: LlmClient; groupTopics?: boolean; budget?: number; integrations?: Integrations; cadence?: { clipsPerWeek?: number; carouselsPerWeek?: number; postsPerWeek?: number; storiesPerWeek?: number }; rendersDir?: string; renderReels?: boolean; audit?: ConstructorParameters<typeof MarketingHead>[0]['audit'] } = {}) {
  const clock = { t: NOW };
  const db = openDb(':memory:');
  const messenger = new MemoryMessenger();
  const hq = new Hq(db, { now: () => clock.t });
  // with `presence`: the owner channel in front of the (memory) Telegram; `messenger` stays the Telegram side
  const channel = opts.presence ? new OwnerChannel({ hq, inner: messenger, ownerId: OWNER, approvalPending: (id) => queue.get(id)?.status === 'pending', onCardSent: (id, m) => queue.noteCard(id, OWNER, m) }) : null;
  const toOwner = channel ?? messenger;
  const queue: ApprovalQueue = new ApprovalQueue(db, toOwner, OWNER, 20, () => clock.t);
  hq.attachQueue(queue);
  seedOrg(hq, { instructionsDir, marketingBudgetUsd: opts.budget ?? 0 });
  const llm = opts.llm ?? routedLlm();
  const posted: { chatId: number; threadId: number; text: string }[] = [];
  const send: TopicSender = (chatId, threadId, text) => Promise.resolve(void posted.push({ chatId, threadId, text }));
  const reporter = opts.groupTopics
    ? new Reporter(-1001, { marketing: 7, general: 2 }, new Map([['marketing', send], ['general', send]]))
    : new Reporter(undefined, {}, new Map());
  const director = new Director({ hq, llm, messenger: toOwner, queue, ownerId: OWNER, reporter });
  const marketing = new MarketingHead({ hq, llm, queue, messenger: toOwner, ownerId: OWNER, reporter, rng: () => 0.1, ...(opts.cadence ?? OLD_PACK), ...(opts.rendersDir ? { rendersDir: opts.rendersDir } : {}), ...(opts.renderReels ? { renderReels: true } : {}), ...(opts.integrations ? { integrations: opts.integrations } : {}), ...(opts.audit ? { audit: opts.audit } : {}) });
  director.editors.set('content_item', marketing);
  director.editors.set('article', marketing);
  /** The owner presses a decision the way the Telegram glue does. */
  const decide = async (action: 'approve' | 'edit' | 'reject', approvalId: number) => {
    await queue.handle(action, approvalId, OWNER);
    director.afterDecision();
  };
  return { clock, db, messenger, channel, hq, queue, llm, posted, reporter, director, marketing, decide };
}
export { OffLlm };
