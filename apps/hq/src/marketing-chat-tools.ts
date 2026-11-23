import { fail, okv, type ToolResult } from '@fir/core';
import { MARKETING_TOOL_DEFS, priceList, type FiraTool, type ToolRegistry } from '@fir/fira';
import type { Hq } from '@fir/hq';
import type { AdminReply } from './admin.js';
import { currentRules } from './marketing-rules.js';
import { cadenceSlots, cleanSlots, planWeek, type MarketingPlans, type Plan, type StudioOrder } from './marketing-plans.js';
import { cadenceOf, CADENCE_PLATFORMS, type SettingsApi } from './settings.js';
import { isoWeekOf, todayIn, weekWindow } from './shell-week.js';

/**
 * The tools of Fira as Head of Marketing (`packages/fira/role-packs/marketing-head.md`): the definitions are Fira's (`MARKETING_TOOL_DEFS`), here is
 * the `run` over the stores HQ already has (the Studio feed and orders, the calendar, campaigns, analytics, the rules, the plans, the settings). Every
 * write is the same code the Shell's own screens run (Studio orders, the rules version, the settings patch); nothing publishes and nothing touches a
 * price. What a tool did lands in `Turn` (cards and actions of the reply).
 */

export type CardKind = 'order' | 'plan' | 'rule' | 'metric' | 'item' | 'campaign';
export interface Card { kind: CardKind; id: string; title: string; href: string; meta?: Record<string, string | number> }
export type ActionType = 'order_created' | 'rule_updated' | 'plan_proposed' | 'plan_accepted' | 'schedule_changed' | 'none';
export interface Action { type: ActionType; ref?: string }

/** What one turn produced: the cards under the reply and the actions the Shell refreshes on. */
export class Turn {
  readonly cards: Card[] = [];
  readonly actions: Action[] = [];
  card(c: Card): void {
    const i = this.cards.findIndex((x) => x.kind === c.kind && x.id === c.id);
    if (i >= 0) this.cards[i] = c;
    else this.cards.push(c);
  }
  act(a: Action): void {
    if (!this.actions.some((x) => x.type === a.type && x.ref === a.ref)) this.actions.push(a);
  }
  /** The cards the reply carries (writes first, then reads; at most `max`). */
  out(max = 8): Card[] {
    const rank: Record<CardKind, number> = { plan: 0, order: 1, rule: 2, campaign: 3, metric: 4, item: 5 };
    return [...this.cards].sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, max);
  }
}

/** Where a card leads in the Shell (relative paths of the site's `/admin`; the Shell maps them to its screens). */
export const HREF = {
  order: (id: number) => `/admin/marketing?tab=studio&order=${id}`,
  plan: (id: number) => `/admin/marketing?tab=plan&plan=${id}`,
  rules: () => '/admin/marketing?tab=rules',
  analytics: (week: string) => `/admin/analytics?week=${week}`,
  item: (reviewId: string | null, itemId: number | string) => (reviewId ? `/admin/approvals?id=${reviewId}` : `/admin/marketing?tab=studio&item=${itemId}`),
  campaign: (id: number) => `/admin/campaigns?id=${id}`,
} as const;

export interface MarketingToolDeps {
  hq: Hq;
  plans: MarketingPlans;
  rules: { write(text: string, note: string, actor?: string): { ok: true; version: number } | { ok: false; status: number; error: string } };
  content?: { feed(q: URLSearchParams): AdminReply; orders(q: URLSearchParams): AdminReply; createOrder(body: unknown, via?: string): AdminReply } | undefined;
  calendar?: { get(q: URLSearchParams): AdminReply } | undefined;
  analytics?: { get(q: URLSearchParams): AdminReply } | undefined;
  /** The weekly numbers of the «Цифры» tab (`createMetrics().numbers`). */
  numbers?: ((week: string) => unknown) | undefined;
  campaigns?: (() => Promise<AdminReply | null>) | undefined;
  settings?: SettingsApi | undefined;
  /** The Studio order of a plan slot (`MarketingHead.requestStudioOrder`). */
  order?: StudioOrder | undefined;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null);
const body = (r: AdminReply) => r.body as Record<string, unknown>;
const replyOk = (r: AdminReply): ToolResult<unknown> => (r.status === 200 ? okv(r.body) : fail(r.status === 404 ? 'not_found' : 'invalid', String(body(r).error ?? 'failed')));
const TYPE_RU: Record<string, string> = { clip: 'рилс', post: 'пост', carousel: 'карусель', story: 'история' };
/** The owner's words of acceptance (a plan is accepted only when he said so in this turn, or by the Shell's button). */
export const ACCEPT_WORDS = /(?:^|[^\p{L}])(?:прини?ма\p{L}*|прим(?:и|у)\p{L}*|да|ага|ок|окей|давай\p{L}*|запуска\p{L}*|запусти\p{L}*|подтвер\p{L}*|соглас\p{L}*|утвер\p{L}*|годится|го|yes|ok|accept\p{L}*)(?![\p{L}])/iu;

