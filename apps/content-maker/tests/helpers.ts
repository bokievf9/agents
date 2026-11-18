import { ApprovalQueue, MemoryMessenger, MockLlm, OffLlm, openDb, type LlmClient, type LlmRequest } from '@fir/core';
import { fileURLToPath } from 'node:url';
import { loadPrompts } from '../src/generate.js';
import { ContentHead } from '../src/head.js';
import { ContentStore } from '../src/store.js';

export const OWNER = 100;
// Wed 2026-11-18 12:00 UTC (Tashkent): the next pack week starts Mon 2026-11-23
export const NOW = Date.UTC(2026, 10, 18, 12, 0);
export const prompts = loadPrompts(fileURLToPath(new URL('../prompts', import.meta.url)));

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

export function setup(opts: { llm?: LlmClient } = {}) {
  const clock = { t: NOW };
  const messenger = new MemoryMessenger();
  const db = openDb(':memory:');
  const now = () => clock.t;
  const queue = new ApprovalQueue(db, messenger, OWNER, 20, now);
  const store = new ContentStore(db, now);
  const llm = opts.llm ?? smartLlm();
  const head = new ContentHead({ store, messenger, llm, queue, prompts, cfg: { ownerId: OWNER, tz: 'Asia/Tashkent' }, now, rng: () => 0.1 });
  /** Press a decision the way the bot glue does. */
  const decide = async (action: 'approve' | 'edit' | 'reject', approvalId: number) => {
    await queue.handle(action, approvalId, OWNER);
    await head.afterDecision(approvalId, action);
  };
  return { head, store, queue, messenger, db, clock, decide, llm };
}
export { OffLlm };
