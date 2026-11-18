import { errMsg, log } from '@fir/core';

/** Sends one message into a chat topic with a given bot. The Telegram wiring is in index.ts; tests use a fake. */
export type TopicSender = (chatId: number, threadId: number, text: string) => Promise<void>;

/**
 * How department heads report. With a group and a topic for the department, the department bot (or, without one, the Director's bot) posts
 * into the topic (the owner only reads). Otherwise `post` returns false: the report stays in the task journal
 * and reaches the owner in the Director's morning summary. Heads never write to the owner's private chat.
 */
export class Reporter {
  constructor(
    private readonly groupId: number | undefined | (() => number | undefined),
    private readonly topics: Record<string, number> | (() => Record<string, number>),
    private readonly senders: Map<string, TopicSender>,
    /** Used for departments without their own bot: the Director's bot posts into the topic. */
    private readonly fallback?: TopicSender,
  ) {}

  /** `dept` is a department id, or "general" for the Director. */
  async post(dept: string, text: string): Promise<boolean> {
    const send = this.senders.get(dept) ?? this.fallback;
    const groupId = typeof this.groupId === 'function' ? this.groupId() : this.groupId;
    const thread = (typeof this.topics === 'function' ? this.topics() : this.topics)[dept];
    if (groupId === undefined || !send || thread === undefined) return false;
    const body = text.slice(0, 3900);
    try {
      await send(groupId, thread, body);
      return true;
    } catch (e) {
      // A department bot that is not in the group ("chat not found"): the Director's bot posts instead.
      if (this.fallback && send !== this.fallback) {
        try {
          await this.fallback(groupId, thread, body);
          log('warn', 'report posted by the Director bot, department bot failed', { dept, err: errMsg(e) });
          return true;
        } catch (e2) {
          log('warn', 'report to topic failed', { dept, err: errMsg(e2) });
          return false;
        }
      }
      log('warn', 'report to topic failed', { dept, err: errMsg(e) });
      return false;
    }
  }
}
