import { z } from 'zod';

/**
 * Payment by stages (owner decision 2026-11-21): the shape of the templates the site publishes in `GET /api/prices` (`stages`,
 * `smallProjectMaxUsd`) and the built-in copy used when the site does not publish them yet. Shares are percents of the one-time
 * total; nothing here is a dollar amount. Kept apart from `prices.ts` and `stages.ts` so both can import it.
 */
const bilingual = z.object({ ru: z.string().min(1), en: z.string().min(1) });

const sharesSchema = z.array(z.object({ id: z.string().min(1), title: bilingual, share: z.number().positive().max(100) })).min(1);
export type StageShare = z.infer<typeof sharesSchema>[number];

/**
 * A template of the stage plan. The site publishes `stages` as an object `{ site: [shares], bot: [...], automation: [...], app: [...], small: [...] }`;
 * which products a template serves is HQ's own mapping (`products`, below), not part of the published JSON.
 */
export interface StageTemplate {
  id: string;
  title: Bilingual;
  /** Product ids the template serves (HQ directions and the site's catalogue ids). Empty: the small-project template, chosen by the total. */
  products: string[];
  shares: StageShare[];
}
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
    id: 'site', title: { ru: 'Сайт', en: 'Website' }, products: ['site', 'websites', 'landing', 'shop'],
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
  {
    id: 'company', title: { ru: 'ИИ-компания', en: 'AI company' }, products: ['company'],
    shares: [t('map', 'Карта компании и Директор', 'Company map and the Director', 25), t('depts', 'Первые отделы на ваших данных', 'First departments on your data', 25), t('pult', 'Пульт, база знаний и каналы', 'Control panel, knowledge base and channels', 25), t('launch', 'Обучение команды и запуск', 'Team training and launch', 25)],
  },
];

/**
 * Reads the price list's `stages` (the site's object keyed by template id; an array of `{id, shares}` is read too, our own normalised copy).
 * Tolerant: unknown template ids are ignored; a template whose shares are broken or do not sum to 100 is skipped with a warning and the built-in one
 * is used. Always returns every built-in template.
 */
export function normalizeStages(raw: unknown, warn: (msg: string, extra: Record<string, unknown>) => void = () => undefined): StageTemplate[] {
  const byId = new Map<string, unknown>();
  if (Array.isArray(raw)) {
    for (const x of raw) if (x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string') byId.set((x as { id: string }).id, (x as { shares?: unknown }).shares);
  } else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) byId.set(k, v);
  return DEFAULT_STAGE_TEMPLATES.map((tpl) => {
    if (!byId.has(tpl.id)) return tpl;
    const parsed = sharesSchema.safeParse(byId.get(tpl.id));
    const sum = parsed.success ? parsed.data.reduce((a, x) => a + x.share, 0) : 0;
    if (!parsed.success || Math.abs(sum - 100) > 0.01) {
      warn('prices: stage template skipped, the built-in one is used', { template: tpl.id, reason: parsed.success ? `shares sum to ${sum}` : 'bad shape' });
      return tpl;
    }
    return { ...tpl, shares: parsed.data };
  });
}

/** The price list's stages in the site's published shape (for the snapshot and tests). */
export const stagesAsPublished = (templates: StageTemplate[]): Record<string, StageShare[]> => Object.fromEntries(templates.map((t) => [t.id, t.shares]));
