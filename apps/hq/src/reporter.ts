import { errMsg, log } from '@fir/core';

/** Sends one message into a chat topic with a given bot. The Telegram wiring is in index.ts; tests use a fake. */
export type TopicSender = (chatId: number, threadId: number, text: string) => Promise<void>;

/**
 * How department heads report. With a group, a topic for the department and a department bot, the bot posts
 * into the topic (the owner only reads). Otherwise `post` returns false: the report stays in the task journal
 * and reaches the owner in the Director's morning summary. Heads never write to the owner's private chat.
 */
export class Reporter {
  constructor(
    private readonly groupId: number | undefined,
    private readonly topics: Record<string, number>,
    private readonly senders: Map<string, TopicSender>,
  ) {}

  /** `dept` is a department id, or "general" for the Director. */
  async post(dept: string, text: string): Promise<boolean> {
    const send = this.senders.get(dept);
    const thread = this.topics[dept];
    if (this.groupId === undefined || !send || thread === undefined) return false;
    try {
      await send(this.groupId, thread, text.slice(0, 3900));
      return true;
    } catch (e) {
      log('warn', 'report to topic failed', { dept, err: errMsg(e) });
      return false;
    }
  }
}
