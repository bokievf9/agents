import { MockLlm, OffLlm, openDb, type LlmClient, type LlmRequest, type Payload } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { fileURLToPath } from 'node:url';
import { ContentMakerWorker } from '../src/worker.js';

export const promptsDir = fileURLToPath(new URL('../prompts', import.meta.url));
// Wed 2026-11-18 12:00 Tashkent: the next pack week starts Mon 2026-11-23
export const NOW = Date.UTC(2026, 10, 18, 7, 0);

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

export function postJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: 'Бот отвечает ночью',
    lines: ['Клиент пишет в два часа ночи.', 'Утром мастер видит запись.'],
    caption: `Клиент пишет в два часа ночи, а салон закрыт. Бот-администратор отвечает сразу.\n\nЧто происходит дальше:\n- бот показывает свободные окна\n- клиент выбирает время\n- мастер утром видит запись в календаре\n\nПример сценария: так выглядит обычная запись на стрижку без звонков и переписки. Бот спрашивает имя, услугу и удобное время, подтверждает запись и напоминает о ней за день и за час. Если клиент хочет перенести визит, бот предложит другое окно.\n\nНапишите нам в @firtech_bot, подберём состав под ваш бизнес.`,
    hashtags: ['#боты', '#салон', '#автоматизация'],
    ...over,
  });
}

export function storyJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: 'Запись ночью',
    frames: [
      { title: 'Клиент пишет в 2:00', line: 'Салон закрыт, ответа нет.' },
      { title: 'Бот отвечает сразу', line: 'Предлагает свободные окна.' },
      { title: 'Запись готова', line: 'Мастер увидит её утром.' },
      { title: 'Хотите так же?', line: 'Напишите в @firtech_bot' },
    ],
    leads: 'В @firtech_bot, анкета из трёх шагов',
    ...over,
  });
}

export function profileJson(): string {
  return JSON.stringify({
    bio: 'Боты и ИИ-агенты для малого бизнеса: запись, заявки, ответы 24/7. Конструктор на firtech.pro',
    link: 'Собрать бота под ваш бизнес: firtech.pro',
    highlights: [
      { name: 'Боты', cover: 'Какие боты делаем' }, { name: 'Как работает', cover: 'Механика бота' }, { name: 'Ниши', cover: 'Для каких бизнесов' },
      { name: 'Вопросы', cover: 'Частые вопросы' }, { name: 'Связаться', cover: 'Напишите нам' },
    ],
    pinned: ['Что делает ИИ-администратор: картинка с примером диалога', 'Как работает «Сборка проекта»: карусель', 'Как с нами связаться: пост с @firtech_bot'],
    week: ['Пн: рилс про бота-администратора', 'Вт: карусель про приёмщика заявок', 'Ср: пост с чеклистом', 'Чт: история с вопросом', 'Пт: рилс про автоматизацию'],
  });
}

export function youtubeJson(): string {
  return JSON.stringify({
    name: 'Fir Tech',
    handle: '@firtech',
    description: 'Fir Tech делает сайты, Telegram-ботов и ИИ-агентов для малого бизнеса: запись клиентов, приём заявок, ответы на вопросы в любое время. На канале показываем, как это устроено изнутри, разбираем ниши и отвечаем на вопросы владельцев. Новые Shorts каждую неделю. Конструктор бота и контакты: firtech.pro, заявка в Telegram: @firtech_bot',
    playlists: [{ name: 'Боты для бизнеса', line: 'Как бот ведёт запись и заявки' }, { name: 'Ниши', line: 'Разбор по типам бизнеса' }, { name: 'Вопросы владельцев', line: 'Короткие ответы на частые вопросы' }],
    banner: { title: 'Боты и сайты для малого бизнеса', sub: 'Запись и заявки без ручной работы' },
    avatar: 'fir.tech',
    shorts: ['Бот отвечает в два часа ночи', 'Как бот записывает клиента', 'Что нужно для запуска бота', 'Сайт и бот вместе', 'Вопрос владельца: сколько ждать'].map((title) => ({ title, hook: `${title}: смотрите, как это выглядит` })),
    pinnedComment: 'Хотите такого бота для своего дела? Напишите @firtech_bot или зайдите на firtech.pro',
    trailer: 'Тридцать секунд: кто мы, что делает бот в живом диалоге и куда писать, чтобы получить такого же.',
  });
}

