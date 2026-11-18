import { ApprovalQueue, MemoryMessenger, MockLlm, OffLlm, openDb, type LlmClient, type LlmRequest } from '@fir/core';
import { Hq } from '@fir/hq';
import { fileURLToPath } from 'node:url';
import { Director } from '../src/director.js';
import { MarketingHead } from '../src/heads/marketing.js';
import { seedOrg } from '../src/org.js';
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
    return user.startsWith('Составь карусель') ? carouselJson() : clipJson();
  });
}

export function world(opts: { llm?: LlmClient; groupTopics?: boolean; budget?: number } = {}) {
  const clock = { t: NOW };
  const db = openDb(':memory:');
  const messenger = new MemoryMessenger();
  const hq = new Hq(db, { now: () => clock.t });
  const queue = new ApprovalQueue(db, messenger, OWNER, 20, () => clock.t);
  hq.attachQueue(queue);
  seedOrg(hq, { instructionsDir, marketingBudgetUsd: opts.budget ?? 0 });
  const llm = opts.llm ?? routedLlm();
  const posted: { chatId: number; threadId: number; text: string }[] = [];
  const send: TopicSender = (chatId, threadId, text) => Promise.resolve(void posted.push({ chatId, threadId, text }));
  const reporter = opts.groupTopics
    ? new Reporter(-1001, { marketing: 7, general: 2 }, new Map([['marketing', send], ['general', send]]))
    : new Reporter(undefined, {}, new Map());
  const director = new Director({ hq, llm, messenger, queue, ownerId: OWNER, reporter });
  const marketing = new MarketingHead({ hq, llm, queue, messenger, ownerId: OWNER, reporter, rng: () => 0.1 });
  director.editors.set('content_item', marketing);
  /** The owner presses a decision the way the Telegram glue does. */
  const decide = async (action: 'approve' | 'edit' | 'reject', approvalId: number) => {
    await queue.handle(action, approvalId, OWNER);
    director.afterDecision();
  };
  return { clock, db, messenger, hq, queue, llm, posted, reporter, director, marketing, decide };
}
export { OffLlm };
