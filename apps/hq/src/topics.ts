import { errMsg, log } from '@fir/core';
import type { Hq } from '@fir/hq';

/** Topic keys and their names in the HQ group (key: a department id, or general / approvals). */
export const TOPIC_NAMES: Record<string, string> = {
  general: 'Общее',
  marketing: 'Маркетинг',
  sales: 'Продажи',
  support: 'Сопровождение',
  production: 'Производство',
  backoffice: 'Бэк-офис',
  approvals: 'Одобрения',
};

/** The slice of the Telegram Bot API that topic management needs (grammy's `Api` fits; tests use a mock). */
export interface TopicsApi {
  getMe(): Promise<{ id: number }>;
  getChat(chatId: number): Promise<{ type: string; is_forum?: boolean }>;
  getChatMember(chatId: number, userId: number): Promise<{ status: string; can_manage_topics?: boolean }>;
  createForumTopic(chatId: number, name: string): Promise<{ message_thread_id: number }>;
}

export const STEPS_TEXT =
  'Чтобы отчёты шли по темам, сделайте два шага в группе HQ:\n' +
  '1. Настройки группы -> включить «Темы» (Topics).\n' +
  '2. Администраторы -> бот @firtech_hq_bot -> дать право «Управление темами» (Manage topics).\n' +
  'Потом отправьте мне /topics: я создам темы сам.';

const RIGHT_TEXT = 'В группе включены Темы, но у бота нет права «Управление темами». Администраторы -> @firtech_hq_bot -> включить «Управление темами», затем /topics.';

export type EnsureState = 'no_group' | 'not_forum' | 'no_right' | 'ok' | 'error';
export interface EnsureResult { state: EnsureState; created: string[]; text: string }

/** What a group service message tells us (extracted from the Telegram update by the glue). */
export interface GroupEvent {
  chatId: number;
  threadId?: number;
  migrateTo?: number;
  migrateFrom?: number;
  topicName?: string;
}

const norm = (s: string) => s.trim().toLowerCase();

/** The group id and topic ids: settings (written by the bot) win over env (written by hand). */
export class TopicManager {
  private forum: EnsureState | null = null;

  constructor(
    private readonly hq: Hq,
    private readonly envGroupId: number | undefined,
    private readonly envTopics: Record<string, number>,
    private readonly api: TopicsApi,
  ) {}

  groupId(): number | undefined {
    const raw = this.hq.setting('hq_group_id');
    const n = raw === '' ? NaN : Number(raw);
    return Number.isSafeInteger(n) ? n : this.envGroupId;
  }

  private stored(): Record<string, number> {
    try {
      const v = JSON.parse(this.hq.setting('hq_topics') || '{}') as unknown;
      const out: Record<string, number> = {};
      if (v && typeof v === 'object') for (const [k, id] of Object.entries(v)) if (Number.isInteger(id) && (id as number) > 0) out[k] = id as number;
      return out;
    } catch {
      return {};
    }
  }

  topics(): Record<string, number> {
    return { ...this.envTopics, ...this.stored() };
  }

  /** Migration to a supergroup, or a topic created by hand. Returns true when something was stored. */
  onGroupEvent(e: GroupEvent): boolean {
    const current = this.groupId();
    if (e.migrateTo !== undefined && e.chatId === current) return this.migrate(e.migrateTo, e.chatId);
    if (e.migrateFrom !== undefined && e.migrateFrom === current) return this.migrate(e.chatId, e.migrateFrom);
    if (e.topicName !== undefined && e.threadId !== undefined && e.chatId === current) return this.learn(e.topicName, e.threadId);
    return false;
  }

  private migrate(newId: number, oldId: number): boolean {
    if (newId === this.groupId()) return false;
    this.hq.setSetting('hq_group_id', String(newId));
    this.hq.setSetting('hq_topics', '{}'); // a basic group had no topics
    this.forum = null;
    this.hq.log('director', 'group_migrated', 'group', String(newId), `from ${oldId}`);
    log('info', 'hq group migrated to a supergroup', { from: oldId, to: newId });
    return true;
  }

  private learn(name: string, threadId: number): boolean {
    const key = Object.keys(TOPIC_NAMES).find((k) => norm(TOPIC_NAMES[k]!) === norm(name) || k === norm(name));
    if (!key || this.topics()[key] !== undefined) return false;
    this.hq.setSetting('hq_topics', JSON.stringify({ ...this.stored(), [key]: threadId }));
    this.hq.log('director', 'topic_learned', 'topic', key, `thread ${threadId}`);
    return true;
  }

  /** Create the missing topics when the group is a forum and the bot may manage them. */
  async ensure(): Promise<EnsureResult> {
    const g = this.groupId();
    if (g === undefined) return this.done('no_group', [], 'Группа HQ не задана: добавьте бота в группу и укажите HQ_GROUP_ID.');
    try {
      const chat = await this.api.getChat(g);
      if (chat.type === 'group' || !chat.is_forum) return this.done('not_forum', [], STEPS_TEXT);
      const me = await this.api.getMe();
      const member = await this.api.getChatMember(g, me.id);
      if (!(member.status === 'creator' || (member.status === 'administrator' && member.can_manage_topics))) return this.done('no_right', [], RIGHT_TEXT);
      const have = this.topics();
      const created: string[] = [];
      const failed: string[] = [];
      const next = this.stored();
      for (const [key, name] of Object.entries(TOPIC_NAMES)) {
        if (have[key] !== undefined) continue;
        try {
          next[key] = (await this.api.createForumTopic(g, name)).message_thread_id;
          created.push(key);
        } catch (e) {
          failed.push(key);
          log('warn', 'createForumTopic failed', { key, err: errMsg(e) });
        }
      }
      if (created.length) {
        this.hq.setSetting('hq_topics', JSON.stringify(next));
        this.hq.log('director', 'topics_created', 'group', String(g), created.join(','));
      }
      const text = `Темы готовы. Создано: ${created.length ? created.map((k) => TOPIC_NAMES[k]).join(', ') : 'ничего нового'}.${failed.length ? ` Не вышло: ${failed.join(', ')} (см. лог).` : ''}`;
      return this.done(failed.length ? 'error' : 'ok', created, text);
    } catch (e) {
      const to = (e as { parameters?: { migrate_to_chat_id?: number } }).parameters?.migrate_to_chat_id;
      if (to !== undefined && this.migrate(to, g)) return this.ensure();
      log('warn', 'topics check failed', { err: errMsg(e) });
      return this.done('error', [], `Не удалось проверить группу: ${errMsg(e)}`);
    }
  }

  private done(state: EnsureState, created: string[], text: string): EnsureResult {
    this.forum = state;
    return { state, created, text };
  }

  /** One line for the morning summary, only once, only when the group is configured but has no topics yet. */
  summaryNote(): string | null {
    if (this.forum !== 'not_forum' && this.forum !== 'no_right') return null;
    if (this.hq.setting('hq_topics_hint') === '1') return null;
    this.hq.setSetting('hq_topics_hint', '1');
    return `Группа HQ ещё без тем. ${this.forum === 'not_forum' ? 'Включите «Темы» в настройках группы и дайте боту право «Управление темами»' : 'Дайте боту право «Управление темами»'}, затем /topics.`;
  }
}