export function tiktokJson(): string {
  return JSON.stringify({
    name: 'Fir Tech',
    bio: 'Боты и сайты для малого бизнеса. firtech.pro',
    videos: [{ hook: 'Клиент пишет в два часа ночи', text: 'Бот отвечает сразу' }, { hook: 'Как бот записывает на стрижку', text: 'Запись за минуту' }, { hook: 'Что умеет ИИ-администратор', text: 'Три задачи в день' }],
    hashtagSets: [['#бот', '#малыйбизнес', '#telegram'], ['#автоматизация', '#бизнес', '#сайт'], ['#барбершоп', '#салон', '#запись'], ['#иибизнес', '#агент', '#бот'], ['#предприниматель', '#заявки', '#сайты']],
    avatarNote: 'Логотип fir.tech на тёмном фоне с лаймовым акцентом',
    pin: 'Закрепите видео про ночного бота: оно объясняет всё за 20 секунд',
  });
}

/** Mock model: the prompt's first words pick the material; everything else is a clip. */
export const smartLlm = () =>
  new MockLlm((r: LlmRequest) => {
    const t = r.messages[0]!.content;
    if (t.startsWith('Составь карусель')) return carouselJson();
    if (t.startsWith('Составь пост')) return postJson();
    if (t.startsWith('Составь историю')) return storyJson();
    if (t.startsWith('Составь пакет настройки канала')) return youtubeJson();
    if (t.startsWith('Составь пакет настройки аккаунта')) return tiktokJson();
    if (t.startsWith('Составь пакет настройки')) return profileJson();
    return clipJson();
  });

export interface Staged {
  kind: string;
  payload: Payload;
  summary: string;
}

/** A worker context the way a head builds it: shared in-memory db, requestApproval stages proposals. */
export function setup(opts: { llm?: LlmClient; clipsPerWeek?: number; carouselsPerWeek?: number; postsPerWeek?: number; storiesPerWeek?: number; rendersDir?: string } = {}) {
  const db = openDb(':memory:');
  const staged: Staged[] = [];
  const clock = { t: NOW };
  const logs: string[] = [];
  const llm = opts.llm ?? smartLlm();
  const ctx: WorkerCtx = {
    llm, db, tz: 'Asia/Tashkent', now: () => clock.t,
    requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
    log: (action, detail) => void logs.push(detail ? `${action}: ${detail}` : action),
  };
  const worker = new ContentMakerWorker({ promptsDir, rng: () => 0.1, ...(opts.clipsPerWeek !== undefined ? { clipsPerWeek: opts.clipsPerWeek } : {}), ...(opts.carouselsPerWeek !== undefined ? { carouselsPerWeek: opts.carouselsPerWeek } : {}), ...(opts.postsPerWeek !== undefined ? { postsPerWeek: opts.postsPerWeek } : {}), ...(opts.storiesPerWeek !== undefined ? { storiesPerWeek: opts.storiesPerWeek } : {}), ...(opts.rendersDir ? { rendersDir: opts.rendersDir } : {}) });
  let n = 0;
  const task = (meta: Record<string, unknown>, title = 'T'): Task => ({
    id: ++n, title, body: '', dept: 'marketing', assigneeId: 'content-maker', creator: 'owner', parentId: null, status: 'running', priority: 0,
    dueAt: null, result: null, costUsd: 0, meta, tags: [], routineId: null, createdAt: 0, updatedAt: 0,
  });
  return { worker, ctx, db, staged, clock, logs, task, llm };
}
export { OffLlm };
