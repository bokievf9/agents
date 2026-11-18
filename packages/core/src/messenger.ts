/** Inline button: `data` comes back in the callback. */
export interface Button {
  text: string;
  data: string;
}

/** Outgoing Telegram, behind an interface so tests (and "dry run") never touch the network. */
export interface Messenger {
  send(chatId: number, text: string, buttons?: Button[][]): Promise<void>;
  /** Like `send`, but resolves with the id of the sent message (needed to `edit` it later). */
  sendMessage(chatId: number, text: string, buttons?: Button[][]): Promise<number>;
  /** Replaces the text of a message this bot sent (buttons are dropped). A message that did not change is not an error. */
  edit(chatId: number, messageId: number, text: string): Promise<void>;
}

/** Test double: keeps everything that would have been sent. */
export class MemoryMessenger implements Messenger {
  readonly sent: { chatId: number; text: string; buttons?: Button[][] }[] = [];
  readonly edits: { chatId: number; messageId: number; text: string }[] = [];
  private seq = 0;
  /** Message id -> index in `sent`. */
  private readonly index = new Map<number, number>();
  async send(chatId: number, text: string, buttons?: Button[][]): Promise<void> {
    await this.sendMessage(chatId, text, buttons);
  }
  sendMessage(chatId: number, text: string, buttons?: Button[][]): Promise<number> {
    const id = ++this.seq;
    this.index.set(id, this.sent.push(buttons ? { chatId, text, buttons } : { chatId, text }) - 1);
    return Promise.resolve(id);
  }
  edit(chatId: number, messageId: number, text: string): Promise<void> {
    this.edits.push({ chatId, messageId, text });
    return Promise.resolve();
  }
  /** The current text of a sent message: the last edit, or the original. */
  textOf(messageId: number): string | undefined {
    return this.edits.filter((e) => e.messageId === messageId).at(-1)?.text ?? this.sent[this.index.get(messageId) ?? -1]?.text;
  }
  to(chatId: number): string[] {
    return this.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
  }
  last(): { chatId: number; text: string; buttons?: Button[][] } | undefined {
    return this.sent.at(-1);
  }
}
