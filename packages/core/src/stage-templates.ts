import { z } from 'zod';

/**
 * Payment by stages (owner decision 2026-11-21): the shape of the templates the site publishes in `GET /api/prices` (`stages`,
 * `smallProjectMaxUsd`) and the built-in copy used when the site does not publish them yet. Shares are percents of the one-time
 * total; nothing here is a dollar amount. Kept apart from `prices.ts` and `stages.ts` so both can import it.
 */
const bilingual = z.object({ ru: z.string().min(1), en: z.string().min(1) });

export const stageTemplateSchema = z.object({
  id: z.string().min(1),
  title: bilingual,
  /** Product ids the template serves (HQ directions and the site's catalogue ids). Empty: the small-project template, chosen by the total. */
  products: z.array(z.string()),
  shares: z.array(z.object({ id: z.string().min(1), title: bilingual, share: z.number().positive().max(100) })).min(1),
});
export type StageTemplate = z.infer<typeof stageTemplateSchema>;
export type Bilingual = z.infer<typeof bilingual>;

/** One stage of a project, with its amount: `no` counts from 1. */
export interface PaymentStage {
  no: number;
  id: string;
  title: Bilingual;
  share: number;
  amountUsd: number;
}

/** A one-time total below this is paid in two stages 50/50 (the site's `paymentStages.smallProjectMaxUsd`). */
export const DEFAULT_SMALL_PROJECT_MAX_USD = 300;

const t = (id: string, ru: string, en: string, share: number) => ({ id, title: { ru, en }, share });

export const DEFAULT_STAGE_TEMPLATES: StageTemplate[] = [
  {
    id: 'site', title: { ru: 'Сайт', en: 'Website' }, products: ['site', 'websites', 'landing', 'company', 'shop'],
    shares: [t('structure', 'Структура и первый экран', 'Structure and first screen', 30), t('pages', 'Все страницы и наполнение', 'All pages and content', 40), t('launch', 'Запуск, SEO, передача', 'Launch, SEO, handover', 30)],
  },
  {
    id: 'bot', title: { ru: 'Telegram-бот', en: 'Telegram bot' }, products: ['bot', 'bots', 'admin', 'receptionist', 'intake', 'faq', 'booking'],
    shares: [t('scenario', 'Сценарий и структура', 'Scenario and structure', 30), t('build', 'Рабочий бот на тесте', 'Working bot on a test account', 40), t('launch', 'Запуск и обучение', 'Launch and training', 30)],
  },
  {
    id: 'automation', title: { ru: 'Автоматизация', en: 'Automation' }, products: ['automation', 'implementation', 'aiteam', 'integration', 'crm', 'assistant'],
    shares: [t('map', 'Карта процессов', 'Process map', 20), t('integrate', 'Интеграции', 'Integrations', 50), t('launch', 'Запуск и обучение', 'Launch and training', 30)],
  },
  {
    id: 'app', title: { ru: 'Приложение', en: 'App' }, products: ['app', 'apps', 'miniapp', 'pwa', 'mobile', 'internal'],
    shares: [t('design', 'Дизайн и прототип', 'Design and prototype', 25), t('core', 'Основной функционал', 'Core features', 25), t('full', 'Все экраны и тесты', 'All screens and tests', 25), t('launch', 'Публикация и передача', 'Publishing and handover', 25)],
  },
  { id: 'small', title: { ru: 'Малый проект', en: 'Small project' }, products: [], shares: [t('start', 'Старт', 'Start', 50), t('launch', 'Запуск', 'Launch', 50)] },
];
