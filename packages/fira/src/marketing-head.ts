import type { LlmToolDef } from '@fir/core';
import type { GuardPolicy, ModelPolicy } from './spec.js';

/**
 * Fira as Head of Marketing (`role-packs/marketing-head.md`, 2026-11-24): the owner's marketing chat in the Shell (`/admin/marketing/chat`).
 * The tool *definitions* live here (like the executive assistant): HQ (`apps/hq/src/marketing-chat-tools.ts`) gives each its `run` over the real
 * stores. Reads: the content feed, Studio orders, the calendar, campaigns, analytics, the rules. Writes: a Studio order, a pending plan, its acceptance,
 * a new rules version, the publishing cadence. Nothing publishes and nothing touches a price: publications go through the review center.
 */

const obj = (properties: Record<string, unknown> = {}, required: string[] = []): LlmToolDef['input_schema'] => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const TYPES = ['clip', 'post', 'carousel', 'story'];
const PLATFORMS = ['instagram', 'tiktok', 'shorts'];
const week = { type: 'string', description: 'неделя YYYY-Www, или this (эта), или next (следующая); по умолчанию следующая' };

export const MARKETING_TOOL_DEFS: Record<string, LlmToolDef> = {
  content_feed: {
    name: 'content_feed',
    description: 'Лента материалов маркетинга (рилсы, посты, карусели, истории, статьи): статус, тип, день выхода, ссылка в ревью-центр. status: draft, pending, approved, rendering, ready, published, rejected.',
    input_schema: obj({ status: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'integer' } }),
  },
  studio_orders: {
    name: 'studio_orders',
    description: 'Заказы в студию (Content Maker): режим, тема, состояние (working, delivered, failed), готовый материал.',
    input_schema: obj({ limit: { type: 'integer' } }),
  },
  content_calendar: {
    name: 'content_calendar',
    description: 'Календарь маркетинга: материалы по дням, слоты принятых планов, рутины отдела. from и to YYYY-MM-DD, по умолчанию 7 дней от сегодня.',
    input_schema: obj({ from: { type: 'string' }, to: { type: 'string' } }),
  },
  campaigns: {
    name: 'campaigns',
    description: 'Рассылки клиентам (новости, рекомендации): тема, статус, получатели. Только чтение.',
    input_schema: obj(),
  },
  marketing_analytics: {
    name: 'marketing_analytics',
    description: 'Цифры недели: воронка заявок, сайт, блог, YouTube, опубликованные материалы по типам, сравнение с прошлой неделей. week: YYYY-Www, по умолчанию текущая.',
    input_schema: obj({ week: { type: 'string' } }),
  },
  marketing_rules: {
    name: 'marketing_rules',
    description: 'Текущие правила маркетинга (версия, текст, история версий). Правила попадают в промпты Content Maker, Publisher, Trend Scout и твой.',
    input_schema: obj(),
  },
  create_order: {
    name: 'create_order',
    description: 'Заказ материала в студию. mode prompt: новая тема (topic обязателен, type: clip, post, carousel, story). mode variant: ещё вариант материала fromItemId. mode niche: материал fromItemId под нишу niche. note: пожелание. Материал придёт в ревью-центр на одобрение.',
    input_schema: obj({
      mode: { type: 'string', enum: ['prompt', 'variant', 'niche'] }, type: { type: 'string', enum: TYPES }, topic: { type: 'string' }, note: { type: 'string' },
      fromItemId: { type: 'integer' }, niche: { type: 'string' },
    }, ['mode']),
  },
  propose_plan: {
    name: 'propose_plan',
    description: 'Предложить план недели: слоты (day YYYY-MM-DD, platform, type, topic). Без slots план собирается по ритму публикаций и свежим темам. План ждёт решения владельца (accept_plan).',
    input_schema: obj({
      week,
      slots: {
        type: 'array', maxItems: 21,
        items: obj({ day: { type: 'string' }, platform: { type: 'string', enum: PLATFORMS }, type: { type: 'string', enum: TYPES }, topic: { type: 'string' } }, ['day', 'type', 'topic']),
      },
    }),
  },
  accept_plan: {
    name: 'accept_plan',
    description: 'Принять план planId: слоты встают в календарь, на каждый слот уходит заказ в студию. Только когда владелец сам сказал, что принимает.',
    input_schema: obj({ planId: { type: 'integer' } }, ['planId']),
  },
  update_rules: {
    name: 'update_rules',
    description: 'Записать новую версию правил маркетинга: text это полный новый текст правил (не дописка), note одна строка, что поменялось. Только по словам владельца.',
    input_schema: obj({ text: { type: 'string' }, note: { type: 'string' } }, ['text']),
  },
  set_cadence: {
    name: 'set_cadence',
    description: 'Ритм публикаций маркетинга: days (0 воскресенье ... 6 суббота), time HH:MM, platforms (instagram, tiktok, shorts). По нему собирается план недели.',
    input_schema: obj({
      days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } }, time: { type: 'string' },
      platforms: { type: 'array', items: { type: 'string', enum: PLATFORMS } },
    }, ['days']),
  },
};

/** Fira-marketing answers with dates and numbers of the company's own data; the price guard stays (she never names a price off the list). */
export const MARKETING_GUARDS: Partial<GuardPolicy> = { prices: true, dates: false, stock: true, maxChars: 1200, note: 'Цены живут в прайс-листе сайта.' };
/** Sonnet for the chat, a few more tool rounds than the assistant (a plan and its orders). */
export const MARKETING_MODEL: Partial<ModelPolicy> = { default: 'sonnet', byTask: { faq: 'haiku', extract: 'haiku', judge: 'haiku' }, maxTokens: 1200, maxRounds: 6 };
