import type { Db } from './db.js';
import { migrate } from './db.js';
import { errMsg, log } from './log.js';
import type { Button, Messenger } from './messenger.js';

/** What the app's card format gets for one proposal. */
export interface CardInfo {
  row: ApprovalRow;
  level: 0 | 1;
  streak: number;
  locked: boolean;
  /** The owner asked for the whole text («👁 Полностью»). */
  full: boolean;
  /** The kind brings its own buttons (`KindSpec.buttons`): the format must not replace them. */
  custom: boolean;
}

/**
 * The app's look of approval cards (Telegram HTML). Without one the core sends its plain card and only strips the
 * buttons after a decision. `buttons` are used only when the kind has no own buttons.
 */
export interface CardFormat {
  card(info: CardInfo): { text: string; buttons: Button[][] };
  /** The card after the owner's decision (or while waiting for the edit text): no decision buttons left, unless given. */
  settled(row: ApprovalRow, state: 'executed' | 'rejected' | 'failed' | 'editing' | 'edited' | 'stale' | 'running'): { text: string; buttons?: Button[][] };
}

export interface CardRef {
  chatId: number;
  messageId: number;
}

/** What an agent proposes. `text` is what the owner can edit (a reply to a client, a post, a price). */
export interface Payload {
  text?: string;
  [key: string]: unknown;
}

export interface KindSpec {
  /** 0: the agent only proposes, the owner presses a button. 1: the agent acts and reports. */
  initialLevel: 0 | 1;
  /** Money, contracts, prices: never promoted to level 1 by the counter, only by the owner's own decision. */
  locked?: boolean;
  /**
   * Content is not money: never promoted to level 1 by the counter (every item still needs the owner), yet ordinary for
   * «Одобрить все обычные». Unlike `locked`, which also keeps the kind out of bulk approval.
   */
  keepManual?: boolean;
  /** Bulk approval even though the kind has its own buttons (a weekly pack's card: it stands for many ordinary items). */
  bulk?: boolean;
  /** Runs only after "approve" (or at level 1). Throwing marks the approval failed. */
  execute(payload: Payload, approvalId: number): Promise<void>;
  /**
   * A text that cannot be executed yet (a `[цена]` left in a client reply): the reason for the owner, in Russian, else null. «Одобрить» on such a
   * card answers the reason and leaves the proposal open (it is not failed: the owner edits the text and approves again).
   */
  ready?(payload: Payload): string | null;
  /**
   * Own button rows for the owner's card instead of the default «Одобрить / Править / Отклонить». Buttons that decide must
   * keep the `ap:<id>:a|e|r` data (approve, edit, reject) so the core's handlers still work; others are the app's own.
   */
  buttons?(id: number, payload: Payload): Button[][];
}

export type Action = 'approve' | 'edit' | 'reject';

/** `ready` hook for texts that carry a template in square brackets (`[цена]`, `[решение владельца]`): the owner fills it with «Править». */
export function placeholderHold(placeholders: string[]): string | null {
  return placeholders.length ? `В тексте осталось ${placeholders.slice(0, 3).join(', ')}: нажмите «Править», впишите значение и одобрите снова` : null;
}
/** `running`: claimed by one decision (approve/reject/auto) and being executed; nobody else may touch it. */
type Status = 'pending' | 'editing' | 'running' | 'executed' | 'rejected' | 'failed';

export interface ApprovalRow {
  id: number;
  kind: string;
  payload: Payload;
  summary: string;
  status: Status;
  edited: boolean;
}