export function planCard(p: Plan): Card {
  return {
    kind: 'plan', id: String(p.id), title: `План на ${p.week}: ${p.slots.length} ${p.slots.length === 1 ? 'слот' : p.slots.length < 5 ? 'слота' : 'слотов'}`, href: HREF.plan(p.id),
    meta: { week: p.week, slots: p.slots.length, status: p.status, ...(p.status === 'accepted' ? { orders: p.slots.filter((s) => s.orderId).length } : {}) },
  };
}

export function ruleCard(version: number, firaVoice: boolean): Card {
  return { kind: 'rule', id: `v${version}`, title: `Правила маркетинга, версия ${version}`, href: HREF.rules(), meta: { version, firaVoice: firaVoice ? 'on' : 'off' } };
}

export function orderCard(o: { id: number; mode?: string; type?: string | null; prompt?: string; state?: string; fromItemId?: number | null }): Card {
  const title = o.mode && o.mode !== 'prompt' ? `${o.mode === 'variant' ? 'Ещё вариант' : 'Под нишу'} к материалу #${o.fromItemId ?? ''}` : `${TYPE_RU[o.type ?? 'clip'] ?? 'материал'}: ${o.prompt ?? ''}`;
  return { kind: 'order', id: String(o.id), title: title.slice(0, 120), href: HREF.order(o.id), meta: { mode: o.mode ?? 'prompt', ...(o.type ? { type: o.type } : {}), state: o.state ?? 'working' } };
}

