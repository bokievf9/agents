/** Inline button: `data` comes back in the callback. */
export interface Button {
  text: string;
  data: string;
}

/** Outgoing Telegram, behind an interface so tests (and "dry run") never touch the network. */
export interface Messenger {
  send(chatId: number, text: string, buttons?: Button[][]): Promise<void>;
}

/** Test double: keeps everything that would have been sent. */
export class MemoryMessenger implements Messenger {
  readonly sent: { chatId: number; text: string; buttons?: Button[][] }[] = [];
  send(chatId: number, text: string, buttons?: Button[][]): Promise<void> {
    this.sent.push(buttons ? { chatId, text, buttons } : { chatId, text });
    return Promise.resolve();
  }
  to(chatId: number): string[] {
    return this.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
  }
  last(): { chatId: number; text: string; buttons?: Button[][] } | undefined {
    return this.sent.at(-1);
  }
}
