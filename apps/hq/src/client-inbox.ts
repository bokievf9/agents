import { migrate, type Db } from '@fir/core';
import type { OwnerLine } from './client/engine.js';
import type { PultLinks } from './links.js';
import type { NoticeType } from './notices.js';

/**
 * The client bot's way to the owner (owner 2026-11-22: «позвать человека» goes through the HQ bot and the Пульт). The client's words become a line of his
 * thread (`ch_inbound`, read by `chats.ts` next to the cabinet, leads and tickets, joined by the Telegram chat id) and the HQ bot reminds the owner in one
 * line with a link to that chat, with no text of the client and no contact in Telegram. These lines exist only for a chat that asked for a person, wrote after
 * the hand-off or needs an answer; an ordinary conversation of the bot stays text-free, as before. Kept 90 days.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ch_inbound (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ch_inbound_chat ON ch_inbound (chat_id);
`;
const KEEP_MS = 90 * 86_400_000;

export class ClientInbox {
  constructor(private readonly db: Db, private readonly now: () => number) {
    migrate(db, SCHEMA);
  }

  add(chatId: number, text: string, why = ''): number {
    this.db.prepare('DELETE FROM ch_inbound WHERE at < ?').run(this.now() - KEEP_MS);
    return Number(this.db.prepare('INSERT INTO ch_inbound (chat_id, text, why, at) VALUES (?, ?, ?, ?)').run(chatId, text.slice(0, 2000), why.slice(0, 120), this.now()).lastInsertRowid);
  }
}

/** The notices side: `push` of `OwnerNotices` and the Пульт links. */
export interface InboxNotices {
  push(type: NoticeType, text: string, link: string, ref?: string): Promise<boolean>;
}

/** The handler the client bot calls (`ClientEngineDeps.toOwner`): stores the line and queues the reminder. Never throws. */
export function clientToOwner(d: { inbox: ClientInbox; notices: InboxNotices; links: PultLinks; now: () => number; onError: (e: unknown) => void }): (line: OwnerLine) => void {
  return (line) => {
    const who = line.name.trim() || 'без имени';
    const link = d.links.to('chats', `g${line.chatId}`);
    const run = async (): Promise<void> => {
      if (line.kind === 'human') {
        d.inbox.add(line.chatId, 'Просит позвать человека', line.why ?? '');
        await d.notices.push('human', `Клиент просит человека: ${who}, Telegram.`, link, `human:${line.chatId}:${d.now()}`);
        return;
      }
      if (line.kind === 'ticket') {
        await d.notices.push('chat', `Клиент написал в бот: ${who}, Telegram.`, link, `bot-ticket:${line.chatId}:${d.now()}`);
        return;
      }
      const id = d.inbox.add(line.chatId, line.text ?? '', line.why ?? '');
      await d.notices.push('chat', `Клиент написал в Telegram: ${who}.`, link, `chat:${line.chatId}:${id}`);
    };
    void run().catch(d.onError);
  };
}
