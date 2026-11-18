import { errMsg, log, zonedParts, type ApprovalQueue, type LlmClient, type Messenger, type Payload } from '@fir/core';
import { generateItem, type Prompts } from './generate.js';
import { PLATFORM_LABEL, splitPlatforms, type ItemType, type Platform } from './format.js';
import { ContentStore } from './store.js';
import { ALL_TOPICS, freeTopic, pickTopics, type Topic } from './topics.js';

export const KIND = 'content_item';
const DAY = 86_400_000;

/** Pack layout: type and day offset from Monday (Tue clip, Wed carousel, Thu clip, Sat clip). */
export const PACK_PLAN: { type: ItemType; day: number }[] = [
  { type: 'clip', day: 1 },
  { type: 'carousel', day: 2 },
  { type: 'clip', day: 3 },
  { type: 'clip', day: 5 },
];

const TYPE_RU: Record<ItemType, string> = { clip: 'клип', carousel: 'карусель' };
const PLATFORMS: Record<ItemType, Platform[]> = { clip: ['instagram', 'tiktok', 'shorts'], carousel: ['instagram'] };

export interface HeadDeps {
  store: ContentStore;
  messenger: Messenger;
  llm: LlmClient;
  queue: ApprovalQueue;
  prompts: Prompts;
  cfg: { ownerId: number; tz: string };
  now?: () => number;
  rng?: () => number;
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => ymd(Date.parse(`${date}T00:00:00Z`) + n * DAY);
const ddmm = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;
const weekday = (date: string) => new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
const dayLabel = (date: string) => `${weekday(date)} ${ddmm(date)}`;

export class ContentHead {
  private readonly now: () => number;
  private readonly rng: () => number;
  private busy = false;

  constructor(private readonly d: HeadDeps) {
    this.now = d.now ?? Date.now;
    this.rng = d.rng ?? Math.random;
    // locked: every item needs the owner's button, the trust counter never promotes publishing to level 1.
    d.queue.register(KIND, {
      initialLevel: 0,
      locked: true,
      execute: (payload: Payload, approvalId: number) => this.onApproved(payload, approvalId),
    });
  }

  private today(): string {
    const p = zonedParts(this.now(), this.d.cfg.tz);
    return ymd(Date.UTC(p.y, p.mo - 1, p.d));
  }

  /** The pack covers the week starting on Monday: today when it is Monday, otherwise the next Monday. */
  weekStart(): string {
    const p = zonedParts(this.now(), this.d.cfg.tz);
    return addDays(this.today(), p.dow === 1 ? 0 : (8 - p.dow) % 7);
  }

  private say(text: string): Promise<void> {
    return this.d.messenger.send(this.d.cfg.ownerId, text);
  }

  /** Scheduled run skips a week that already has a pack; `force` (the /pack command) always generates. */
  async generatePack(force = false): Promise<void> {
    if (this.busy) return void (await this.say('Пакет уже генерируется, подождите.'));
    if (!this.d.llm.enabled) return void (await this.say('Модель недоступна (LLM off): нет LLM_API_KEY. Пакет не создан.'));
    const week = this.weekStart();
    if (!force && this.d.store.packExists(week)) return;
    this.busy = true;
    try {
      const topics = pickTopics(this.d.store.history(), PACK_PLAN.length, this.now(), this.rng);
      const packId = this.d.store.createPack(week);
      await this.say(`Пакет на неделю с ${ddmm(week)}: ${PACK_PLAN.length} материала, ниже по одному. Одобрите, поправьте или отклоните каждый.`);
      let ok = 0;
      for (const [i, plan] of PACK_PLAN.entries()) {
        const topic = topics[i]!;
        const itemId = this.d.store.insertItem({
          packId, seq: i + 1, total: PACK_PLAN.length, type: plan.type, topicKey: topic.key, topicText: topic.text, plannedDate: addDays(week, plan.day),
        });
        this.d.store.recordTopic(topic.key);
        if (await this.produce(itemId, topic, '')) ok++;
      }
      if (ok < PACK_PLAN.length) await this.say(`Из ${PACK_PLAN.length} материалов получилось ${ok}. Остальное можно сделать через /topic.`);
    } finally {
      this.busy = false;
    }
  }