/** The tools for one turn of the owner (`text`: his message, `turn`: what the reply carries). */
export function marketingTools(d: MarketingToolDeps, ctx: { text: string; turn: Turn }): ToolRegistry {
  const { hq, plans } = d;
  const { turn } = ctx;
  const tool = (name: string, run: FiraTool['run']): [string, FiraTool] => [name, { def: MARKETING_TOOL_DEFS[name]!, run }];
  const today = () => todayIn(hq.now(), hq.tz);

  const entries: [string, FiraTool][] = [
    tool('content_feed', (input) => {
      if (!d.content) return Promise.resolve(fail('not_configured', 'no content'));
      const q = new URLSearchParams();
      const status = str(input.status, 20);
      const kind = str(input.kind, 20);
      if (status) q.set('status', status);
      if (kind) q.set('kind', kind);
      q.set('limit', String(Math.min(int(input.limit) ?? 8, 10)));
      const r = d.content.feed(q);
      if (r.status !== 200) return Promise.resolve(replyOk(r));
      const items = (body(r).items as { id: number | string; kind: string; status: string; title: string; plannedDate: string; reviewId: string | null }[]).map((x) => ({
        id: x.id, kind: x.kind, status: x.status, title: str(x.title, 100), day: x.plannedDate, reviewId: x.reviewId,
      }));
      for (const x of items.slice(0, 4)) turn.card({ kind: 'item', id: String(x.id), title: x.title, href: HREF.item(x.reviewId, x.id), meta: { kind: x.kind, status: x.status, day: x.day } });
      return Promise.resolve(okv({ total: body(r).total, items }));
    }),
    tool('studio_orders', (input) => {
      if (!d.content) return Promise.resolve(fail('not_configured', 'no content'));
      const r = d.content.orders(new URLSearchParams({ limit: String(Math.min(int(input.limit) ?? 8, 10)) }));
      if (r.status !== 200) return Promise.resolve(replyOk(r));
      const items = (body(r).items as { id: number; mode: string; prompt: string; type: string | null; state: string; itemId: number | null; reviewId: string | null }[]).map((o) => ({ ...o, prompt: str(o.prompt, 120) }));
      return Promise.resolve(okv({ items }));
    }),
    tool('content_calendar', (input) => {
      if (!d.calendar) return Promise.resolve(fail('not_configured', 'no calendar'));
      const from = DATE.test(String(input.from ?? '')) ? String(input.from) : today();
      const to = DATE.test(String(input.to ?? '')) ? String(input.to) : new Date(Date.parse(`${from}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
      const r = d.calendar.get(new URLSearchParams({ from, to }));
      if (r.status !== 200) return Promise.resolve(replyOk(r));
      const all = (body(r).events as { id: string; kind: string; at: string; title: string; detail: string; dept: string; status: string }[]).filter((e) => e.dept === 'marketing');
      // the content and the plan slots one by one (short), the routines only counted: the result must fit the model's tool budget
      const events = all.filter((e) => e.kind === 'content').slice(0, 25).map((e) => ({ id: e.id, day: e.at.slice(0, 10), title: str(e.title, 60), type: e.detail.slice(0, 30), status: e.status }));
      const routines = all.filter((e) => e.kind === 'routine').length;
      return Promise.resolve(okv({ from, to, content: events, more: Math.max(0, all.filter((e) => e.kind === 'content').length - events.length), routineRuns: routines }));
    }),
    tool('campaigns', async () => {
      if (!d.campaigns) return fail('not_configured', 'no campaigns');
      const r = await d.campaigns();
      if (!r || r.status !== 200) return fail('not_configured', 'no campaigns');
      const items = ((body(r).items ?? []) as { id: number; kind: string; subject: { ru: string }; status: string; counts: Record<string, number>; sentAt: string | null }[])
        .slice(0, 10)
        .map((c) => ({ id: c.id, kind: c.kind, subject: str(c.subject.ru, 100), status: c.status, sent: c.counts.email ?? 0, sentAt: c.sentAt }));
      for (const c of items.slice(0, 3)) turn.card({ kind: 'campaign', id: String(c.id), title: c.subject || `Рассылка #${c.id}`, href: HREF.campaign(c.id), meta: { status: c.status, sent: c.sent } });
      return okv({ items });
    }),
    tool('marketing_analytics', (input) => {
      const week = typeof input.week === 'string' && /^\d{4}-W\d{2}$/.test(input.week) ? input.week : isoWeekOf(today());
      const a = d.analytics?.get(new URLSearchParams({ week }));
      if (a && a.status !== 200) return Promise.resolve(replyOk(a));
      const nums = d.numbers?.(week) as { site?: Record<string, number>; blog?: { hits: number; published: number }; youtube?: { shorts: number; views: number; subscribers: number; delta: number } } | undefined;
      const published = publishedByType(hq, week);
      const funnel = a ? (body(a).funnel as Record<string, number>) : null;
      const prev = a ? (body(a).prevFunnel as Record<string, number>) : null;
      if (funnel) turn.card({ kind: 'metric', id: `leads:${week}`, title: 'Заявки за неделю', href: HREF.analytics(week), meta: { value: funnel.leads ?? 0, prev: prev?.leads ?? 0 } });
      turn.card({ kind: 'metric', id: `published:${week}`, title: 'Опубликовано за неделю', href: HREF.analytics(week), meta: { value: Object.values(published).reduce((x, y) => x + y, 0), ...published } });
      if (nums?.youtube) turn.card({ kind: 'metric', id: `youtube:${week}`, title: 'YouTube: просмотры', href: HREF.analytics(week), meta: { value: nums.youtube.views, shorts: nums.youtube.shorts } });
      return Promise.resolve(okv({
        week, funnel, prevFunnel: prev, site: nums?.site ?? null, blog: nums?.blog ?? null, youtube: nums?.youtube ?? null, publishedByType: published,
        sources: a ? body(a).sources : null,
      }));
    }),
    tool('marketing_rules', () => {
      const r = currentRules(hq);
      turn.card(ruleCard(r.version, r.firaVoice));
      return Promise.resolve(okv({ version: r.version, text: r.text, firaVoice: r.firaVoice, history: hq.instructionVersions('marketing-head').slice(0, 5).map((v) => ({ version: v.version, note: v.note, at: new Date(v.at).toISOString() })) }));
    }),
    tool('create_order', (input) => {
      if (!d.content) return Promise.resolve(fail('not_configured', 'no studio'));
      const mode = input.mode === 'variant' || input.mode === 'niche' ? input.mode : 'prompt';
      const type = typeof input.type === 'string' && input.type in TYPE_RU ? input.type : undefined;
      const note = str(input.note, 500);
      let req: Record<string, unknown>;
      if (mode === 'prompt') {
        const topic = str(input.topic, 1000) || note;
        if (topic.length < 3) return Promise.resolve(fail('invalid', 'topic is required: ask the owner for the topic'));
        req = { mode, prompt: topic, ...(type ? { type } : {}) };
      } else {
        const from = int(input.fromItemId);
        if (!from) return Promise.resolve(fail('invalid', 'fromItemId is required: ask the owner which item'));
        const niche = str(input.niche, 60);
        if (mode === 'niche' && !niche) return Promise.resolve(fail('invalid', 'niche is required'));
        req = { mode, fromItemId: from, ...(note ? { note } : {}), ...(mode === 'niche' ? { niche } : {}) };
      }
      const r = d.content.createOrder(req, 'chat');
      if (r.status !== 200) return Promise.resolve(replyOk(r));
      const o = body(r).order as { id: number; mode: string; type: string | null; prompt: string; state: string; fromItemId: number | null };
      turn.card(orderCard(o));
      turn.act({ type: 'order_created', ref: String(o.id) });
      return Promise.resolve(okv({ orderId: o.id, state: o.state, note: 'Материал придёт в ревью-центр на одобрение.' }));
    }),
    tool('propose_plan', (input) => {
      const week = planWeek(input.week, hq.now(), hq.tz);
      if (!week) return Promise.resolve(fail('invalid', 'week must be this, next or YYYY-Www'));
      const cadence = cadenceOf(hq);
      const given = cleanSlots(input.slots, week, cadence.platforms[0] ?? 'instagram');
      const slots = given.length ? given : cadenceSlots(hq.db, hq.now(), week, cadence);
      if (!slots.length) return Promise.resolve(fail('invalid', 'no slots'));
      const p = plans.propose(week, slots);
      turn.card(planCard(p));
      turn.act({ type: 'plan_proposed', ref: String(p.id) });
      return Promise.resolve(okv({ planId: p.id, week: p.week, status: p.status, slots: p.slots, note: 'План ждёт решения владельца: принять словами или кнопкой.' }));
    }),
    tool('accept_plan', (input) => {
      const id = int(input.planId);
      if (!id) return Promise.resolve(fail('invalid', 'planId is required'));
      // a plan is the owner's decision: only when his message of this turn says yes
      if (!ACCEPT_WORDS.test(ctx.text)) return Promise.resolve(fail('blocked', 'the owner has not said he accepts the plan: ask him'));
      const r = plans.accept(id, d.order ?? null);
      if (!r.ok) return Promise.resolve(fail(r.status === 404 ? 'not_found' : 'invalid', r.error));
      turn.card(planCard(r.plan));
      turn.act({ type: 'plan_accepted', ref: String(id) });
      return Promise.resolve(okv({ planId: id, orders: r.orders.length, status: r.plan.status }));
    }),
    tool('update_rules', (input) => {
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text) return Promise.resolve(fail('invalid', 'text is required'));
      const w = d.rules.write(text, `чат: ${str(input.note, 180) || 'правка правил'}`, 'owner');
      if (!w.ok) return Promise.resolve(fail('invalid', w.error));
      const r = currentRules(hq);
      turn.card(ruleCard(w.version, r.firaVoice));
      turn.act({ type: 'rule_updated', ref: `v${w.version}` });
      return Promise.resolve(okv({ version: w.version, firaVoice: r.firaVoice }));
    }),
    tool('set_cadence', (input) => {
      if (!d.settings) return Promise.resolve(fail('not_configured', 'no settings'));
      const cur = cadenceOf(hq);
      const days = Array.isArray(input.days) ? input.days.filter((x): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 6) : [];
      const platforms = Array.isArray(input.platforms) ? input.platforms.filter((x): x is (typeof CADENCE_PLATFORMS)[number] => (CADENCE_PLATFORMS as readonly unknown[]).includes(x)) : cur.platforms;
      const time = typeof input.time === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(input.time) ? input.time : cur.time;
      if (!days.length) return Promise.resolve(fail('invalid', 'days are required (0 Sunday ... 6 Saturday)'));
      const r = d.settings.patch({ marketing: { cadence: { days, time, platforms: platforms.length ? platforms : cur.platforms } } }, 'owner');
      if (r.status !== 200) return Promise.resolve(replyOk(r));
      const changed = (body(r).changed as string[]).length > 0;
      if (changed) turn.act({ type: 'schedule_changed', ref: 'marketing.cadence' });
      return Promise.resolve(okv({ cadence: cadenceOf(hq), changed }));
    }),
  ];
  return { ...Object.fromEntries(entries), price_list: priceList };
}

/** Items published this week by type (`pb_posts.published_at` in the week on the company's clock). */
function publishedByType(hq: Hq, week: string): Record<string, number> {
  const out: Record<string, number> = {};
  const w = weekWindow(week, hq.tz);
  if (!w) return out;
  try {
    const rows = hq.db.prepare(`SELECT i.type t, COUNT(DISTINCT i.id) n FROM pb_posts p JOIN cm_items i ON i.id = p.item_id
      WHERE p.published_at >= ? AND p.published_at < ? GROUP BY i.type`).all(w.fromMs, w.toMs) as { t: string; n: number }[];
    for (const r of rows) out[r.t] = r.n;
  } catch {
    // tables not there yet: nothing published
  }
  return out;
}