export interface Decision {
  id: number;
  approvalId: number | null;
  kind: string;
  decision: 'approve' | 'edit' | 'reject' | 'auto' | 'auto_failed';
  at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  edited INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS trust (
  kind TEXT PRIMARY KEY,
  level INTEGER NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS approval_cards (
  approval_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER,
  kind TEXT NOT NULL,
  decision TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

interface ApprovalDbRow {
  id: number;
  kind: string;
  payload: string;
  summary: string;
  status: Status;
  edited: number;
}

/**
 * The approval queue: an agent proposes, the owner gets a message with buttons, and the action runs
 * only after "approve". Per kind it counts approvals in a row without edits; after `threshold` the
 * kind moves from level 0 to level 1 (unless locked). Every decision goes to the journal.
 * Decision records hold kinds and ids only, never message texts.
 */
export class ApprovalQueue {
  private readonly kinds = new Map<string, KindSpec>();
  private editing: number | null = null;
  private format: CardFormat | null = null;

  constructor(
    private readonly db: Db,
    private readonly messenger: Messenger,
    private readonly ownerId: number,
    private readonly threshold = 20,
    private readonly now: () => number = Date.now,
  ) {
    migrate(db, SCHEMA);
  }

  register(kind: string, spec: KindSpec): void {
    this.kinds.set(kind, spec);
    this.db.prepare('INSERT OR IGNORE INTO trust (kind, level, streak) VALUES (?, ?, 0)').run(kind, spec.initialLevel);
  }

  private spec(kind: string): KindSpec {
    const s = this.kinds.get(kind);
    if (!s) throw new Error(`Unknown approval kind "${kind}"`);
    return s;
  }

  /** The app's card look (HTML, decisions edited in place). */
  setCardFormat(format: CardFormat | null): void {
    this.format = format;
  }

  hasCardFormat(): boolean {
    return this.format !== null;
  }

  /** Money, prices, contracts: never approved in bulk, never promoted by the counter. */
  isLocked(kind: string): boolean {
    return Boolean(this.kinds.get(kind)?.locked);
  }

  /** The kind brings its own buttons (an app-specific card, e.g. «Скопировать / Отправлено»). */
  hasOwnButtons(kind: string): boolean {
    return Boolean(this.kinds.get(kind)?.buttons);
  }

  /** Ordinary: «Одобрить все обычные» may approve it (not locked, and no own buttons unless the kind says `bulk`). */
  isBulk(kind: string): boolean {
    const s = this.kinds.get(kind);
    return Boolean(s) && !s!.locked && (!s!.buttons || Boolean(s!.bulk));
  }

  /** The Telegram message that shows the proposal's card (the last one sent). */
  cardMessage(id: number): CardRef | undefined {
    const r = this.db.prepare('SELECT chat_id, message_id FROM approval_cards WHERE approval_id = ?').get(id) as { chat_id: number; message_id: number } | undefined;
    return r ? { chatId: r.chat_id, messageId: r.message_id } : undefined;
  }

  /** Remembers where the card was sent (also when it went out later, e.g. resent from the owner inbox). */
  noteCard(id: number, chatId: number, messageId: number): void {
    if (messageId <= 0) return;
    this.db.prepare('INSERT INTO approval_cards (approval_id, chat_id, message_id) VALUES (?, ?, ?) ON CONFLICT(approval_id) DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id').run(id, chatId, messageId);
  }

  /** The card's text and buttons as the format renders it now (null without a format or for an unknown id). */
  cardView(id: number, full = false): { text: string; buttons: Button[][] } | null {
    const row = this.get(id);
    if (!row || !this.format) return null;
    const spec = this.kinds.get(row.kind);
    const custom = spec?.buttons?.(id, row.payload);
    const view = this.format.card({ row, level: this.level(row.kind), streak: this.streak(row.kind), locked: Boolean(spec?.locked), full, custom: Boolean(custom) });
    return { text: view.text, buttons: custom ?? view.buttons };
  }

  /**
   * Edits the card in place to match the proposal's state: decided (no buttons), waiting for the edit text, or still
   * pending (the full card again). `at`: the message the button was on. Returns false without a card format.
   */
  async settleCard(id: number, at?: CardRef): Promise<boolean> {
    if (!this.format) return false;
    const ref = at ?? this.cardMessage(id);
    const row = this.get(id);
    if (!ref) return false;
    if (at) this.noteCard(id, at.chatId, at.messageId);
    let view: { text: string; buttons?: Button[][] };
    if (!row) view = this.format.settled({ id, kind: '', payload: {}, summary: '', status: 'rejected', edited: false }, 'stale');
    else if (row.status === 'pending') view = this.cardView(id)!;
    else view = this.format.settled(row, row.status);
    await this.messenger.edit(ref.chatId, ref.messageId, view.text, { html: true, ...(view.buttons ? { buttons: view.buttons } : {}) });
    return true;
  }

  /** Sends the card of a pending proposal again (a fresh copy at the bottom of the chat). False when it is decided. */
  async showCard(id: number): Promise<boolean> {
    const row = this.get(id);
    if (!row || (row.status !== 'pending' && row.status !== 'editing')) return false;
    await this.ask(id);
    return true;
  }

  /** «👁 Полностью» / «Свернуть»: the card shows the whole text or the preview again. Returns the callback toast. */
  async expandCard(id: number, full: boolean, at: CardRef): Promise<string> {
    const row = this.get(id);
    if (!row || !this.format) return 'Устарело';
    if (row.status !== 'pending') {
      await this.settleCard(id, at);
      return 'Уже обработано';
    }
    const view = this.cardView(id, full)!;
    this.noteCard(id, at.chatId, at.messageId);
    await this.messenger.edit(at.chatId, at.messageId, view.text, { html: true, buttons: view.buttons });
    return full ? 'Полный текст' : 'Свернул';
  }

  /**
   * «Одобрить все обычные»: approves every pending proposal that is not locked (money, prices, client sends) and has no own buttons
   * (those need the owner's own action; a weekly pack's card is the exception), one by one through `handle`, so trust counters and the journal stay as for a
   * button press. Each decided card is edited in place.
   */
  async approveAll(fromId: number): Promise<{ approved: number; failed: number; skipped: number }> {
    const out = { approved: 0, failed: 0, skipped: 0 };
    if (fromId !== this.ownerId) return out;
    for (const row of this.pending()) {
      if (row.status !== 'pending' || !this.isBulk(row.kind)) {
        out.skipped++;
        continue;
      }
      if (this.notReady(row.id)) {
        out.skipped++; // a template is left in the text: decided one by one, after the owner fills it
        continue;
      }
      const answer = await this.handle('approve', row.id, fromId);
      if (answer === 'Одобрено') out.approved++;
      else if (answer === 'Уже обработано') out.skipped++;
      else out.failed++;
      await this.settleCard(row.id).catch((e) => log('warn', 'card settle failed', { approvalId: row.id, err: errMsg(e) }));
    }
    return out;
  }

  level(kind: string): 0 | 1 {
    const row = this.db.prepare('SELECT level FROM trust WHERE kind = ?').get(kind) as { level: number } | undefined;
    return row?.level === 1 ? 1 : 0;
  }

  streak(kind: string): number {
    const row = this.db.prepare('SELECT streak FROM trust WHERE kind = ?').get(kind) as { streak: number } | undefined;
    return row?.streak ?? 0;
  }

  /** Owner's own decision to move a kind (the only way to unlock a locked one). */
  setLevel(kind: string, level: 0 | 1): void {
    this.spec(kind);
    this.db.prepare('UPDATE trust SET level = ?, streak = 0 WHERE kind = ?').run(level, kind);
  }

  trustTable(): { kind: string; level: number; streak: number; locked: boolean }[] {
    return [...this.kinds.entries()].map(([kind, s]) => ({
      kind,
      level: this.level(kind),
      streak: this.streak(kind),
      locked: Boolean(s.locked),
    }));
  }

  /**
   * Level 0: stores the proposal and asks the owner. Level 1: runs it now and journals "auto"; when the action fails the
   * owner is told (a message with the way back to manual approval), never a silent journal row.
   * `summary` is what the owner reads above the buttons (can hold client text: it only goes to the owner).
   * `onCreated` gets the id as soon as the row exists, before the card is sent: if the send fails the caller still knows
   * the id and can show the same card later (`showCard`) instead of proposing the same thing twice.
   */
  async propose(kind: string, payload: Payload, summary: string, opts: { onCreated?: (id: number) => void } = {}): Promise<{ id: number; auto: boolean; ok?: boolean }> {
    const spec = this.spec(kind);
    // level 1 acts alone, but a draft with a template left in it (`[цена]`) cannot: it waits as a card for the owner to fill it
    if (this.level(kind) === 1 && !spec.ready?.(payload)) {
      const id = this.insert(kind, payload, summary, 'running');
      opts.onCreated?.(id);
      const ok = await this.run(id, spec, payload);
      this.journal(id, kind, ok ? 'auto' : 'auto_failed');
      if (!ok) {
        await this.messenger
          .send(this.ownerId, `Предложение #${id} (${kind}) выполнилось само (уровень 1), но не сработало: подробности в логе. Вернуть на ручное одобрение: /level ${kind} 0`)
          .catch((e) => log('warn', 'auto failure notice not sent', { approvalId: id, err: errMsg(e) }));
      }
      return { id, auto: true, ok };
    }
    const id = this.insert(kind, payload, summary, 'pending');
    opts.onCreated?.(id);
    await this.ask(id);
    return { id, auto: false };
  }

  get(id: number): ApprovalRow | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalDbRow | undefined;
    return r ? { id: r.id, kind: r.kind, payload: JSON.parse(r.payload) as Payload, summary: r.summary, status: r.status, edited: r.edited === 1 } : undefined;
  }

  pending(): ApprovalRow[] {
    const ids = this.db.prepare("SELECT id FROM approvals WHERE status IN ('pending','editing') ORDER BY id").all() as { id: number }[];
    return ids.map((r) => this.get(r.id)!);
  }

  journalRows(limit = 50): Decision[] {
    const rows = this.db.prepare('SELECT * FROM decisions ORDER BY id DESC LIMIT ?').all(limit) as {
      id: number; approval_id: number | null; kind: string; decision: Decision['decision']; at: number;
    }[];
    return rows.map((r) => ({ id: r.id, approvalId: r.approval_id, kind: r.kind, decision: r.decision, at: r.at }));
  }

  /** A button press. Returns a short answer for the callback toast. Only the owner may decide. */
  async handle(action: Action, id: number, fromId: number): Promise<string> {
    if (fromId !== this.ownerId) return 'Нет доступа';
    const row = this.get(id);
    if (!row) return 'Не найдено';
    if (row.status !== 'pending' && !(row.status === 'editing' && action !== 'edit')) return 'Уже обработано';
    const spec = this.spec(row.kind);

    if (action === 'approve') {
      const hold = spec.ready?.(row.payload);
      if (hold) return hold;
    }
    if (action === 'reject') {
      if (!this.claim(id)) return 'Уже обработано';
      this.setStatus(id, 'rejected');
      this.bump(row.kind, 'reset');
      this.journal(id, row.kind, 'reject');
      if (this.editing === id) this.editing = null;
      return 'Отклонено';
    }
    if (action === 'edit') {
      this.setStatus(id, 'editing');
      this.editing = id;
      await this.messenger.send(this.ownerId, `Пришлите новый текст для предложения #${id} одним сообщением.`);
      return 'Жду правку';
    }
    // approve: claim first (one UPDATE), so a second press or «Одобрить все» running at the same time cannot execute it twice
    if (!this.claim(id)) return 'Уже обработано';
    if (this.editing === id) this.editing = null;
    const ok = await this.run(id, spec, row.payload);
    if (!ok) {
      await this.messenger.send(this.ownerId, `Предложение #${id} (${row.kind}) не выполнено, подробности в логе.`);
      return 'Ошибка выполнения';
    }
    this.journal(id, row.kind, 'approve');
    // An approval of a text the owner already edited is not a clean one.
    if (row.edited) this.bump(row.kind, 'reset');
    else await this.bumpClean(row.kind);
    return 'Одобрено';
  }

  /** Why an open proposal cannot be approved as it stands (its `ready` hook), else null. */
  notReady(id: number): string | null {
    const row = this.get(id);
    return row ? (this.spec(row.kind).ready?.(row.payload) ?? null) : null;
  }

  /** True while the next owner message is a correction for a proposal (the bot must route it here). */
  get awaitingEdit(): boolean {
    return this.editing !== null;
  }

  /** The owner's next message after "править": replaces the text, resets the streak, asks again. */
  async submitEdit(fromId: number, text: string): Promise<boolean> {
    if (fromId !== this.ownerId || this.editing === null) return false;
    const id = this.editing;
    this.editing = null;
    return this.applyEdit(id, text);
  }

  /**
   * Replaces the proposal's text with an edited one (a pending proposal; the agent builds the new text itself,
   * e.g. one platform part swapped), resets the streak, journals "edit" and asks again.
   */
  async applyEdit(id: number, text: string): Promise<boolean> {
    const row = this.get(id);
    if (!row || (row.status !== 'pending' && row.status !== 'editing')) return false;
    const payload: Payload = { ...row.payload, text };
    this.db.prepare("UPDATE approvals SET payload = ?, edited = 1, status = 'pending' WHERE id = ?").run(JSON.stringify(payload), id);
    this.bump(row.kind, 'reset');
    this.journal(id, row.kind, 'edit');
    const old = this.format ? this.cardMessage(id) : undefined;
    if (old && this.format) {
      const view = this.format.settled(this.get(id)!, 'edited');
      await this.messenger.edit(old.chatId, old.messageId, view.text, { html: true }).catch((e) => log('warn', 'card settle failed', { approvalId: id, err: errMsg(e) }));
    }
    await this.ask(id);
    return true;
  }

  /**
   * A pending proposal without a card: the owner decides it through another card (a weekly pack). The caller approves or
   * rejects it with `handle`, so the trust counter and the journal stay as for a button press. Level 1 does not apply here.
   */
  open(kind: string, payload: Payload, summary: string): number {
    this.spec(kind);
    return this.insert(kind, payload, summary, 'pending');
  }

  private insert(kind: string, payload: Payload, summary: string, status: Status): number {
    const r = this.db
      .prepare('INSERT INTO approvals (kind, payload, summary, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(kind, JSON.stringify(payload), summary, status, this.now());
    return Number(r.lastInsertRowid);
  }

  /** Atomically takes a pending (or being edited) proposal for one decision; false when somebody else already did. */
  private claim(id: number): boolean {
    return this.db.prepare("UPDATE approvals SET status = 'running', decided_at = ? WHERE id = ? AND status IN ('pending','editing')").run(this.now(), id).changes === 1;
  }

  /** At process start: a proposal still `running` was cut off mid-execution; whether it happened is unknown, so it is failed and the owner decides. */
  recoverInterrupted(): number[] {
    const ids = (this.db.prepare("SELECT id FROM approvals WHERE status = 'running'").all() as { id: number }[]).map((r) => r.id);
    for (const id of ids) this.setStatus(id, 'failed');
    return ids;
  }

  private setStatus(id: number, status: Status): void {
    this.db.prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?').run(status, this.now(), id);
  }

  private async ask(id: number): Promise<void> {
    const view = this.cardView(id);
    if (view) {
      const messageId = await this.messenger.sendMessage(this.ownerId, view.text, view.buttons, { html: true });
      this.noteCard(id, this.ownerId, messageId);
      return;
    }
    const row = this.get(id)!;
    const body = typeof row.payload.text === 'string' ? `\n\nПредлагаю отправить:\n${row.payload.text}` : '';
    const level = this.level(row.kind);
    const messageId = await this.messenger.sendMessage(
      this.ownerId,
      `#${id} ${row.kind} (уровень ${level}, подряд ${this.streak(row.kind)})\n${row.summary}${body}`,
      this.spec(row.kind).buttons?.(id, row.payload) ?? [[
        { text: 'Одобрить', data: `ap:${id}:a` },
        { text: 'Править', data: `ap:${id}:e` },
        { text: 'Отклонить', data: `ap:${id}:r` },
      ]],
    );
    this.noteCard(id, this.ownerId, messageId);
  }

  private async run(id: number, spec: KindSpec, payload: Payload): Promise<boolean> {
    try {
      await spec.execute(payload, id);
      this.setStatus(id, 'executed');
      return true;
    } catch (e) {
      this.setStatus(id, 'failed');
      log('error', 'approval execute failed', { approvalId: id, err: errMsg(e) });
      return false;
    }
  }

  private journal(approvalId: number | null, kind: string, decision: Decision['decision']): void {
    this.db.prepare('INSERT INTO decisions (approval_id, kind, decision, at) VALUES (?, ?, ?, ?)').run(approvalId, kind, decision, this.now());
    log('info', 'decision', { approvalId, kind, decision });
  }

  private bump(kind: string, mode: 'reset'): void {
    if (mode === 'reset') this.db.prepare('UPDATE trust SET streak = 0 WHERE kind = ?').run(kind);
  }

  private async bumpClean(kind: string): Promise<void> {
    this.db.prepare('UPDATE trust SET streak = streak + 1 WHERE kind = ?').run(kind);
    const spec = this.spec(kind);
    if (this.level(kind) === 0 && !spec.locked && !spec.keepManual && this.streak(kind) >= this.threshold) {
      this.db.prepare('UPDATE trust SET level = 1 WHERE kind = ?').run(kind);
      log('info', 'trust level raised', { kind, level: 1 });
      await this.messenger.send(this.ownerId, `Тип «${kind}»: ${this.threshold} одобрений подряд без правок, перехожу на уровень 1 (делаю сам, отчитываюсь). Вернуть: /level ${kind} 0`);
    }
  }
}
