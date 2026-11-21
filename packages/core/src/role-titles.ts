/**
 * The one map of agent job titles (owner 2026-11-23: «должности агентов на английском везде»). Every place where the owner or a client
 * sees an agent's title from HQ (notifications, Telegram digests, documents, the office/hub API `title`, emails) takes it from here.
 * The titles follow the org chart in `COMPANY.md` (tested in `tests/role-titles.test.ts`). `ru` is only a short Russian gloss for a
 * subtitle line next to the English title, never a replacement for it. This is NOT the product map: product names a client buys
 * (`product-names.ts`) follow the page language; job titles do not.
 */
export interface RoleTitle {
  /** The agent id in the HQ database (`agents.id`). */
  id: string;
  /** The English job title shown everywhere. */
  en: string;
  /** A short Russian explanation of what the role does (a subtitle, lower case, no title). */
  ru: string;
  /** Row title in the org chart of COMPANY.md, or null for a role that is not in the chart. */
  company: string | null;
  /** Earlier Russian titles stored in existing databases; the startup sync replaces exactly these (an owner's own edit survives). */
  legacy: readonly string[];
}

export const ROLE_TITLES: readonly RoleTitle[] = [
  { id: 'director', en: 'Director', ru: 'единый голос компании для владельца', company: null, legacy: ['Директор'] },
  // marketing
  { id: 'marketing-head', en: 'Head of Marketing', ru: 'руководит маркетингом', company: null, legacy: ['Голова маркетинга'] },
  { id: 'content-maker', en: 'Content Maker', ru: 'клипы, посты, карусели и статьи', company: 'Content Maker', legacy: ['Контент-мейкер'] },
  { id: 'trend-scout', en: 'Trend Scout', ru: 'хуки и форматы дня, тренды ниши', company: 'Trend Scout', legacy: ['Трендвотчер'] },
  { id: 'publisher', en: 'Publisher', ru: 'расписание и публикация', company: 'Publisher', legacy: ['Публикатор'] },
  { id: 'seo', en: 'SEO Specialist', ru: 'SEO и AI-SEO сайта и блога', company: 'SEO Specialist', legacy: ['SEO'] },
  { id: 'analyst', en: 'Analyst', ru: 'метрики и недельный отчёт', company: 'Analyst', legacy: ['Аналитик'] },
  // sales
  { id: 'sales-head', en: 'Head of Sales', ru: 'руководит продажами', company: null, legacy: ['Голова продаж'] },
  { id: 'lead-intake', en: 'Lead Handler', ru: 'принимает заявки, отвечает за минуту', company: 'Lead Handler', legacy: ['Приёмщик лидов'] },
  { id: 'prospector', en: 'Prospector', ru: 'ищет бизнесы и готовит первые сообщения', company: 'Prospector', legacy: ['Разведчик'] },
  { id: 'presales', en: 'Presales', ru: 'КП, смета и черновик договора', company: 'Presales', legacy: ['Пресейл'] },
  { id: 'referral', en: 'Referral Manager', ru: 'рекомендации и выплаты за них', company: null, legacy: ['Рекомендации'] },
  { id: 'client-bot', en: 'Client Assistant', ru: 'отвечает клиентам в Telegram и на сайте', company: null, legacy: ['Клиентский бот'] },
  // production
  { id: 'production-head', en: 'Head of Production', ru: 'руководит производством', company: null, legacy: ['Голова производства'] },
  { id: 'project-manager', en: 'Project Manager', ru: 'ТЗ, план и статусы клиенту', company: 'Project Manager', legacy: ['Проектный менеджер'] },
  { id: 'reviewer', en: 'Reviewer and QA', ru: 'ревью кода и проверка качества', company: 'Reviewer and QA', legacy: ['Ревьюер'] },
  { id: 'deployer', en: 'Deployer', ru: 'выкладка на сервер', company: 'Deployer', legacy: ['Деплойер'] },
  // support
  { id: 'support-head', en: 'Head of Support', ru: 'руководит сопровождением', company: null, legacy: ['Голова сопровождения'] },
  { id: 'customer-support', en: 'Customer Support', ru: 'вопросы клиентов после сдачи', company: 'Customer Support', legacy: ['Поддержка клиентов'] },
  { id: 'monitoring', en: 'Monitoring', ru: 'доступность сайтов и сервисов', company: 'Monitoring', legacy: ['Мониторинг'] },
  { id: 'billing', en: 'Billing', ru: 'счета и напоминания об оплате', company: 'Billing', legacy: ['Биллинг'] },
  { id: 'onboarding', en: 'Onboarding Manager', ru: 'вводит нового клиента в проект', company: null, legacy: ['Онбординг'] },
  // back office
  { id: 'backoffice-head', en: 'Head of Back Office', ru: 'руководит бэк-офисом', company: null, legacy: ['Голова бэк-офиса'] },
  { id: 'finance', en: 'Finance', ru: 'расходы, доходы и месячный отчёт', company: 'Finance', legacy: ['Финансист'] },
  { id: 'documents', en: 'Documents', ru: 'договоры, акты, шаблоны', company: 'Documents', legacy: ['Документовед'] },
  { id: 'knowledge', en: 'Knowledge Base', ru: 'плейбуки и уроки из проектов', company: 'Knowledge Base', legacy: ['Хранитель знаний'] },
] as const;

const BY_ID = new Map(ROLE_TITLES.map((r) => [r.id, r] as const));

/** The English title of an agent id; unknown ids (a custom agent) fall back to `fallback`, else the id. */
export function roleTitle(id: string, fallback?: string): string {
  return BY_ID.get(id)?.en ?? fallback ?? id;
}

/** The Russian gloss of the role (for a subtitle line), or null. */
export function roleGloss(id: string): string | null {
  return BY_ID.get(id)?.ru ?? null;
}

/** `Prospector · ищет бизнесы…` for a place with room for both lines; just the title when there is no gloss. */
export function roleTitleWithGloss(id: string, fallback?: string): string {
  const g = roleGloss(id);
  return g ? `${roleTitle(id, fallback)} (${g})` : roleTitle(id, fallback);
}

/**
 * The title an agent row should carry: the English one when the stored title is empty, already English or one of the old Russian
 * titles of that role; anything else is the owner's own edit and stays.
 */
export function syncedTitle(id: string, stored: string): string {
  const r = BY_ID.get(id);
  if (!r) return stored;
  return !stored || stored === r.en || r.legacy.includes(stored) ? r.en : stored;
}
