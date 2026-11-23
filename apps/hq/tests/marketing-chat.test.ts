/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { MockChatLlm, OffLlm, type LlmChatRequest, type ScriptedTurn } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { ACCEPT_WORDS } from '../src/marketing-chat-tools.js';
import { DEFAULT_RULES } from '../src/marketing-rules.js';
import { createSettings, type SettingsApi } from '../src/settings.js';
import { serve, shellWorld } from './shell-helpers.js';

/** A world whose marketing chat runs on a scripted model (the content pipeline keeps its own routed mock). */
function chatWorld(script?: ScriptedTurn[] | ((req: LlmChatRequest, n: number) => ScriptedTurn | Promise<ScriptedTurn>)) {
  const chat = script ? new MockChatLlm(script) : undefined;
  // the settings API needs the world's hq: a late-bound reference
  const ref: { s?: SettingsApi } = {};
  const settings = new Proxy({} as SettingsApi, { get: (_t, k) => (ref.s as unknown as Record<string | symbol, unknown>)[k] });
  const p = shellWorld({ admin: { settings, ...(chat ? { llm: chat } : { llm: new OffLlm() }) } });
  ref.s = createSettings({
    hq: p.w.hq, queue: p.w.queue, now: p.t, limiters: () => [], slotHours: ['10:00', '18:00'], setLevel: () => undefined, onSchedule: () => undefined,
    defaults: { trustThreshold: 20, slotHours: ['10:00', '18:00'], kpValidDays: 14, clientLlmDailyCap: 300, tgApprovalCards: false, tgGroupReports: false },
  });
  return { ...p, chat };
}
const systemText = (r: LlmChatRequest) => (typeof r.system === 'string' ? r.system : r.system.map((b) => b.text).join('\n'));
const studioTasks = (p: ReturnType<typeof chatWorld>) => p.w.hq.db.prepare("SELECT id, meta FROM tasks WHERE json_extract(meta, '$.studio') IS NOT NULL ORDER BY id").all() as { id: number; meta: string }[];

describe('marketing chat: auth and shape', () => {
  it('401 without the token on every route', async () => {
    const p = chatWorld();
    const s = await serve(p);
    for (const [m, path, body] of [['GET', '/admin/marketing/chat'], ['POST', '/admin/marketing/chat', { text: 'привет' }], ['POST', '/admin/marketing/plan/accept', { planId: 1 }]] as const) {
      expect((await s.http(m, path, body, {})).status).toBe(401);
    }
    expect((await s.http('GET', '/admin/marketing/chat')).status).toBe(200);
    await s.close();
  });

  it('GET: empty thread, rules version; bad query and body are 400; unknown route 404', async () => {
    const p = chatWorld();
    const r = await p.call('GET', '/admin/marketing/chat');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, items: [], rules: { version: 0, updatedAt: null }, pending: [] });
    expect((await p.call('GET', '/admin/marketing/chat?limit=x')).status).toBe(400);
    expect((await p.call('GET', '/admin/marketing/chat?before=-1')).status).toBe(400);
    expect((await p.call('POST', '/admin/marketing/chat', { text: '' })).status).toBe(400);
    expect((await p.call('POST', '/admin/marketing/chat', { text: 'x', extra: 1 })).status).toBe(400);
    expect((await p.call('GET', '/admin/marketing/nope')).status).toBe(404);
  });
});

