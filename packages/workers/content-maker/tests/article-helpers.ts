import { MockLlm, type LlmRequest } from '@fir/core';

const RU_SENTENCE = 'Бот принимает запись в любое время, показывает свободные окна и напоминает клиенту о визите за день и за час. Владелец видит все записи в одном чате и тратит на рутину гораздо меньше времени.';
const EN_SENTENCE = 'The bot takes bookings at any hour, shows free slots and reminds the customer about the visit a day and an hour before. The owner sees every booking in one chat and spends much less time on routine.';

const para = (s: string, n: number) => ({ type: 'p' as const, text: Array.from({ length: n }, () => s).join(' ') });

/** A valid article body: ~800 words RU / ~750 EN, 5 headings, a cta, a FAQ of three. */
export function contentOf(lang: 'ru' | 'en', over: Record<string, unknown> = {}) {
  const s = lang === 'ru' ? RU_SENTENCE : EN_SENTENCE;
  const h = lang === 'ru' ? ['С чего начать', 'Как работает запись', 'Что видит владелец', 'Как подключить', 'Частые вопросы'] : ['Where to start', 'How booking works', 'What the owner sees', 'How to connect', 'Frequently asked questions'];
  const desc = lang === 'ru'
    ? 'Как бот берёт на себя запись и напоминания в вашем бизнесе, что видит владелец и с чего начать подключение: механика на примере, без лишних слов.'
    : 'How a bot takes over booking and reminders in your business, what the owner sees and where to start connecting it: the mechanics on a simple example.';
  return {
    title: lang === 'ru' ? 'Бот для записи клиентов: с чего начать' : 'A booking bot for your business: where to start',
    description: desc,
    blocks: [
      para(s, 3), para(s, 3),
      { type: 'h2' as const, text: h[0]! }, para(s, 4),
      { type: 'h2' as const, text: h[1]! }, para(s, 4), { type: 'list' as const, items: [s.split('. ')[0]!, s.split('. ')[1]!] },
      { type: 'h2' as const, text: h[2]! }, para(s, 4),
      { type: 'cta' as const, text: lang === 'ru' ? 'Подберите состав, цену назовёт конструктор.' : 'Pick the parts, the builder names the price.' },
      { type: 'h2' as const, text: h[3]! }, para(s, 4),
      { type: 'h2' as const, text: h[4]! },
      { type: 'list' as const, items: [1, 2, 3].map((n) => ({ title: lang === 'ru' ? `Вопрос ${n}?` : `Question ${n}?`, text: s })) },
    ],
    ...over,
  };
}

export const ruJson = (over: Record<string, unknown> = {}) => JSON.stringify({ slug: 'bot-dlya-barber', ru: contentOf('ru', over) });
export const enJson = (over: Record<string, unknown> = {}) => JSON.stringify({ en: contentOf('en', over) });

/** Answers the two article prompts (Russian first, then English). */
export const articleLlm = (ru: () => string = ruJson, en: () => string = enJson) =>
  new MockLlm((r: LlmRequest) => (r.messages[0]!.content.startsWith('Напиши статью') ? ru() : r.messages[0]!.content.startsWith('Translate') ? en() : '{}'));
