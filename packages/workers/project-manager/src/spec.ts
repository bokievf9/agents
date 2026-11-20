import { tryComplete, type LlmClient } from '@fir/core';
import { fmtDate, MILESTONE_RU, PRODUCT_RU } from './plan.js';
import type { Milestone, Product, Project } from './store.js';

/** What a product of each type normally includes; the base of the template spec. */
const SCOPE: Record<Product, string[]> = {
  site: ['Дизайн и вёрстка страниц по согласованному прототипу', 'Адаптив под телефон и компьютер', 'Форма заявки с отправкой в Telegram', 'Базовое SEO: заголовки, описания, карта сайта', 'Публикация на сервере и подключение домена с TLS'],
  bot: ['Сценарии диалога по согласованной схеме', 'Хранение данных и админ-доступ для владельца', 'Уведомления владельцу в Telegram', 'Развёртывание на сервере, перезапуск при сбое', 'Инструкция по работе с ботом'],
  app: ['Прототип экранов и сценариев', 'Реализация согласованных экранов и логики', 'Серверная часть и хранение данных', 'Публикация или установка у заказчика', 'Инструкция для пользователей'],
  automation: ['Описание процесса «как есть» и «как будет»', 'Реализация интеграций и скриптов', 'Журнал работы и уведомления об ошибках', 'Развёртывание и запуск по расписанию', 'Инструкция по сопровождению'],
};

const MONEY = /\d[\d\s.,]*\s*(\$|usd|eur|€|руб|₽|сум|тенге|₸|долл)/i;

/** The template spec: always valid, used without an LLM or when the model's text is rejected. */
export function templateSpec(p: Pick<Project, 'client' | 'what' | 'product'>, ms: Pick<Milestone, 'title' | 'dueAt'>[], tz: string): string {
  return [
    `# ТЗ: ${p.client}`,
    '',
    '## Цель',
    p.what.trim(),
    '',
    `## Тип работы`,
    PRODUCT_RU[p.product],
    '',
    '## Состав работ',
    ...SCOPE[p.product].map((s) => `- ${s}`),
    '',
    '## Этапы и целевые даты',
    ...ms.map((m) => `- ${m.title}: до ${fmtDate(m.dueAt, tz)}`),
    '',
    '## Вне объёма',
    '- Всё, что не названо в составе работ, оценивается отдельно',
    '- Контент (тексты, фото, логотипы) предоставляет заказчик, если не оговорено иное',
    '',
    '## Критерии приёмки',
    '- Результат соответствует составу работ и согласованному прототипу',
    '- Проверки проекта (сборка, тесты, линтер) проходят',
    '- Заказчик получил доступы и инструкцию',
    '',
    '## Стоимость и сроки',
    'Стоимость: [цена]. Окончательные сроки: [срок] (целевые даты выше ориентировочные).',
  ].join('\n');
}

/**
 * A short ТЗ: the model writes the text, the template is the fallback. The model never names money (a price in its text
 * means the template is used), and the placeholders [цена] and [срок] always stay for the owner.
 */
export async function buildSpec(llm: LlmClient, p: Pick<Project, 'client' | 'what' | 'product'>, ms: Milestone[], tz: string): Promise<string> {
  const base = templateSpec(p, ms, tz);
  const raw = await tryComplete(llm, {
    tier: 'sonnet', maxTokens: 1200,
    system: 'Ты руководитель проектов студии Fir Tech. Составь короткое техническое задание на русском в Markdown по структуре шаблона: Цель, Тип работы, Состав работ, Этапы и целевые даты, Вне объёма, Критерии приёмки, Стоимость и сроки. Не называй цены и сроки сам: пиши [цена] и [срок]. Не выдумывай функции, которых нет во вводных. Без эмодзи и длинных тире.',
    messages: [{ role: 'user', content: `Заказчик: ${p.client}\nЗадача: ${p.what}\nТип: ${PRODUCT_RU[p.product]}\n\nШаблон:\n${base}` }],
  });
  if (!raw) return base;
  const text = raw.trim();
  if (text.length < 200 || text.length > 6000 || MONEY.test(text) || !text.includes('[цена]') || !text.includes('[срок]')) return base;
  return text;
}

/** A client status message from the milestones: facts only, no prices. */
export function statusMessage(p: Pick<Project, 'client' | 'what'>, ms: Milestone[], tz: string): string {
  const done = ms.filter((m) => m.status === 'done');
  const open = ms.filter((m) => m.status === 'open');
  const next = open[0];
  const lines = [`Здравствуйте! Статус проекта «${p.what.slice(0, 80)}».`];
  lines.push(done.length ? `Готово: ${done.map((m) => (m.stageNo !== null ? m.title : MILESTONE_RU[m.kind]).toLowerCase()).join(', ')}.` : 'Работа идёт по плану, первый этап в процессе.');
  if (next) lines.push(`Следующий этап: ${next.title.toLowerCase()}, ориентир ${fmtDate(next.dueAt, tz)}.`);
  lines.push('Если есть вопросы или правки, напишите, учтём.');
  return lines.join('\n');
}