describe('marketing chat: tools with a stubbed model', () => {
  it('create_order: a Studio order (via chat), the reply has an order card and the order_created action; the thread keeps both lines', async () => {
    const p = chatWorld([{ tools: [{ name: 'create_order', input: { mode: 'prompt', type: 'clip', topic: 'Запись в салон ночью' } }] }, { text: 'Заказала рилс про ночную запись, придёт в ревью-центр.' }]);
    const r = await p.call('POST', '/admin/marketing/chat', { text: 'Новая тема: запись в салон ночью' });
    expect(r.status).toBe(200);
    expect(r.json.reply.text).toBe('Заказала рилс про ночную запись, придёт в ревью-центр.');
    const [task] = studioTasks(p);
    expect(JSON.parse(task!.meta)).toMatchObject({ action: 'topic', type: 'clip', studio: { mode: 'prompt', via: 'chat' } });
    expect(r.json.reply.cards).toEqual([{ kind: 'order', id: String(task!.id), title: 'рилс: Запись в салон ночью', href: `/admin/marketing?tab=studio&order=${task!.id}`, meta: { mode: 'prompt', type: 'clip', state: 'working' } }]);
    expect(r.json.actions).toEqual([{ type: 'order_created', ref: String(task!.id) }]);
    const g = await p.call('GET', '/admin/marketing/chat');
    expect(g.json.items.map((i: any) => [i.role, i.text.slice(0, 8)])).toEqual([['owner', 'Новая те'], ['fira', 'Заказала']]);
    expect(Object.keys(g.json.items[1]).sort()).toEqual(['at', 'cards', 'id', 'role', 'text']);
    expect(g.json.items[1].id).toBe(r.json.reply.id);
    // audit: the order is an owner action
    const audit = await p.call('GET', '/admin/audit?kind=owner');
    expect(audit.json.entries.some((e: any) => e.action === 'studio_order' && e.objectId === String(task!.id) && e.detail === 'prompt chat')).toBe(true);
    // the order runs through the ordinary pipeline
    await p.w.marketing.onHeartbeat();
    expect((await p.call('GET', '/admin/content/orders')).json.items[0]).toMatchObject({ id: task!.id, state: 'delivered' });
  });

  it('create_order without a topic fails to the model (it asks), nothing is created', async () => {
    const p = chatWorld([{ tools: [{ name: 'create_order', input: { mode: 'prompt' } }] }, { text: 'Про что сделать рилс?' }]);
    const r = await p.call('POST', '/admin/marketing/chat', { text: 'сделай рилс' });
    expect(r.json.reply.text).toBe('Про что сделать рилс?');
    expect(r.json.actions).toEqual([{ type: 'none' }]);
    expect(studioTasks(p)).toHaveLength(0);
    const res = JSON.parse((p.chat!.chats[1]!.messages.at(-1)!.content as any[])[0].content);
    expect(res).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('propose_plan (by cadence) -> pending plan card; accept_plan needs the owner\'s yes; then orders for the slot days and calendar slots', async () => {
    const p = chatWorld((req, n) => {
      const last = req.messages.at(-1)!;
      const text = typeof last.content === 'string' ? last.content : '';
      if (n === 1) return { tools: [{ name: 'propose_plan', input: { week: 'next' } }] };
      if (n === 2) return { text: 'План на следующую неделю готов, три слота.' };
      if (text.includes('Сделай сама')) return n === 3 ? { tools: [{ name: 'accept_plan', input: { planId: 1 } }] } : { text: 'Нужно ваше решение.' };
      return n % 2 === 1 ? { tools: [{ name: 'accept_plan', input: { planId: 1 } }] } : { text: 'Приняла.' };
    });
    const r = await p.call('POST', '/admin/marketing/chat', { text: 'План на неделю' });
    expect(r.json.actions).toEqual([{ type: 'plan_proposed', ref: '1' }]);
    expect(r.json.reply.cards[0]).toMatchObject({ kind: 'plan', id: '1', href: '/admin/marketing?tab=plan&plan=1', meta: { week: '2026-W48', slots: 3, status: 'pending' } });
    const plan = (await p.call('GET', '/admin/marketing/plan/1')).json.plan;
    expect(plan.slots.map((s: any) => [s.day, s.type, s.platform])).toEqual([['2026-11-23', 'clip', 'instagram'], ['2026-11-25', 'carousel', 'shorts'], ['2026-11-27', 'clip', 'instagram']]);
    expect(plan.slots.every((s: any) => s.topic.length >= 3)).toBe(true);
    // the model tries to accept without the owner's yes: refused by code
    const sneaky = await p.call('POST', '/admin/marketing/chat', { text: 'Сделай сама как лучше' });
    expect(sneaky.json.actions).toEqual([{ type: 'none' }]);
    expect((await p.call('GET', '/admin/marketing/plan/1')).json.plan.status).toBe('pending');
    const yes = await p.call('POST', '/admin/marketing/chat', { text: 'Принимаю, запускай' });
    expect(yes.json.actions).toEqual([{ type: 'plan_accepted', ref: '1' }]);
    const accepted = (await p.call('GET', '/admin/marketing/plan/1')).json.plan;
    expect(accepted.status).toBe('accepted');
    const tasks = studioTasks(p).map((t) => JSON.parse(t.meta));
    expect(tasks.map((m) => [m.plannedDate, m.type, m.studio.via])).toEqual([['2026-11-23', 'clip', 'plan'], ['2026-11-25', 'carousel', 'plan'], ['2026-11-27', 'clip', 'plan']]);
    const cal = await p.call('GET', '/admin/calendar?from=2026-11-23&to=2026-11-29');
    expect(cal.json.events.filter((e: any) => e.status === 'planned').map((e: any) => e.id)).toEqual(['plan:1:1', 'plan:1:2', 'plan:1:3']);
    // the items get written for the slot days; then the item is on the calendar and the slot is gone
    await p.w.marketing.onHeartbeat();
    const after = await p.call('GET', '/admin/calendar?from=2026-11-23&to=2026-11-29');
    expect(after.json.events.filter((e: any) => e.status === 'planned')).toEqual([]);
    expect(after.json.events.filter((e: any) => e.kind === 'content' && e.status !== 'planned').map((e: any) => e.at.slice(0, 10)).sort()).toEqual(['2026-11-22', '2026-11-24', '2026-11-26'].map((d) => d)); // UTC of the Dushanbe midnight
  });

  it('propose_plan with the model\'s own slots keeps only real days of the week and known types', async () => {
    const p = chatWorld([{ tools: [{ name: 'propose_plan', input: { week: '2026-W49', slots: [
      { day: '2026-12-01', platform: 'tiktok', type: 'post', topic: 'Как агент отвечает ночью' },
      { day: '2026-11-20', platform: 'instagram', type: 'clip', topic: 'не та неделя' },
      { day: '2026-12-02', type: 'video', topic: 'неизвестный тип' },
    ] } }] }, { text: 'Готово.' }]);
    const r = await p.call('POST', '/admin/marketing/chat', { text: 'план на 49 неделю, один пост во вторник' });
    expect(r.json.reply.cards[0].meta).toMatchObject({ week: '2026-W49', slots: 1 });
    expect((await p.call('GET', '/admin/marketing/plan/1')).json.plan.slots).toEqual([{ n: 1, day: '2026-12-01', platform: 'tiktok', type: 'post', topic: 'Как агент отвечает ночью' }]);
  });

  it('update_rules: a new version of marketing-head instructions (confirm-free), rule card, rule_updated; audit row', async () => {
    const text = `${DEFAULT_RULES}\n- Рилсы не длиннее 25 секунд.`;
    const p = chatWorld([{ tools: [{ name: 'update_rules', input: { text, note: 'рилсы до 25 с' } }] }, { text: 'Записала правило, версия 2.' }]);
    const r = await p.call('POST', '/admin/marketing/chat', { text: 'Добавь правило: рилсы не длиннее 25 секунд' });
    expect(r.json.actions).toEqual([{ type: 'rule_updated', ref: 'v2' }]);
    expect(r.json.reply.cards).toEqual([{ kind: 'rule', id: 'v2', title: 'Правила маркетинга, версия 2', href: '/admin/marketing?tab=rules', meta: { version: 2, firaVoice: 'on' } }]);
    const rules = await p.call('GET', '/admin/marketing/rules');
    expect(rules.json.text).toBe(text);
    expect(rules.json.history[0]).toMatchObject({ version: 2, note: 'чат: рилсы до 25 с', actor: 'owner' });
    expect((await p.call('GET', '/admin/marketing/chat')).json.rules.version).toBe(2);
    const audit = await p.call('GET', '/admin/audit?kind=instruction');
    expect(audit.json.entries[0]).toMatchObject({ actor: 'owner', objectId: 'marketing-head', detail: 'v2' });
  });

  it('set_cadence: the setting changes, settings_log has it, schedule_changed; the next plan follows it', async () => {
    const p = chatWorld((_req, n) => (n === 1 ? { tools: [{ name: 'set_cadence', input: { days: [2, 4], time: '11:30', platforms: ['tiktok'] } }] } : n === 2 ? { text: 'Ритм: вт и чт в 11:30, TikTok.' } : n === 3 ? { tools: [{ name: 'propose_plan', input: {} }] } : { text: 'План.' }));
    const r = await p.call('POST', '/admin/marketing/chat', { text: 'Публикуем по вторникам и четвергам в 11:30 в TikTok' });
    expect(r.json.actions).toEqual([{ type: 'schedule_changed', ref: 'marketing.cadence' }]);
    expect((await p.call('GET', '/admin/settings')).json.settings.marketing.cadence).toEqual({ days: [2, 4], time: '11:30', platforms: ['tiktok'] });
    const log = (await p.call('GET', '/admin/settings/log')).json.items;
    expect(log[0]).toMatchObject({ key: 'marketing.cadence', source: 'owner' });
    await p.call('POST', '/admin/marketing/chat', { text: 'План на неделю' });
    expect((await p.call('GET', '/admin/marketing/plan/1')).json.plan.slots.map((s: any) => [s.day, s.platform])).toEqual([['2026-11-24', 'tiktok'], ['2026-11-26', 'tiktok']]);
  });

  it('read tools: feed, calendar, analytics, rules give data and cards; the system has the rules block and the context; last 50 messages in history', async () => {
    const p = chatWorld((_req, n) => (n === 1 ? { tools: [{ name: 'marketing_analytics' }, { name: 'marketing_rules' }, { name: 'content_calendar' }, { name: 'content_feed' }, { name: 'studio_orders' }] } : { text: 'Заявок за неделю 0, публикаций нет.' }));
    for (let i = 0; i < 30; i++) {
      p.w.hq.db.prepare("INSERT INTO mk_chat (role, text, at) VALUES ('owner', ?, ?), ('fira', ?, ?)").run(`вопрос ${i}`, p.t(), `ответ ${i}`, p.t());
    }
    const r = await p.call('POST', '/admin/marketing/chat', { text: 'Что зашло за неделю?' });
    expect(r.status).toBe(200);
    expect(r.json.reply.cards.map((c: any) => c.kind)).toEqual(['rule', 'metric', 'metric', 'metric']);
    const req = p.chat!.chats[0]!;
    expect(systemText(req)).toContain('## Правила маркетинга владельца (версия 0;');
    expect(systemText(req)).toContain('Ритм публикаций: пн, ср, пт в 10:00');
    expect(systemText(req)).toContain('Фира, Head of Marketing');
    // 50 earlier messages plus the new question (the runtime appends the tool round to the same array after it)
    expect(req.messages[0]).toMatchObject({ role: 'user', content: 'вопрос 5' });
    expect(req.messages[50]).toMatchObject({ role: 'user', content: 'Что зашло за неделю?' });
    expect(req.messages[49]).toMatchObject({ role: 'assistant', content: 'ответ 29' });
    const blocks = p.chat!.chats[1]!.messages.at(-1)!.content as any[];
    expect(blocks.every((b) => b.content.length < 2000)).toBe(true);
    const results = blocks.map((b) => JSON.parse(b.content));
    expect(results.every((x) => x.ok)).toBe(true);
    // spend lands on the marketing head
    expect((p.w.db.prepare("SELECT COUNT(*) n FROM costs WHERE agent_id = 'marketing-head'").get() as { n: number }).n).toBe(2);
  });

  it('Fira never publishes and has no price tool beyond the list: the spec tools are the marketing ones', async () => {
    const p = chatWorld([{ text: 'Опубликовать могу только через ревью-центр.' }]);
    await p.call('POST', '/admin/marketing/chat', { text: 'Опубликуй рилс сейчас' });
    const names = (p.chat!.chats[0]!.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['accept_plan', 'campaigns', 'content_calendar', 'content_feed', 'create_order', 'knowledge_search', 'marketing_analytics', 'marketing_rules', 'price_list', 'propose_plan', 'set_cadence', 'studio_orders', 'update_rules']);
    expect(names.some((n) => /publish|price_set|approve/.test(n))).toBe(false);
  });

  it('accept words', () => {
    for (const yes of ['Принимаю', 'да', 'ок, запускай', 'Подтверждаю план', 'давай']) expect(ACCEPT_WORDS.test(yes)).toBe(true);
    for (const no of ['Сделай сама как лучше', 'покажи план', 'надо подумать']) expect(ACCEPT_WORDS.test(no)).toBe(false);
  });
});

describe('POST /admin/marketing/plan/accept (the Shell button)', () => {
  it('orders and calendar slots, a line of Fira in the thread; a second accept is 409; unknown 404; bad body 400', async () => {
    const p = chatWorld();
    await p.call('POST', '/admin/marketing/chat', { text: 'План на неделю' });
    const r = await p.call('POST', '/admin/marketing/plan/accept', { planId: 1 });
    expect(r.status).toBe(200);
    expect(r.json.orders).toHaveLength(3);
    expect(r.json.actions[0]).toEqual({ type: 'plan_accepted', ref: '1' });
    expect(r.json.cards[0]).toMatchObject({ kind: 'plan', meta: { status: 'accepted', orders: 3 } });
    expect((await p.call('POST', '/admin/marketing/plan/accept', { planId: 1 })).status).toBe(409);
    expect((await p.call('POST', '/admin/marketing/plan/accept', { planId: 99 })).status).toBe(404);
    expect((await p.call('POST', '/admin/marketing/plan/accept', { plan: 1 })).status).toBe(400);
    const items = (await p.call('GET', '/admin/marketing/chat')).json.items;
    expect(items.at(-1)).toMatchObject({ role: 'fira', cards: [{ kind: 'plan', id: '1' }] });
    expect(items.at(-1).text).toContain('План #1');
    const audit = await p.call('GET', '/admin/audit?kind=owner');
    expect(audit.json.entries.filter((e: any) => e.action === 'studio_order').length).toBe(3);
    expect(audit.json.entries.some((e: any) => e.action === 'marketing_plan_accepted')).toBe(true);
    expect((await p.call('GET', '/admin/marketing/plans?status=accepted')).json.items).toHaveLength(1);
  });
});

describe('marketing chat offline (no model)', () => {
  it('chips work from the data: rules, plan, new topic, numbers; each says the model is off', async () => {
    const p = chatWorld();
    const rules = await p.call('POST', '/admin/marketing/chat', { text: 'Покажи правила' });
    expect(rules.json.reply.text).toMatch(/^Модель сейчас недоступна/);
    expect(rules.json.reply.text).toContain('Голос Фиры');
    expect(rules.json.reply.cards[0]).toMatchObject({ kind: 'rule', id: 'v0' });
    const plan = await p.call('POST', '/admin/marketing/chat', { text: 'План на неделю' });
    expect(plan.json.actions).toEqual([{ type: 'plan_proposed', ref: '1' }]);
    const topic = await p.call('POST', '/admin/marketing/chat', { text: 'Новая тема: как агент отвечает в выходные' });
    expect(topic.json.actions[0].type).toBe('order_created');
    expect(JSON.parse(studioTasks(p)[0]!.meta).topic).toBe('как агент отвечает в выходные');
    const week = await p.call('POST', '/admin/marketing/chat', { text: 'Что зашло за неделю' });
    expect(week.json.reply.text).toContain('заявок за неделю: 0');
    expect(week.json.actions).toEqual([{ type: 'none' }]);
    expect((await p.call('GET', '/admin/marketing/chat')).json.items).toHaveLength(8);
  });

  it('a model that fails falls back to the offline answer', async () => {
    const p = chatWorld(() => {
      throw new Error('gateway down');
    });
    const r = await p.call('POST', '/admin/marketing/chat', { text: 'Покажи правила' });
    expect(r.status).toBe(200);
    expect(r.json.reply.text).toMatch(/^Модель сейчас недоступна/);
  });
});

describe('marketing chat budget: past it the answer is 202 pending and lands in GET', () => {
  it('202 then GET has the reply', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const chat = new MockChatLlm(async () => {
      await gate;
      return { text: 'Готово, посмотрела.' };
    });
    const { createMarketingChat } = await import('../src/marketing-chat.js');
    const { MarketingPlans } = await import('../src/marketing-plans.js');
    const { createMarketingRules } = await import('../src/shell-marketing.js');
    const p = shellWorld();
    const c = createMarketingChat({ hq: p.w.hq, llm: chat, plans: new MarketingPlans(p.w.hq), rules: createMarketingRules(p.w.hq), budgetMs: 20 });
    const r = await c.post({ text: 'Как дела?' });
    expect(r.status).toBe(202);
    const pending = (r.body as any).pending as number;
    expect((c.get(new URLSearchParams()).body as any)).toMatchObject({ items: [{ role: 'owner' }], pending: [pending] });
    release();
    await new Promise((res) => setTimeout(res, 20));
    const g = c.get(new URLSearchParams()).body as any;
    expect(g.pending).toEqual([]);
    expect(g.items.map((i: any) => [i.id, i.role, i.text])).toEqual([[pending - 1, 'owner', 'Как дела?'], [pending, 'fira', 'Готово, посмотрела.']]);
  });
});
