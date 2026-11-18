/** Inline button: `data` comes back in the callback (Telegram allows at most 64 bytes). */
export interface Button {
  text: string;
  data: string;
}

/** A persistent reply keyboard (the buttons under the input field); each button sends its own text. */
export interface ReplyKeyboard {
  rows: string[][];
  placeholder?: string;
}

export interface SendOptions {
  /** The text is Telegram HTML (escape everything that is not markup with `escapeHtml`). */
  html?: boolean;
  /** Shows the reply keyboard with this message (Telegram keeps it until removed). Not combined with inline buttons. */
  keyboard?: ReplyKeyboard;
}

export interface EditOptions {
  html?: boolean;
  /** New inline buttons; absent: the message is left without buttons. */
  buttons?: Button[][];
}

/** Outgoing Telegram, behind an interface so tests (and "dry run") never touch the network. */
export interface Messenger {
  send(chatId: number, text: string, buttons?: Button[][], opts?: SendOptions): Promise<void>;
  /** Like `send`, but resolves with the id of the sent message (needed to `edit` it later). */
  sendMessage(chatId: number, text: string, buttons?: Button[][], opts?: SendOptions): Promise<number>;
  /** Replaces the text of a message this bot sent (buttons dropped unless given). A message that did not change is not an error. */
  edit(chatId: number, messageId: number, text: string, opts?: EditOptions): Promise<void>;
  /** Replaces only the inline buttons of a message (null: removes them). */
  editButtons(chatId: number, messageId: number, buttons: Button[][] | null): Promise<void>;
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
/** Text for Telegram HTML: `&`, `<`, `>` and `"` as entities. */
export const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ENTITIES[c]!);
/** Telegram HTML back to plain text (the owner inbox and the website show plain text). */
export const stripHtml = (s: string): string =>
  s
    .replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|tg-spoiler|span)(?:\s[^>]*)?>/g, '')
    .replace(/<a\s[^>]*>|<\/a>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

/** Test double: keeps everything that would have been sent. */
export class MemoryMessenger implements Messenger {
  readonly sent: { chatId: number; text: string; buttons?: Button[][] }[] = [];
  readonly edits: { chatId: number; messageId: number; text: string; buttons?: Button[][]; html?: boolean }[] = [];
  /** Options of each sent message, by index in `sent` (kept apart so `sent` entries keep their old shape). */
  readonly options: (SendOptions | undefined)[] = [];
  private seq = 0;
  /** Message id -> index in `sent`. */
  private readonly index = new Map<number, number>();
  /** Message id -> its current inline buttons (after edits). */
  private readonly markup = new Map<number, Button[][] | undefined>();
  async send(chatId: number, text: string, buttons?: Button[][], opts?: SendOptions): Promise<void> {
    await this.sendMessage(chatId, text, buttons, opts);
  }
  sendMessage(chatId: number, text: string, buttons?: Button[][], opts?: SendOptions): Promise<number> {
    const id = ++this.seq;
    this.index.set(id, this.sent.push(buttons ? { chatId, text, buttons } : { chatId, text }) - 1);
    this.options.push(opts);
    this.markup.set(id, buttons);
    return Promise.resolve(id);
  }
  edit(chatId: number, messageId: number, text: string, opts?: EditOptions): Promise<void> {
    this.edits.push({ chatId, messageId, text, ...(opts?.buttons ? { buttons: opts.buttons } : {}), ...(opts?.html ? { html: true } : {}) });
    this.markup.set(messageId, opts?.buttons);
    return Promise.resolve();
  }
  editButtons(_chatId: number, messageId: number, buttons: Button[][] | null): Promise<void> {
    this.markup.set(messageId, buttons ?? undefined);
    return Promise.resolve();
  }
  /** The current text of a sent message: the last edit, or the original. */
  textOf(messageId: number): string | undefined {
    return this.edits.filter((e) => e.messageId === messageId).at(-1)?.text ?? this.sent[this.index.get(messageId) ?? -1]?.text;
  }
  /** The current inline buttons of a sent message (undefined: none). */
  buttonsOf(messageId: number): Button[][] | undefined {
    const b = this.markup.get(messageId);
    return b && b.length ? b : undefined;
  }
  /** The id of the n-th sent message (0-based; negative counts from the end). */
  idAt(n: number): number {
    const i = n < 0 ? this.sent.length + n : n;
    for (const [id, idx] of this.index) if (idx === i) return id;
    return -1;
  }
  to(chatId: number): string[] {
    return this.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
  }
  last(): { chatId: number; text: string; buttons?: Button[][] } | undefined {
    return this.sent.at(-1);
  }
}