  /** One item on a given topic (`карусель ...` or `carousel ...` makes a carousel, otherwise a clip). */
  async generateTopic(arg: string): Promise<void> {
    const m = /^(карусель|carousel)\s+/i.exec(arg);
    const type: ItemType = m ? 'carousel' : 'clip';
    const text = (m ? arg.slice(m[0].length) : arg).trim().slice(0, 300);
    if (!text) return void (await this.say('Укажите тему: /topic <тема> или /topic карусель <тема>.'));
    if (!this.d.llm.enabled) return void (await this.say('Модель недоступна (LLM off): нет LLM_API_KEY.'));
    const topic = freeTopic(text);
    const itemId = this.d.store.insertItem({
      packId: null, seq: 1, total: 1, type, topicKey: topic.key, topicText: topic.text, plannedDate: addDays(this.today(), 1),
    });
    this.d.store.recordTopic(topic.key);
    await this.produce(itemId, topic, '');
  }

  /** Generates the text of a drafted item and puts it into the approval queue. */
  private async produce(itemId: number, topic: Topic, weekNote: string, retry?: { comment: string; previous: string }): Promise<boolean> {
    const item = this.d.store.item(itemId)!;
    const week = weekNote || (item.packId ? `с ${ddmm(item.plannedDate)}` : '');
    try {
      const gen = await generateItem(this.d.llm, this.d.prompts, { type: item.type, topic, week, ...(retry ?? {}) });
      if (!gen) {
        this.d.store.setStatus(itemId, 'failed');
        await this.say(`Материал ${item.seq} из ${item.total} (${TYPE_RU[item.type]}, ${topic.text}) не получился: модель не дала валидный ответ. Повторить: /topic ${topic.text.slice(0, 80)}`);
        return false;
      }
      const head = `${item.packId ? `Пакет, материал ${item.seq} из ${item.total}` : 'Отдельный материал'}${item.attempt ? ' (вторая версия)' : ''}. ${TYPE_RU[item.type]}, ${PLATFORMS[item.type].map((p) => PLATFORM_LABEL[p]).join(' + ')}. Выход: ${dayLabel(item.plannedDate)}. Тема: ${topic.text}`;
      const warn = gen.issues.length ? `\nПроверка тона нашла: ${gen.issues.join('; ')}.` : '';
      const { id: approvalId } = await this.d.queue.propose(KIND, { text: gen.text, itemId }, head + warn);
      this.d.store.setProposed(itemId, gen.text, gen.title, approvalId);
      return true;
    } catch (e) {
      this.d.store.setStatus(itemId, 'failed');
      log('error', 'item failed', { itemId, err: errMsg(e) });
      await this.say(`Материал ${item.seq} из ${item.total} не удалось отправить на одобрение, подробности в логе.`).catch(() => undefined);
      return false;
    }
  }

  /** Runs after "approve" (the queue calls it): the item becomes ready, one row per platform. */
  private onApproved(payload: Payload, approvalId: number): Promise<void> {
    const itemId = Number(payload.itemId);
    const item = this.d.store.item(itemId);
    if (!item) return Promise.reject(new Error(`item ${itemId} not found`));
    const text = typeof payload.text === 'string' ? payload.text : item.text;
    const { body, sections } = splitPlatforms(text);
    const rows = PLATFORMS[item.type].map((platform) => {
      const own = sections[platform];
      return { platform, text: own ? `${body}\n\n${PLATFORM_LABEL[platform]}:\n${own}` : text };
    });
    this.d.store.markReady(itemId, text, this.d.queue.get(approvalId)?.edited ?? false, rows);
    return Promise.resolve();
  }

