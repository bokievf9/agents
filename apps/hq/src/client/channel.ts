import { errMsg, log, type Messenger } from '@fir/core';

/** The way back to a client who wrote to the public bot: the heads deliver approved texts through it. */
export interface ClientChannel {
  /** Sends the text as it is (plain text, no markup). Throws `ClientBlockedError` when the client blocked the bot. */
  send(chatId: number, text: string): Promise<void>;
}

/** Telegram answered 403: the client blocked the bot (or deleted the chat). */
export class ClientBlockedError extends Error {
  constructor(readonly chatId: number) {
    super('client blocked the bot');
    this.name = 'ClientBlockedError';
  }
}

export interface HandOff {
  client: ClientChannel | undefined;
  messenger: Messenger | undefined;
  ownerId: number | undefined;
  /** Set when the record (lead, ticket) came from the client bot. */
  chatId: number | undefined;
  text: string;
  /** «Лид #3», «Тикет #7»: what the owner reads. */
  ref: string;
  contact: string;
  /** Today's message to the owner when there is no chat to deliver to (he sends the text himself). */
  ownerText: string;
}

/**
 * Delivery of an approved text. With a chat id and the client bot: the bot sends it, and when that fails (blocked,
 * network) the owner gets the text to send by hand and the error is rethrown, so the approval is marked failed.
 * Without a chat id: the text goes to the owner as before.
 */
export async function deliverOrHandOff(h: HandOff): Promise<void> {
  const toOwner = (text: string) => (h.messenger && h.ownerId !== undefined ? h.messenger.send(h.ownerId, text) : Promise.resolve());
  if (h.chatId === undefined || !h.client) return toOwner(h.ownerText);
  try {
    await h.client.send(h.chatId, h.text);
    log('info', 'client delivery', { ref: h.ref, ok: true });
  } catch (e) {
    const blocked = e instanceof ClientBlockedError;
    log('warn', 'client delivery failed', { ref: h.ref, blocked, err: blocked ? 'blocked' : errMsg(e) });
    await toOwner(
      `${h.ref}: ответ не доставлен в бот (${blocked ? 'клиент заблокировал бота' : 'ошибка Telegram'}). Отправьте вручную по контакту ${h.contact || '-'}:\n\n${h.text}`,
    ).catch(() => undefined);
    throw e;
  }
}