  /**
   * Called by the bot glue after a button press. A rejected first version asks the owner for a comment and is
   * regenerated once with it; a rejected second version is final.
   */
  async afterDecision(approvalId: number, action: 'approve' | 'edit' | 'reject'): Promise<void> {
    if (action !== 'reject') return;
    const item = this.d.store.itemByApproval(approvalId);
    if (!item || item.status === 'rejected' || this.d.queue.get(approvalId)?.status !== 'rejected') return;
    this.d.store.setStatus(item.id, 'rejected');
    if (item.attempt > 0) return void (await this.say(`Материал #${item.id} отклонён во второй раз, больше не пересоздаю. Новая тема: /topic.`));
    this.d.store.setKv('await_comment', String(item.id));
    await this.say(`Что не так в материале #${item.id}? Напишите комментарий одним сообщением, я сделаю вторую версию. /skip отменяет.`);
  }

  /** A plain owner message: the comment on a rejected item, if one is awaited. Returns true when consumed. */
  async onText(text: string): Promise<boolean> {
    const id = Number(this.d.store.getKv('await_comment'));
    if (!id) return false;
    const old = this.d.store.item(id);
    this.d.store.setKv('await_comment', null);
    if (!old) return false;
    this.d.store.setStatus(id, 'rejected', text.slice(0, 500));
    const topic = ALL_TOPICS.find((t) => t.key === old.topicKey) ?? { key: old.topicKey, directionId: null, text: old.topicText };
    const newId = this.d.store.insertItem({
      packId: old.packId, seq: old.seq, total: old.total, type: old.type, topicKey: old.topicKey, topicText: old.topicText, plannedDate: old.plannedDate, attempt: old.attempt + 1,
    });
    await this.say('Принял комментарий, делаю вторую версию.');
    await this.produce(newId, topic, '', { comment: text.slice(0, 500), previous: old.text });
    return true;
  }

  async onCommand(name: string, arg = ''): Promise<void> {
    switch (name) {
      case 'start':
      case 'help':
        return this.say('Контент-мейкер Fir Tech.\n/pack: пакет недели сейчас\n/topic <тема>: один материал (карусель: /topic карусель <тема>)\n/queue: одобрено и ждёт выхода\n/stats: счётчики\n/skip: отменить ожидание комментария');
      case 'pack':
        return this.generatePack(true);
      case 'topic':
        return this.generateTopic(arg);
      case 'queue':
        return this.say(this.queueText());
      case 'stats':
        return this.say(this.statsText());
      case 'skip':
        this.d.store.setKv('await_comment', null);
        return this.say('Ок, без второй версии.');
      default:
        return;
    }
  }

  queueText(): string {
    const rows = this.d.store.readyRows();
    const pending = this.d.store.counts().proposed;
    const byItem = new Map<number, typeof rows>();
    for (const r of rows) byItem.set(r.itemId, [...(byItem.get(r.itemId) ?? []), r]);
    const lines = [...byItem.entries()].map(([itemId, rs]) => {
      const item = this.d.store.item(itemId);
      return `${dayLabel(rs[0]!.plannedDate)}: ${TYPE_RU[rs[0]!.type]}, ${rs.map((r) => PLATFORM_LABEL[r.platform]).join(' + ')}. ${item?.title ?? ''}`;
    });
    return [lines.length ? `Одобрено и ждёт выхода (${byItem.size}):\n${lines.join('\n')}` : 'Одобренных материалов в очереди нет.', pending ? `Ждут вашего решения: ${pending}.` : ''].filter(Boolean).join('\n');
  }

  statsText(): string {
    const c = this.d.store.counts();
    return `Одобрено: ${c.ready} (с правкой: ${c.edited})\nОтклонено: ${c.rejected}\nВторых версий: ${c.regenerated}\nЖдут решения: ${c.proposed}\nНе получились: ${c.failed}`;
  }
}
